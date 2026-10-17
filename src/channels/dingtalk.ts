/**
 * 钉钉渠道适配器（T2.1：Stream 模式 + AI Card 优先 / 文本回退 + 标签进度）。
 *
 * 协议事实（open.dingtalk.com 公开文档独立重实现，净室口径——不复制任何
 * 第三方 SDK 源码结构，只按文档口径落协议形态）：
 *
 * 1) Stream 模式（《Stream模式协议接入说明》
 *    https://open.dingtalk.com/document/direction/stream-mode-protocol-access-description
 *    与《协议描述》https://open-dingtalk.github.io/developerpedia/docs/learn/stream/protocol/）：
 *    - 注册连接凭证：POST https://api.dingtalk.com/v1.0/gateway/connections/open
 *      body {clientId, clientSecret, subscriptions:[{type:'EVENT',topic:'*'},
 *      {type:'CALLBACK',topic:'/v1.0/im/bot/messages/get'}], ua, localIp}
 *      → {endpoint, ticket}；文档明确 ticket 有效期 90s 且只能建立一条连接，
 *      禁存储/复用 → 每次重连都要重新注册取新 ticket。
 *    - 建连：以 endpoint 为 Host+Path、ticket 为查询参数发起 WebSocket 握手
 *      （GET /connect?ticket=${ticket}）。
 *    - 推送帧：{specVersion, type:SYSTEM|EVENT|CALLBACK,
 *      headers:{topic, contentType, messageId, time}, data:<json 字符串>}。
 *      headers.messageId 标记一次推送，客户端必须回传。
 *    - 响应（ACK）帧：{code:200|404|500, headers:{messageId, contentType:
 *      'application/json'}, message, data:<json 字符串>}；机器人回调的 data
 *      服务端不消费，文档给出固定形态 '{"response": null}'；EVENT 需
 *      {"status":"SUCCESS","message":"success"}。
 *    - 系统推送：topic='ping' 为服务端探活，data {"opaque":"..."}，客户端必须
 *      把 data 原样回传且 messageId 一致（即 PONG）；topic='disconnect' 为优雅
 *      断连（data.reason），客户端无需响应，服务端静默 10s 后断开——本适配器
 *      主动关闭并重新注册建连。
 *    - 机器人消息为 fire-forgot（不超时重推），但事件订阅仍可能重复推送，
 *      故按 msgId 排重。
 *
 * 2) 机器人接收消息（《机器人接收消息》
 *    https://open.dingtalk.com/document/isvapp/bot-receive-message）：
 *    data 解出 {conversationId, conversationType:'1'单聊|'2'群聊, senderId,
 *    senderStaffId, senderNick, senderUnionId, msgId, createAt(ms), atUsers[],
 *    isInAtList, chatbotUserId, robotCode, sessionWebhook,
 *    sessionWebhookExpiredTime(ms), msgtype:text|richText|picture|audio|video|file,
 *    text.content 或 content.richText[]}。
 *    群聊只有「@机器人」才会回调（协议事实）→ 群回调即被点名；text.content
 *    常带 "@机器人名 " 前缀与首尾空格，需剥离。
 *
 * 3) 出站：
 *    - 回复：消息回调自带的 sessionWebhook（POST JSON，无需 token，响应
 *      {errcode, errmsg}，errcode=0 成功）——支持 text / markdown。
 *    - 主动推送（无回调上下文时）：POST /v1.0/robot/oToMessages/batchSend
 *      （单聊，userIds）与 /v1.0/robot/groupMessages/send（群聊，
 *      openConversationId），body {robotCode, msgKey, msgParam:<json 字符串>}；
 *      v1.0 接口鉴权头 x-acs-dingtalk-access-token，token 由
 *      POST /v1.0/oauth2/accessToken {appKey, appSecret} 换取
 *      （https://open.dingtalk.com/document/development/obtain-the-access-token-of-an-internal-app，
 *      expireIn=7200s，文档要求自行缓存并按应用维度区分）。
 *      注：群侧 conversationId 与 openConversationId 口径是否等价未真机核
 *      （诊断里 card/推送面保持 unverified，不谎报）。
 *    - AI Card 优先（《AI卡片流式更新》
 *      https://open.dingtalk.com/document/development/api-streamingupdate）：
 *      创建并投放 POST /v1.0/card/instances/createAndDeliver（
 *      https://open.dingtalk.com/document/orgapp/create-and-deliver-cards），
 *      body {cardTemplateId, outTrackId(业务侧生成、一卡一 id), callbackType:
 *      'STREAM', openSpaceId:'dtv1.card//IM_ROBOT.<userId>' | 'dtv1.card//IM_GROUP.<conversationId>',
 *      imRobotOpenDeliverModel|imGroupOpenDeliverModel:{spaceType,...}, cardData:
 *      {cardParamMap}}；随后 PUT /v1.0/card/streaming body {outTrackId,
 *      guid(每次调用唯一，平台用于幂等判断), key(流式变量名), content,
 *      isFull, isFinalize, isError}，content 单次不超过 1K、总量建议 3K，
 *      markdown 变量必须 isFull=true。
 *      卡片状态机（《AI 卡片模板》
 *      https://open.dingtalk.com/document/development/ai-card-template）：
 *      投放后自动「处理中」→ 流式开始「输入中」→ isFinalize=true「完成」→
 *      isError=true「失败」——即本渠道的「标签进度」原生档位：宿主 step/start、
 *      tool/call 事件语义由引擎把 note 附进 update 快照（gateway.ts
 *      noteProgress/snapshot），适配器正常消费 update/finish 即可，
 *      caps.statusProgress=true 声明该档位。
 *    - 文本回退：卡片面确定性失败（权限 Card.Instance.Write/Card.Streaming.Write
 *      缺失、模板未发布、参数被拒）→ 适配器内回退 sessionWebhook 文本档，
 *      并把本实例后续卡片尝试一并关闭（cardDisabled）；uncertain 一律上抛，
 *      本渠道不自愈重发（红线 D7）。
 *    - Markdown 转钉钉：钉钉 markdown 为子集且格式错误无法预知，
 *      故沿用 telegram 的回退链思路——先 markdown，被格式类拒绝则纯文本重发。
 *
 * 4) 频率/长度：群机器人 webhook 约 20 条/分钟；单帧内容上限按文档「1 K」取
 *    保守值并与 caps.maxMessageLength 对齐（引擎分段单位=字符），中间帧超限时
 *    保留最新尾窗（打字机可见尾部），最终帧由引擎按 maxMessageLength 切段保证全量。
 *
 * 运行时依赖零：Node≥22 全局 fetch/WebSocket + node:crypto（randomUUID 生成
 * outTrackId/guid）；测试注入 fetchImpl / WebSocketImpl，不发真实请求。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { ChatAddress } from '../engine/router.js'
import { FILE_BUDGET } from '../engine/files.js'
import type {
  ChannelAdapter,
  ChannelCaps,
  ChannelDiagnosisCheck,
  MessageListener,
  OutboundFile,
  Receipt,
  ReplyStream,
  SemanticMessage,
} from './types.js'

const API_BASE = 'https://api.dingtalk.com'
/**
 * 素材上传/下载走 oapi 基址（企业内部应用 accessToken 新老接口通用）。
 * 文档：上传媒体文件 https://open.dingtalk.com/document/orgapp/upload-media-files
 * 机器人发送消息类型（sampleFile）：https://open.dingtalk.com/document/orgapp/types-of-messages-sent-by-robots
 */
const OAPI_BASE = 'https://oapi.dingtalk.com'
/** 普通文件素材上限 20MB（3 天有效）——与引擎 FILE_BUDGET 同值，渠道不自设更大限额。 */
const DINGTALK_FILE_MAX_BYTES = FILE_BUDGET.perFileMaxBytes
/** 机器人消息回调 topic（单聊不需 @，群聊必须 @机器人）。 */
const BOT_MESSAGES_TOPIC = '/v1.0/im/bot/messages/get'
/** 卡片互动回调 topic（首档只 ACK 不消费——caps.nativeChoices=false）。 */
const CARD_CALLBACK_TOPIC = '/v1.0/card/instances/callback'
/** 文档要求 ua 形如 name-sdk-lang/version。 */
const STREAM_UA = 'dsh-im-union-stream-node/0.0.1'
/** 单帧/单条上限：文档「单次不要超过 1 K」取字符口径保守值，与分段单位对齐。 */
const DINGTALK_MAX_MESSAGE = 1000
const STREAM_THROTTLE_MS = 1_100
const REQUEST_TIMEOUT_MS = 15_000
/** 服务端 30s 级探活；长时间不见任何下行帧即判连接腐化。 */
const IDLE_RECONNECT_MS = 90_000
const IDLE_CHECK_MS = 10_000
const TOKEN_EARLY_REFRESH_MS = 60_000

interface WSLike {
  send(data: string): void
  close(): void
  addEventListener(type: string, cb: (event: any) => void): void
  readyState: number
}
type WSFactory = (url: string) => WSLike

type FetchResponseLike = {
  ok: boolean
  status: number
  json(): Promise<unknown>
  arrayBuffer?(): Promise<ArrayBuffer>
}
type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal },
) => Promise<FetchResponseLike>

/** multipart/form-data 手搭（零依赖）：字段名固定 media（oapi 素材上传协议名）。 */
function buildFileMultipart(boundary: string, fileName: string, data: Uint8Array): Uint8Array {
  const encoder = new TextEncoder()
  const head = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  )
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`)
  const out = new Uint8Array(head.byteLength + data.byteLength + tail.byteLength)
  out.set(head, 0)
  out.set(data, head.byteLength)
  out.set(tail, head.byteLength + data.byteLength)
  return out
}

/** 入站文件引用（msgtype=file 且带 downloadCode）；图片/音视频不在本面。 */
function extractFileRef(payload: Record<string, any>): { downloadCode: string; fileName: string } | undefined {
  if (String(payload.msgtype ?? '') !== 'file') return undefined
  const downloadCode = typeof payload.content?.downloadCode === 'string' ? payload.content.downloadCode : ''
  if (downloadCode === '') return undefined
  const name = typeof payload.content?.fileName === 'string' && payload.content.fileName !== '' ? payload.content.fileName : '未命名文件'
  return { downloadCode, fileName: name }
}

/** Stream 通道线帧（收发共用，宽松形）。 */
interface StreamFrame {
  specVersion?: string
  type?: string
  headers?: { topic?: string; messageId?: string; contentType?: string; time?: string | number }
  data?: string
}

export interface DingtalkAdapterOptions {
  clientId: string
  clientSecret: string
  /** 覆盖 REST 基址（测试注入/专有云代理）。 */
  apiBase?: string
  /** 覆盖 oapi 基址（素材上传面，测试注入用）。 */
  oapiBase?: string
  /** AI 卡片模板 ID；缺位=不启卡片档（文本档）。 */
  cardTemplateId?: string
  /** 卡片流式变量名（以模板定义为准，默认 content）。 */
  cardTemplateKey?: string
  /** 流式档位：card=AI Card 优先（默认，需 cardTemplateId）/text=纯文本。 */
  cardMode?: 'card' | 'text'
  /** 机器人编码；文档口径企业内部应用即 AppKey（=clientId）。 */
  robotCode?: string
  WebSocketImpl?: WSFactory
  fetchImpl?: FetchLike
  requestTimeoutMs?: number
  idleReconnectMs?: number
  /** 卡片流式帧间隔（默认 1100ms，避开群 webhook ~20 条/分钟量级；测试可置 0）。 */
  streamThrottleMs?: number
  logger?: (msg: string) => void
}

/** HTTP 4xx / errcode·code 明确拒绝 = 确定性失败（服务端未投递，可安全告知）。 */
export class DingTalkApiError extends Error {
  constructor(
    message: string,
    /** 平台错误码或 HTTP 状态字符串（判型/日志用，不进用户可见文案）。 */
    readonly code: string,
  ) {
    super(message)
  }
}
/** 结果不明（网络错/超时/5xx/断连）——D7：禁自动重发。 */
export class DingTalkUncertainError extends Error {}

export class DingtalkAdapter implements ChannelAdapter {
  readonly id = 'dingtalk'
  readonly label = '钉钉'
  readonly caps: ChannelCaps

  connected = false
  /** 卡片面确定性失败后置位：本实例不再尝试卡片（内部退化文本档）。 */
  cardDisabled = false

  private readonly clientId: string
  private readonly clientSecret: string
  private readonly apiBase: string
  private readonly oapiBase: string
  private readonly cardTemplateId: string
  private readonly cardTemplateKey: string
  private readonly cardMode: 'card' | 'text'
  private readonly robotCodeConfigured: string
  private readonly wsFactory: WSFactory
  private readonly fetchImpl: FetchLike
  private readonly requestTimeoutMs: number
  private readonly idleReconnectMs: number
  private readonly streamThrottleMs: number
  private readonly log: (msg: string) => void

  private ws: WSLike | undefined
  private listeners: MessageListener[] = []
  private tokenCache: { value: string; expireAtMs: number } | undefined
  private observedRobotCode = ''
  /** msgId 排重（事件面可能重放）。 */
  private readonly seenMsgIds = new Set<string>()
  /** kind:chatId → 回调自带 sessionWebhook（回复首选面，带过期时间）。 */
  private readonly webhookByChat = new Map<string, { url: string; expiredAtMs: number }>()
  /** kind:chatId → 发送者 userId（batchSend 主动推送用）。 */
  private readonly userIdByChat = new Map<string, string>()
  /** kind:chatId → conversationId（群侧推送 openConversationId 候选）。 */
  private readonly conversationIdByChat = new Map<string, string>()
  private idleTimer: ReturnType<typeof setInterval> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private lastInboundAt = 0
  private backoffMs = 1_000
  private stopping = false

  constructor(options: DingtalkAdapterOptions) {
    if (typeof options.clientId !== 'string' || options.clientId === '') {
      throw new Error('dingtalk: clientId 缺失（开发者后台「应用信息」获取）')
    }
    if (typeof options.clientSecret !== 'string' || options.clientSecret === '') {
      throw new Error('dingtalk: clientSecret 缺失（开发者后台「应用信息」获取）')
    }
    this.clientId = options.clientId
    this.clientSecret = options.clientSecret
    this.apiBase = (options.apiBase ?? API_BASE).replace(/\/+$/, '')
    this.oapiBase = (options.oapiBase ?? OAPI_BASE).replace(/\/+$/, '')
    this.cardTemplateId = options.cardTemplateId ?? ''
    // 官方 AI 卡片模板内容字段名社区见 content/msgContent 两种口径，以模板定义为
    // 准——默认 content，config.cardTemplateKey 覆盖。
    this.cardTemplateKey = options.cardTemplateKey ?? 'content'
    this.cardMode = options.cardMode === 'text' ? 'text' : 'card'
    this.robotCodeConfigured = options.robotCode ?? ''
    const globalWS = (globalThis as { WebSocket?: { new (url: string): WSLike } }).WebSocket
    this.wsFactory =
      options.WebSocketImpl ??
      ((url: string) => {
        if (globalWS === undefined) throw new Error('dingtalk: 宿主 Node 运行时缺全局 WebSocket，无法建 Stream 长连接')
        return new globalWS(url)
      })
    this.fetchImpl = options.fetchImpl ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike)
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.idleReconnectMs = options.idleReconnectMs ?? IDLE_RECONNECT_MS
    this.streamThrottleMs = options.streamThrottleMs ?? STREAM_THROTTLE_MS
    this.log = options.logger ?? (() => {})
    // E1 纪律：声明=真实现。卡片档才声明原生流式与进度档位；
    // threads/nativeChoices/statusReaction/typing/imageIn/voice 本版本未实现 → false。
    // 文件面：出站 sampleFile + 入站 messageFiles/download 已接（见 sendFile/fillFile）。
    const cardLive = this.cardEnabled
    this.caps = {
      editStream: false,
      nativeStream: cardLive,
      nativeChoices: false,
      statusReaction: false,
      statusProgress: cardLive,
      typing: false,
      imageIn: false,
      fileIn: true,
      fileOut: true,
      threads: false,
      voice: false,
      maxMessageLength: DINGTALK_MAX_MESSAGE,
    }
  }

  /** 卡片档是否可用（未配模板/显式 text 档/已确定性失败 → 否）。 */
  private get cardEnabled(): boolean {
    return this.cardMode === 'card' && this.cardTemplateId !== '' && !this.cardDisabled
  }

  private get robotCode(): string {
    return this.robotCodeConfigured !== '' ? this.robotCodeConfigured : this.observedRobotCode
  }

  // —— 连接（Stream 模式）—————————————————————————————————

  async connect(signal?: AbortSignal): Promise<void> {
    this.stopping = false
    await this.openOnce(signal)
  }

  /** 注册 ticket→建连。ticket 90s 单次有效，故每次建连都重新注册。 */
  private async openOnce(signal?: AbortSignal): Promise<void> {
    const gateway = await this.openGatewayTicket(signal)
    const url = `${gateway.endpoint}${gateway.endpoint.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(gateway.ticket)}`
    const ws = this.wsFactory(url)
    this.ws = ws
    this.lastInboundAt = Date.now()
    let settled = false
    await new Promise<void>((resolve, reject) => {
      const succeed = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }
      ws.addEventListener('message', (event: { data?: string }) => {
        this.lastInboundAt = Date.now()
        this.handleFrame(event?.data)
      })
      ws.addEventListener('open', () => {
        this.connected = true
        this.backoffMs = 1_000
        this.startIdleWatchdog()
        succeed()
      })
      ws.addEventListener('error', () => fail(new DingTalkUncertainError('dingtalk: Stream 建连失败，结果不确定')))
      ws.addEventListener('close', () => {
        this.connected = false
        this.stopIdleWatchdog()
        if (!settled) fail(new DingTalkUncertainError('dingtalk: Stream 在建连完成前关闭'))
        else this.scheduleReconnect()
      })
      signal?.addEventListener('abort', () => fail(new Error('dingtalk: connect aborted')), { once: true })
    })
  }

  /** POST /v1.0/gateway/connections/open → {endpoint, ticket}。 */
  private async openGatewayTicket(signal?: AbortSignal): Promise<{ endpoint: string; ticket: string }> {
    const { body } = await this.send(
      'gateway/connections/open',
      `${this.apiBase}/v1.0/gateway/connections/open`,
      {
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        subscriptions: [
          { type: 'EVENT', topic: '*' },
          { type: 'CALLBACK', topic: BOT_MESSAGES_TOPIC },
        ],
        ua: STREAM_UA,
      },
      { 'content-type': 'application/json' },
      { signal, noToken: true },
    )
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : ''
    const ticket = typeof body.ticket === 'string' ? body.ticket : ''
    if (endpoint === '' || ticket === '') throw new DingTalkApiError('dingtalk: 注册连接凭证未返回 endpoint/ticket', 'empty')
    return { endpoint, ticket }
  }

  async disconnect(): Promise<void> {
    this.stopping = true
    this.connected = false
    this.stopIdleWatchdog()
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.ws?.close()
    this.ws = undefined
  }

  /** close 后自动重连（指数退避）；主动 disconnect/拆除期不重连。 */
  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer !== undefined) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.stopping) return
      this.openOnce().then(
        () => this.log('dingtalk: Stream 连接已恢复'),
        () => this.scheduleReconnect(),
      )
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private startIdleWatchdog(): void {
    this.stopIdleWatchdog()
    this.idleTimer = setInterval(() => {
      if (!this.connected || this.stopping) return
      if (Date.now() - this.lastInboundAt > this.idleReconnectMs) {
        this.log('dingtalk: 长时间未见服务端下行帧（含探活），判连接腐化，重建连接')
        this.ws?.close()
      }
    }, IDLE_CHECK_MS)
    this.idleTimer.unref?.()
  }

  private stopIdleWatchdog(): void {
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer)
    this.idleTimer = undefined
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  // —— 入站：线帧分发与归一 ——————————————————————————————

  private handleFrame(raw: string | undefined): void {
    if (typeof raw !== 'string' || raw === '') return
    let frame: StreamFrame
    try {
      frame = JSON.parse(raw) as StreamFrame
    } catch {
      this.log('dingtalk: 收到非法 JSON 帧，忽略')
      return
    }
    const topic = typeof frame.headers?.topic === 'string' ? frame.headers.topic : ''
    const messageId = typeof frame.headers?.messageId === 'string' ? frame.headers.messageId : ''
    const type = typeof frame.type === 'string' ? frame.type : ''

    if (type === 'SYSTEM') {
      if (topic === 'ping') {
        // 探活：data 必须原样回传（opaque），且 messageId 与请求一致——即 PONG。
        this.ack(messageId, frame.data ?? '')
        return
      }
      if (topic === 'disconnect') {
        // 优雅断连：无需响应，服务端静默 10s 后断开；ticket 不可复用，
        // 这里主动关闭走「重新注册取新 ticket」的重连路径。
        const reason = String(this.parseData(frame.data).reason ?? 'unknown')
        this.log(`dingtalk: 服务端 disconnect（${reason}），重建连接`)
        this.ws?.close()
        return
      }
      return
    }

    if (type === 'EVENT') {
      // 事件订阅：ACK data 需带 status（首档不消费任何业务事件，但仍回 ACK
      // 以免服务端判消费失败重推）。
      this.ack(messageId, JSON.stringify({ status: 'SUCCESS', message: 'success' }))
      return
    }

    if (type === 'CALLBACK') {
      if (topic === BOT_MESSAGES_TOPIC) {
        // 先 ACK 再处理：避免业务耗时触发服务端超时重推。
        this.ack(messageId, JSON.stringify({ response: null }))
        const message = this.handleCallback(this.parseData(frame.data))
        if (message === undefined) return
        for (const listener of this.listeners) listener(message)
        return
      }
      if (topic === CARD_CALLBACK_TOPIC) {
        // 首档不实现卡片按钮回包（caps.nativeChoices=false），只确认收到。
        this.ack(messageId, JSON.stringify({ response: null }))
        return
      }
      this.ack(messageId, JSON.stringify({ response: null }), 404, 'topic not supported')
      return
    }
  }

  /** 回一帧 ACK（messageId 必须与推送一致；发送失败只记日志，不改判业务）。 */
  private ack(messageId: string, data: string, code = 200, message = 'OK'): void {
    if (messageId === '' || this.ws === undefined) return
    const frame: StreamFrame & { code: number; message: string } = {
      code,
      headers: { contentType: 'application/json', messageId },
      message,
      data,
    }
    try {
      this.ws.send(JSON.stringify(frame))
    } catch (error) {
      this.log(`dingtalk: ACK 发送失败（${String(error)}）`)
    }
  }

  private parseData(data: string | undefined): Record<string, any> {
    if (typeof data !== 'string' || data === '') return {}
    try {
      const parsed = JSON.parse(data) as unknown
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, any>) : {}
    } catch {
      return {}
    }
  }

  /** 回调 payload → 上下文登记 + 排重 + 归一（导出 normalize 供单测直验）。 */
  private handleCallback(payload: Record<string, any>): SemanticMessage | undefined {
    const msgId = typeof payload.msgId === 'string' ? payload.msgId : ''
    if (msgId !== '') {
      if (this.seenMsgIds.has(msgId)) return undefined
      this.seenMsgIds.add(msgId)
      if (this.seenMsgIds.size > 500) {
        const first = this.seenMsgIds.values().next().value
        if (typeof first === 'string') this.seenMsgIds.delete(first)
      }
    }
    const message = this.normalize(payload)
    if (message === undefined) return undefined
    const key = `${message.address.kind}:${message.address.chatId}`
    const webhook = typeof payload.sessionWebhook === 'string' ? payload.sessionWebhook : ''
    if (webhook !== '') {
      const expiredRaw = Number(payload.sessionWebhookExpiredTime ?? 0)
      // 缺省兜底按文档量级（90 分钟）留 60s 余量，过期即改走推送面。
      const expiredAtMs = Number.isFinite(expiredRaw) && expiredRaw > 0 ? expiredRaw : Date.now() + 90 * 60_000 - 60_000
      this.webhookByChat.set(key, { url: webhook, expiredAtMs })
    }
    if (typeof payload.senderStaffId === 'string' && payload.senderStaffId !== '') {
      this.userIdByChat.set(key, payload.senderStaffId)
    }
    if (typeof payload.conversationId === 'string' && payload.conversationId !== '') {
      this.conversationIdByChat.set(key, payload.conversationId)
    }
    if (typeof payload.robotCode === 'string' && payload.robotCode !== '') this.observedRobotCode = payload.robotCode
    const fileRef = extractFileRef(payload)
    if (fileRef !== undefined) {
      // 入站非图文件：公开下载面（POST /v1.0/robot/messageFiles/download → downloadUrl）。
      // 沿用异步 fill 范式：先换字节再投递；失败降级文本说明，不丢整条消息。
      const code = typeof payload.robotCode === 'string' && payload.robotCode !== '' ? payload.robotCode : this.robotCode
      void this.fillFile(message, fileRef, code).then(() => {
        if (this.stopping) return
        for (const listener of this.listeners) listener(message)
      })
      return undefined
    }
    return message
  }

  /**
   * 机器人回调 payload → SemanticMessage。
   * conversationType '2'→group（chatId=conversationId）/'1'→dm（chatId=senderStaffId）；
   * 机器人自发回声丢弃；非文本类型给占位文案不丢事件（与飞书同纪律）。
   */
  normalize(payload: Record<string, any>): SemanticMessage | undefined {
    if (payload === null || typeof payload !== 'object') return undefined
    // 回声闸：钉钉 chatbotUserId 即「本机器人」的加密 id，与 senderId 同源即自发消息。
    if (typeof payload.chatbotUserId === 'string' && payload.chatbotUserId !== '' && payload.senderId === payload.chatbotUserId) {
      return undefined
    }
    const group = String(payload.conversationType ?? '1') === '2'
    const userId = String(payload.senderStaffId ?? payload.senderId ?? '')
    const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : ''
    const chatId = group ? conversationId : userId !== '' ? userId : conversationId
    if (chatId === '') return undefined
    const address: ChatAddress = { channel: 'dingtalk', kind: group ? 'group' : 'dm', chatId }
    const msgtype = String(payload.msgtype ?? 'unknown')
    let text: string
    if (msgtype === 'text') {
      text = String(payload.text?.content ?? '')
    } else if (msgtype === 'richText') {
      text = this.richTextToText(payload.content?.richText)
    } else if (msgtype === 'picture') {
      text = '[图片输入首档未启用（downloadCode 换取面未真机核）]'
    } else if (msgtype === 'audio') {
      text = '[语音输入未启用（caps.voice=false）]'
    } else if (msgtype === 'video') {
      // 协议上视频同样有 downloadCode 下载面，但本版本未接视频归一 → 占位不丢事件。
      text = '[视频输入未启用（视频字节面未接）]'
    } else if (msgtype === 'file') {
      // 入站文件：占位文案先行，字节由 fillFile 异步补齐（失败只追加说明）。
      const name = typeof payload.content?.fileName === 'string' && payload.content.fileName !== '' ? payload.content.fileName : '未命名文件'
      text = `[文件：${name}]`
    } else {
      text = `[暂不支持的消息类型：${msgtype}]`
    }
    if (group) {
      // 群回调的 content 常带 "@机器人名 " 前缀（回调只在 @ 本机器人时发生），剥离。
      text = text.replace(/^(@[^@\s]+\s+)+/, '').trim()
    } else {
      text = text.trim()
    }
    // 协议事实：群里只有 @ 到本机器人才会产生机器人消息回调；单聊不算点名。
    const mentionedBot = group
    const created = Number(payload.createAt ?? 0)
    const nick = typeof payload.senderNick === 'string' ? payload.senderNick : undefined
    const semantic: SemanticMessage = {
      address,
      userId: userId !== '' ? userId : chatId,
      ...(nick !== undefined ? { userDisplayName: nick } : {}),
      text,
      mentionedBot,
      timestamp: Number.isFinite(created) && created > 0 ? created : undefined,
    }
    return semantic
  }

  /** 富文本片段 → 线性文本（图片位以占位标注，不丢事件）。 */
  private richTextToText(parts: unknown): string {
    if (!Array.isArray(parts)) return '[富文本消息：无法解析]'
    const out: string[] = []
    for (const part of parts) {
      const item = part as { text?: unknown; type?: unknown; downloadCode?: unknown }
      if (typeof item?.text === 'string') out.push(item.text)
      else if (item?.type === 'picture' || item?.downloadCode !== undefined) out.push('[图片]')
    }
    return out.join(' ').trim() === '' ? '[富文本消息：无可读文本]' : out.join(' ')
  }

  // —— 出站 ——————————————————————————————————————————

  /**
   * 回复：回调自带 sessionWebhook 优先（无需 token）；无上下文/已过期 →
   * 机器人主动推送面（batchSend / groupMessages.send）。
   * markdown 优先，格式类拒绝回退纯文本（回退链同 telegram 思路）。
   */
  async reply(address: ChatAddress, text: string, signal?: AbortSignal): Promise<Receipt> {
    const content = clip(text, this.caps.maxMessageLength)
    const key = `${address.kind}:${address.chatId}`
    const hook = this.webhookByChat.get(key)
    if (hook !== undefined && hook.expiredAtMs > Date.now()) {
      return this.replyViaWebhook(hook.url, content, signal)
    }
    return this.replyViaRobotSend(address, content, signal)
  }

  private async replyViaWebhook(url: string, content: string, signal?: AbortSignal): Promise<Receipt> {
    try {
      return await this.postWebhook(url, { msgtype: 'markdown', markdown: { title: markdownTitle(content), text: content } }, signal)
    } catch (error) {
      if (error instanceof DingTalkUncertainError) throw error
      if (!(error instanceof DingTalkApiError) || !isFormatReject(error)) throw error
      const sent = await this.postWebhook(url, { msgtype: 'text', text: { content } }, signal)
      this.log('dingtalk: markdown 被格式类拒绝，已回退纯文本')
      return sent
    }
  }

  /** webhook POST：响应 {errcode,errmsg}；errcode=0 即成功。 */
  private async postWebhook(url: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Receipt> {
    const { body } = await this.send('sessionWebhook', url, payload, { 'content-type': 'application/json' }, { signal })
    const errcode = Number(body.errcode ?? 0)
    if (Number.isFinite(errcode) && errcode !== 0) {
      // errcode=-1 为钉钉「系统繁忙」类：投递结果不明，按 uncertain 处理。
      if (errcode === -1) throw new DingTalkUncertainError('dingtalk: sessionWebhook 返回 errcode=-1（系统繁忙），结果不确定')
      throw new DingTalkApiError(`dingtalk: sessionWebhook 被拒（errcode ${errcode}：${String(body.errmsg ?? '')}）`, String(errcode))
    }
    return { uncertain: false }
  }

  /** 主动推送面（v1.0 机器人接口，需 accessToken）。 */
  private async replyViaRobotSend(address: ChatAddress, content: string, signal?: AbortSignal): Promise<Receipt> {
    const key = `${address.kind}:${address.chatId}`
    if (this.robotCode === '') {
      throw new DingTalkApiError('dingtalk: 缺少回复上下文（无 sessionWebhook 且 robotCode 未知）', 'no-context')
    }
    try {
      return await this.robotSend(address, key, 'sampleMarkdown', { title: markdownTitle(content), text: content }, signal)
    } catch (error) {
      if (error instanceof DingTalkUncertainError) throw error
      if (!(error instanceof DingTalkApiError) || !isFormatReject(error)) throw error
      const sent = await this.robotSend(address, key, 'sampleText', { content }, signal)
      this.log('dingtalk: markdown 推送被格式类拒绝，已回退纯文本')
      return sent
    }
  }

  private async robotSend(
    address: ChatAddress,
    key: string,
    msgKey: string,
    param: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Receipt> {
    const body: Record<string, unknown> =
      address.kind === 'group'
        ? {
            robotCode: this.robotCode,
            openConversationId: this.conversationIdByChat.get(key) ?? address.chatId,
            msgKey,
            msgParam: JSON.stringify(param),
          }
        : {
            robotCode: this.robotCode,
            userIds: [this.userIdByChat.get(key) ?? address.chatId],
            msgKey,
            msgParam: JSON.stringify(param),
          }
    const path = address.kind === 'group' ? '/v1.0/robot/groupMessages/send' : '/v1.0/robot/oToMessages/batchSend'
    const result = await this.restV1(path, body, signal)
    const queryKey = typeof result.processQueryKey === 'string' ? result.processQueryKey : undefined
    return queryKey === undefined ? { uncertain: false } : { platformMessageId: queryKey, uncertain: false }
  }

  /**
   * 出站文件（公开面两步，均已核实）：
   * 1) POST {oapiBase}/media/upload?access_token=…&type=file，multipart/form-data
   *    字段名固定 media → { media_id }（普通文件 ≤20MB、3 天有效）
   * 2) 机器人推送 msgKey='sampleFile'，msgParam=JSON {mediaId, fileName, fileType}
   *    ——文档：机器人发送消息类型 types-of-messages-sent-by-robots
   * 注：协议只支持企业内部应用/第三方企业应用机器人（本适配器即此档）；
   * webhook 自定义机器人无文件外发公开面。
   * 判型沿用文本面：errcode≠0/4xx = 确定性 DingTalkApiError；超时/传输失败 = DingTalkUncertainError（D7）。
   */
  async sendFile(address: ChatAddress, file: OutboundFile, signal?: AbortSignal): Promise<Receipt> {
    if (file.data.byteLength === 0) throw new DingTalkApiError(`dingtalk: 空文件不上传（${file.name}）`, 'emptyFile')
    if (file.data.byteLength > DINGTALK_FILE_MAX_BYTES) {
      throw new DingTalkApiError(
        `dingtalk: 文件 ${file.data.byteLength} 字节，超素材上限 ${DINGTALK_FILE_MAX_BYTES}`,
        'fileTooLarge',
      )
    }
    if (this.robotCode === '') throw new DingTalkApiError('dingtalk: 缺少 robotCode（sampleFile 推送必需）', 'no-context')
    const mediaId = await this.uploadMedia(file, signal)
    const dot = file.name.lastIndexOf('.')
    const fileType = dot > 0 ? file.name.slice(dot + 1) : 'file'
    return this.robotSend(
      address,
      `${address.kind}:${address.chatId}`,
      'sampleFile',
      { mediaId, fileName: file.name, fileType },
      signal,
    )
  }

  /** 素材上传 multipart：oapi 口径 errcode≠0 / 非 2xx = 确定性；传输失败 = uncertain（不重传）。 */
  private async uploadMedia(file: OutboundFile, signal?: AbortSignal): Promise<string> {
    const token = await this.accessToken(signal)
    const boundary = `----dshImUnion${randomBytes(12).toString('hex')}`
    const url = `${this.oapiBase}/media/upload?access_token=${encodeURIComponent(token)}&type=file`
    let response: FetchResponseLike
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: buildFileMultipart(boundary, file.name, file.data),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      // 错误不带 URL（含 access_token）；上传是否已达服务端不可知 → uncertain
      throw new DingTalkUncertainError(`dingtalk: media/upload 传输失败（${String(error)}），结果不确定`)
    }
    if (!response.ok) throw new DingTalkApiError(`dingtalk: media/upload HTTP ${response.status}`, String(response.status))
    const body = (await response.json().catch(() => ({}))) as Record<string, any>
    const errcode = Number(body.errcode ?? 0)
    if (errcode !== 0) {
      throw new DingTalkApiError(`dingtalk: media/upload ${String(body.errmsg ?? '')}（errcode ${errcode}）`, String(errcode))
    }
    const mediaId = typeof body.media_id === 'string' ? body.media_id : ''
    if (mediaId === '') throw new DingTalkApiError('dingtalk: media/upload 成功体无 media_id', 'mediaIdEmpty')
    return mediaId
  }

  /**
   * 下载码 → 临时链接 → 取字节。
   * 文档：下载机器人接收消息的文件内容
   * https://open.dingtalk.com/document/development/download-the-file-content-of-the-robot-receiving-message
   * 任何失败均降级：保留占位文案加说明，不抛不丢消息（入站面无 Receipt 语义）。
   */
  private async fillFile(
    message: SemanticMessage,
    ref: { downloadCode: string; fileName: string },
    robotCode: string,
  ): Promise<void> {
    try {
      if (robotCode === '') throw new DingTalkApiError('dingtalk: 无 robotCode，无法换取下载链接', 'no-context')
      const result = await this.restV1('/v1.0/robot/messageFiles/download', {
        downloadCode: ref.downloadCode,
        robotCode,
      })
      const url = typeof result.downloadUrl === 'string' ? result.downloadUrl : ''
      if (url === '') throw new DingTalkApiError('dingtalk: 下载响应无 downloadUrl', 'downloadUrlEmpty')
      const response = await this.fetchImpl(url, { method: 'GET' })
      if (!response.ok) throw new DingTalkApiError(`dingtalk: 文件下载 HTTP ${response.status}`, String(response.status))
      if (response.arrayBuffer === undefined) throw new DingTalkApiError('dingtalk: 宿主 fetch 无 arrayBuffer 面', 'noArrayBuffer')
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength === 0) throw new DingTalkApiError('dingtalk: 文件下载响应体为空', 'emptyBody')
      if (bytes.byteLength > FILE_BUDGET.perFileMaxBytes) {
        this.log(`dingtalk: 入站文件 ${bytes.byteLength} 字节超引擎裁额 ${FILE_BUDGET.perFileMaxBytes}，不取字节`)
        message.text = `${message.text}（字节超限未取回）`
        return
      }
      message.files = [{ name: ref.fileName, data: bytes }]
    } catch (error) {
      this.log(`dingtalk: 入站文件下载失败（${String(error)}），保留占位文案`)
      message.text = `${message.text}（字节未取回）`
    }
  }

  /**
   * AI Card 流式：createAndDeliver 起卡 → PUT /v1.0/card/streaming 逐帧全量
   * （isFull=true，markdown 变量硬性要求；guid 每帧唯一做幂等标志）→
   * finish 帧 isFinalize=true（卡片状态机自动切「完成」档）。
   */
  async beginStream(address: ChatAddress, signal?: AbortSignal): Promise<ReplyStream> {
    if (this.cardMode !== 'card') throw new Error('dingtalk: 当前为文本档（cardMode=text）')
    if (this.cardTemplateId === '') throw new Error('dingtalk: 未配置 cardTemplateId（AI 卡片模板），流式退化文本档')
    let outTrackId: string
    try {
      outTrackId = await this.createAndDeliverCard(address, signal)
    } catch (error) {
      if (error instanceof DingTalkApiError) {
        // 确定性拒绝=卡片未投放，回退文本不会双发；同时关闭后续卡片尝试。
        this.cardDisabled = true
        this.caps.nativeStream = false
        this.caps.statusProgress = false
        this.log(`dingtalk: 卡片投放被拒（${error.message}），本实例退化文本档`)
        return this.textStream(address, signal)
      }
      throw error // uncertain 一律上抛：渠道内禁自愈重发（D7）
    }
    const self = this // stream 方法内 this 指向返回对象，必须外提
    let lastSentAt = 0
    let pending: Promise<void> = Promise.resolve()
    let aborted = false
    const step = (content: string, finalize: boolean) => async (): Promise<void> => {
      if (aborted && !finalize) return
      if (!finalize) {
        const wait = this.streamThrottleMs - (Date.now() - lastSentAt)
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      }
      lastSentAt = Date.now()
      await self.streamUpdate(outTrackId, clip(content, self.caps.maxMessageLength), finalize, signal)
    }
    const queued = (content: string, finalize: boolean): Promise<void> => {
      // 前序帧失败不阻塞后续帧（仍把本帧的错误回抛给调用方）。
      const run = pending.then(step(content, finalize), step(content, finalize))
      pending = run.catch(() => undefined)
      return run
    }
    return {
      async update(markdown: string): Promise<void> {
        await queued(markdown, false)
      },
      async finish(markdown: string): Promise<Receipt> {
        await queued(markdown, true)
        return { platformMessageId: outTrackId, uncertain: false }
      },
      abort(): void {
        aborted = true
      },
    }
  }

  /** 文本档流式：中间快照无可编辑承载面，只缓存；收轮一次性 reply。 */
  private textStream(address: ChatAddress, signal?: AbortSignal): ReplyStream {
    const self = this // 对象字面量方法内 this 指向 stream 本身，必须外提
    let aborted = false
    return {
      async update(_markdown: string): Promise<void> {
        // 文本档无原生进度面（statusProgress 已随卡片档关闭），不发中间帧避免刷屏。
      },
      async finish(markdown: string): Promise<Receipt> {
        if (aborted) return { uncertain: false }
        return self.reply(address, markdown, signal)
      },
      abort(): void {
        aborted = true
      },
    }
  }

  private async createAndDeliverCard(address: ChatAddress, signal?: AbortSignal): Promise<string> {
    const key = `${address.kind}:${address.chatId}`
    const outTrackId = `imu_${randomUUID()}`
    const group = address.kind === 'group'
    const userId = this.userIdByChat.get(key) ?? (group ? '' : address.chatId)
    const openSpaceId = group ? `dtv1.card//IM_GROUP.${this.conversationIdByChat.get(key) ?? address.chatId}` : `dtv1.card//IM_ROBOT.${userId}`
    const spaceModel = { supportForward: true }
    const deliverModel: Record<string, unknown> = group
      ? { robotCode: this.robotCode, spaceType: 'IM_GROUP' }
      : { spaceType: 'IM_ROBOT' }
    const body: Record<string, unknown> = {
      cardTemplateId: this.cardTemplateId,
      outTrackId,
      callbackType: 'STREAM',
      openSpaceId,
      cardData: { cardParamMap: { [this.cardTemplateKey]: '' } },
      ...(group ? { imGroupOpenSpaceModel: spaceModel, imGroupOpenDeliverModel: deliverModel }
                : { userId, imRobotOpenSpaceModel: spaceModel, imRobotOpenDeliverModel: deliverModel }),
    }
    await this.restV1('/v1.0/card/instances/createAndDeliver', body, signal)
    return outTrackId
  }

  private async streamUpdate(outTrackId: string, content: string, finalize: boolean, signal?: AbortSignal): Promise<void> {
    // 文档口径：流式更新为 PUT /v1.0/card/streaming。
    await this.restV1(
      '/v1.0/card/streaming',
      {
        outTrackId,
        // guid：每次调用唯一，平台侧用于幂等判断。
        guid: randomUUID(),
        key: this.cardTemplateKey,
        content,
        // markdown 变量必须全量覆盖，否则报 param.stream.isFull。
        isFull: true,
        isFinalize: finalize,
      },
      signal,
      false,
      'PUT',
    )
  }

  // —— REST 底座 ——————————————————————————————————————————

  /** accessToken 自管（expireIn 7200s，提前 60s 刷新；文档要求按应用维度缓存）。 */
  private async accessToken(signal?: AbortSignal): Promise<string> {
    const cached = this.tokenCache
    if (cached !== undefined && cached.expireAtMs - TOKEN_EARLY_REFRESH_MS > Date.now()) return cached.value
    const { body } = await this.send(
      'oauth2/accessToken',
      `${this.apiBase}/v1.0/oauth2/accessToken`,
      { appKey: this.clientId, appSecret: this.clientSecret },
      { 'content-type': 'application/json' },
      { signal, noToken: true },
    )
    const token = typeof body.accessToken === 'string' ? body.accessToken : ''
    if (token === '') throw new DingTalkApiError('dingtalk: accessToken 换取失败（应用凭据或权限面被拒）', 'token-empty')
    const expireIn = Number(body.expireIn ?? 7200)
    this.tokenCache = { value: token, expireAtMs: Date.now() + (Number.isFinite(expireIn) ? expireIn : 7200) * 1000 }
    return token
  }

  /** v1.0 接口调用：token 头 + 错误分级（4xx/code 确定性，5xx/网络 uncertain）。 */
  private async restV1(
    path: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    staleRetried = false,
    method: 'POST' | 'PUT' = 'POST',
  ): Promise<Record<string, any>> {
    const token = await this.accessToken(signal)
    const { status, body } = await this.send(
      path,
      `${this.apiBase}${path}`,
      payload,
      { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
      { signal, method },
    )
    const code = typeof body.code === 'string' ? body.code : ''
    const rejected = status >= 400 || (code !== '' && !/^ok$/i.test(code))
    if (!rejected) return body
    if (!staleRetried && isTokenStale(status, code, String(body.message ?? ''))) {
      this.tokenCache = undefined // token 失效属确定性拒绝（未投递），刷新后重试一次
      return this.restV1(path, payload, signal, true)
    }
    throw new DingTalkApiError(`dingtalk ${path}: ${code !== '' ? code : `HTTP ${status}`} ${String(body.message ?? '')}`.trim(), code !== '' ? code : String(status))
  }

  /**
   * POST JSON 底座：返回 {status, body}。
   * 网络异常/超时/HTTP 5xx → DingTalkUncertainError（D7 禁重发）；
   * HTTP 4xx 与业务码由调用方判确定性拒绝。
   */
  private async send(
    label: string,
    url: string,
    payload: Record<string, unknown>,
    headers: Record<string, string> = { 'content-type': 'application/json' },
    opts: { signal?: AbortSignal; noToken?: boolean; method?: 'POST' | 'PUT' } = {},
  ): Promise<{ status: number; body: Record<string, any> }> {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    opts.signal?.addEventListener('abort', onAbort)
    // 超时判据必须落在 timer 回调里直接 reject：注入的 fake fetch 可以不响应
    // AbortSignal 而永久挂起，只靠 abort 抛错兜不住（真实全局 fetch 会在 abort
    // 时抛 AbortError，同样归类 uncertain）。
    let rejectTimeout: (error: unknown) => void = () => {}
    const timeout = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject
    })
    const timer = setTimeout(() => {
      controller.abort()
      rejectTimeout(new DingTalkUncertainError(`dingtalk ${label}: 请求超时，结果不确定`))
    }, this.requestTimeoutMs)
    const inflight = Promise.resolve().then(() =>
      this.fetchImpl(url, { method: opts.method ?? 'POST', headers, body: JSON.stringify(payload), signal: controller.signal }),
    )
    inflight.catch(() => undefined) // 竞态后到达的失败不留孤儿 promise
    let response: FetchResponseLike
    try {
      response = await Promise.race([inflight, timeout])
    } catch (error) {
      if (error instanceof DingTalkUncertainError) throw error
      if ((error as Error)?.name === 'AbortError' && opts.signal?.aborted === true) throw error
      throw new DingTalkUncertainError(`dingtalk ${label}: 传输失败（${String(error)}），结果不确定`)
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
    let body: Record<string, any> = {}
    try {
      const parsed = (await response.json()) as unknown
      body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, any>) : {}
    } catch {
      body = {}
    }
    if (response.status >= 500) throw new DingTalkUncertainError(`dingtalk ${label}: HTTP ${response.status}，结果不确定`)
    return { status: response.status, body }
  }

  // —— 准入 / 诊断 —————————————————————————————————————————

  /** 渠道内不裁决准入：白名单在网关（红线 D6），恒交全局。 */
  authorize(): boolean | undefined {
    return undefined
  }

  /** 诊断三态：credentials 实探（换 token）；roundtrip 恒 unverified；零 secret 回显。 */
  async diagnose(signal?: AbortSignal): Promise<ChannelDiagnosisCheck[]> {
    const checks: ChannelDiagnosisCheck[] = []
    const start = Date.now()
    this.tokenCache = undefined // 实探：不复用缓存，真实走一次换取
    try {
      await this.accessToken(signal)
      checks.push({ name: 'credentials', status: 'passed', hint: 'accessToken 换取成功（有效期 7200s，应用维度缓存）', elapsedMs: Date.now() - start })
    } catch (error) {
      const uncertain = error instanceof DingTalkUncertainError
      checks.push({
        name: 'credentials',
        status: uncertain ? 'unverified' : 'failed',
        hint: uncertain ? '网络面不稳定，token 结果不明，稍后复测' : '钉钉拒绝换取 accessToken：检查 Client ID/Secret 与应用发布状态（开发者后台「应用信息」）',
        elapsedMs: Date.now() - start,
      })
    }
    checks.push({
      name: 'stream-connection',
      status: this.connected ? 'passed' : 'unverified',
      hint: this.connected ? 'Stream 长连接在线（已注册 EVENT+机器人 CALLBACK）' : '未建连，无法验证',
    })
    checks.push({
      name: 'card-streaming',
      status: 'unverified',
      hint: this.cardEnabled
        ? 'AI Card 投放/流式需真机验证权限面（互动卡片实例写权限 + AI 卡片流式更新权限）'
        : this.cardTemplateId === ''
          ? '未配置 config.cardTemplateId，流式为文本档（caps.nativeStream=false）'
          : '卡片面因确定性拒绝已关闭（本实例退化文本档）',
    })
    checks.push({
      name: 'file-surface',
      status: 'unverified',
      hint: '出站 sendFile 走 oapi media/upload(type=file ≤20MB/3 天) + msgKey=sampleFile；入站走 /v1.0/robot/messageFiles/download（需企业内机器人发消息权限），素材上传/下载权限均需真机实证',
    })
    checks.push({
      name: 'roundtrip',
      status: 'unverified',
      hint: '收发 round-trip 需真机（钉钉客户端给机器人发消息）验证',
    })
    return checks
  }
}

/** 平台码判型：token 失效类（确定性拒绝，可刷新后重试一次）。 */
function isTokenStale(status: number, code: string, message: string): boolean {
  if (status === 401) return true
  return /InvalidAuthentication|AccessTokenInvalid|invalid.*access.*token|token.*expired/i.test(`${code} ${message}`)
}

/** 格式类拒绝（markdown 子集解析失败）——触发纯文本回退链。 */
function isFormatReject(error: DingTalkApiError): boolean {
  return /markdown|format|parse|syntax|invalid.*content|content.*invalid|param\.[a-z]*content/i.test(error.message)
}

function markdownTitle(text: string): string {
  const first = text
    .split('\n')
    .map((line) => line.replace(/[#>*`_-]/g, '').trim())
    .find((line) => line !== '')
  if (first === undefined) return 'IM 回复'
  return first.length > 20 ? `${first.slice(0, 20)}…` : first
}

/** 单帧/单条上限裁剪：超限保留最新尾窗（打字机可见尾部），前缀省略号提示截断。 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `…${text.slice(text.length - (max - 1))}`
}

/** 工厂挂 registry（secrets 取 meta 里的钉钉字段名 clientId/clientSecret；config 可含 apiBase 覆盖）。 */
export function createDingtalkAdapter(options: {
  accountId: string
  config: Record<string, string>
  secrets: Record<string, string | undefined>
}): DingtalkAdapter {
  const clientId = options.secrets.clientId ?? ''
  const clientSecret = options.secrets.clientSecret ?? ''
  if (clientId === '' || clientSecret === '') {
    throw new Error(`dingtalk 账号 ${options.accountId}: clientId/clientSecret 未入库（检查凭据配置）`)
  }
  const config = options.config
  return new DingtalkAdapter({
    clientId,
    clientSecret,
    ...(optional(config, 'apiBase') !== undefined ? { apiBase: optional(config, 'apiBase') } : {}),
    ...(optional(config, 'cardTemplateId') !== undefined ? { cardTemplateId: optional(config, 'cardTemplateId') } : {}),
    ...(optional(config, 'cardTemplateKey') !== undefined ? { cardTemplateKey: optional(config, 'cardTemplateKey') } : {}),
    ...(optional(config, 'robotCode') !== undefined ? { robotCode: optional(config, 'robotCode') } : {}),
    ...(config.cardMode === 'text' ? { cardMode: 'text' as const } : {}),
  })
}

function optional(config: Record<string, string>, key: string): string | undefined {
  const value = config[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}
