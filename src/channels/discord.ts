/**
 * Discord 渠道适配器（M1 P0）。
 *
 * 协议事实（Bot API v10 公开规范独立重实现，净室口径）：
 * - 入站：REST GET /gateway 取 WSS 地址 → Gateway op2 IDENTIFY（intents 组合）；
 *   op10 HELLO 给心跳间隔，op1 HEARTBEAT 带 last seq，op11 ACK；
 *   op9 INVALID_SESSION（d=false）重 IDENTIFY、op7 RECONNECT 重连；
 *   op0 DISPATCH 的 MESSAGE_CREATE 归一为 SemanticMessage。
 * - 出站：POST /channels/{id}/messages；流式 = 占位消息 + PATCH 编辑；
 *   "Unknown message" 编辑被拒 → 补发接替；typing POST /channels/{id}/typing（10s 过期）。
 * - Markdown 是纯文本内建渲染（无 parse_mode，格式错无从发生）；
 *   表格转竖排由本层做（Discord 客户端不渲染表格）。
 * - Thread 模型：thread 内消息的 channel_id 即 thread 通道 id，天然每聊天独立会话；
 *   kind 判定 = 有无 guild_id（DM 无 guild）。
 * - 群触发（红线 D6）：只认 mentions 显式 @ 本机器人。
 * - Receipt：网络/5xx = uncertain 禁重发；4xx 确定性抛错。
 * - 文件面（T2.4 渠道侧）：出站 POST /channels/{id}/messages 的 multipart/form-data
 *   （payload_json + files[0]，字段名为 Discord 公开约定）；入站 attachments 非图项
 *   按 content_type 判型进 SemanticMessage.files（图仍走 images）。
 *   本渠道不自设限额：张数/体积上限归引擎 FILE_BUDGET（20 MiB / ≤4 个）。
 * - 引用面（T3.6 上下文增强）：MESSAGE_CREATE 的 message_reference 只给定位，
 *   正文靠内联 referenced_message / message_snapshot（在网关缓存内才有），
 *   不在位时走公开面 GET /channels/{id}/messages/{message_id} 回取（失败静默）。
 *
 * 运行时依赖零：Node≥22 全局 fetch/WebSocket/AbortController（宿主 engines 已锁），
 * 测试全量注入 fetchImpl/WebSocketImpl。
 */
import type { ChatAddress } from '../engine/router.js'
import { FILE_BUDGET } from '../engine/files.js'
import { mergeQuote } from '../engine/quote.js'
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

/**
 * Gateway intents：位值逐条对齐官方 list-of-intents。
 *
 * 写错不会报错也不会断连——只是对应事件永远不推，连接看着完全健康，所以很难发现
 * （历史上 `GUILD_MESSAGES` 被写成 `1 << 15`、`MESSAGE_CONTENT` 写成 `1 << 24`，
 * 于是服务器频道消息永远收不到）。故每个常量带官方位号注释，并由
 * `tests/discord.test.mjs` 按位钉值校验（断言写在测试里的必须是官方文档值，
 * 不得拿实现值自证）。
 */
const INTENTS = {
  /** `1 << 0` GUILDS：`GUILD_CREATE` 等（非特权）。 */
  GUILDS: 1 << 0,
  /** `1 << 9` GUILD_MESSAGES：服务器频道 `MESSAGE_CREATE`（非特权）。 */
  GUILD_MESSAGES: 1 << 9,
  /** `1 << 12` DIRECT_MESSAGES：私聊 `MESSAGE_CREATE`（非特权）。 */
  DIRECT_MESSAGES: 1 << 12,
  /** `1 << 15` MESSAGE_CONTENT：读消息正文（**特权** intent，需在开发者门户勾选）。 */
  MESSAGE_CONTENT: 1 << 15,
} as const

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const

const EDIT_THROTTLE_MS = 1500
const DISCORD_MAX_MESSAGE = 2000

interface FetchResponseLike {
  ok: boolean
  status: number
  json(): Promise<unknown>
  arrayBuffer?(): Promise<ArrayBuffer>
}
type FetchBody = string | Uint8Array
type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: FetchBody; signal?: AbortSignal },
) => Promise<FetchResponseLike>

interface WSLike {
  send(data: string): void
  close(): void
  addEventListener(type: string, cb: (event: any) => void): void
  readyState: number
}
type WSFactory = (url: string) => WSLike

export interface DiscordAdapterOptions {
  token: string
  apiBase?: string
  fetchImpl?: FetchLike
  WebSocketImpl?: WSFactory
  logger?: (msg: string) => void
  /** 重连退避基准（默认 1000ms），按 2^n 递增到 `reconnectMaxMs`；测试可压小。 */
  reconnectBaseMs?: number
  /** 重连退避上限（默认 60000ms）：不放弃重试，只封顶等待。 */
  reconnectMaxMs?: number
  /** 抖动源（默认 `Math.random`）：测试注定值以确定性断言等待时长。 */
  random?: () => number
}

export class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}
export class DiscordUncertainError extends Error {}

export class DiscordAdapter implements ChannelAdapter {
  readonly id = 'discord'
  readonly label = 'Discord'
  readonly caps: ChannelCaps = {
    editStream: true,
    nativeStream: false,
    nativeChoices: true,
    statusReaction: false,
    typing: true,
    imageIn: true,
    fileIn: true,
    fileOut: true,
    threads: true,
    voice: false,
    maxMessageLength: DISCORD_MAX_MESSAGE,
  }

  connected = false
  private readonly token: string
  private readonly apiBase: string
  private readonly fetchImpl: FetchLike
  private readonly wsFactory: WSFactory
  private readonly log: (msg: string) => void
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly random: () => number
  private listeners: MessageListener[] = []
  private ws: WSLike | undefined
  private botUserId = ''
  private lastSeq: number | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private readonly closeController = new AbortController()
  /** 首次 IDENTIFY 用的 Gateway 地址（`connect()` 取定）；重连优先走 `resumeUrl`。 */
  private gatewayUrl = ''
  /** READY 下发的 session_id：有值且 `resumeUrl` 在位才能 RESUME（不丢事件）。 */
  private sessionId = ''
  /** READY 下发的 resume_gateway_url（与初次 `/gateway` 不同域，必须用它续传）。 */
  private resumeUrl = ''
  /** 连续重连次数；READY/RESUMED 归零，驱动指数退避。 */
  private attempts = 0
  /** 已发 HEARTBEAT 等 ACK：下一拍仍未清即判定僵尸连接。 */
  private awaitingAck = false
  /** 待执行的重连排程（单一排程位即并发守卫：重复 close/RECONNECT 不叠加）。 */
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  /** 主动拆线位：`disconnect()` 后不得再自动重连。 */
  private shuttingDown = false

  constructor(options: DiscordAdapterOptions) {
    if (typeof options.token !== 'string' || options.token === '') {
      throw new Error('discord: botToken 缺失（凭据库解析失败或未配置账号）')
    }
    this.token = options.token
    this.apiBase = options.apiBase ?? 'https://discord.com/api/v10'
    this.fetchImpl = options.fetchImpl ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike)
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1000
    this.reconnectMaxMs = options.reconnectMaxMs ?? 60_000
    this.random = options.random ?? Math.random
    const globalWS = (globalThis as { WebSocket?: { new (url: string): WSLike } }).WebSocket
    this.wsFactory =
      options.WebSocketImpl ??
      ((url: string) => {
        if (globalWS === undefined) throw new Error('discord: 宿主 Node 运行时缺全局 WebSocket，无法建 Gateway 连接')
        return new globalWS(url)
      })
    this.log = options.logger ?? (() => {})
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  // —— REST ——————————————————————————————————————————

  private async rest(method: string, path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    let response: FetchResponseLike
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: { authorization: `Bot ${this.token}`, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: signal ?? this.closeController.signal,
      })
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error
      throw new DiscordUncertainError(`discord ${method} ${path}: 网络异常 ${(error as Error).message}`)
    }
    if (response.status >= 500) throw new DiscordUncertainError(`discord ${method} ${path}: HTTP ${response.status}`)
    const payload = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
    if (!response.ok) {
      const detail = typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`
      throw new DiscordApiError(`discord ${method} ${path}: ${detail}`, response.status)
    }
    return payload
  }

  // —— Gateway ——————————————————————————————————————————

  async connect(signal?: AbortSignal): Promise<void> {
    this.shuttingDown = false
    // 上层显式 connect（`AccountManager.ensureConnected` 在任何操作前都会调）：
    // 由它接管重连。若不先撤内部排程并拆旧 socket，会同时存在两条 Gateway 连接
    // （Discord 视为两个 session，入站可能只投其中一条）。
    this.cancelScheduled()
    this.attempts = 0
    const prev = this.ws
    if (prev !== undefined) {
      this.ws = undefined // 先摘引用：旧 socket 迟到的 close/message 不再参与状态判定
      this.stopHeartbeat()
      try {
        prev.close()
      } catch {
        // ignore：旧连接关不上也不能阻塞新连接建立。
      }
    }
    const me = (await this.rest('GET', '/users/@me', undefined, signal)) as { id?: string }
    this.botUserId = String(me.id ?? '')
    const gateway = (await this.rest('GET', '/gateway', undefined, signal)) as { url?: string }
    const url = String(gateway.url ?? 'wss://gateway.discord.gg/?v=10&encoding=json')
    this.gatewayUrl = url.includes('?') ? `${url}&encoding=json` : `${url}/?v=10&encoding=json`
    this.openGateway()
  }

  /**
   * 建一条 Gateway 连接。重连不重跑 `connect()` 的 REST 面：
   * 能续传时用 READY 给的 `resume_gateway_url`，否则回退初次取定的 `gatewayUrl`。
   */
  private openGateway(): void {
    if (this.shuttingDown) return
    const wsUrl = this.resumeUrl !== '' ? this.resumeUrl : this.gatewayUrl
    const ws = this.wsFactory(wsUrl)
    this.ws = ws
    this.awaitingAck = false
    // 两个处理器都先比 `this.ws !== ws`：被 connect()/重连替换过的旧 socket，
    // 其迟到帧与 close 一律不得再改当前状态（否则会误判断开、叠排重连）。
    ws.addEventListener('message', (event: { data: string }) => {
      if (this.ws !== ws) return
      this.handleGatewayFrame(String(event.data))
    })
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return
      this.connected = false
      this.stopHeartbeat()
      // 主动拆线（disconnect / 宿主 abort / connect 接管）不重连；其余一律进退避排程。
      if (this.shuttingDown || this.closeController.signal.aborted) return
      this.scheduleReconnect('断开')
    })
    ws.addEventListener('error', () => {
      if (this.ws !== ws) return
      this.connected = false
    })
  }

  /** 取消待执行的重连排程（单一收口，避免各处 clearTimeout 写法走样）。 */
  private cancelScheduled(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true
    this.stopHeartbeat()
    this.cancelScheduled()
    this.sessionId = ''
    this.resumeUrl = ''
    this.attempts = 0
    this.closeController.abort()
    const ws = this.ws
    this.ws = undefined
    try {
      ws?.close()
    } catch {
      // 已断开即目标达成。
    }
    this.connected = false
  }

  private handleGatewayFrame(raw: string): void {
    let frame: { op?: number; d?: any; s?: number; t?: string }
    try {
      frame = JSON.parse(raw)
    } catch {
      this.log('discord Gateway 帧解析失败（丢弃）')
      return
    }
    if (typeof frame.s === 'number') this.lastSeq = frame.s
    switch (frame.op) {
      case OP.HELLO: {
        const intervalMs = Number(frame.d?.heartbeat_interval ?? 41250)
        this.stopHeartbeat()
        this.heartbeat = setInterval(() => this.sendHeartbeat(), intervalMs)
        // 有 session 就续传（不丢断口期间的事件、不重拉全量）；否则完整 IDENTIFY。
        if (this.canResume()) this.sendResume()
        else this.sendIdentify()
        return
      }
      case OP.HEARTBEAT_ACK:
        this.awaitingAck = false
        return
      case OP.RECONNECT:
        // 服务端定期要求重连：先落排程，再关连接（close 处理器看到已有排程就不叠加）。
        this.scheduleReconnect('收到 op7 RECONNECT')
        try {
          this.ws?.close()
        } catch {
          // ignore：排程已落，关失败也不影响下一轮。
        }
        return
      case OP.INVALID_SESSION: {
        this.connected = false
        this.stopHeartbeat()
        // d=false 意味会话已确定没了：不清 session 的话，下一条 HELLO 会误走 RESUME 反复碰壁。
        if (frame.d !== true) this.sessionId = ''
        // 官方要求收到 op9 后等 1–5s 再动作；走同一退避位，不另并一套定时器，
        // 也避免「op9 d=true → 同连接立即 RESUME → 再被拒」的热循环。
        const useResume = this.canResume()
        this.scheduleAttempt(`会话失效（op9 d=${String(frame.d)}）`, () => {
          if (useResume) this.sendResume()
          else this.sendIdentify()
        })
        return
      }
      case OP.DISPATCH: {
        if (frame.t === 'READY') {
          this.connected = true
          this.attempts = 0
          this.awaitingAck = false
          this.sessionId = String(frame.d?.session_id ?? '')
          const resume = frame.d?.resume_gateway_url
          if (typeof resume === 'string' && resume !== '') this.resumeUrl = resume
          this.log(
            this.sessionId !== '' && this.resumeUrl !== ''
              ? 'discord Gateway 就绪（session 已建立，后续断开可 RESUME 续传）'
              : 'discord Gateway 就绪（未拿到 resume 信息，后续断开将重 IDENTIFY）',
          )
          return
        }
        if (frame.t === 'RESUMED') {
          const recovered = this.attempts
          this.connected = true
          this.attempts = 0
          this.awaitingAck = false
          this.log(`discord Gateway RESUME 成功（断口期间事件已续传${recovered > 1 ? `，第 ${recovered} 次尝试` : ''}）`)
          return
        }
        if (frame.t === 'MESSAGE_CREATE') {
          const message = this.normalize(frame.d)
          if (message !== undefined) {
            // 图片入站（T1.7）：下载后投递；失败降级无图文本，不丢整条。
            // 引用原文（T3.6）：同一「投递前完成」异步范式，链式串联免并发写同对象。
            void this.fillAttachments(message, frame.d)
              .then(() => this.fillQuote(message, frame.d))
              .catch((error: unknown) =>
                this.log(`discord 入站增强失败（降级投递）: ${(error as Error).message}`),
              )
              .then(() => {
                for (const listener of this.listeners) listener(message)
              })
          }
        }
        return
      }
      default:
        return
    }
  }

  private sendIdentify(): void {
    this.sendFrame({
      op: OP.IDENTIFY,
      d: {
        token: this.token,
        // 含 GUILDS：否则无 GUILD_CREATE，部分场景（刚加入的服务器、缓存缺失的频道）拿不到上下文。
        intents: INTENTS.GUILDS | INTENTS.GUILD_MESSAGES | INTENTS.DIRECT_MESSAGES | INTENTS.MESSAGE_CONTENT,
        properties: { os: 'dsh-plugin', browser: 'dsh-im-union', device: 'dsh-im-union' },
      },
    })
  }

  /** 可续传：READY 同时给了 session_id 与 resume_gateway_url 才成立（缺一必须重 IDENTIFY）。 */
  private canResume(): boolean {
    return this.sessionId !== '' && this.resumeUrl !== ''
  }

  private sendResume(): void {
    this.sendFrame({
      op: OP.RESUME,
      d: { token: this.token, session_id: this.sessionId, seq: this.lastSeq ?? 0 },
    })
  }

  /** 指数退避 + 正向抖动（最多 +30%，避免全量客户端同刻共击）：base·2^(n-1) 封顶 maxMs。 */
  private backoffMs(attempt: number): number {
    const base = Math.min(this.reconnectBaseMs * 2 ** Math.max(0, attempt - 1), this.reconnectMaxMs)
    return Math.round(base * (1 + this.random() * 0.3))
  }

  /**
   * 唯一的退避排程原语。单一 `reconnectTimer` 位就是并发守卫：close、op7、op9 多源
   * 同时触发时只保留第一个排程（不叠加、不互相覆盖、不泄漏旧定时器）。
   * 不主动放弃：只把等待封顶在 `reconnectMaxMs`，IM 账号静默失联比慢重连更糟。
   */
  private scheduleAttempt(reason: string, action: () => void): void {
    if (this.shuttingDown) return
    if (this.reconnectTimer !== undefined) {
      this.log(`discord ${reason}：已有重连排程在队，不叠加`)
      return
    }
    const attempt = ++this.attempts
    const wait = this.backoffMs(attempt)
    this.log(`discord ${reason}，${wait}ms 后第 ${attempt} 次尝试`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.shuttingDown) return
      try {
        action()
      } catch (error) {
        // 建连/发帧本身抛（如宿主缺 WebSocket）：转下一轮退避，不把异常冒到事件循环外。
        this.log(`discord 重连尝试失败: ${(error as Error).message}`)
        this.scheduleAttempt('重连尝试失败', action)
      }
    }, wait)
  }

  /** 重连一条新连接：不重跑 `connect()` 的 REST 面，地址用已取定的 resume/gateway 位。 */
  private scheduleReconnect(reason: string): void {
    this.scheduleAttempt(`Gateway ${reason}`, () => {
      this.openGateway()
    })
  }

  private sendHeartbeat(): void {
    // 上一拍还没 ACK 就到了下一拍 = 僵尸连接（TCP 活着但服务端已不响应），
    // 官方推荐做法是主动断开重建；close 处理器会接手排重连。
    if (this.awaitingAck) {
      this.awaitingAck = false
      this.stopHeartbeat()
      this.log('discord 心跳无 ACK，判定僵尸连接并主动断开重连')
      try {
        this.ws?.close()
      } catch {
        // close 处理器不可依赖时，手动补一排程。
        this.scheduleReconnect('僵尸连接断开失败')
      }
      return
    }
    this.awaitingAck = true
    this.sendFrame({ op: OP.HEARTBEAT, d: this.lastSeq ?? null })
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }
  }

  private sendFrame(payload: Record<string, unknown>): void {
    try {
      this.ws?.send(JSON.stringify(payload))
    } catch (error) {
      this.log(`discord Gateway 发送失败: ${(error as Error).message}`)
    }
  }

  /** MESSAGE_CREATE → SemanticMessage。bot 自发消息丢弃（回声），无 author 丢弃。 */
  normalize(message: DiscordMessageLike | undefined): SemanticMessage | undefined {
    if (message === undefined || message.author === undefined || typeof message.channel_id !== 'string') return undefined
    if (this.botUserId !== '' && message.author.id === this.botUserId) return undefined
    const kind = message.guild_id === undefined || message.guild_id === null ? 'dm' : 'group'
    const address: ChatAddress = { channel: 'discord', kind, chatId: message.channel_id }
    const mentionedBot =
      kind === 'dm' ? false : Array.isArray(message.mentions) && message.mentions.some((m) => m?.id === this.botUserId)
    const semantic: SemanticMessage = {
      address,
      userId: String(message.author.id),
      userDisplayName:
        typeof message.author.global_name === 'string' && message.author.global_name !== ''
          ? message.author.global_name
          : typeof message.author.username === 'string'
            ? message.author.username
            : undefined,
      text: String(message.content ?? ''),
      mentionedBot,
      timestamp: typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : undefined,
    }
    // 引用（T3.6）：MESSAGE_CREATE 只给 message_reference 定位，正文不在位时由
    // fillQuote 走公开面回取（见文件头协议事实）；这里只登记平台 id，不伪填文本。
    const refId = typeof message.message_reference?.message_id === 'string' ? message.message_reference.message_id : ''
    if (refId !== '') semantic.quoteId = refId
    return semantic
  }

  /**
   * 引用原文回取（T3.6 上下文增强）。
   * 协议事实（https://discord.com/developers/docs/resources/message#get-message，
   * 同页 Message Reference Object / Message Reference Types）：
   * - `message_reference.type` 未设按 DEFAULT(0) 处理，耦合消息字段 `referenced_message`；
   *   FORWARD(1) 耦合 `message_snapshot`；被引用消息不在网关缓存时内联字段会缺席；
   * - `message_reference.channel_id` 「接收事件时总是存在」→ 跨频道引用也能定位；
   * - 公开取回面 = `GET /channels/{channel_id}/messages/{message_id}`。
   * 优先级：内联在位即用（省一次 REST）→ 不在位才回取。
   * 失败（404/无权限/网络/正文为空）静默保持现状：不覆盖已有 quoteText、不丢整条消息。
   */
  private async fillQuote(message: SemanticMessage, raw: DiscordMessageLike | undefined): Promise<void> {
    const ref = raw?.message_reference
    const refId = typeof ref?.message_id === 'string' ? ref.message_id : ''
    if (refId === '') return
    let body = quoteBodyOf(raw?.referenced_message) ?? quoteBodyOf(raw?.message_snapshot?.message)
    if (body === undefined) {
      const channelId =
        typeof ref?.channel_id === 'string' && ref.channel_id !== '' ? ref.channel_id : message.address.chatId
      try {
        const fetched = (await this.rest('GET', `/channels/${channelId}/messages/${refId}`)) as DiscordMessageLike
        body = quoteBodyOf(fetched)
      } catch (error) {
        this.log(`discord 引用原文回取失败（保持截断现状）: ${(error as Error).message}`)
        return
      }
    }
    const merged = mergeQuote(message.quoteText, body, refId)
    if (merged !== '') message.quoteText = merged
  }

  /**
   * 附件入站（T1.7 图 / T2.4 非图文件）：content_type 判型。
   * 图→images（上限 4 张）；其余→files（上限 FILE_BUDGET.maxCount，
   * 声明体积超单文件上限的不拉）；单件下载失败只跳过该件，不丢整条消息。
   */
  private async fillAttachments(message: SemanticMessage, raw: DiscordMessageLike | undefined): Promise<void> {
    const attachments = raw?.attachments
    if (!Array.isArray(attachments) || attachments.length === 0) return
    const images: Array<{ name: string; data: Uint8Array; mimeType: string }> = []
    const files: Array<{ name: string; data: Uint8Array }> = []
    for (const attachment of attachments) {
      const contentType = typeof attachment?.content_type === 'string' ? attachment.content_type : ''
      const isImage = contentType.startsWith('image/')
      if (isImage ? images.length >= 4 : files.length >= FILE_BUDGET.maxCount) continue
      const url =
        typeof attachment?.url === 'string' ? attachment.url : typeof attachment?.proxy_url === 'string' ? attachment.proxy_url : undefined
      if (url === undefined) continue
      const name = String(attachment?.filename ?? (isImage ? 'image' : 'file'))
      if (!isImage && typeof attachment?.size === 'number' && attachment.size > FILE_BUDGET.perFileMaxBytes) {
        this.log(`文件超过 20 MiB 上限，未下载：${name}`)
        continue
      }
      try {
        const response = await this.fetchImpl(url)
        const buffer = typeof response.arrayBuffer === 'function' ? await response.arrayBuffer() : undefined
        if (buffer === undefined || buffer.byteLength === 0) continue
        const data = new Uint8Array(buffer)
        if (isImage) images.push({ name, data, mimeType: contentType })
        else files.push({ name, data })
      } catch (error) {
        this.log(`附件下载失败（降级跳过）: ${(error as Error).message}`)
      }
    }
    if (images.length > 0) message.images = images
    if (files.length > 0) message.files = files
  }

  // —— 出站 ——————————————————————————————————————————

  /** 表格转竖排后发送；markdown 是内建渲染，无格式拒收路径。 */
  async reply(address: ChatAddress, text: string, signal?: AbortSignal): Promise<Receipt> {
    const value = await this.rest(
      'POST',
      `/channels/${address.chatId}/messages`,
      { content: capLength(convertMarkdownTables(text)), allowed_mentions: { parse: [] } },
      signal,
    ) as { id?: string }
    return typeof value?.id === 'string' ? { platformMessageId: value.id, uncertain: false } : { uncertain: false }
  }

  /** 占位 + PATCH 编辑流式；"Unknown message" → 补发接替。 */
  async beginStream(address: ChatAddress, signal?: AbortSignal): Promise<ReplyStream> {
    let messageId: string | undefined
    let lastEditAt = 0
    let pending: Promise<void> = Promise.resolve()
    let aborted = false
    const send = async (text: string): Promise<void> => {
      const created = (await this.rest(
        'POST',
        `/channels/${address.chatId}/messages`,
        { content: capLength(convertMarkdownTables(text)), allowed_mentions: { parse: [] } },
        signal,
      )) as { id?: string }
      messageId = typeof created?.id === 'string' ? created.id : undefined
    }
    const edit = async (text: string): Promise<void> => {
      if (messageId === undefined) return send(text)
      try {
        await this.rest(
          'PATCH',
          `/channels/${address.chatId}/messages/${messageId}`,
          { content: capLength(convertMarkdownTables(text)) },
          signal,
        )
      } catch (error) {
        if (error instanceof DiscordUncertainError) throw error
        if (error instanceof DiscordApiError && error.status === 404) return send(text)
        if (error instanceof DiscordApiError && error.status === 400 && /unknown message/i.test(error.message)) {
          return send(text)
        }
        // 内容校验被拒等：补发接替，编辑链恢复用新 id。
        return send(text)
      }
    }
    const queued = (text: string): Promise<void> => {
      pending = pending.then(async () => {
        if (aborted) return
        const wait = EDIT_THROTTLE_MS - (Date.now() - lastEditAt)
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
        lastEditAt = Date.now()
        await edit(text)
      })
      return pending
    }
    return {
      async update(markdown: string): Promise<void> {
        await queued(markdown)
      },
      async finish(markdown: string): Promise<Receipt> {
        await queued(markdown)
        return messageId === undefined ? { uncertain: false } : { platformMessageId: messageId, uncertain: false }
      },
      abort(): void {
        aborted = true
      },
    }
  }

  async setTyping(address: ChatAddress): Promise<void> {
    try {
      await this.rest('POST', `/channels/${address.chatId}/typing`)
    } catch (error) {
      if (error instanceof DiscordUncertainError) return
      this.log(`discord typing 失败: ${(error as Error).message}`)
    }
  }

  /** 准入库归网关 dmAllowlist（红线 D6），渠道不越权。 */
  authorize(): boolean | undefined {
    return undefined
  }

  async diagnose(signal?: AbortSignal): Promise<ChannelDiagnosisCheck[]> {
    const checks: ChannelDiagnosisCheck[] = []
    const start = Date.now()
    try {
      const me = (await this.rest('GET', '/users/@me', undefined, signal)) as { username?: string }
      checks.push({ name: 'token-valid', status: 'passed', hint: me.username, elapsedMs: Date.now() - start })
    } catch (error) {
      const uncertain = error instanceof DiscordUncertainError || (error instanceof DiscordApiError && error.status === 429)
      checks.push({
        name: 'token-valid',
        status: uncertain ? 'unverified' : 'failed',
        hint: uncertain ? '网络/限流不确定，稍后复测' : 'token 无效或应用被禁用',
        elapsedMs: Date.now() - start,
      })
    }
    checks.push({
      name: 'gateway-session',
      status: this.connected ? 'passed' : 'unverified',
      hint: this.connected ? `seq=${this.lastSeq ?? 'n/a'}` : '未连接',
    })
    // 文件面依赖频道「Attach Files」权限（与 token 不同层），本层无法事前实证。
    checks.push({
      name: 'file-surface',
      status: 'unverified',
      hint: '出站上传需目标频道 Attach Files 权限；首次文件发送时由 4xx 判定',
    })
    return checks
  }

  /**
   * 文件回传：multipart/form-data（payload_json + files[0]）——走可注入 fetch 面。
   * 限额不在本层重定（引擎 FILE_BUDGET 已裁）；语义同 rest()：
   * 网络/5xx = DiscordUncertainError（禁重发）；4xx = DiscordApiError。
   */
  async sendFile(address: ChatAddress, file: OutboundFile, signal?: AbortSignal): Promise<Receipt> {
    const boundary = `----imu${Date.now().toString(16)}`
    const payload = JSON.stringify({ content: file.name, allowed_mentions: { parse: [] } })
    const body = buildMultipart(
      [{ name: 'payload_json', value: payload }],
      { field: 'files[0]', filename: file.name, mimeType: file.mimeType ?? 'application/octet-stream', data: file.data },
      boundary,
    )
    const path = `/channels/${address.chatId}/messages`
    let response: FetchResponseLike
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method: 'POST',
        headers: { authorization: `Bot ${this.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
        body,
        signal: signal ?? this.closeController.signal,
      })
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error
      throw new DiscordUncertainError(`discord sendFile POST ${path}: 网络异常 ${(error as Error).message}`)
    }
    if (response.status >= 500) throw new DiscordUncertainError(`discord sendFile POST ${path}: HTTP ${response.status}`)
    const created = (await response.json().catch(() => undefined)) as { id?: string; message?: string } | undefined
    if (created === undefined) {
      throw new DiscordUncertainError(`discord sendFile POST ${path}: 回包不可解析（结果不明）`)
    }
    if (!response.ok) throw new DiscordApiError(`discord sendFile: ${created.message ?? `HTTP ${response.status}`}`, response.status)
    return typeof created.id === 'string' ? { platformMessageId: created.id, uncertain: false } : { uncertain: false }
  }
}

function capLength(text: string): string {
  if (text.length <= DISCORD_MAX_MESSAGE) return text
  return `${text.slice(0, DISCORD_MAX_MESSAGE - 1)}…`
}

/**
 * 被引用消息 → 引用正文（T3.6）：无文本（纯附件/贴纸等）回 undefined，
 * 不编造占位（引擎侧 mergeQuote 会因此保持现状）。作者名可选（global_name 优先）。 */
function quoteBodyOf(message: DiscordMessageLike | undefined): string | undefined {
  const content = typeof message?.content === 'string' ? message.content.trim() : ''
  if (content === '') return undefined
  const globalName = typeof message?.author?.global_name === 'string' ? (message.author.global_name as string) : ''
  const username = typeof message?.author?.username === 'string' ? (message.author.username as string) : ''
  const author = globalName !== '' ? globalName : username
  return author === '' ? content : `${author}: ${content}`
}

/** 极简 multipart（零依赖）：先文本字段，后文件部分。 */
function buildMultipart(
  fields: Array<{ name: string; value: string }>,
  file: { field: string; filename: string; mimeType: string; data: Uint8Array },
  boundary: string,
): Uint8Array {
  const parts: Buffer[] = []
  for (const field of fields) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`,
        'utf8',
      ),
    )
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename.replace(/"/g, '')}"\r\n` +
        `Content-Type: ${file.mimeType}\r\n\r\n`,
      'utf8',
    ),
  )
  parts.push(Buffer.from(file.data))
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'))
  return Buffer.concat(parts)
}

/**
 * Markdown 表格转竖排（Discord 客户端不渲染表格）：
 * 每数据行变「字段: 值」多行块，行间空行分隔。非表格文本原样返回。
 */
export function convertMarkdownTables(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const header = lines[i]
    const sep = lines[i + 1]
    if (isTableRow(header) && isTableSeparator(sep)) {
      const heads = parseRow(header)
      i += 2
      while (i < lines.length && isTableRow(lines[i])) {
        const cells = parseRow(lines[i])
        const block: string[] = []
        for (let c = 0; c < cells.length; c += 1) {
          const h = heads[c] !== undefined && heads[c] !== '' ? heads[c] : `列${c + 1}`
          block.push(`${h}: ${cells[c]}`)
        }
        out.push(`【${cells[0] ?? ''}】`)
        out.push(...block.slice(1))
        i += 1
      }
      continue
    }
    out.push(lines[i])
    i += 1
  }
  return out.join('\n')
}

function isTableRow(line: string | undefined): boolean {
  return typeof line === 'string' && line.trim().startsWith('|') && line.trim().endsWith('|')
}

function isTableSeparator(line: string | undefined): boolean {
  return typeof line === 'string' && /^\|[\s:|-]+\|?$/.test(line.trim())
}

function parseRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/** 工厂挂 registry（动态 import 后由 index.ts 调用）。 */
export function createDiscordAdapter(options: {
  accountId: string
  config: Record<string, string>
  secrets: Record<string, string | undefined>
  /** 生命周期日志出口（`ChannelFactory` 契约字段）；不接则 Gateway 断开等日志静默。 */
  logger?: (msg: string) => void
}): DiscordAdapter {
  const token = options.secrets.botToken
  if (typeof token !== 'string' || token === '') {
    throw new Error(`discord 账号 ${options.accountId}: botToken 未入库（检查凭据配置）`)
  }
  const apiBase = options.config.apiBaseUrl
  return new DiscordAdapter({
    token,
    ...(apiBase !== undefined && apiBase !== '' ? { apiBase } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  })
}

interface DiscordMessageLike {
  channel_id?: string
  guild_id?: string | null
  author?: { id?: string; username?: string; global_name?: string | null }
  content?: string
  timestamp?: string
  mentions?: Array<{ id?: string } | undefined>
  attachments?: Array<{ id?: string; filename?: string; content_type?: string; url?: string; proxy_url?: string; size?: number }>
  /** 引用定位（公开面 Message Reference Object）：message_id/channel_id 为字符串雪花 id。 */
  message_reference?: { type?: number; message_id?: string; channel_id?: string; guild_id?: string }
  /** DEFAULT(0) 引用的耦合消息体（被引用消息在网关缓存内时才带）。 */
  referenced_message?: DiscordMessageLike
  /** FORWARD(1) 转发的耦合快照。 */
  message_snapshot?: { message?: DiscordMessageLike }
}
