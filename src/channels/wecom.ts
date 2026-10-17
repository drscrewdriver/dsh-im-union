/**
 * 企业微信「智能机器人」渠道适配器（M1 P0，T1.6）。
 *
 * 协议事实（长连接模式公开规范独立重实现，净室口径，文档 path/101463）：
 * - 连接：wss://openws.work.weixin.qq.com → 订阅帧 aibot_subscribe
 *   （body {bot_id, secret}，req_id 开发者自生成）；响应帧无 cmd、带
 *   errcode/errmsg/headers.req_id（errcode=0 即订阅成功）。
 * - 心跳：{cmd:"ping", headers:{req_id}}，建议 30s 间隔；服务端超时主动断开。
 * - 入站：aibot_msg_callback（body: msgid/aibotid/chatid(仅群)/chattype
 *   single|group/from.userid/msgtype/text.content）；
 *   aibot_event_callback（enter_chat / template_card_event /
 *   feedback_event / disconnected_event）。
 * - 群触发即协议事实：长连接模式只在「群里 @机器人」或「单聊发消息」时回调，
 *   所以群回调 mentionedBot 恒 true；text.content 带 "@RobotA " 前缀需剥离。
 * - 回复绑定：aibot_respond_msg 必须透传原回调的 req_id（同一回调的所有
 *   流式发送与刷新共用该 req_id；stream.id 标识同一条流式消息，
 *   finish=true 结束，首次发送起 10 分钟内必须 finish）。
 * - 主动推送：aibot_send_msg（chatid + chat_type 1单聊/2群聊，markdown）；
 *   前提是用户先在会话里给机器人发过消息。
 * - 频率：每会话 30 条/分钟、1000 条/小时；markdown content ≤20480 字节。
 * - 单连接排他：同一机器人新订阅踢旧连接，旧连接收 disconnected_event
 *   ——被踢后禁自动重连（防互踢乒乓）。
 *
 * 首档诚实能力位：纯文本/markdown 收发 + stream 编辑流式；
 * 图片入站（url+aeskey AES-256-CBC 解密，密钥编码细节待真机核）、模板卡片
 * 按钮、文件（需 REST 上传临时素材，长连接 bot 无 corpid 面）均声明 false。
 *
 * 运行时依赖零：Node≥22 全局 WebSocket；测试注入 WebSocketImpl。
 */
import type { ChatAddress } from '../engine/router.js'
import type {
  ChannelAdapter,
  ChannelCaps,
  ChannelDiagnosisCheck,
  MessageListener,
  Receipt,
  ReplyStream,
  SemanticMessage,
} from './types.js'

const WS_URL = 'wss://openws.work.weixin.qq.com'
const HEARTBEAT_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000
const STREAM_THROTTLE_MS = 1_100
/** markdown 20480 字节上限，按中文 3 字节/字留余量。 */
const WECOM_MAX_MESSAGE = 6000

interface WSLike {
  send(data: string): void
  close(): void
  addEventListener(type: string, cb: (event: any) => void): void
  readyState: number
}
type WSFactory = (url: string) => WSLike

/** 线协议帧（收发共用，宽松形）。 */
interface WecomFrame {
  cmd?: string
  headers?: { req_id?: string }
  errcode?: number
  errmsg?: string
  body?: Record<string, any>
}

export interface WecomAdapterOptions {
  botId: string
  secret: string
  wsUrl?: string
  WebSocketImpl?: WSFactory
  heartbeatMs?: number
  requestTimeoutMs?: number
  logger?: (msg: string) => void
}

/** errcode≠0 的确定性失败（服务端明确拒绝，可安全告知/不改内容重试）。 */
export class WecomApiError extends Error {
  constructor(
    message: string,
    readonly errcode: number,
  ) {
    super(message)
  }
}
/** 结果不明（超时/断连）——D7：禁自动重发。 */
export class WecomUncertainError extends Error {}

export class WecomAdapter implements ChannelAdapter {
  readonly id = 'wecom'
  readonly label = '企业微信'
  readonly caps: ChannelCaps = {
    editStream: true,
    nativeStream: false,
    nativeChoices: false,
    statusReaction: false,
    typing: false,
    imageIn: false,
    fileIn: false,
    fileOut: false,
    threads: false,
    voice: false,
    maxMessageLength: WECOM_MAX_MESSAGE,
  }

  connected = false
  /** 被新连接踢掉（disconnected_event）——置位后禁自动重连防互踢乒乓。 */
  kicked = false
  private readonly botId: string
  private readonly secret: string
  private readonly wsUrl: string
  private readonly wsFactory: WSFactory
  private readonly heartbeatMs: number
  private readonly requestTimeoutMs: number
  private readonly log: (msg: string) => void

  private ws: WSLike | undefined
  private listeners: MessageListener[] = []
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private reqSeq = 0
  /** req_id → 响应帧关联（请求-响应面）。 */
  private readonly inflight = new Map<string, { onFrame: (frame: WecomFrame) => void; onBroken: () => void }>()
  /** kind:chatId → 最近一次消息回调的 req_id（respond 必须透传）。 */
  private readonly lastReqId = new Map<string, string>()
  /** msgid 排重（回调可能重放，协议明确要求排重）。 */
  private readonly seenMsgIds = new Set<string>()

  constructor(options: WecomAdapterOptions) {
    if (typeof options.botId !== 'string' || options.botId === '') {
      throw new Error('wecom: botId 缺失（凭据库解析失败或未配置账号）')
    }
    if (typeof options.secret !== 'string' || options.secret === '') {
      throw new Error('wecom: secret 缺失（长连接专用密钥，管理后台获取）')
    }
    this.botId = options.botId
    this.secret = options.secret
    this.wsUrl = options.wsUrl ?? WS_URL
    const globalWS = (globalThis as { WebSocket?: { new (url: string): WSLike } }).WebSocket
    this.wsFactory =
      options.WebSocketImpl ??
      ((url: string) => {
        if (globalWS === undefined) throw new Error('wecom: 宿主 Node 运行时缺全局 WebSocket，无法建长连接')
        return new globalWS(url)
      })
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.log = options.logger ?? (() => {})
  }

  get connectionState(): boolean {
    return this.connected
  }

  async connect(signal?: AbortSignal): Promise<void> {
    this.kicked = false
    await this.openOnce(signal)
  }

  private async openOnce(signal?: AbortSignal): Promise<void> {
    const ws = this.wsFactory(this.wsUrl)
    this.ws = ws
    let settled = false
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }
      const succeed = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      ws.addEventListener('open', () => {
        void (async () => {
          try {
            const reqId = this.newReqId('sub')
            await this.request(
              { cmd: 'aibot_subscribe', headers: { req_id: reqId }, body: { bot_id: this.botId, secret: this.secret } },
              reqId,
              true, // 握手期：connected 尚未置位，允许未就绪态发送
            )
            this.connected = true
            this.startHeartbeat()
            this.scheduleReconnectCleanup()
            succeed()
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)))
          }
        })()
      })
      ws.addEventListener('error', () => fail(new WecomUncertainError('wecom: 长连接建立失败')))
      ws.addEventListener('close', () => {
        this.connected = false
        if (!settled) fail(new WecomUncertainError('wecom: 长连接在订阅完成前关闭'))
      })
      ws.addEventListener('message', (event: { data?: string }) => {
        this.handleFrame(event?.data)
      })
      signal?.addEventListener('abort', () => fail(new Error('wecom: connect aborted')), { once: true })
    })
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat()
    this.connected = false
    // 拆除期禁重连：close 事件里走不到重连分支。
    this.kicked = true
    for (const [, waiter] of this.inflight) {
      // 在途请求随连接拆除结果不明——按 uncertain 终结（D7），不伪装确定性失败。
      waiter.onBroken()
    }
    this.inflight.clear()
    this.ws?.close()
    this.ws = undefined
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  // —— 入站 ——————————————————————————————————————————

  private handleFrame(raw: string | undefined): void {
    if (typeof raw !== 'string' || raw === '') return
    let frame: WecomFrame
    try {
      frame = JSON.parse(raw) as WecomFrame
    } catch {
      this.log('wecom: 收到非法 JSON 帧，忽略')
      return
    }
    const reqId = frame.headers?.req_id
    // 响应帧：无 cmd、带 errcode，按 req_id 关联。
    if (frame.cmd === undefined && reqId !== undefined) {
      const waiter = this.inflight.get(reqId)
      if (waiter !== undefined) {
        this.inflight.delete(reqId)
        waiter.onFrame(frame)
      }
      return
    }
    if (frame.cmd === 'aibot_msg_callback') {
      this.handleMsgCallback(frame)
      return
    }
    if (frame.cmd === 'aibot_event_callback') {
      const eventtype = frame.body?.event?.eventtype
      if (eventtype === 'disconnected_event') {
        // 被新连接踢掉：置位禁重连（协议单连接排他，重连会反向踢掉新连接）。
        this.kicked = true
        this.log('wecom: 被新连接踢掉（disconnected_event），本适配器停止重连')
      }
      // enter_chat 等事件首档不响应（欢迎语非必需）。
      return
    }
  }

  private handleMsgCallback(frame: WecomFrame): void {
    const body = frame.body ?? {}
    const msgid = typeof body.msgid === 'string' ? body.msgid : ''
    if (msgid !== '') {
      if (this.seenMsgIds.has(msgid)) return
      this.seenMsgIds.add(msgid)
      if (this.seenMsgIds.size > 500) {
        const first = this.seenMsgIds.values().next().value
        if (typeof first === 'string') this.seenMsgIds.delete(first)
      }
    }
    const reqId = frame.headers?.req_id
    const message = this.normalize(body)
    if (message === undefined) return
    if (typeof reqId === 'string') {
      this.lastReqId.set(`${message.address.kind}:${message.address.chatId}`, reqId)
    }
    for (const listener of this.listeners) listener(message)
  }

  /** 回调 body → SemanticMessage（导出供单测直验）。 */
  normalize(body: Record<string, any>): SemanticMessage | undefined {
    const chattype = body.chattype === 'group' ? 'group' : 'single'
    const userid = typeof body.from?.userid === 'string' ? body.from.userid : ''
    if (userid === '' && chattype !== 'group') return undefined
    const chatId = chattype === 'group' ? String(body.chatid ?? '') : userid
    if (chatId === '') return undefined
    const address: ChatAddress = { channel: 'wecom', kind: chattype === 'group' ? 'group' : 'dm', chatId }
    let text = ''
    if (body.msgtype === 'text') text = String(body.text?.content ?? '')
    else text = `[暂不支持的消息类型：${String(body.msgtype ?? 'unknown')}]`
    // 群回调的 content 带 "@RobotA " 前缀（协议事实：群触发即 @机器人），剥离。
    if (chattype === 'group') text = text.replace(/^@\S+\s+/, '').trimStart()
    // 长连接模式只在「群 @机器人」或「单聊」时回调——群回调即被点名。
    const mentionedBot = chattype === 'group'
    // 非文本占位文案不丢事件（与 feishu 同纪律）。
    if (body.msgtype === 'image') text = '[图片输入首档未启用（aeskey 解密待真机核）]'
    const semantic: SemanticMessage = {
      address,
      userId: userid,
      text,
      mentionedBot,
      timestamp: typeof body.create_time === 'number' ? body.create_time * 1000 : undefined,
    }
    return semantic
  }

  // —— 出站 ——————————————————————————————————————————

  async reply(address: ChatAddress, text: string, signal?: AbortSignal): Promise<Receipt> {
    const reqId = this.reqIdForReply(address)
    const frame: WecomFrame =
      reqId === undefined
        ? {
            // 无回调上下文 → 主动推送（前提：用户此前发过消息，协议事实）。
            cmd: 'aibot_send_msg',
            headers: { req_id: this.newReqId('push') },
            body: {
              chatid: address.chatId,
              chat_type: address.kind === 'group' ? 2 : 1,
              msgtype: 'markdown',
              markdown: { content: text },
            },
          }
        : {
            cmd: 'aibot_respond_msg',
            headers: { req_id: reqId },
            body: { msgtype: 'markdown', markdown: { content: text } },
          }
    void signal
    return this.sendFrame(frame)
  }

  /**
   * 流式 = aibot_respond_msg stream 模式：首个 update 用 stream.id 创建流式
   * 消息，同 id 推送刷新，finish=true 结束（10 分钟硬限由引擎看门狗对齐）。
   * 该回合所有帧共用回调透传的 req_id。
   */
  async beginStream(address: ChatAddress, signal?: AbortSignal): Promise<ReplyStream> {
    const reqId = this.reqIdForReply(address)
    if (reqId === undefined) throw new Error('wecom: 流式回复缺少回调 req_id（仅能回复触发消息的会话）')
    const streamId = this.newReqId('stream')
    let lastSentAt = 0
    let pending: Promise<void> = Promise.resolve()
    let aborted = false
    let everSent = false
    const push = async (content: string, finish: boolean): Promise<void> => {
      const frame: WecomFrame = {
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'stream', stream: { id: streamId, finish, content } },
      }
      await this.sendFrame(frame)
      everSent = true
    }
    const queued = (content: string, finish: boolean): Promise<void> => {
      pending = pending.then(async () => {
        if (aborted && !finish) return
        if (!finish) {
          const wait = STREAM_THROTTLE_MS - (Date.now() - lastSentAt)
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
        }
        lastSentAt = Date.now()
        await push(content, finish)
      })
      return pending
    }
    void signal
    return {
      async update(markdown: string): Promise<void> {
        await queued(markdown, false)
      },
      async finish(markdown: string): Promise<Receipt> {
        await queued(markdown, true)
        return { platformMessageId: everSent ? streamId : undefined, uncertain: false }
      },
      abort(): void {
        aborted = true
      },
    }
  }

  private reqIdForReply(address: ChatAddress): string | undefined {
    return this.lastReqId.get(`${address.kind}:${address.chatId}`)
  }

  private newReqId(prefix: string): string {
    this.reqSeq += 1
    return `${prefix}_${Date.now().toString(36)}_${this.reqSeq}`
  }

  /** 发一帧并等待该 req_id 的响应；errcode≠0 确定性抛，超时/断连 uncertain。 */
  private async sendFrame(frame: WecomFrame): Promise<Receipt> {
    const reqId = frame.headers?.req_id ?? ''
    await this.request(frame, reqId)
    return { uncertain: false }
  }

  private request(frame: WecomFrame, reqId: string, preHandshake = false): Promise<WecomFrame> {
    const ws = this.ws
    if (ws === undefined || (!this.connected && !preHandshake)) {
      return Promise.reject(new WecomUncertainError('wecom: 长连接未就绪，发送结果不确定'))
    }
    return new Promise<WecomFrame>((resolve, reject) => {
      let settled = false
      const broken = (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.inflight.delete(reqId)
        reject(error)
      }
      const timer = setTimeout(() => {
        broken(new WecomUncertainError(`wecom: 等待响应超时（req_id=${reqId}），结果不确定`))
      }, this.requestTimeoutMs)
      this.inflight.set(reqId, {
        onFrame: (response) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.inflight.delete(reqId)
          if (response.errcode !== undefined && response.errcode !== 0) {
            reject(new WecomApiError(`wecom: ${String(response.errmsg ?? 'errcode ' + response.errcode)}`, response.errcode))
          } else {
            resolve(response)
          }
        },
        onBroken: () => {
          broken(new WecomUncertainError('wecom: 连接拆除时在途请求结果不确定'))
        },
      })
      try {
        ws.send(JSON.stringify(frame))
      } catch (error) {
        broken(new WecomUncertainError(`wecom: 发送失败（${String(error)}），结果不确定`))
      }
    })
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      const ws = this.ws
      if (ws === undefined || !this.connected) return
      try {
        ws.send(JSON.stringify({ cmd: 'ping', headers: { req_id: this.newReqId('hb') } }))
      } catch {
        this.log('wecom: 心跳发送失败，等待 close 事件走重连')
      }
    }, this.heartbeatMs)
    this.heartbeat.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  /** close 后的自动重连（指数退避）；被踢/主动拆除不重连。 */
  private scheduleReconnectCleanup(): void {
    const ws = this.ws
    if (ws === undefined) return
    let backoff = 1000
    const attempt = (): void => {
      if (this.kicked) return
      void this.openOnce()
        .then(() => {
          this.log('wecom: 长连接已恢复')
          this.scheduleReconnectCleanup()
        })
        .catch(() => {
          setTimeout(() => attempt(), backoff)
          backoff = Math.min(backoff * 2, 30_000)
        })
    }
    ws.addEventListener('close', () => {
      this.connected = false
      this.stopHeartbeat()
      if (!this.kicked) attempt()
    })
  }

  // —— 诊断三态 ——————————————————————————————————————————

  async diagnose(): Promise<ChannelDiagnosisCheck[]> {
    const checks: ChannelDiagnosisCheck[] = [
      {
        name: 'credentials',
        status: this.botId !== '' && this.secret !== '' ? 'passed' : 'failed',
        hint: 'Bot ID / Secret 在企微管理后台「智能机器人 → API 模式（长连接）」获取',
      },
      {
        name: 'connection',
        status: this.connected ? 'passed' : this.kicked ? 'failed' : 'unverified',
        hint: this.kicked ? '本连接已被新连接踢掉（单连接排他），请检查是否有另一实例在跑' : undefined,
      },
      {
        name: 'roundtrip',
        status: 'unverified',
        hint: '收发 round-trip 需真机（企微客户端给机器人发消息）验证',
      },
    ]
    return checks
  }
}

export function createWecomAdapter(options: {
  accountId: string
  config: Record<string, string>
  secrets: Record<string, string | undefined>
}): WecomAdapter {
  const botId = options.secrets.botId ?? ''
  const secret = options.secrets.secret ?? ''
  return new WecomAdapter({
    botId,
    secret,
    ...(options.config.wsUrl !== undefined ? { wsUrl: options.config.wsUrl } : {}),
  })
}
