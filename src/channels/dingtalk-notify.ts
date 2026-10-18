/**
 * 钉钉「自定义机器人 Webhook」纯推送通知渠道（id=`dingtalk-notify`）。
 *
 * 与既有 `dingtalk.ts`（Stream 双向机器人）互不依赖：本渠道只做**出站单发**，
 * 面向「把 harness 的通知/告警推到某个钉钉群」这一单一职责，零入站。
 *
 * ── 协议锚点（open.dingtalk.com 公开文档独立重实现，净室口径）────────────────
 * A) 端点与请求形态——《自定义机器人发送群消息 / 消息类型》
 *    https://open.dingtalk.com/document/orgapp/custom-robot-access
 *    https://open.dingtalk.com/document/development/custom-robots-send-group-messages
 *    https://open.dingtalk.com/document/orgapp/custom-bot-send-message-type
 *    - POST https://oapi.dingtalk.com/robot/send?access_token=<webhook token>
 *    - 加签档追加查询参数 `&timestamp=<ms>&sign=<urlencode(base64)>`
 *    - Content-Type: application/json
 *    - body 三型：
 *        {msgtype:'text',     text:{content},                at?:{...}}
 *        {msgtype:'markdown', markdown:{title,text},         at?:{...}}
 *      at = {atMobiles?:string[], atUserIds?:string[], isAtAll?:boolean}
 *      ——**at 与 text/markdown 平级（顶层）**，非嵌套在 text 内。
 * B) 成功判据——经典坑：HTTP 恒 200，**body.errcode≠0 才是失败**。
 *    成功：`{"errcode":0,"errmsg":"ok"}`；一切安全校验/内容拒绝都在 errcode。
 *    只看 HTTP 状态即判成 = 假成功（本实现以 errcode 为唯一成功判据）。
 * C) 错误码——《发送群消息》错误码表（官方口径）：
 *    - 310000 统摄「消息校验未通过」四类：`keywords not in content`（关键词不匹配）、
 *      `invalid timestamp`（时间戳无效）、`sign not match`（签名不匹配）、
 *      `ip X.X.X.X not in whitelist`（IP 不在白名单）——均为**确定性**拒绝（未投递）。
 *    - 300001/`token is not found`、`robot code is invalid` 等——确定性（机器人失效）。
 *    - 130101/`send too fast, limit 20/min per robot`——限流，确定性拒绝（未投递）。
 *    本实现把「能解析出非零 errcode」一律判为确定性失败并抛错；仅网络错/5xx/
 *    响应体不可解析才判 uncertain（见下 D7 纪律）。
 * D) 安全三档——《自定义机器人安全设置》
 *    https://open.dingtalk.com/document/orgapp/customize-robot-security-settings
 *    三选一（可叠加），此处实装 keyword / sign / none：
 *    - 自定义关键词：正文必须**包含**至少一个预设关键词，否则 errcode 310000
 *      `keywords not in content`。
 *    - 加签：sign = URLEncoder.encode(Base64(HmacSHA256(secret,
 *      timestamp + "\n" + secret)), "UTF-8")；timestamp 为**毫秒**字符串；
 *      secret 即机器人「加签密钥」（SEC 开头），走 secrets 注入，config 不落明文。
 *    - IP 段：白名单（无需本端逻辑，none 档亦可依赖平台侧 IP 白名单）。
 *    - timestamp 与服务端时间相差 >1h 视为非法（invalid timestamp）——故每次发送
 *      实时重算 timestamp/sign，不缓存。
 * E) 频率/长度：群机器人 ~20 条/分钟（超限 130101）；消息体上限按平台口径取
 *    **20000**（markdown/text 单条 body 社区与文档实测上界），超限由引擎按
 *    caps.maxMessageLength 分段，本适配器不自行截断谎报。
 *
 * ── D7 投递纪律（与全仓红线一致）────────────────────────────────────────────
 * 网络异常 / HTTP 5xx / 响应体无法解析 → DingtalkNotifyUncertainError，
 * Receipt.uncertain 语义下**引擎禁自动重发**（宁可漏发不双发）。
 *
 * ── 决策注释（关键取舍）──────────────────────────────────────────────────────
 * K1 keyword 档「补前缀 vs 拒发」：选**自动前置拼入关键词模板**，保「通知必达」——
 *    通知渠道的失败代价（漏报）远高于多一个前缀的观感代价；命中回执文案标
 *    `已按关键词模板补前缀`（见 NotifyReceipt.note）。若配置了 keyword 但 keyword
 *    为空串则等同不补（不误判必达）。
 * K2 判败基准：以 body.errcode 为唯一成功判据；errcode≠0 → 确定性抛错（含 310000），
 *    HTTP 200 也判败（反「假成功」坑）；仅传输层/5xx/不可解析 → uncertain。
 * K3 caps 全收信位 false：webhook 无入站回调，onMessage 返回 no-op（注册即忽略，
 *    listener 永不被调用）；connect/disconnect 仅维护「已就绪」标记位，无长连接。
 */
import { createHmac } from 'node:crypto'
import type { ChatAddress } from '../engine/router.js'
import type {
  ChannelAdapter,
  ChannelCaps,
  ChannelDiagnosisCheck,
  MessageListener,
  Receipt,
} from './types.js'

const OAPI_BASE = 'https://oapi.dingtalk.com/robot/send'
/** 单条消息体上限（见锚点 E：markdown 平台上界），引擎据此分段。 */
const DINGTALK_NOTIFY_MAX_MESSAGE = 20000
const REQUEST_TIMEOUT_MS = 15_000
/** 诊断试发的最小正文（keyword 档会被 applyKeyword 自动补前缀，见 K1）。 */
const DIAG_TEXT = 'dsh-im-union 诊断'

/** 官方 errcode 310000 = 消息校验未通过（关键词/时间戳/签名/IP 白名单）。 */
const ERRCODE_SECURITY_FAIL = 310000

export type DingtalkNotifySecurity = 'keyword' | 'sign' | 'none'

type FetchResponseLike = {
  ok: boolean
  status: number
  json(): Promise<unknown>
}
type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchResponseLike>

/** 平台明确拒绝（HTTP 200 但 errcode≠0，或 4xx）——确定性失败，未投递。 */
export class DingtalkNotifyApiError extends Error {
  constructor(
    message: string,
    /** 平台 errcode（判型/诊断转译用，不进用户可见文案主干）。 */
    readonly errcode: number,
    /** 平台 errmsg 原文（诊断 hint 转译参考）。 */
    readonly errmsg: string,
  ) {
    super(message)
  }
}
/** 结果不明（网络错/超时/5xx/响应不可解析）——D7：禁自动重发。 */
export class DingtalkNotifyUncertainError extends Error {}

/** 出站回执：在标准 Receipt 之上附关键词补前缀标记（诊断/回执文案用）。 */
export interface NotifyReceipt extends Receipt {
  /** K1：本次是否因未命中关键词而自动补了前缀。 */
  keywordPrefixed?: boolean
  /** 补前缀时的说明文案。 */
  note?: string
}

export interface DingtalkNotifyAdapterOptions {
  /** webhook access_token（secrets 注入）。 */
  token: string
  security: DingtalkNotifySecurity
  /** keyword 档：关键词模板（不含则自动前置补入，见 K1）。 */
  keyword?: string
  /** sign 档：加签密钥 SECxxx（secrets 注入，config 不落明文）。 */
  signSecret?: string
  atAll?: boolean
  atMobiles?: string[]
  atUserIds?: string[]
  /** markdown 档默认标题（sendMarkdown 未显式传 title 时用）。 */
  markdownTitle?: string
  /** 覆盖基址（测试注入/专有云代理）；缺省 oapi.dingtalk.com。 */
  webhookBase?: string
  fetchImpl?: FetchLike
  /** 注入时钟（测试确定性 timestamp/sign）。 */
  now?: () => number
  requestTimeoutMs?: number
  logger?: (msg: string) => void
}

export class DingtalkNotifyAdapter implements ChannelAdapter {
  readonly id = 'dingtalk-notify'
  readonly label = '钉钉通知（Webhook）'
  readonly caps: ChannelCaps = {
    // K3：纯推送通知渠道——所有收信/交互位一律 false（声明=实装）。
    editStream: false,
    nativeStream: false,
    nativeChoices: false,
    statusReaction: false,
    statusProgress: false,
    typing: false,
    imageIn: false,
    fileIn: false,
    fileOut: false,
    threads: false,
    voice: false,
    maxMessageLength: DINGTALK_NOTIFY_MAX_MESSAGE,
  }

  connected = false

  private readonly token: string
  private readonly security: DingtalkNotifySecurity
  private readonly keyword: string
  private readonly signSecret: string
  private readonly atAll: boolean
  private readonly atMobiles: string[]
  private readonly atUserIds: string[]
  private readonly markdownTitle: string
  private readonly webhookBase: string
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly requestTimeoutMs: number
  private readonly log: (msg: string) => void

  constructor(options: DingtalkNotifyAdapterOptions) {
    if (typeof options.token !== 'string' || options.token === '') {
      throw new Error('dingtalk-notify: webhook access_token 缺失（secrets.webhook）')
    }
    const security: DingtalkNotifySecurity = options.security ?? 'none'
    if (security === 'sign' && (typeof options.signSecret !== 'string' || options.signSecret === '')) {
      throw new Error('dingtalk-notify: security=sign 时 signSecret 必填（secrets.signSecret）')
    }
    this.token = options.token
    this.security = security
    this.keyword = options.keyword ?? ''
    this.signSecret = options.signSecret ?? ''
    this.atAll = options.atAll === true
    this.atMobiles = options.atMobiles ?? []
    this.atUserIds = options.atUserIds ?? []
    this.markdownTitle = options.markdownTitle ?? 'dsh-im-union 通知'
    this.webhookBase = options.webhookBase ?? OAPI_BASE
    const globalFetch = (globalThis as { fetch?: FetchLike }).fetch
    this.fetchImpl =
      options.fetchImpl ??
      ((url: string, init?: Parameters<FetchLike>[1]) => {
        if (globalFetch === undefined) {
          return Promise.reject(new Error('dingtalk-notify: 运行时缺全局 fetch（需 Node≥22）'))
        }
        return globalFetch(url, init)
      })
    this.now = options.now ?? (() => Date.now())
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.log = options.logger ?? (() => {})
  }

  // —— 生命周期（K3：无长连接，connect/disconnect 仅就绪标记）————

  async connect(signal?: AbortSignal): Promise<void> {
    void signal
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  /**
   * 通知类渠道无入站：listener 收下即忽略，永不回调（K3）。
   * 返回的取消函数为 no-op，保持与 ChannelAdapter.onMessage 契约一致。
   */
  onMessage(_listener: MessageListener): () => void {
    return () => {}
  }

  // —— 出站 ——————————————————————————————————————————

  /** 文本单发（引擎主用）。webhook 固定目标群，address 仅满足契约，不参与寻址。 */
  async reply(_address: ChatAddress, text: string, signal?: AbortSignal): Promise<NotifyReceipt> {
    const { content, prefixed } = this.applyKeyword(text)
    const body: Record<string, unknown> = { msgtype: 'text', text: { content } }
    const at = this.buildAt()
    if (at !== undefined) body.at = at
    await this.deliver(body, signal)
    return this.toReceipt(prefixed)
  }

  /** markdown 单发（sendMarkdown 显式调用；reply 不走此型以保持关键词判据简单）。 */
  async sendMarkdown(_address: ChatAddress, title: string, md: string, signal?: AbortSignal): Promise<NotifyReceipt> {
    const { content, prefixed } = this.applyKeyword(md)
    const body: Record<string, unknown> = {
      msgtype: 'markdown',
      markdown: { title: title !== '' ? title : this.markdownTitle, text: content },
    }
    const at = this.buildAt()
    if (at !== undefined) body.at = at
    await this.deliver(body, signal)
    return this.toReceipt(prefixed)
  }

  private toReceipt(prefixed: boolean): NotifyReceipt {
    const receipt: NotifyReceipt = { uncertain: false }
    if (prefixed) {
      receipt.keywordPrefixed = true
      receipt.note = '已按关键词模板补前缀'
    }
    return receipt
  }

  // —— 安全档位与帧形构造（可测）——————————————————————

  /** 组装完整 URL（含 access_token；sign 档追加 timestamp/sign 查询参数）。 */
  buildUrl(): string {
    let query = `access_token=${encodeURIComponent(this.token)}`
    if (this.security === 'sign') {
      const timestamp = String(this.now())
      const sign = this.computeSign(timestamp)
      // 官方要求对 base64 结果 urlencode：base64 字母表内 +/= 必须转 %2B/%2F/%3D。
      query += `&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`
    }
    return `${this.webhookBase}?${query}`
  }

  /** sign 档：urlencode 前的原始 base64（HmacSHA256(secret, ts+"\n"+secret)）。 */
  private computeSign(timestamp: string): string {
    return createHmac('sha256', this.signSecret).update(`${timestamp}\n${this.signSecret}`, 'utf8').digest('base64')
  }

  /** K1：keyword 档未命中关键词则自动前置补入；其余档原样返回。 */
  private applyKeyword(text: string): { content: string; prefixed: boolean } {
    if (this.security === 'keyword' && this.keyword !== '' && !text.includes(this.keyword)) {
      return { content: `${this.keyword} ${text}`, prefixed: true }
    }
    return { content: text, prefixed: false }
  }

  /** 顶层 at 块：仅在需要 @ 时携带（isAtAll/atMobiles/atUserIds）。 */
  private buildAt(): Record<string, unknown> | undefined {
    if (!this.atAll && this.atMobiles.length === 0 && this.atUserIds.length === 0) return undefined
    return {
      ...(this.atMobiles.length > 0 ? { atMobiles: this.atMobiles } : {}),
      ...(this.atUserIds.length > 0 ? { atUserIds: this.atUserIds } : {}),
      isAtAll: this.atAll,
    }
  }

  /**
   * 发送并判定成败（K2）：以 body.errcode 为唯一成功判据。
   * 抛错口径：确定性失败 → DingtalkNotifyApiError；结果不明 → DingtalkNotifyUncertainError。
   */
  private async deliver(body: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const url = this.buildUrl()
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs)
    const composed = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    let res: FetchResponseLike
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: composed,
      })
    } catch (error) {
      // 网络/超时/中止：结果不明（不谎报成功，也不伪确定性失败）——D7。
      throw new DingtalkNotifyUncertainError(`dingtalk-notify: 传输失败（${String(error)}），结果不确定`)
    }
    if (res.status >= 500) {
      throw new DingtalkNotifyUncertainError(`dingtalk-notify: HTTP ${res.status}（服务端异常），结果不确定`)
    }
    let json: Record<string, unknown> | undefined
    try {
      json = (await res.json()) as Record<string, unknown>
    } catch {
      json = undefined
    }
    const errcode = typeof json?.errcode === 'number' ? json.errcode : undefined
    const errmsg = typeof json?.errmsg === 'string' ? json.errmsg : ''
    if (errcode === undefined) {
      // 拿不到 errcode：2xx 不谎报成功（判 uncertain）；4xx 视为确定性拒绝。
      if (res.ok) {
        throw new DingtalkNotifyUncertainError('dingtalk-notify: 响应缺少 errcode，无法确认投递结果')
      }
      throw new DingtalkNotifyApiError(`dingtalk-notify: HTTP ${res.status}${errmsg ? ` ${errmsg}` : ''}`, res.status, errmsg)
    }
    if (errcode === 0) return
    // errcode≠0：无论 HTTP 是否 200，都是确定性失败（经典「假成功」坑的反例）。
    throw new DingtalkNotifyApiError(`dingtalk-notify: ${errmsg || `errcode ${errcode}`}`, errcode, errmsg)
  }

  // —— 诊断三态 ——————————————————————————————————————

  /**
   * 静态安全档核对 + 一条最小 text 实探（DIAG_TEXT）。
   * errcode=0 → passed；310000/其它确定性拒绝 → failed（hint 转译）；网络/不可解析 → unverified。
   */
  async diagnose(signal?: AbortSignal): Promise<ChannelDiagnosisCheck[]> {
    const checks: ChannelDiagnosisCheck[] = []

    if (this.security === 'sign' && this.signSecret === '') {
      checks.push({ name: 'security-config', status: 'failed', hint: '加签档缺少 signSecret（secrets.signSecret）' })
    } else if (this.security === 'keyword' && this.keyword === '') {
      checks.push({ name: 'security-config', status: 'failed', hint: '关键词档缺少 keyword（config.keyword）' })
    } else {
      checks.push({
        name: 'security-config',
        status: 'passed',
        hint: `安全档=${this.security}${this.security === 'keyword' ? `（关键词：${this.keyword}）` : ''}`,
      })
    }

    const started = this.now()
    const { content } = this.applyKeyword(DIAG_TEXT)
    const body: Record<string, unknown> = { msgtype: 'text', text: { content } }
    const at = this.buildAt()
    if (at !== undefined) body.at = at
    const elapsedMs = Math.max(0, this.now() - started)
    try {
      await this.deliver(body, signal)
      checks.push({ name: 'webhook-delivery', status: 'passed', hint: '试发诊断消息成功（errcode=0）', elapsedMs })
    } catch (error) {
      if (error instanceof DingtalkNotifyApiError) {
        checks.push({
          name: 'webhook-delivery',
          status: 'failed',
          hint: this.translateErrcode(error),
          elapsedMs,
        })
      } else {
        checks.push({
          name: 'webhook-delivery',
          status: 'unverified',
          hint: '网络错误或结果不确定，无法确认平台可达性',
          elapsedMs,
        })
      }
    }
    return checks
  }

  /** 官方错误码 → 用户可操作文案（诊断 hint）。 */
  private translateErrcode(error: DingtalkNotifyApiError): string {
    if (error.errcode === ERRCODE_SECURITY_FAIL) {
      return '关键词/安全设置不匹配，检查机器人安全设置（关键词/加签/IP 白名单）'
    }
    if (error.errcode === 130101) {
      return '发送过快被限流（约 20 条/分钟），降低推送频率后重试'
    }
    if (error.errcode === 300001 || /token is not found|robot code is invalid/i.test(error.errmsg)) {
      return 'access_token 无效或机器人已失效，重新复制 Webhook'
    }
    return `平台拒绝（errcode=${error.errcode}${error.errmsg ? `：${error.errmsg}` : ''}）`
  }
}

/** secrets.webhook 允许是裸 access_token，也可能是整条 Webhook URL——两者都吃。 */
function splitWebhook(raw: string): { base: string; token: string } {
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw)
      return { base: `${u.origin}${u.pathname}`, token: u.searchParams.get('access_token') ?? '' }
    } catch {
      /* 非法 URL：退回按裸 token 处理 */
    }
  }
  return { base: OAPI_BASE, token: raw }
}

function csv(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

export function createDingtalkNotifyAdapter(options: {
  accountId: string
  config: Record<string, string>
  secrets: Record<string, string | undefined>
  /** 测试/专有云注入位（不进 ChannelFactory 常规调用；缺省走全局 fetch）。 */
  fetchImpl?: FetchLike
  now?: () => number
}): DingtalkNotifyAdapter {
  const rawSecurity = (options.config.security ?? 'none').trim().toLowerCase()
  const security: DingtalkNotifySecurity = rawSecurity === 'keyword' ? 'keyword' : rawSecurity === 'sign' ? 'sign' : 'none'
  const rawWebhook = options.secrets.webhook ?? options.secrets.accessToken ?? ''
  const { base, token } = splitWebhook(rawWebhook)
  if (token === '') {
    throw new Error('dingtalk-notify: webhook access_token 缺失（secrets.webhook）')
  }
  const signSecret = options.secrets.signSecret ?? ''
  if (security === 'sign' && signSecret === '') {
    throw new Error('dingtalk-notify: security=sign 时 signSecret 必填（secrets.signSecret）')
  }
  const adapterOptions: DingtalkNotifyAdapterOptions = {
    token,
    security,
    keyword: options.config.keyword ?? '',
    signSecret,
    atAll: options.config.atAll === 'true',
    atMobiles: csv(options.config.atMobiles),
    atUserIds: csv(options.config.atUserIds),
    webhookBase: base,
  }
  if (options.config.markdownTitle !== undefined && options.config.markdownTitle !== '') {
    adapterOptions.markdownTitle = options.config.markdownTitle
  }
  if (options.fetchImpl !== undefined) adapterOptions.fetchImpl = options.fetchImpl
  if (options.now !== undefined) adapterOptions.now = options.now
  return new DingtalkNotifyAdapter(adapterOptions)
}
