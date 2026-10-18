/**
 * QQ 推送通知档（id=`qq-notify`）—— 纯出站、主动推送定档的 QQ 机器人渠道。
 *
 * 与同仓 `qq.ts`（双向渠道）独立并存：本文件按 QQ 开放平台公开协议文档独立实现，
 * 不 import qq.ts 内部（两文件互不依赖，各自演进）。本档只做「通知/推送」，
 * 不建 WebSocket、不收信（通知类无需收信），connect 仅取凭证。
 *
 * ── 第一步查实：QQ 官方机器人「公开推送面」现行边界（查证于官方文档，2026-10）────────
 * 主据（现行官方域 bot.qq.com / bot.q.qq.com）：
 * - 消息收发概述：https://bot.qq.com/wiki/develop/api-v2/server-inter/message/overview.html
 *   「主动消息 | 无任何条件 | 机器人主动触达用户，用户可在客户端关闭『允许主动发送』开关，
 *    关闭后主动消息将发送失败」——即：不携带 msg_id 的请求即主动消息，官方明确开放；
 *   主动消息频控（HTTP 接口）：
 *     单聊  企业认证/个人认证 10/qps · 未认证 5/qps & 30/qpm · 单关系 20/qpm · 1000 条/用户/日；
 *     群聊  企业认证/个人认证 60/qpm · 未认证 30/qpm · 单关系 20/qpm · 1000 条/群/日；
 *   msg_type 发送面：0 文本 / 2 Markdown / 7 富媒体（主动、被动通用）；
 *   被动窗口（携带 msg_id）：单聊 60 分钟/4 次、群聊 5 分钟/5 次——本档无入站，取不到 msg_id，故不走被动窗口。
 * - 发送群聊消息：https://bot.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
 *   发送单聊消息：https://bot.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html
 *   POST /v2/groups/{group_openid}/messages、POST /v2/users/{user_openid}/messages；
 *   不带 msg_id 即为主动消息；错误码 40034100 主动消息超频控、40034105 主动消息无权限。
 * - 取凭证：https://bots.qq.com/app/getAppAccessToken（POST 体 {appId, clientSecret} → {access_token, expires_in≤7200}）
 *   API 调用指南：https://bot.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html
 *   （统一地址 https://api.bot.qq.com；请求头 Authorization: `QQBot {ACCESS_TOKEN}`；失败体 {err_code, message, trace_id}）
 * 任务点名的两页 https://developers.qq.com/docs/90/41660（群消息）/ 90/41656（C2C 消息）：
 *   本次核实该域 DNS 不可解析（no such host，疑为旧/别名域），故以现行 bot.qq.com 官方文档定档。
 *
 * ── 定档结论：官方「有」主动推送面 → 本渠道实现为「主动档」（非仅被动窗口通知档）──────────
 * ① 主动消息（无 msg_id 被动窗口）官方开放：单聊/群聊 HTTP 发消息接口不带 msg_id 即为主动消息，
 *    msg_type 0 文本可用；② 现行边界：并非「仅模板消息/被动窗口」，但主动推送受两条硬约束——
 *    (a) 平台频控（qps/qpm + 每日 1000 条/用户/群）；(b) 用户可在 QQ 客户端关闭「允许主动发送」，
 *    关闭后主动消息「一律发送失败」。二者均为平台侧「确定性拒绝」（errcode），非网络不确定。
 *    据此实现 sendTo(openid/groupOpenid) 主动档，reply 委托之；caps/诊断如实标注为「主动推送档」，
 *    频控/权限/用户开关拒绝给确定性失败 + 引导文案，不伪称无限制自由推送。
 *
 * 运行时依赖为零：只用宿主 Node≥22 全局 fetch（测试注入 fetchImpl，不发真实网络请求）。
 */
import type { ChatAddress, ChatKind } from '../engine/router.js'
import type {
  ChannelAdapter,
  ChannelCaps,
  ChannelDiagnosisCheck,
  MessageListener,
  Receipt,
} from './types.js'

/** msg_type=0 纯文本（主动/被动通用，官方 send 面 0 文本 ✅）。 */
const MSG_TEXT = 0

/**
 * 保守字节预算：官方仅有错误码 40054007「消息长度超限」而无具体字节数，公开口径约 4-5K，
 * 取小 4000 字节兜底截断；caps.maxMessageLength 交引擎分段的字符数按中文 3 字节/字折算（留余量）。
 */
const QQ_CONTENT_MAX_BYTES = 4000
const QQ_MAX_MESSAGE_CHARS = 1300

/** 主动推送确定性拒绝档 → 各自附引导文案（均取自官方群聊/单聊接口页错误码表）。 */
const ACTIVE_PUSH_HINTS: Record<number, string> = {
  40034100: '主动消息超出平台频控（qps/qpm 与每日 1000 条上限），请降频或改期再推',
  40034105: '主动消息无权限（平台侧未开通主动发言权限，或群内非管理员），请到 QQ 开放平台后台核权限',
  1100100: '用户已在 QQ 客户端关闭「允许主动发送」，主动推送一律失败，需引导用户重新开启该开关',
}

interface JsonHttpFace {
  ok: boolean
  status: number
  json(): Promise<unknown>
}
type JsonHttpCall = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<JsonHttpFace>

export interface QqNotifyAdapterOptions {
  appId: string
  /** QQ 取凭证字段名为 clientSecret；本档内部统一存为 appSecret，凭据注入两名单皆可。 */
  appSecret: string
  /** OpenAPI 基址，默认 https://api.bot.qq.com（沙箱可覆盖为 https://sandbox.api.sgroup.qq.com）。 */
  apiBase?: string
  /** 换凭证接口全 URL，默认 https://bots.qq.com/app/getAppAccessToken。 */
  tokenUrl?: string
  fetchImpl?: JsonHttpCall
  logger?: (msg: string) => void
}

/** 平台明确拒绝（errcode / 4xx / 频控 / 用户关闭主动发送）→ 确定性失败，可安全提示与改道。 */
export class QQNotifyApiError extends Error {
  readonly httpStatus: number
  readonly errCode: number

  constructor(message: string, httpStatus: number, errCode: number) {
    super(message)
    this.httpStatus = httpStatus
    this.errCode = errCode
  }
}

/** 网络异常 / 超时 / 5xx / 429 / 不可解析成功体 → 结果不确定，禁自动重发（D7）。 */
export class QQNotifyUncertainError extends Error {}

type UnknownRecord = Record<string, unknown>

const asRecord = (value: unknown): UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : {}
const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined
const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/** 抛错叙述：中止/超时与网络异常同属不确定面，文案不得回显凭据（由 scrub 兜底）。 */
const describeThrown = (error: unknown): string => {
  const name = (error as Error)?.name ?? ''
  if (name === 'AbortError') return '请求被中止或超时（平台侧结果不确定）'
  return `网络异常 ${((error as Error)?.message ?? String(error))}`
}

export class QqNotifyAdapter implements ChannelAdapter {
  readonly id = 'qq-notify'
  readonly label = 'QQ 通知（主动推送）'
  readonly caps: ChannelCaps = {
    /** 通知档不做编辑/撤回流式。 */
    editStream: false,
    /** stream_messages 增量语义未核 → 不猜。 */
    nativeStream: false,
    /** 按钮面需后台模板/回调配置 → 无（审批/提问由公共层落数字菜单回退）。 */
    nativeChoices: false,
    statusReaction: false,
    /** 纯出站通知：无交互会话，「正在输入」无意义（且需被动窗口）→ false。 */
    typing: false,
    /** 不收信（无 WS）→ 无入站附件面。 */
    imageIn: false,
    fileIn: false,
    /** 富媒体需平台侧开通 + 上传换 file_info + 日配额，本档不做。 */
    fileOut: false,
    threads: false,
    voice: false,
    maxMessageLength: QQ_MAX_MESSAGE_CHARS,
  }

  connected = false

  private readonly appId: string
  private readonly appSecret: string
  private readonly apiBase: string
  private readonly tokenUrl: string
  private readonly http: JsonHttpCall
  private readonly log: (msg: string) => void

  private readonly listeners: MessageListener[] = []
  private accessToken: string | undefined
  private tokenDueAt = 0

  constructor(options: QqNotifyAdapterOptions) {
    // 类构造保持宽容：空凭据不在构造期抛（工厂 createQqNotifyAdapter 才强制），
    // 以便 diagnose 如实报告「无凭据 → unverified」三态之一。
    this.appId = typeof options.appId === 'string' ? options.appId : ''
    this.appSecret = typeof options.appSecret === 'string' ? options.appSecret : ''
    this.apiBase = (options.apiBase ?? 'https://api.bot.qq.com').replace(/\/+$/, '')
    this.tokenUrl = options.tokenUrl ?? 'https://bots.qq.com/app/getAppAccessToken'
    this.http = options.fetchImpl ?? ((globalThis as { fetch?: JsonHttpCall }).fetch as JsonHttpCall)
    this.log = options.logger ?? (() => {})
  }

  private get hasCredentials(): boolean {
    return this.appId !== '' && this.appSecret !== ''
  }

  /** 通知档不收信：监听器登记但无事件源（维持 ChannelAdapter 契约完整，实际永不回调）。 */
  onMessage(listener: MessageListener): () => void {
    this.listeners.push(listener)
    return () => {
      const index = this.listeners.indexOf(listener)
      if (index >= 0) this.listeners.splice(index, 1)
    }
  }

  // —— 凭证与 REST ——————————————————————————————————

  /** 换 access_token 并缓存；expires_in≤7200 且期内不刷新，故提前 120s 续期。 */
  private async resolveToken(signal?: AbortSignal): Promise<string> {
    const now = Date.now()
    if (this.accessToken !== undefined && this.tokenDueAt > now) return this.accessToken
    if (!this.hasCredentials) {
      throw new QQNotifyApiError('qq-notify 取凭证: 凭据缺失（appId/clientSecret 未入库）', 0, 0)
    }
    let response: JsonHttpFace
    try {
      response = await this.http(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
        signal,
      })
    } catch (error) {
      throw new QQNotifyUncertainError(`qq-notify 取凭证: ${describeThrown(error)}`)
    }
    const payload = asRecord(await this.readBody(response))
    if (response.status >= 500 || response.status === 429) {
      throw new QQNotifyUncertainError(`qq-notify 取凭证: HTTP ${response.status}`)
    }
    if (!response.ok) {
      throw new QQNotifyApiError(
        `qq-notify 取凭证: ${this.scrub(asText(payload.message) ?? `HTTP ${response.status}`)}`,
        response.status,
        asNumber(payload.err_code ?? payload.code) ?? response.status,
      )
    }
    const token = asText(payload.access_token) ?? asText(payload.token)
    if (token === undefined) throw new QQNotifyUncertainError('qq-notify 取凭证: 回包缺 access_token（结果不确定）')
    const ttl = asNumber(payload.expires_in) ?? 7_200
    this.accessToken = token
    this.tokenDueAt = now + Math.max(60, ttl * 1000 - 120_000)
    return token
  }

  private forgetToken(): void {
    this.accessToken = undefined
    this.tokenDueAt = 0
  }

  private readBody(response: JsonHttpFace): Promise<unknown> {
    return response.json().catch(() => undefined)
  }

  /**
   * 统一 REST 面：err_code≠0 或 4xx → QQNotifyApiError（确定性）；网络/5xx/429/成功但体不可解 →
   * QQNotifyUncertainError（不确定，禁重发）。401 与凭证类错误码换发凭证后重试一次。
   */
  private async requestJson(
    path: string,
    body: UnknownRecord,
    signal?: AbortSignal,
    allowTokenRetry = true,
  ): Promise<UnknownRecord> {
    const token = await this.resolveToken(signal)
    let response: JsonHttpFace
    try {
      response = await this.http(`${this.apiBase}${path}`, {
        method: 'POST',
        headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      throw new QQNotifyUncertainError(`qq-notify POST ${path}: ${describeThrown(error)}`)
    }
    if (response.status >= 500 || response.status === 429) {
      throw new QQNotifyUncertainError(`qq-notify POST ${path}: HTTP ${response.status}`)
    }
    const raw = await this.readBody(response)
    const payload = asRecord(raw)
    const errCode = asNumber(payload.err_code ?? payload.code ?? payload.errcode)
    if (errCode !== undefined && errCode !== 0) {
      if (allowTokenRetry && this.isCredentialCode(response.status, errCode)) {
        this.forgetToken()
        return this.requestJson(path, body, signal, false)
      }
      const detail = this.scrub(asText(payload.message) ?? asText(payload.errmsg) ?? `err_code ${errCode}`)
      throw new QQNotifyApiError(`qq-notify POST ${path}: ${detail}`, response.status, errCode)
    }
    if (!response.ok) {
      if (allowTokenRetry && this.isCredentialCode(response.status, errCode ?? response.status)) {
        this.forgetToken()
        return this.requestJson(path, body, signal, false)
      }
      throw new QQNotifyApiError(
        `qq-notify POST ${path}: ${this.scrub(asText(payload.message) ?? `HTTP ${response.status}`)}`,
        response.status,
        errCode ?? response.status,
      )
    }
    if (raw === undefined) throw new QQNotifyUncertainError(`qq-notify POST ${path}: 成功状态但回包不可解析（结果不确定）`)
    return payload
  }

  /** 凭证失效一档：HTTP 401 或公共错误码 11241/11242/11243（缺 token / 校验失败 / token 错误）。 */
  private isCredentialCode(status: number, code: number): boolean {
    return status === 401 || code === 11241 || code === 11242 || code === 11243
  }

  /** 抹掉回显面里的凭据痕迹（诊断/错误文案零 secret 回显纪律）。 */
  private scrub(text: string): string {
    let out = text
    if (this.accessToken !== undefined && this.accessToken !== '') out = out.split(this.accessToken).join('***')
    if (this.appSecret !== '') out = out.split(this.appSecret).join('***')
    return out
  }

  // —— 连接（通知档：仅取凭证，不建 WS，不收信）——————————————————

  async connect(signal?: AbortSignal): Promise<void> {
    await this.resolveToken(signal)
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  // —— 出站：主动推送档 ——————————————————————————————————

  private endpoint(kind: ChatKind, id: string): string {
    const encoded = encodeURIComponent(id)
    return kind === 'group' ? `/v2/groups/${encoded}/messages` : `/v2/users/${encoded}/messages`
  }

  /**
   * 主动推送出站：不带 msg_id 即官方「主动消息」（定档依据见文件头查实结论）。
   * 频控/权限/用户关闭主动发送（errcode）→ 确定性失败 + 引导文案；网络/5xx/429 → 不确定（禁重发）。
   */
  async sendTo(target: string, text: string, kind: ChatKind = 'dm', signal?: AbortSignal): Promise<Receipt> {
    const path = this.endpoint(kind, target)
    const body: UnknownRecord = { msg_type: MSG_TEXT, content: fitByteBudget(text) }
    try {
      const payload = await this.requestJson(path, body, signal)
      const id = asText(payload.id)
      return id === undefined ? { uncertain: false } : { platformMessageId: id, uncertain: false }
    } catch (error) {
      if (error instanceof QQNotifyApiError) {
        const hint = ACTIVE_PUSH_HINTS[error.errCode]
        if (hint !== undefined) throw new QQNotifyApiError(`${error.message}。引导：${hint}`, error.httpStatus, error.errCode)
      }
      throw error
    }
  }

  /** reply 委托主动档（引擎统一出站原语；address.chatId 即 openid/group_openid）。 */
  reply(address: ChatAddress, text: string, signal?: AbortSignal): Promise<Receipt> {
    return this.sendTo(address.chatId, text, address.kind, signal)
  }

  /** 渠道内不做准入判断：白名单归网关（红线 D6），恒交回 undefined。 */
  authorize(): boolean | undefined {
    return undefined
  }

  /**
   * 诊断三态：
   * - token-endpoint：有凭据实探（passed）/ 平台拒绝（failed，确定性）/ 网络不确定（unverified）/
   *   无凭据无法实探（unverified）；
   * - active-push-quota：恒 unverified（频控与「用户可关闭主动发送」需平台侧实测，本档不谎报为可达）。
   */
  async diagnose(signal?: AbortSignal): Promise<ChannelDiagnosisCheck[]> {
    const checks: ChannelDiagnosisCheck[] = []
    const start = Date.now()
    if (!this.hasCredentials) {
      checks.push({
        name: 'token-endpoint',
        status: 'unverified',
        hint: '无凭据：appId/clientSecret 未入库，无法实探取凭证面',
        elapsedMs: 0,
      })
    } else {
      try {
        this.forgetToken()
        await this.resolveToken(signal)
        const ttl = Math.max(0, Math.round((this.tokenDueAt - Date.now()) / 1000))
        checks.push({
          name: 'token-endpoint',
          status: 'passed',
          hint: `凭证有效期剩余约 ${ttl}s`,
          elapsedMs: Date.now() - start,
        })
      } catch (error) {
        const uncertain = error instanceof QQNotifyUncertainError
        checks.push({
          name: 'token-endpoint',
          status: uncertain ? 'unverified' : 'failed',
          hint: uncertain ? '取凭证网络不确定，稍后复测' : this.scrub((error as Error).message),
          elapsedMs: Date.now() - start,
        })
      }
    }
    checks.push({
      name: 'active-push-quota',
      status: 'unverified',
      hint: '主动推送受平台频控（单聊 1000 条/用户/日、群聊 1000 条/群/日与 qps/qpm）与用户「允许主动发送」开关约束，' +
        '关闭后一律失败；真实到达需平台侧沙箱/正式群实测，本档不谎报为无条件自由推送',
    })
    return checks
  }
}

/** 按 UTF-8 字节预算安全截断（不切裂代理对），超限补省略号。 */
export function fitByteBudget(text: string, maxBytes = QQ_CONTENT_MAX_BYTES): string {
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= maxBytes) return text
  const ellipsis = '…'
  const keep = maxBytes - encoder.encode(ellipsis).length
  const cut: string[] = []
  let used = 0
  for (const char of text) {
    const size = encoder.encode(char).length
    if (used + size > keep) break
    used += size
    cut.push(char)
  }
  return `${cut.join('')}${ellipsis}`
}

/**
 * 工厂：secret 走 secrets 注入（appId 兼容 config/secrets，clientSecret 兼容 secrets.clientSecret/appSecret）；
 * 缺凭据抛校验错（红线：不装载无凭据适配器）。config 可覆盖 apiBaseUrl/tokenUrl。
 */
export function createQqNotifyAdapter(options: {
  accountId: string
  config: Record<string, string>
  secrets: Record<string, string | undefined>
}): QqNotifyAdapter {
  const appId = options.config.appId ?? options.secrets.appId
  const clientSecret = options.secrets.clientSecret ?? options.secrets.appSecret
  if (typeof appId !== 'string' || appId === '') {
    throw new Error(`qq-notify 账号 ${options.accountId}: appId 未入库（检查凭据配置）`)
  }
  if (typeof clientSecret !== 'string' || clientSecret === '') {
    throw new Error(`qq-notify 账号 ${options.accountId}: clientSecret 未入库（检查凭据配置）`)
  }
  const apiBase = options.config.apiBaseUrl
  const tokenUrl = options.config.tokenUrl
  return new QqNotifyAdapter({
    appId,
    appSecret: clientSecret,
    ...(apiBase !== undefined && apiBase !== '' ? { apiBase } : {}),
    ...(tokenUrl !== undefined && tokenUrl !== '' ? { tokenUrl } : {}),
  })
}
