/**
 * QQ（腾讯 QQ 官方机器人）渠道适配器 —— 多渠道层 T2.2。
 *
 * 净室口径：本文件按 QQ 开放平台「公开协议文档」独立实现，未参照、未复制同仓
 * 其他渠道文件的结构划分或命名。引用来源（查证于公开文档，2026-10）：
 * - 接口调用与鉴权 / 取凭证：https://bot.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html
 *   （POST /app/getAppAccessToken，体 {appId, clientSecret} → {access_token, expires_in≤7200}；
 *    生命周期内不刷新，临近过期 60s 内可换发且旧凭证在 60s 内仍可用；curl 示例域名 bots.qq.com）
 * - API 调用指南：https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html
 *   （统一地址 https://api.bot.qq.com；请求头 Authorization: `QQBot {ACCESS_TOKEN}`；
 *    失败体 {err_code, message, trace_id}；HTTP 401/404/405/429/500/504 语义；公共错误码表）
 * - 通用数据结构 / Intents：https://bot.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html
 *   （payload {id, op, d, s, t}；opCode 0/1/2/6/7/9/10/11/12/13；
 *    GROUP_AND_C2C_EVENT = 1<<25 → C2C_MESSAGE_CREATE + GROUP_AT_MESSAGE_CREATE）
 * - WebSocket 方式：https://bot.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html
 *   （先取 WSS 接入点 → op10 HELLO 给 heartbeat_interval(ms) → op2 IDENTIFY
 *    d={token:"QQBot {AT}", intents, shard:[0,1], properties} → READY(d.session_id/d.user)
 *    → op1 HEARTBEAT d=最新 s（首连 null）→ op11 ACK；op6 RESUME {token,session_id,seq}；
 *    op7 RECONNECT / op9 INVALID_SESSION；WS 错误码表 4001…4915 与可否重试）
 * - 获取通用 WSS 接入点：https://bot.qq.com/wiki/develop/api-v2/autogen/api/gateway.get.html（GET /gateway → {url}）
 * - 发送单聊消息：https://bot.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html
 *   （POST /v2/users/{user_openid}/messages；msg_type 0=纯文本 2=Markdown 6=输入中状态 7=富媒体；
 *    msg_id 从事件 d.id 取、文档口径「5 分钟内有效」；msg_seq 与 msg_id 联合去重，缺省 1；
 *    msg_type=6 体 {input_notify:{input_type:1,input_second≤60}}；响应 {id, timestamp, ext_info}）
 * - 发送群聊消息：https://bot.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
 *   （POST /v2/groups/{group_openid}/messages；群消息不支持流式参数；
 *    错误码 40034005 回复 msg_id 已过期、40054005 消息被去重、40054007 消息长度超限、
 *    40034100 主动消息超频控、40034105 主动消息无权限）
 * - 单聊消息事件：https://bot.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html
 * - 群@机器人消息：https://bot.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html
 *   （d.id/d.author.user_openid|member_openid/d.content/d.group_openid/d.timestamp(RFC3339)/
 *    d.message_type 0 文本 3 卡片 103 引用/d.attachments[]/d.msg_elements[]；content 已去 @ 前缀；
 *    mentions 不含机器人自身；「相同 msg_id 可能重复推送」需自行去重）
 * - 消息收发概述：https://bot.qq.com/wiki/develop/api-v2/server-inter/message/overview.html
 *   （被动窗口表：单聊 60 分钟/4 次、群聊 5 分钟/5 次；主动消息频控与「用户可关闭主动推送」）
 * - 富媒体：https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/rich-media.html
 *   （须先上传换 file_info，msg_type=7 携带；file_type 4=文件「暂不开放」；
 *    群/单聊上传接口不互通；40093002「超过今天发送文件容量上限」=日配额）
 * - 沙箱域名：https://bot.q.qq.com/wiki/develop/api/ （正式 api.sgroup.qq.com / 沙箱 sandbox.api.sgroup.qq.com）
 * - 接入指南（消息 URL 需后台白名单报备、IP 白名单、沙箱配置）：https://bot.qq.com/
 *
 * 「协议未核，故不实现」的面（caps 相应声明 false，详见 caps 注释）：
 * 1. 文本长度上限的具体数值：官方只给错误码 40054007「消息长度超限」，未公布字节数 → 保守字节预算兜底。
 * 2. 原生流式 POST /v2/users/{openid}/stream_messages：接口存在（autogen 索引可查），但增量语义/
 *    参数/失败面未细核 → nativeStream=false，不猜实现。
 * 3. 编辑/撤回（PATCH/DELETE .../messages/{id}）：群聊撤回路径未逐面核实 → editStream=false。
 * 4. keyboard 按钮面（需后台模板/回调配置 + INTERACTION_CREATE 链路）→ nativeChoices=false，
 *    审批/提问由公共层自动落「数字菜单」回退，本适配器无按钮实现。
 * 5. 入站附件下载（attachments[].url 带 rkey 时效，语音/文件下载权限未核）→ imageIn=false、fileIn=false，
 *    只给占位文案，不丢事件。
 * 6. 出站富媒体（须换 file_info + 日配额 40093002 + file_type=4「暂不开放」）→ fileOut=false。
 * 7. 频道（guild/子频道/私信）事件与 REST、语音 AUDIO_* 位、表情表态是否对群/C2C 开放 → 均不实现
 *    （threads=false、voice=false、statusReaction=false）。
 * 8. webhook 回调模式（op12/op13）与多分片（shard>1）：只走 WS 长连接单分片 [0,1]。
 * 9. message_scene.ext 中 auth_token 的鉴权用途：未核，不伪使用。
 *
 * 运行时依赖为零：Node≥22 全局 fetch/WebSocket（宿主 engines 已锁）；测试全量注入
 * fetchImpl/SocketImpl，不发真实网络请求。
 */
import type { ChatAddress } from '../engine/router.js'
import type {
  ChannelAdapter,
  ChannelCaps,
  ChannelDiagnosisCheck,
  MessageListener,
  Receipt,
  SemanticMessage,
} from './types.js'

/** 群/C2C 事件族（1<<25）：C2C_MESSAGE_CREATE + GROUP_AT_MESSAGE_CREATE。 */
export const QQ_INTENTS_GROUP_AND_C2C = 1 << 25

/** 帧 opcode（协议值固定，语义见 websocket.html）。 */
const FRAME = {
  event: 0,
  beat: 1,
  login: 2,
  resume: 6,
  shift: 7,
  invalid: 9,
  greet: 10,
  beatAck: 11,
} as const

/** msg_type：0=纯文本(content)、6=输入中状态(input_notify)。 */
const MSG_TEXT = 0
const MSG_TYPING = 6

/**
 * 保守字节预算：官方仅有错误码 40054007「消息长度超限」而无具体数值（协议未核，见文件头 1），
 * 公开文档口径约 4-5K 字节，取小 4000 字节兜底截断；caps.maxMessageLength 交给引擎分段的
 * 字符数按中文 3 字节/字折算（4000/3≈1333，取 1300 留余量）。
 */
const QQ_CONTENT_MAX_BYTES = 4000
const QQ_MAX_MESSAGE_CHARS = 1300

/**
 * 主动/被动消息窗口语义（文件头 overview 与接口页冲突，保守取小）：
 * - 被动回复 = 请求体带 msg_id（取自入站事件 d.id）+ msg_seq；窗口内才允许回；
 *   msg_id「5 分钟内有效」（接口页），概述页写单聊 60 分钟/4 次、群聊 5 分钟/5 次 → 取 5 分钟/4 次；
 * - 相同 msg_id + msg_seq 重复发送会失败（40054005 消息被去重）→ 每次成功消费递增 seq；
 * - 窗口过期/次数耗尽后不再带 msg_id，退化为主动消息：受 Bot 维度与单关系维度频控，
 *   且 QQ 客户端可关闭「允许主动发送」→ 平台返回确定性拒绝（40034100/40034105/1100100），
 *   不属网络不确定，故不吞、直接抛（引擎据 Receipt 语义处理）。
 */
const PASSIVE_WINDOW_MS = 5 * 60_000
const PASSIVE_MAX_USES = 4

const HEARTBEAT_FALLBACK_MS = 45_000
const SEEN_EVENT_CAP = 512

/** WS 关闭码中「不可重试 IDENTIFY/RESUME」的一档（websocket.html 错误码表）。 */
const FATAL_CLOSE_CODES = new Set([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915])

interface JsonHttpFace {
  ok: boolean
  status: number
  json(): Promise<unknown>
}
type JsonHttpCall = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<JsonHttpFace>

interface SocketFace {
  send(data: string): void
  close(): void
  addEventListener(type: string, handler: (event: SocketEventFace) => void): void
  readyState?: number
}
interface SocketEventFace {
  data?: unknown
  code?: number
  reason?: string
}
type SocketDial = (url: string) => SocketFace

export interface QqAdapterOptions {
  appId: string
  appSecret: string
  /** OpenAPI 基址，默认 https://api.bot.qq.com（沙箱可覆盖为 https://sandbox.api.sgroup.qq.com）。 */
  apiBase?: string
  /** 换凭证接口全 URL，默认 https://bots.qq.com/app/getAppAccessToken。 */
  tokenUrl?: string
  fetchImpl?: JsonHttpCall
  SocketImpl?: SocketDial
  logger?: (msg: string) => void
  /** 下列三项为测试/调参面，默认取协议保守值。 */
  passiveWindowMs?: number
  passiveMaxUses?: number
  reconnectDelayMs?: number
}

/** 平台明确拒绝（errcode / 4xx / 窗口过期）→ 确定性失败，可安全提示与改道。 */
export class QQApiError extends Error {
  readonly httpStatus: number
  readonly errCode: number

  constructor(message: string, httpStatus: number, errCode: number) {
    super(message)
    this.httpStatus = httpStatus
    this.errCode = errCode
  }
}

/** 网络异常 / 超时 / 5xx / 429 / 不可解析成功体 → 结果不确定，Receipt.uncertain=true，引擎禁自动重发。 */
export class QQUncertainError extends Error {}

interface QqWindow {
  msgId: string
  dueAt: number
  used: number
  seq: number
}

type UnknownRecord = Record<string, unknown>

const asRecord = (value: unknown): UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : {}
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined
const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}
const asFlag = (value: unknown): boolean => value === true

/** 抛错叙述：中止/超时与网络异常同属不确定面，文案不得回显凭据（由调用侧 scrub 兜底）。 */
const describeThrown = (error: unknown): string => {
  const name = (error as Error)?.name ?? ''
  if (name === 'AbortError') return '请求被中止或超时（平台侧结果不确定）'
  return `网络异常 ${((error as Error)?.message ?? String(error))}`
}

export class QqAdapter implements ChannelAdapter {
  readonly id = 'qq'
  readonly label = 'QQ'
  readonly caps: ChannelCaps = {
    /** 编辑流式：撤回/编辑路径未逐面核实 → 不做（文件头 3）。 */
    editStream: false,
    /** stream_messages 接口存在但语义未核 → 不猜（文件头 2）。 */
    nativeStream: false,
    /** 无按钮面：审批/提问由公共层自动落数字菜单回退（文件头 4）。 */
    nativeChoices: false,
    statusReaction: false,
    /** 输入中提示仅有单聊 msg_type=6；群聊文档明列 0/2/7，无此档 → 群内静默。 */
    typing: true,
    /** 附件下载面（rkey 时效/权限）未核 → 只给占位文案，不丢事件（文件头 5）。 */
    imageIn: false,
    fileIn: false,
    /** 富媒体需平台侧开通 + 日配额，首版不做（文件头 6）。 */
    fileOut: false,
    /** 频道/子频道模型不在本渠道范围（文件头 7）。 */
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
  private readonly dial: SocketDial
  private readonly log: (msg: string) => void
  private readonly windowMs: number
  private readonly maxPassiveUses: number
  private readonly reconnectDelayMs: number

  private listeners: MessageListener[] = []
  private accessToken: string | undefined
  private tokenDueAt = 0
  private socket: SocketFace | undefined
  private gatewayUrl = ''
  private sessionId: string | undefined
  private lastSeq: number | undefined
  private botUserId = ''
  private preferResume = false
  private beatTimer: ReturnType<typeof setInterval> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private shuttingDown = false
  private readonly windows = new Map<string, QqWindow>()
  private readonly seen: string[] = []

  constructor(options: QqAdapterOptions) {
    if (typeof options.appId !== 'string' || options.appId === '') {
      throw new Error('qq: appId 缺失（凭据库未入库或账号配置为空）')
    }
    if (typeof options.appSecret !== 'string' || options.appSecret === '') {
      throw new Error('qq: appSecret 缺失（凭据库未入库或账号配置为空）')
    }
    this.appId = options.appId
    this.appSecret = options.appSecret
    this.apiBase = (options.apiBase ?? 'https://api.bot.qq.com').replace(/\/+$/, '')
    this.tokenUrl = options.tokenUrl ?? 'https://bots.qq.com/app/getAppAccessToken'
    this.http = options.fetchImpl ?? ((globalThis as { fetch?: JsonHttpCall }).fetch as JsonHttpCall)
    const globalSocket = (globalThis as { WebSocket?: { new (url: string): SocketFace } }).WebSocket
    this.dial =
      options.SocketImpl ??
      ((url: string) => {
        if (globalSocket === undefined) throw new Error('qq: 宿主 Node 运行时缺全局 WebSocket，无法建网关长连接')
        return new globalSocket(url)
      })
    this.log = options.logger ?? (() => {})
    this.windowMs = options.passiveWindowMs ?? PASSIVE_WINDOW_MS
    this.maxPassiveUses = options.passiveMaxUses ?? PASSIVE_MAX_USES
    this.reconnectDelayMs = options.reconnectDelayMs ?? 3_000
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  // —— 凭证与 REST ——————————————————————————————————

  /** 换 access_token 并缓存；文档口径 expires_in≤7200s 且期内不刷新，故提前 120s 续期。 */
  private async resolveToken(signal?: AbortSignal): Promise<string> {
    const now = Date.now()
    if (this.accessToken !== undefined && this.tokenDueAt > now) return this.accessToken
    let response: JsonHttpFace
    try {
      response = await this.http(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
        signal,
      })
    } catch (error) {
      throw new QQUncertainError(`qq 取凭证: ${describeThrown(error)}`)
    }
    const payload = asRecord(await this.readBody(response))
    if (response.status >= 500 || response.status === 429) {
      throw new QQUncertainError(`qq 取凭证: HTTP ${response.status}`)
    }
    if (!response.ok) {
      throw new QQApiError(
        `qq 取凭证: ${this.scrub(asText(payload.message) ?? `HTTP ${response.status}`)}`,
        response.status,
        asNumber(payload.err_code ?? payload.code) ?? response.status,
      )
    }
    const token = asText(payload.access_token) ?? asText(payload.token)
    if (token === undefined) throw new QQUncertainError('qq 取凭证: 回包缺 access_token（结果不确定）')
    const ttl = asNumber(payload.expires_in) ?? 7_200
    this.accessToken = token
    this.tokenDueAt = now + Math.max(60, ttl * 1000 - 120_000)
    this.preferResume = false
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
   * 统一 REST 面：err_code≠0 或 4xx → QQApiError（确定性）；网络/5xx/429/成功但体不可解 →
   * QQUncertainError（不确定，禁重发）。401 与凭证类错误码换发凭证后重试一次（不重复消费窗口 seq）。
   */
  private async requestJson(
    method: 'GET' | 'POST',
    path: string,
    body?: UnknownRecord,
    signal?: AbortSignal,
    allowTokenRetry = true,
  ): Promise<UnknownRecord> {
    const token = await this.resolveToken(signal)
    let response: JsonHttpFace
    try {
      response = await this.http(`${this.apiBase}${path}`, {
        method,
        headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      })
    } catch (error) {
      throw new QQUncertainError(`qq ${method} ${path}: ${describeThrown(error)}`)
    }
    if (response.status >= 500 || response.status === 429) {
      throw new QQUncertainError(`qq ${method} ${path}: HTTP ${response.status}`)
    }
    const raw = await this.readBody(response)
    const payload = asRecord(raw)
    const errCode = asNumber(payload.err_code ?? payload.code ?? payload.errcode)
    if (errCode !== undefined && errCode !== 0) {
      if (allowTokenRetry && this.isCredentialCode(response.status, errCode)) {
        this.forgetToken()
        return this.requestJson(method, path, body, signal, false)
      }
      const detail = this.scrub(asText(payload.message) ?? asText(payload.errmsg) ?? `err_code ${errCode}`)
      throw new QQApiError(`qq ${method} ${path}: ${detail}`, response.status, errCode)
    }
    if (!response.ok) {
      if (allowTokenRetry && this.isCredentialCode(response.status, errCode ?? response.status)) {
        this.forgetToken()
        return this.requestJson(method, path, body, signal, false)
      }
      throw new QQApiError(
        `qq ${method} ${path}: ${this.scrub(asText(payload.message) ?? `HTTP ${response.status}`)}`,
        response.status,
        errCode ?? response.status,
      )
    }
    if (raw === undefined) throw new QQUncertainError(`qq ${method} ${path}: 成功状态但回包不可解析（结果不确定）`)
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

  // —— 网关长连接 ——————————————————————————————————

  async connect(signal?: AbortSignal): Promise<void> {
    await this.resolveToken(signal)
    const greet = await this.requestJson('GET', '/gateway', undefined, signal)
    this.gatewayUrl = asText(greet.url) ?? this.deriveSocketUrl()
    this.shuttingDown = false
    this.openSocket()
  }

  private deriveSocketUrl(): string {
    return this.apiBase.startsWith('https://') ? `wss://${this.apiBase.slice('https://'.length)}/websocket` : `${this.apiBase}/websocket`
  }

  private openSocket(): void {
    const socket = this.dial(this.gatewayUrl)
    this.socket = socket
    socket.addEventListener('message', (event) => this.onFrame(String(event.data ?? '')))
    socket.addEventListener('close', (event) => this.onSocketClosed(event.code))
    socket.addEventListener('error', () => {
      this.connected = false
    })
  }

  private onSocketClosed(code: number | undefined): void {
    if (this.socket === undefined) return
    this.socket = undefined
    this.connected = false
    this.stopBeat()
    if (this.shuttingDown) return
    if (code !== undefined && FATAL_CLOSE_CODES.has(code)) {
      this.log(`qq 网关关闭码 ${code}（不可重连：需人工核对 intents 权限/机器人状态）`)
      return
    }
    if (code === 4006 || code === 4007) this.preferResume = false
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== undefined) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.rebuild()
    }, this.reconnectDelayMs)
  }

  /** 重连：换新 socket；HELLO 后按 preferResume 决定 RESUME 或 IDENTIFY。 */
  private async rebuild(): Promise<void> {
    if (this.shuttingDown || this.socket !== undefined) return
    try {
      await this.resolveToken()
      this.openSocket()
    } catch (error) {
      this.log(`qq 重连取凭证失败: ${(error as Error).message}`)
      this.scheduleRetry()
    }
  }

  private onFrame(raw: string): void {
    let frame: UnknownRecord
    try {
      frame = asRecord(JSON.parse(raw))
    } catch {
      this.log('qq 网关帧不可解析（丢弃）')
      return
    }
    const op = asNumber(frame.op)
    const seq = asNumber(frame.s)
    if (seq !== undefined) this.lastSeq = seq
    switch (op) {
      case FRAME.greet: {
        const interval = asNumber(asRecord(frame.d).heartbeat_interval) ?? HEARTBEAT_FALLBACK_MS
        this.startBeat(interval)
        this.handshake()
        return
      }
      case FRAME.beat:
        // 服务端也可主动下发心跳要求（payload.html：op1 客户端行为 Send/Receive）。
        this.writeFrame({ op: FRAME.beat, d: this.lastSeq ?? null })
        return
      case FRAME.beatAck:
        return
      case FRAME.shift:
        this.log('qq 网关要求重连（op7）')
        this.dropSocket()
        this.preferResume = false
        void this.rebuild()
        return
      case FRAME.invalid: {
        this.connected = false
        this.stopBeat()
        this.preferResume = asFlag(frame.d) && this.sessionId !== undefined
        this.log(`qq 会话失效（op9，d=${String(frame.d)}），按 ${this.preferResume ? 'RESUME' : 'IDENTIFY'} 重建`)
        this.handshake()
        return
      }
      case FRAME.event: {
        const type = asText(frame.t)
        if (type === 'READY') {
          this.connected = true
          const data = asRecord(frame.d)
          this.sessionId = asText(data.session_id)
          const user = asRecord(data.user)
          this.botUserId = asText(user.id) ?? ''
          this.preferResume = true
          return
        }
        if (type === 'RESUMED') {
          this.connected = true
          return
        }
        if (type === 'C2C_MESSAGE_CREATE' || type === 'GROUP_AT_MESSAGE_CREATE') {
          const message = this.normalize(type, frame)
          if (message !== undefined) {
            this.rememberWindow(type, frame, message)
            for (const listener of this.listeners) listener(message)
          }
        }
        return
      }
      default:
        return
    }
  }

  private handshake(): void {
    if (this.preferResume && this.sessionId !== undefined && this.lastSeq !== undefined) {
      this.writeFrame({
        op: FRAME.resume,
        d: { token: `QQBot ${this.accessToken ?? ''}`, session_id: this.sessionId, seq: this.lastSeq },
      })
      return
    }
    if (this.accessToken === undefined) {
      // 断连期间凭证过期：异步换发后再 IDENTIFY，不阻塞帧循环。
      void this.resolveToken()
        .then(() => this.loginFrame())
        .catch((error: Error) => this.log(`qq IDENTIFY 前置取凭证失败: ${error.message}`))
      return
    }
    this.loginFrame()
  }

  private loginFrame(): void {
    this.writeFrame({
      op: FRAME.login,
      d: {
        token: `QQBot ${this.accessToken ?? ''}`,
        intents: QQ_INTENTS_GROUP_AND_C2C,
        shard: [0, 1],
        properties: { $os: 'win32', $browser: 'dsh-im-union', $device: 'dsh-im-union' },
      },
    })
  }

  private startBeat(intervalMs: number): void {
    this.stopBeat()
    this.beatTimer = setInterval(() => this.writeFrame({ op: FRAME.beat, d: this.lastSeq ?? null }), intervalMs)
  }

  private stopBeat(): void {
    if (this.beatTimer !== undefined) {
      clearInterval(this.beatTimer)
      this.beatTimer = undefined
    }
  }

  private writeFrame(payload: UnknownRecord): void {
    try {
      this.socket?.send(JSON.stringify(payload))
    } catch (error) {
      this.log(`qq 网关发送失败: ${this.scrub((error as Error).message)}`)
    }
  }

  private dropSocket(): void {
    const socket = this.socket
    this.socket = undefined
    try {
      socket?.close()
    } catch {
      // 已断开即目标达成。
    }
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true
    this.stopBeat()
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
    this.dropSocket()
    this.connected = false
  }

  // —— 入站归一 ——————————————————————————————————

  /**
   * C2C/GROUP_AT 事件 → SemanticMessage。
   * 丢弃条件：缺 d/缺消息 id；author.bot=true 或 author.id 等于 READY 的机器人 id（回声）；
   * 相同消息 id 重复推送（协议明载「相同 msg_id 可能重复推送」，按 d.id 去重）。
   */
  normalize(type: string, frame: UnknownRecord): SemanticMessage | undefined {
    const data = asRecord(frame.d)
    const messageId = asText(data.id)
    if (messageId === undefined) return undefined
    const author = asRecord(data.author)
    if (asFlag(author.bot)) return undefined
    const authorId = asText(author.id)
    if (this.botUserId !== '' && authorId !== undefined && authorId === this.botUserId) return undefined
    if (this.duplicate(`${type}:${messageId}`)) return undefined

    const group = type === 'GROUP_AT_MESSAGE_CREATE'
    const chatId = group ? asText(data.group_openid) : asText(author.user_openid) ?? authorId
    if (chatId === undefined) return undefined
    const address: ChatAddress = { channel: 'qq', kind: group ? 'group' : 'dm', chatId }
    const semantic: SemanticMessage = {
      address,
      userId: String(group ? asText(author.member_openid) ?? authorId ?? chatId : authorId ?? chatId),
      userDisplayName: asText(author.username),
      text: this.inboundText(data),
      // 群事件只有 GROUP_AT_MESSAGE_CREATE（@ 机器人才回调）→ 协议事实即 mentionedBot=true；
      // 单聊无 @ 语义，置 false（DM 判定归网关白名单）。
      mentionedBot: group,
      quoteText: this.quoteOf(data),
      timestamp: this.timeOf(data.timestamp),
    }
    return semantic
  }

  /** 富文本/卡片/附件入站给占位文案而不丢事件（caps.imageIn/fileIn=false，不下载字节）。 */
  private inboundText(data: UnknownRecord): string {
    const content = asText(data.content)
    if (content !== undefined && content.trim() !== '') return content
    const attachments = asList(data.attachments)
    if (attachments.length > 0) {
      const kinds: string[] = []
      for (const item of attachments) {
        const face = asRecord(item)
        const mime = asText(face.content_type) ?? ''
        if (mime.startsWith('image/')) kinds.push('图片')
        else if (mime === 'voice' || asText(face.voice_wav_url) !== undefined) kinds.push('语音')
        else if (mime.startsWith('video/')) kinds.push('视频')
        else kinds.push('附件')
      }
      const unique = [...new Set(kinds)]
      return `[${unique.join('+')}${attachments.length > 1 ? `×${attachments.length}` : ''}]`
    }
    const ark = asRecord(data.ark_data)
    if (Object.keys(ark).length > 0) return `[卡片消息${asText(ark.ark_name) !== undefined ? ` ${asText(ark.ark_name)}` : ''}]`
    if (asList(data.msg_elements).length > 0) return '[引用消息]'
    return '[空消息]'
  }

  /** message_type=103 引用消息：被引用正文在 msg_elements[0].content（协议可据）。 */
  private quoteOf(data: UnknownRecord): string | undefined {
    if (asNumber(data.message_type) !== 103) return undefined
    const first = asRecord(asList(data.msg_elements)[0])
    return asText(first.content)
  }

  private timeOf(value: unknown): number | undefined {
    const text = asText(value)
    if (text === undefined) return undefined
    const parsed = Date.parse(text)
    return Number.isNaN(parsed) ? undefined : parsed
  }

  private duplicate(key: string): boolean {
    if (this.seen.includes(key)) return true
    this.seen.push(key)
    if (this.seen.length > SEEN_EVENT_CAP) this.seen.splice(0, this.seen.length - SEEN_EVENT_CAP)
    return false
  }

  /** 入站即记录被动回复窗口（消息 id + 到期时刻 + 已用次数/序号）。 */
  private rememberWindow(_type: string, frame: UnknownRecord, message: SemanticMessage): void {
    const data = asRecord(frame.d)
    const messageId = asText(data.id)
    if (messageId === undefined) return
    const key = `${message.address.kind}:${message.address.chatId}`
    const previous = this.windows.get(key)
    this.windows.set(key, {
      msgId: messageId,
      dueAt: Date.now() + this.windowMs,
      used: 0,
      // 不同 msg_id 起点为 1；同一 msg_id 重复推送已被去重，不在此续用。
      seq: previous?.msgId === messageId ? previous.seq : 0,
    })
    if (this.windows.size > 256) {
      const oldest = this.windows.keys().next().value
      if (oldest !== undefined && oldest !== key) this.windows.delete(oldest)
    }
  }

  private liveWindow(address: ChatAddress): QqWindow | undefined {
    const key = `${address.kind}:${address.chatId}`
    const entry = this.windows.get(key)
    if (entry === undefined) return undefined
    if (entry.dueAt <= Date.now() || entry.used >= this.maxPassiveUses) {
      this.windows.delete(key)
      return undefined
    }
    return entry
  }

  // —— 出站 ——————————————————————————————————

  private endpoint(address: ChatAddress): string {
    const id = encodeURIComponent(address.chatId)
    return address.kind === 'group' ? `/v2/groups/${id}/messages` : `/v2/users/${id}/messages`
  }

  /**
   * 文本出站：msg_type=0（官方文档口径；台账原文写 1，以公开文档为准，见文件头接口页引用）。
   * 窗口内带 msg_id+msg_seq（被动回复），否则为主动消息（无 msg_id）。
   */
  async reply(address: ChatAddress, text: string, signal?: AbortSignal): Promise<Receipt> {
    const body: UnknownRecord = { msg_type: MSG_TEXT, content: fitByteBudget(text) }
    const entry = this.liveWindow(address)
    if (entry !== undefined) {
      entry.used += 1
      entry.seq += 1
      body.msg_id = entry.msgId
      body.msg_seq = entry.seq
    }
    let payload: UnknownRecord
    try {
      payload = await this.requestJson('POST', this.endpoint(address), body, signal)
    } catch (error) {
      if (error instanceof QQApiError && isWindowReject(error.errCode)) {
        // msg_id 过期/去重/被动超限：确定性失败，原样上抛，但清空窗口避免后续重复撞墙。
        this.windows.delete(`${address.kind}:${address.chatId}`)
      }
      throw error
    }
    const id = asText(payload.id)
    return id === undefined ? { uncertain: false } : { platformMessageId: id, uncertain: false }
  }

  /**
   * 「正在输入」：单聊 msg_type=6 的 input_notify 档（协议可据）；群聊无该档 → 静默返回。
   * 状态通知同样消耗 msg_seq（相同 msg_id+msg_seq 会被判重复），但不占被动回复额度。
   * 失败一律吞：typing 属装饰面，不得影响主回复链。
   */
  async setTyping(address: ChatAddress): Promise<void> {
    if (address.kind !== 'dm') return
    const body: UnknownRecord = { msg_type: MSG_TYPING, input_notify: { input_type: 1, input_second: 30 } }
    const entry = this.liveWindow(address)
    if (entry !== undefined) {
      entry.seq += 1
      body.msg_id = entry.msgId
      body.msg_seq = entry.seq
    }
    try {
      await this.requestJson('POST', this.endpoint(address), body)
    } catch (error) {
      if (error instanceof QQUncertainError) return
      this.log(`qq typing 通知失败（忽略）: ${this.scrub((error as Error).message)}`)
    }
  }

  /** 渠道内不做准入判断：白名单归网关（红线 D6），恒交回 undefined。 */
  authorize(): boolean | undefined {
    return undefined
  }

  /**
   * 诊断三态：token 面实探（只回显有效期，零 secret）；gateway 会话位；
   * roundtrip（真实收发闭环）恒 unverified；富媒体能力 unverified（平台侧开通/日配额）。
   */
  async diagnose(signal?: AbortSignal): Promise<ChannelDiagnosisCheck[]> {
    const checks: ChannelDiagnosisCheck[] = []
    const start = Date.now()
    try {
      this.forgetToken()
      await this.resolveToken(signal)
      const ttl = Math.max(0, Math.round((this.tokenDueAt - Date.now()) / 1000))
      checks.push({ name: 'token-endpoint', status: 'passed', hint: `凭证有效期剩余约 ${ttl}s`, elapsedMs: Date.now() - start })
    } catch (error) {
      const uncertain = error instanceof QQUncertainError
      checks.push({
        name: 'token-endpoint',
        status: uncertain ? 'unverified' : 'failed',
        hint: uncertain ? '取凭证网络不确定，稍后复测' : this.scrub((error as Error).message),
        elapsedMs: Date.now() - start,
      })
    }
    checks.push({
      name: 'gateway-session',
      status: this.connected ? 'passed' : 'unverified',
      hint: this.connected ? `seq=${this.lastSeq ?? 'n/a'}（intents=1<<25）` : '网关未就绪',
    })
    checks.push({
      name: 'send-roundtrip',
      status: 'unverified',
      hint: '真实收发闭环需平台侧沙箱群/沙箱账号验证；被动窗口（5 分钟内、≤4 次）与主动消息频控需实测',
    })
    checks.push({
      name: 'rich-media-capability',
      status: 'unverified',
      hint: '富媒体需平台侧开通能力：图片/视频/语音须先上传换 file_info，file_type=4 文件暂不开放，且有日容量上限（40093002）',
    })
    return checks
  }
}

/** 被动窗口类拒绝码（均取自官方群聊/单聊接口页错误码表）：msg_id 过期或无效、event_id 过期/不支持回复、
 * 被动回复时间或次数超限、msg_id+msg_seq 去重（40054005）。均为平台明确拒绝 → 确定性失败。 */
function isWindowReject(errCode: number): boolean {
  return (
    errCode === 40034005 ||
    errCode === 40034024 ||
    errCode === 40034026 ||
    errCode === 40034027 ||
    errCode === 40034128 ||
    errCode === 40054005 ||
    errCode === 304103
  )
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

/** 工厂：secrets 取 meta(qq) 字段名 appId/appSecret；config 可覆盖 apiBaseUrl/tokenUrl。 */
export function createQqAdapter(options: {
  accountId: string
  config: Record<string, string>
  secrets: Record<string, string | undefined>
}): QqAdapter {
  const appId = options.secrets.appId
  const appSecret = options.secrets.appSecret
  if (typeof appId !== 'string' || appId === '') {
    throw new Error(`qq 账号 ${options.accountId}: appId 未入库（检查凭据配置）`)
  }
  if (typeof appSecret !== 'string' || appSecret === '') {
    throw new Error(`qq 账号 ${options.accountId}: appSecret 未入库（检查凭据配置）`)
  }
  const apiBase = options.config.apiBaseUrl
  const tokenUrl = options.config.tokenUrl
  return new QqAdapter({
    appId,
    appSecret,
    ...(apiBase !== undefined && apiBase !== '' ? { apiBase } : {}),
    ...(tokenUrl !== undefined && tokenUrl !== '' ? { tokenUrl } : {}),
  })
}
