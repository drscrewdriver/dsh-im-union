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
 * 5. 入站附件下载（P3/F3 已实现图片/文件档）：attachments[].url 带 rkey 时效 → 事件到达即下载填
 *    images[]/files[]；content_type 群聊图片实测为 'file' → 兼用 URL 形态判定；下载失败/过期/无 arrayBuffer
 *    面 → 按占位文案不丢事件。语音（voice=false）不解码，取事件原生 asr_refer_text 转写（见 inboundText）。
 * 6. 出站富媒体（P1/F1 已实现图片档）：先上传换 file_info、msg_type=7 携带；file_type=4 文件官方
 *    「暂不开放」→ 仅图片（png/jpeg/gif/webp）可发，非图片优雅拒绝；日配额 40093002、file_info 过期 304080
 *    均确定性转译。群/单聊上传接口不互通 → 按 address.kind 选端点。
 * 7. 频道（guild/子频道/私信）事件与 REST、语音 AUDIO_* 位、表情表态是否对群/C2C 开放 → 均不实现
 *    （threads=false、voice=false、statusReaction=false）。
 * 8. webhook 回调模式（op12/op13）与多分片（shard>1）：只走 WS 长连接单分片 [0,1]。
 * 9. message_scene.ext 中 auth_token 的鉴权用途：未核，不伪使用。
 *
 * 运行时依赖为零：Node≥22 全局 fetch/WebSocket（宿主 engines 已锁）；测试全量注入
 * fetchImpl/SocketImpl，不发真实网络请求。
 */
import type { ChatAddress } from '../engine/router.js'
import { createHash } from 'node:crypto'
import type {
  ChannelAdapter,
  ChannelCaps,
  ChannelDiagnosisCheck,
  MessageListener,
  OutboundFile,
  Receipt,
  SemanticMessage,
} from './types.js'

import { QQ_GROUP_FEATURE_GATES, qqGroupErrHuman } from './qq-group-admin.js'
import type { QqGroupResult } from './qq-group-admin.js'

/** 群/C2C 事件族（1<<25）：C2C_MESSAGE_CREATE + GROUP_AT_MESSAGE_CREATE。 */
export const QQ_INTENTS_GROUP_AND_C2C = 1 << 25
/** 交互事件族（INTERACTION_CREATE，1<<26）：仅在 config 开 keyboard 时订阅（无权限会致 IDENTIFY 拒载）。 */
export const QQ_INTENTS_INTERACTION = 1 << 26

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

/** msg_type：0=纯文本(content)、2=Markdown(markdown.content)、6=输入中状态(input_notify)、7=富媒体(image/file/video)。 */
const MSG_TEXT = 0
const MSG_MARKDOWN = 2
const MSG_TYPING = 6
/** 富媒体消息档（官方 0/2/7 之一）；图片经上传换 file_info 后置于 image 字段。 */
const MSG_RICH_MEDIA = 7
/** 上传 file_type：1=图片（png/jpeg/gif/webp 白名单）；2 视频/3 语音/4 文件官方未开放或超出本轮范围。 */
const QQ_FILE_TYPE_IMAGE = 1

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
/** askChoices 按钮等待回包超时（与被动回复窗口同量级 5 分钟）；超时按取消（D5：空答不伪装批准）。 */
const QQ_CHOICE_TIMEOUT_MS = 5 * 60_000

/** WS 关闭码中「不可重试 IDENTIFY/RESUME」的一档（websocket.html 错误码表）。 */
const FATAL_CLOSE_CODES = new Set([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915])

interface JsonHttpFace {
  ok: boolean
  status: number
  json(): Promise<unknown>
  /** 入站附件下载用（P3/F3）：全局 fetch 的 Response 自带；测试替身缺位则视为不可下载、优雅跳过。 */
  arrayBuffer?(): Promise<ArrayBuffer>
}
type JsonHttpCall = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | FormData | Uint8Array; signal?: AbortSignal },
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
  /** 开启 keyboard 按钮面（审批/提问）：订阅 INTERACTION intent + nativeChoices 置真；默认关（零风险）。 */
  enableKeyboard?: boolean
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

/** askChoices 一次待决按钮：选项标签 + 发起者（D5）+ 结算回调 + 超时器。 */
interface QqPendingChoice {
  labels: string[]
  ownerUserId?: string
  resolve: (answer: string) => void
  timer: ReturnType<typeof setTimeout>
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
    /** 入站图片/文件已实装（P3/F3：事件附件 rkey 即时下载填 images/files；失败/过期按占位不丢事件）。 */
    imageIn: true,
    fileIn: true,
    /** 出站图片已实装（sendFile：上传换 file_info→msg_type=7）；非图片优雅拒绝（文件档官方未开放）。 */
    fileOut: true,
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
  private readonly pendingChoice = new Map<string, QqPendingChoice>()
  /** 入站派发串行链：保证按到达顺序派发（附件消息先下好字节再发，不越过后续消息）。 */
  private dispatchTail: Promise<void> = Promise.resolve()
  private readonly enableKeyboard: boolean

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
    // E1 档位声明=实际模式：仅当订阅了 INTERACTION intent 才声明 nativeChoices，否则引擎自动落数字菜单。
    this.enableKeyboard = options.enableKeyboard === true
    if (this.enableKeyboard) this.caps.nativeChoices = true
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
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT',
    path: string,
    body?: UnknownRecord,
    signal?: AbortSignal,
    allowTokenRetry = true,
    expectBody = true,
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
        return this.requestJson(method, path, body, signal, false, expectBody)
      }
      const detail = this.scrub(asText(payload.message) ?? asText(payload.errmsg) ?? `err_code ${errCode}`)
      throw new QQApiError(`qq ${method} ${path}: ${detail}`, response.status, errCode)
    }
    if (!response.ok) {
      if (allowTokenRetry && this.isCredentialCode(response.status, errCode ?? response.status)) {
        this.forgetToken()
        return this.requestJson(method, path, body, signal, false, expectBody)
      }
      throw new QQApiError(
        `qq ${method} ${path}: ${this.scrub(asText(payload.message) ?? `HTTP ${response.status}`)}`,
        response.status,
        errCode ?? response.status,
      )
    }
    if (raw === undefined) {
      if (expectBody) throw new QQUncertainError(`qq ${method} ${path}: 成功状态但回包不可解析（结果不确定）`)
      return {}
    }
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
        if (type === 'INTERACTION_CREATE') {
          this.handleInteraction(asRecord(frame.d))
          return
        }
        if (type === 'C2C_MESSAGE_CREATE' || type === 'GROUP_AT_MESSAGE_CREATE') {
          const message = this.normalize(type, frame)
          if (message !== undefined) {
            this.rememberWindow(type, frame, message)
            this.dispatchInbound(asRecord(frame.d), message)
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
        intents: QQ_INTENTS_GROUP_AND_C2C | (this.enableKeyboard ? QQ_INTENTS_INTERACTION : 0),
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
    for (const held of this.pendingChoice.values()) {
      clearTimeout(held.timer)
      held.resolve('')
    }
    this.pendingChoice.clear()
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
   * 文本出站：默认 msg_type=0（官方文档口径）。含 markdown 图片内嵌（`![` 或 `qqbot-media://`）时
   * 走 msg_type=2（markdown 通道才渲染图）；若 markdown 档被平台确定性拒绝（未开通/体不符）且非窗口类
   * 拒绝，降级重发一次纯文本（协议安全：纯文本通道总是可用）。窗口内带 msg_id+msg_seq，每次 HTTP 尝试递增 seq 防撞去重。
   */
  async reply(address: ChatAddress, text: string, signal?: AbortSignal): Promise<Receipt> {
    const content = fitByteBudget(text)
    const wantMarkdown = looksLikeRichMarkdown(content)
    const entry = this.liveWindow(address)
    const postOnce = async (markdown: boolean): Promise<UnknownRecord> => {
      const body: UnknownRecord = markdown
        ? { msg_type: MSG_MARKDOWN, markdown: { content } }
        : { msg_type: MSG_TEXT, content }
      if (entry !== undefined) {
        entry.used += 1
        entry.seq += 1
        body.msg_id = entry.msgId
        body.msg_seq = entry.seq
      }
      try {
        return await this.requestJson('POST', this.endpoint(address), body, signal)
      } catch (error) {
        if (error instanceof QQApiError && isWindowReject(error.errCode)) {
          // msg_id 过期/去重/被动超限：确定性失败，原样上抛，但清空窗口避免后续重复撞墙。
          this.windows.delete(`${address.kind}:${address.chatId}`)
        }
        throw error
      }
    }
    let payload: UnknownRecord
    if (!wantMarkdown) {
      payload = await postOnce(false)
    } else {
      try {
        payload = await postOnce(true)
      } catch (error) {
        // markdown 档确定性拒绝（非窗口类、非网络不确定）→ 降级纯文本重发一次。
        if (error instanceof QQApiError && !isWindowReject(error.errCode) && error.httpStatus < 500) {
          payload = await postOnce(false)
        } else {
          throw error
        }
      }
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

  // —— 富媒体出站（P1/F1）————————————————————————————

  /** 富媒体上传端点：群/单聊不互通（文件头 6），路径与消息端点同构但尾缀 /files。 */
  private uploadEndpoint(address: ChatAddress): string {
    const id = encodeURIComponent(address.chatId)
    return address.kind === 'group' ? `/v2/groups/${id}/files` : `/v2/users/${id}/files`
  }

  /**
   * 上传换 file_info（仅图片档 file_type=1）。**双形态递降**：先按官方 Node SDK（
   * @tencent-connect/qqbot-nodejs 1.0.5 `MediaApi.uploadMedia`）的小文件形态——JSON +
   * base64 `file_data`（已被在跑的真机器人证明可用）；若平台确定性拒绝，再回退官方文档记载的
   * multipart/form-data 形态一次。网络不确定（uncertain）绝不重试（D7：上传重试会白占配额）。
   * 两种形态均带 `srv_send_msg=false`，否则平台会自己把图发出去与我们后续 msg_type=7 构成重发。
   */
  private async uploadFile(
    address: ChatAddress,
    fileName: string,
    data: Uint8Array,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<{ fileInfo: string; ttl: number }> {
    try {
      return await this.uploadFileJson(address, fileName, data, mimeType, signal)
    } catch (error) {
      if (error instanceof QQApiError) {
        this.log(`qq 上传 JSON 形态被拒（err ${error.errCode}），回退 multipart 形态重试一次`)
        return this.uploadFileForm(address, fileName, data, mimeType, signal)
      }
      throw error
    }
  }

  /** 小文件上传（官方 SDK 形态）：POST …/files 体 {file_type, file_name, file_data(base64), srv_send_msg:false}。 */
  private async uploadFileJson(
    address: ChatAddress,
    fileName: string,
    data: Uint8Array,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<{ fileInfo: string; ttl: number }> {
    void mimeType
    const body: UnknownRecord = {
      file_type: QQ_FILE_TYPE_IMAGE,
      file_name: fileName,
      file_data: Buffer.from(data).toString('base64'),
      srv_send_msg: false,
    }
    const payload = await this.requestJson('POST', this.uploadEndpoint(address), body, signal, true, true)
    const fileInfo = asText(payload.file_info)
    if (fileInfo === undefined) throw new QQUncertainError('qq upload: 成功状态但回包缺 file_info（结果不确定）')
    return { fileInfo, ttl: asNumber(payload.ttl) ?? 0 }
  }

  /** 上传备形态（官方文档记载）：multipart/form-data，file_data 为二进制部分。 */
  private async uploadFileForm(
    address: ChatAddress,
    fileName: string,
    data: Uint8Array,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<{ fileInfo: string; ttl: number }> {
    const token = await this.resolveToken(signal)
    const form = new FormData()
    form.append('file_type', String(QQ_FILE_TYPE_IMAGE))
    form.append('file_name', fileName)
    form.append('file_data', new Blob([data], { type: mimeType }), fileName)
    form.append('srv_send_msg', 'false')
    let response: JsonHttpFace
    try {
      response = await this.http(`${this.apiBase}${this.uploadEndpoint(address)}`, {
        method: 'POST',
        headers: { authorization: `QQBot ${token}` },
        body: form,
        signal,
      })
    } catch (error) {
      throw new QQUncertainError(`qq upload: ${describeThrown(error)}`)
    }
    if (response.status >= 500 || response.status === 429) {
      throw new QQUncertainError(`qq upload: HTTP ${response.status}`)
    }
    const payload = asRecord(await this.readBody(response))
    const errCode = asNumber(payload.err_code ?? payload.code ?? payload.errcode)
    if (errCode !== undefined && errCode !== 0) {
      throw new QQApiError(`qq upload: ${this.scrub(asText(payload.message) ?? `err_code ${errCode}`)}`, response.status, errCode)
    }
    if (!response.ok) {
      throw new QQApiError(`qq upload: ${this.scrub(asText(payload.message) ?? `HTTP ${response.status}`)}`, response.status, errCode ?? response.status)
    }
    const fileInfo = asText(payload.file_info)
    if (fileInfo === undefined) throw new QQUncertainError('qq upload: 成功状态但回包缺 file_info（结果不确定）')
    return { fileInfo, ttl: asNumber(payload.ttl) ?? 0 }
  }

  /**
   * 出站图片：先上传换 file_info，再以 msg_type=7 携带 image 发送（群/单聊分端点）。窗口内带
   * msg_id+msg_seq（同 reply 纪律，撞窗清空窗口）。QQ 官方机器人仅图片档开放，非图片 mime 优雅
   * 拒绝（不静默）；空字节拒发。file_info 过期(304080)/日配额(40093002)→确定性转译上抛。
   */
  async sendFile(address: ChatAddress, file: OutboundFile, signal?: AbortSignal): Promise<Receipt> {
    const mimeType = file.mimeType ?? ''
    if (!isImageMime(mimeType)) {
      throw new QQApiError(
        `qq: 暂不支持回传该类型文件（${mimeType || '未知'} · ${file.name}）；官方机器人出站富媒体仅开放图片`,
        0,
        QQ_FILE_TYPE_NOT_OPEN,
      )
    }
    if (file.data.byteLength === 0) throw new QQApiError(`qq: 空文件不允许上传（${file.name}）`, 0, 0)
    const { fileInfo } = await this.uploadFile(address, file.name, file.data, mimeType, signal)
    // 官方体形（@tencent-connect/qqbot-nodejs 1.0.5 sendMediaMessage 对账）：msg_type=7 用
    // `media: { file_info }` 包裹，而非旧式 `image: file_info`——后者在 api-v2 不渲染。
    const body: UnknownRecord = { msg_type: MSG_RICH_MEDIA, media: { file_info: fileInfo } }
    const entry = this.liveWindow(address)
    if (entry !== undefined) {
      entry.used += 1
      entry.seq += 1
      body.msg_id = entry.msgId
      body.msg_seq = entry.seq
    }
    try {
      const payload = await this.requestJson('POST', this.endpoint(address), body, signal)
      const id = asText(payload.id)
      return id === undefined ? { uncertain: false } : { platformMessageId: id, uncertain: false }
    } catch (error) {
      if (error instanceof QQApiError && isWindowReject(error.errCode)) {
        this.windows.delete(`${address.kind}:${address.chatId}`)
      }
      throw error
    }
  }

  /** 富文本/卡片/附件入站给占位文案而不丢事件；语音取事件原生 ASR 转写（P4/F5、免解码）。 */
  private inboundText(data: UnknownRecord): string {
    const content = asText(data.content)
    if (content !== undefined && content.trim() !== '') return content
    const attachments = asList(data.attachments)
    if (attachments.length > 0) {
      const asrTexts: string[] = []
      const kinds: string[] = []
      for (const item of attachments) {
        const face = asRecord(item)
        const mime = asText(face.content_type) ?? ''
        if (mime === 'voice' || asText(face.voice_wav_url) !== undefined) {
          const asr = asText(face.asr_refer_text) ?? asText(face.asrText)
          if (asr !== undefined && asr.trim() !== '') asrTexts.push(asr.trim())
          else kinds.push('语音')
        } else if (mime.startsWith('image/')) kinds.push('图片')
        else if (mime.startsWith('video/')) kinds.push('视频')
        else kinds.push('附件')
      }
      const unique = [...new Set(kinds)]
      const placeholder = `[${unique.join('+')}${attachments.length > 1 ? `×${attachments.length}` : ''}]`
      if (asrTexts.length > 0) return unique.length > 0 ? `${asrTexts.join('\n')}\n${placeholder}` : asrTexts.join('\n')
      return placeholder
    }
    const ark = asRecord(data.ark_data)
    if (Object.keys(ark).length > 0) return `[卡片消息${asText(ark.ark_name) !== undefined ? ` ${asText(ark.ark_name)}` : ''}]`
    if (asList(data.msg_elements).length > 0) return '[引用消息]'
    return '[空消息]'
  }

  /**
   * 入站派发（P3/F3）：若附件可下载且本渠道开了 imageIn/fileIn → 先抢时效下载再派发；否则同步派发。
   * 下载失败/过期不阻断（fillInboundAttachments 内部逐项吞错），事件绝不丢。
   */
  private dispatchInbound(data: UnknownRecord, message: SemanticMessage): void {
    const attachments = asList(data.attachments)
    const wantDownload = attachments.length > 0 && (this.caps.imageIn || this.caps.fileIn)
    // 串行链保序：本条消息的下载+派发排在上条之后，避免异步下载打乱消息顺序。
    this.dispatchTail = this.dispatchTail
      .then(async () => {
        if (wantDownload) {
          try {
            await this.fillInboundAttachments(attachments, message)
          } catch (error) {
            this.log(`qq 入站附件下载异常（忽略）: ${this.scrub((error as Error).message)}`)
          }
        }
        for (const listener of this.listeners) listener(message)
      })
      .catch((error: Error) => {
        this.log(`qq 入站派发异常（忽略）: ${this.scrub(error.message)}`)
      })
  }

  /**
   * 逐个下载附件字节填入 images[]/files[]（rkey 时效，事件到达即拉）。图片优先按 content_type，
   * 群聊图片 content_type 实测为 'file' → 兼用 URL 形态兵底；无 arrayBuffer 面/非 2xx/空字节 → 跳过不丢。
   * 语音/视频不归入下载（voice=false，不入字节）。
   */
  private async fillInboundAttachments(attachments: unknown[], message: SemanticMessage): Promise<void> {
    for (const item of attachments) {
      const face = asRecord(item)
      const url = asText(face.url)
      if (url === undefined) continue
      const mime = asText(face.content_type) ?? ''
      const isVoice = mime === 'voice' || asText(face.voice_wav_url) !== undefined || mime.startsWith('audio/')
      if (isVoice) continue
      const isImage = mime.startsWith('image/') || looksLikeQqImageUrl(url)
      if (isImage && !this.caps.imageIn) continue
      if (!isImage && !this.caps.fileIn) continue
      let response: JsonHttpFace
      try {
        response = await this.http(url, { method: 'GET' })
      } catch (error) {
        this.log(`qq 入站附件下载失败（忽略）: ${describeThrown(error)}`)
        continue
      }
      if (!response.ok || response.status >= 400 || typeof response.arrayBuffer !== 'function') continue
      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(await response.arrayBuffer())
      } catch {
        continue
      }
      if (bytes.byteLength === 0) continue
      const name = asText(face.filename) ?? asText(face.file_name) ?? deriveAttachName(url, isImage)
      if (isImage) {
        const mimeType = mime.startsWith('image/') ? mime : guessImageMimeFromUrl(url)
        ;(message.images ??= []).push({ name, data: bytes, mimeType })
      } else {
        ;(message.files ??= []).push({ name, data: bytes })
      }
    }
  }

  /**
   * 审批/提问按钮（P5/F4）：msg_type=2 + keyboard 行按钮（action.type=1 回传交互），等 INTERACTION_CREATE
   * 回包结算。未启用 keyboard / 多选 / 选项为空 → 抛错（引擎回落文本菜单）；发送失败同样上抛→回落。
   * D5：仅接受发起者（ownerUserId）点按，非发起者忽略；超时/取消→空答（uncertain=false）。
   */
  async askChoices(
    address: ChatAddress,
    question: string,
    options: readonly string[],
    multi: boolean,
    signal?: AbortSignal,
    opts?: { ownerUserId?: string },
  ): Promise<{ answer: string; uncertain: boolean }> {
    if (!this.enableKeyboard) throw new Error('qq: keyboard 未启用（config.keyboard），回落文本菜单')
    if (multi) throw new Error('qq: 多选无按钮原语，回落文本菜单')
    const labels = options.map((option) => String(option)).filter((label) => label !== '')
    if (labels.length === 0) throw new Error('qq: 选项为空')
    const token = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const body: UnknownRecord = {
      msg_type: MSG_MARKDOWN,
      markdown: { content: fitByteBudget(question) },
      keyboard: buildKeyboard(labels, token, opts?.ownerUserId),
    }
    const entry = this.liveWindow(address)
    if (entry !== undefined) {
      entry.used += 1
      entry.seq += 1
      body.msg_id = entry.msgId
      body.msg_seq = entry.seq
    }
    // 发送失败（未连接/无模板权限/不确定）直接上抛 → 引擎 catch 后回落纯文本菜单。
    await this.requestJson('POST', this.endpoint(address), body, signal)
    return new Promise<{ answer: string; uncertain: boolean }>((resolveOuter) => {
      let done = false
      const settle = (answer: string): void => {
        if (done) return
        done = true
        const held = this.pendingChoice.get(token)
        if (held !== undefined) {
          clearTimeout(held.timer)
          this.pendingChoice.delete(token)
        }
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        resolveOuter({ answer, uncertain: false })
      }
      const onAbort = (): void => settle('')
      if (signal !== undefined) {
        if (signal.aborted) {
          settle('')
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      const timer = setTimeout(() => settle(''), QQ_CHOICE_TIMEOUT_MS)
      timer.unref?.()
      this.pendingChoice.set(token, {
        labels,
        ...(opts?.ownerUserId !== undefined ? { ownerUserId: opts.ownerUserId } : {}),
        resolve: settle,
        timer,
      })
    })
  }

  /** INTERACTION_CREATE 消息按钮回传：解出 token+idx → 定位 pending → D5 发起者校验 → 结算。 */
  private handleInteraction(data: UnknownRecord): void {
    // 官方交互确认面（SDK acknowledgeInteraction → PUT /interactions/{id} {code:0}）：best-effort，
    // 失败不影响结算（错过确认只会让客户端按钮短暂停在“待响应”，不丢用户选择）。
    const interactionId = asText(data.id)
    if (interactionId !== undefined) {
      void this.requestJson('PUT', `/interactions/${encodeURIComponent(interactionId)}`, { code: 0 }, undefined, true, false).catch((error: Error) => {
        this.log(`qq 交互确认失败（忽略）: ${this.scrub(error.message)}`)
      })
    }
    const parsed = parseChoiceData(data)
    if (parsed === undefined) return
    const pending = this.pendingChoice.get(parsed.token)
    if (pending === undefined) return
    const user = asRecord(data.user)
    const operator =
      asText(user.user_openid) ?? asText(user.member_openid) ?? asText(asRecord(data.member).member_openid)
    if (pending.ownerUserId !== undefined && operator !== undefined && operator !== pending.ownerUserId) return
    const label = pending.labels[parsed.idx]
    if (label === undefined) return
    pending.resolve(label)
  }

  /** 渠道内不做准入判断：白名单归网关（红线 D6），恒交回 undefined。 */
  authorize(): boolean | undefined {
    return undefined
  }

  /**
   * markdown 内联本地图的媒体上传原语（P8/task_8）：走 3 步 /v2/media-images——prepare→PUT presigned→complete，
   * 返 `qqbot-media://` url 供写进 msg_type=2 正文。**适配器不读盘**：字节由调用方（gateway 受管工作区读）传入。
   * 先查服务端同名（含内容指纹）复用不占配额；md5/sha1/sha256 走 node:crypto；网络/平台码→QqGroupResult 失败体。
   */
  async uploadMarkdownImage(file: OutboundFile, signal?: AbortSignal): Promise<QqGroupResult<{ url: string; imageId: string }>> {
    const mime = (file.mimeType ?? '').toLowerCase()
    const ext = QQ_MD_EXT[mime]
    if (ext === undefined) return { ok: false, code: 'BAD_MIME', human: `markdown 内联图仅支持 png/jpeg/gif/webp（当前 ${mime || '未知'}）` }
    const bytes = file.data
    if (bytes.byteLength === 0) return { ok: false, code: 'EMPTY', human: `空文件不允许上传（${file.name}）` }
    if (bytes.byteLength > QQ_MD_MAX_BYTES) return { ok: false, code: 'TOO_BIG', human: `超过 10MB 上限（${bytes.byteLength} 字节）` }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const base = (file.name.split(/[\\/]/).pop() ?? 'image').replace(/\.[A-Za-z0-9]+$/, '').slice(0, 40)
    const fileName = `${base}_${sha256.slice(0, 12)}.${ext}`
    const md5 = createHash('md5').update(bytes).digest('hex')
    const sha1 = createHash('sha1').update(bytes).digest('hex')
    try {
      // ① 先去重：GET /v2/media-images 命中同名（含内容指纹）直接复用。
      const list = await this.requestJson('GET', '/v2/media-images', undefined, signal)
      const hit = asList(list.images).map(asRecord).find((x) => asText(x.file_name) === fileName && asText(x.url) !== undefined)
      if (hit !== undefined) return { ok: true, data: { url: String(hit.url), imageId: String(asText(hit.image_id) ?? '') } }
      // ② prepare
      const prep = await this.requestJson('POST', '/v2/media-images/prepare', { file_name: fileName, file_size: bytes.byteLength, content_type: mime, md5, sha1 }, signal)
      const uploadId = asText(prep.upload_id)
      const presigned = asText(prep.presigned_url)
      if (uploadId === undefined || presigned === undefined) return { ok: false, code: 'PREPARE', human: 'prepare 返回缺 upload_id/presigned_url' }
      // ③ PUT 直传 COS（不带 QQBot 鉴权头；content-type 必须与 prepare 一致否则 403）。
      try {
        const put = await this.http(presigned, { method: 'PUT', headers: { 'content-type': mime }, body: bytes, signal })
        if (!put.ok) return { ok: false, code: 'PUT', human: `直传失败 HTTP ${put.status}` }
      } catch (error) {
        return { ok: false, code: 'PUT', human: `直传异常：${describeThrown(error)}` }
      }
      // ④ complete（md5 用 ETag，这里回退本地 md5）
      const done = await this.requestJson('POST', '/v2/media-images/complete', { upload_id: uploadId, md5 }, signal)
      const url = asText(done.url)
      if (url === undefined) return { ok: false, code: 'COMPLETE', human: 'complete 返回缺 url' }
      return { ok: true, data: { url, imageId: String(asText(done.image_id) ?? '') } }
    } catch (error) {
      return this.toGroupErr(error)
    }
  }

  // —— 群管理（P6/F6）：入群审批/禁言/群消息撤回。机器人须为群管理员；门控见 qq-group-admin.ts。——

  /** 能力门：官方未开（内邀中）直接回人话拒绝，不发请求（未逐面核协议不猜发）。 */
  private gateGroup(name: keyof typeof QQ_GROUP_FEATURE_GATES): QqGroupResult<never> | undefined {
    const g = QQ_GROUP_FEATURE_GATES[name]
    if (g !== undefined && !g.open) return { ok: false, code: '11253', human: g.human }
    return undefined
  }

  /** REST 抛错→统一群管返回体：平台码人话化，网络不确定标记为需复查（不自动重试）。 */
  private toGroupErr(error: unknown): QqGroupResult<never> {
    if (error instanceof QQApiError) return { ok: false, code: String(error.errCode), human: qqGroupErrHuman(error.errCode) }
    if (error instanceof QQUncertainError) return { ok: false, code: 'NETWORK', human: '网络不确定，请稍后复查（不自动重试以防重复操作）' }
    return { ok: false, code: 'UNKNOWN', human: this.scrub((error as Error)?.message ?? '调用失败') }
  }

  /** 入群申请列表（🟡 群管理员）。 */
  async qqGroupListJoinRequests(gid: string, signal?: AbortSignal): Promise<QqGroupResult<UnknownRecord[]>> {
    const blocked = this.gateGroup('listJoinRequests')
    if (blocked !== undefined) return blocked
    try {
      const payload = await this.requestJson('GET', `/v2/groups/${encodeURIComponent(gid)}/join_request_list`, undefined, signal)
      return { ok: true, data: asList(payload.join_requests ?? payload.list) as UnknownRecord[] }
    } catch (error) {
      return this.toGroupErr(error)
    }
  }

  /** 审批入群申请（🟡 群管理员；op=approve|decline）。 */
  async qqGroupApproveJoin(
    gid: string,
    memberOpenid: string,
    op: 'approve' | 'decline',
    opts?: { joinRequestId?: string; signal?: AbortSignal },
  ): Promise<QqGroupResult<true>> {
    const blocked = this.gateGroup('approveJoinRequest')
    if (blocked !== undefined) return blocked
    const body: UnknownRecord = { op }
    if (opts?.joinRequestId !== undefined && opts.joinRequestId !== '') body.join_request_id = opts.joinRequestId
    try {
      await this.requestJson(
        'POST',
        `/v2/groups/${encodeURIComponent(gid)}/approval_join_request/${encodeURIComponent(memberOpenid)}`,
        body,
        opts?.signal,
        true,
        false,
      )
      return { ok: true, data: true }
    } catch (error) {
      return this.toGroupErr(error)
    }
  }

  /** 查询群禁言状态（🟡 群管理员）。 */
  async qqGroupGetMuteState(gid: string, signal?: AbortSignal): Promise<QqGroupResult<UnknownRecord>> {
    const blocked = this.gateGroup('getMuteState')
    if (blocked !== undefined) return blocked
    try {
      const payload = await this.requestJson('GET', `/v2/groups/${encodeURIComponent(gid)}/restrict_chat_setting`, undefined, signal)
      return { ok: true, data: payload }
    } catch (error) {
      return this.toGroupErr(error)
    }
  }

  /**
   * 设置群禁言（🟡 群管理员；仅普通成员，单次≤20 人）。muteSeconds<=0 → 解除禁言（del）；
   * 否则 add 逐条发（官方 add 批量会 50015013，del 支持一次多）。mute_expire_at 用 RFC3339。
   */
  async qqGroupSetMute(
    gid: string,
    memberOpenids: readonly string[],
    muteSeconds: number,
    signal?: AbortSignal,
  ): Promise<QqGroupResult<true>> {
    const blocked = this.gateGroup('setMute')
    if (blocked !== undefined) return blocked
    const ids = memberOpenids.map((v) => String(v).trim()).filter((v) => v !== '').slice(0, 20)
    if (ids.length === 0) return { ok: false, code: 'BAD_ARG', human: '未指定有效成员' }
    const path = `/v2/groups/${encodeURIComponent(gid)}/restrict_chat_setting`
    const release = muteSeconds <= 0
    if (release) {
      const members = ids.map((id) => ({ op: 'del', member_openid: id, mute_expire_at: '' }))
      try {
        await this.requestJson('POST', path, { members }, signal, true, false)
        return { ok: true, data: true }
      } catch (error) {
        return this.toGroupErr(error)
      }
    }
    const expire = new Date(Date.now() + muteSeconds * 1000).toISOString()
    for (const id of ids) {
      try {
        await this.requestJson('POST', path, { members: [{ op: 'add', member_openid: id, mute_expire_at: expire }] }, signal, true, false)
      } catch (error) {
        return this.toGroupErr(error)
      }
    }
    return { ok: true, data: true }
  }

  /** 撤回消息（🟡 仅机器人自己发的、2 分钟窗口；scope=group|c2c）。DELETE 容忍空回包。 */
  async qqGroupRecall(
    peerId: string,
    msgId: string,
    scope: 'group' | 'c2c' = 'group',
    signal?: AbortSignal,
  ): Promise<QqGroupResult<true>> {
    const blocked = this.gateGroup('recallMessage')
    if (blocked !== undefined) return blocked
    const base = scope === 'c2c' ? '/v2/users' : '/v2/groups'
    try {
      await this.requestJson('DELETE', `${base}/${encodeURIComponent(peerId)}/messages/${encodeURIComponent(msgId)}`, undefined, signal, true, false)
      return { ok: true, data: true }
    } catch (error) {
      return this.toGroupErr(error)
    }
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
      hint: this.connected
        ? `seq=${this.lastSeq ?? 'n/a'}（intents=1<<25${this.enableKeyboard ? '+1<<26' : ''}）`
        : '网关未就绪',
    })
    checks.push({
      name: 'send-roundtrip',
      status: 'unverified',
      hint: '真实收发闭环需平台侧沙箱群/沙箱账号验证；被动窗口（5 分钟内、≤4 次）与主动消息频控需实测',
    })
    checks.push({
      name: 'rich-media-capability',
      status: 'unverified',
      hint: '富媒体需平台侧开通能力：图片 sendFile 已实现（上传换 file_info→msg_type=7），但真机投递/日容量上限（40093002）待验；file_type=4 文件暂不开放',
    })
    checks.push({
      name: 'native-choices',
      status: this.enableKeyboard ? 'unverified' : 'passed',
      hint: this.enableKeyboard
        ? 'keyboard 已启用（订阅 INTERACTION intent）：审批/提问走按钮，需平台侧按钮模板/回调实测'
        : 'keyboard 未启用：审批/提问回退数字菜单（config.keyboard=on 且开通交互事件后启用按钮面）',
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

/** QQ markdown 内嵌图驱动信号：含 markdown 图片语法或 qqbot-media:// 引用串才走 msg_type=2。 */
function looksLikeRichMarkdown(text: string): boolean {
  return text.includes('![') || text.includes('qqbot-media://')
}

/** 本地图片路径判定：非 http(s)/协议相对/data:/qqbot-media: 即视为需上传的本地路径。 */
function isLocalImageRef(path: string): boolean {
  return !/^(https?:|data:|qqbot-media:|\/\/|\/v\d)/i.test(path.trim())
}

/**
 * 扫描正文 `![alt](path)` 将本地图片路径交给 resolveAndUpload（由调用方以受管工作区读+上传实现），
 * 拿到 url 则替换，拿不到（不可解/越界/上传失败）保留原样。网络图/data:/qqbot-media: 不碰。
 */
export async function rewriteMarkdownLocalImages(
  text: string,
  resolveAndUpload: (rawPath: string, alt: string) => Promise<string | undefined>,
): Promise<string> {
  if (!text.includes('![')) return text
  const re = /!\[([^\]]*)\]\(([^)\s]+)\)/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out += text.slice(last, m.index)
    const alt = m[1] ?? ''
    const p = (m[2] ?? '').trim()
    if (isLocalImageRef(p)) {
      const url = await resolveAndUpload(p, alt)
      out += url !== undefined && url !== '' ? `![${alt}](${url})` : m[0]
    } else {
      out += m[0]
    }
    last = m.index + m[0].length
  }
  out += text.slice(last)
  return out
}

/**
 * 构造 keyboard（官方行/按钮形）：每选项一行，单行单按钮；action.type=1 回传交互，data 携 token:idx；
 * 有发起者→permission.type=0 限定 specify_user_ids，否则 type=1 公开（靠 askChoices 侧 D5 兼容）。
 * 注意官方包装层：`keyboard` 的值是 `{ content: { rows } }`（InlineKeyboard 形状，与 SDK/qqbot 一致），
 * 少一层 content 则平台不渲染按钮。
 */
function buildKeyboard(labels: readonly string[], token: string, ownerUserId?: string): UnknownRecord {
  return {
    content: {
      rows: labels.map((label, idx) => ({
        buttons: [
          {
            id: `${token}:${idx}`,
            render_data: { label, visited_label: label, style: idx === 0 ? 1 : 2 },
            action: {
              type: 1,
              data: JSON.stringify({ token, idx }),
              permission:
                ownerUserId !== undefined
                  ? { type: 0, specify_user_ids: [ownerUserId] }
                  : { type: 1 },
              unsupported_verify: true,
            },
          },
        ],
      })),
    },
  }
}

/** 从 INTERACTION_CREATE 负载提 token+idx：依次试 data / data_resolved.data / button.data（JSON 或 token:idx）。 */
function parseChoiceData(data: UnknownRecord): { token: string; idx: number } | undefined {
  const resolved = asRecord(data.data_resolved)
  const button = asRecord(data.button)
  const candidates = [data.data, resolved.data, button.data]
  for (const cand of candidates) {
    if (typeof cand !== 'string' || cand === '') continue
    try {
      const obj = asRecord(JSON.parse(cand))
      const t = asText(obj.token)
      const i = asNumber(obj.idx)
      if (t !== undefined && i !== undefined) return { token: t, idx: i }
    } catch {
      const m = /^([a-z0-9]+):(\d+)$/i.exec(cand)
      if (m !== null) return { token: m[1], idx: Number(m[2]) }
    }
  }
  return undefined
}

/** QQ 开放平台图片白名单 mime（file_type=1 仅收这几类）。 */
const QQ_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'])
/** markdown 内联媒体图上传上限 10MB；mime→扩展名（官方仅收 png/jpeg/gif/webp）。 */
const QQ_MD_MAX_BYTES = 10 * 1024 * 1024
const QQ_MD_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}
/** 语义码：非图片类型经能力门直接拒发，未落 HTTP（httpStatus=0），供 sendFile 优雅拒绝分支。 */
const QQ_FILE_TYPE_NOT_OPEN = 4

function isImageMime(mimeType: string): boolean {
  return QQ_IMAGE_MIMES.has(mimeType.toLowerCase())
}

/** 群聊图片 content_type 实测为 'file' → 靠 URL 形态兵底判定为图片（QQ 多媒体域 + 图片扩展名）。 */
function looksLikeQqImageUrl(url: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)(?:[?#]|$)/i.test(url) || /image/i.test(new URL(url, 'https://api.bot.qq.com').pathname)
}

/** 从 URL 去 query 后提文件名（无则回退占位名）；图片补默认扩展。 */
function deriveAttachName(url: string, isImage: boolean): string {
  try {
    const path = new URL(url, 'https://api.bot.qq.com').pathname
    const base = path.split('/').pop()
    if (base !== undefined && base !== '') return decodeURIComponent(base)
  } catch {
    // URL 不可解即回退。
  }
  return isImage ? 'image' : 'attachment'
}

/** 无 content_type 时据 URL 扩展名猜图片 mime，兜底 image/png。 */
function guessImageMimeFromUrl(url: string): string {
  const m = /\.(png|jpe?g|gif|webp)(?:[?#]|$)/i.exec(url)
  if (m === null) return 'image/png'
  const ext = m[1].toLowerCase()
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
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
  const kb = options.config.keyboard
  const enableKeyboard = kb === '1' || kb === 'true' || kb === 'on'
  return new QqAdapter({
    appId,
    appSecret,
    ...(apiBase !== undefined && apiBase !== '' ? { apiBase } : {}),
    ...(tokenUrl !== undefined && tokenUrl !== '' ? { tokenUrl } : {}),
    ...(enableKeyboard ? { enableKeyboard: true } : {}),
  })
}
