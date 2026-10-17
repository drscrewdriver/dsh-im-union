/**
 * Slack 渠道适配器（T2.3：Socket Mode 零 SDK + thread 模型 + mrkdwn 转换）。
 *
 * 净室口径：以下协议事实全部取自 Slack 公开文档独立重实现，未参考任何第三方
 * SDK 源码结构；运行时依赖为零（Node≥22 全局 fetch / WebSocket，测试注入 fake）。
 *
 * 协议事实（公开文档）：
 * - Socket Mode 总览/信封帧：https://api.slack.com/apis/connections/socket
 *   （现网镜像 https://docs.slack.dev/apis/events-api/using-socket-mode）
 *   两步式：先用 App Level Token（xapp-）POST apps.connections.open 换取一次性
 *   wss:// 临时 URL，再建 WS；首帧 type:"hello"；事件帧 type:"events_api" 必须在
 *   3s 内回 ACK 帧（文档形：`{"envelope_id":"…","payload":{}}`，服务端未收到 ACK
 *   会重投同一 envelope_id，因此 envelope_id 兼作排重键）。
 *   服务端回收指令 type:"disconnect"（reason=link_disabled|warning|refresh_requested）
 *   需要重连；type:"canary"（reason_code）同类，见下方注释的诚实标注。
 * - apps.connections.open：https://api.slack.com/methods/apps.connections.open
 *   POST、token 必须走 Authorization 头（作 POST 参数会被拒），content-type 支持
 *   json/form；成功响应 `{"ok":true,"url":"wss://wss.slack.com/link/?ticket=…"}`；
 *   Tier 3（50+/min）——所以本适配器只在建连/重连时调用。
 * - 事件载荷形（Events API event_callback）：
 *   https://api.slack.com/events-api / https://api.slack.com/events/message
 *   `payload` 是单个事件对象（带 event_id/event_type/event_ts），不是事件数组；
 *   message 事件 `{type:"message",channel,user,text,ts,channel_type}`，
 *   thread 内回复额外带 `thread_ts`（thread_ts !== ts 即为线程内消息）。
 * - 出站：https://api.slack.com/methods/chat.postMessage（channel/text/thread_ts/
 *   blocks，bot scope chat:write；正文「超过 40000 字符会被截断」→ 长度上限取 40000）
 *   与 https://api.slack.com/methods/chat.update（必填 channel+ts，bot 可编辑自己
 *   发的消息，线程内消息同样可编辑 → 编辑流式成立）。
 *   ⚠ 判定必须看响应体 `ok` 字段：Slack 即使 HTTP 200 也会返回
 *   `{"ok":false,"error":"…"}`，只看 HTTP 状态会把业务失败当成功。
 * - 速率：https://api.slack.com/apis/rate-limits —— chat.postMessage 属 Tier 4，
 *   实践上限「每频道约 1 条/秒」（可短时突发）；编辑流式节流取 ≥1.1s。
 *   `rate_limited`/`ratelimited` 是服务端明确拒绝（HTTP 429 + Retry-After），
 *   属确定性可告知错误，不是结果不明。
 * - 鉴权实探：https://api.slack.com/methods/auth.test —— bot token 成功响应带
 *   `{ok:true,url,team,user,team_id,user_id,bot_id}`；mention 语法用的是 bot 的
 *   user id（`<@U…>`，见 https://api.slack.com/reference/messaging/threading 与
 *   formatting 文档的 mentioning-users），故自检同时比对 user_id 与 bot_id。
 * - 消息格式 mrkdwn：https://api.slack.com/reference/surfaces/formatting
 *   （现网镜像 https://docs.slack.dev/messaging/formatting-message-text）——
 *   `*bold*`、`_italic_`、`~strike~`、`<url|label>`、行内代码/围栏代码块与
 *   markdown 一致；**没有标题语法、没有表格渲染**。
 *
 * 能力位（声明=真实现）：编辑流式（chat.update）成立；原生流式（chat.startStream）
 * 首版不接；Block Kit 按钮、typing API、文件收发、reactions 首版均不接（详见 caps）。
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

const API_BASE = 'https://slack.com/api'
/** chat.postMessage 实践上限每频道 1 条/秒，留 100ms 余量。 */
const EDIT_THROTTLE_MS = 1_100
/** https://api.slack.com/methods/chat.postMessage：>40000 字符服务端截断。 */
const SLACK_MAX_MESSAGE = 40_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/** envelope 排重表上限（Socket Mode 重投窗口有限，环形淘汰足够）。 */
const SEEN_LIMIT = 500

/** 可注入的 fetch 形态（只声明用到的能力）。 */
type FetchLike = (
  url: string,
  init?: RequestInitLike,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
interface RequestInitLike {
  method?: string
  body?: string
  headers?: Record<string, string>
  signal?: AbortSignal
}

interface WSLike {
  send(data: string): void
  close(): void
  addEventListener(type: string, cb: (event: any) => void): void
  readyState: number
}
type WSFactory = (url: string) => WSLike

/** Socket Mode 线帧（宽松形）：hello / disconnect / canary / events_api / interactive / slash_commands。 */
interface SlackFrame {
  type?: string
  envelope_id?: string
  accepts_response_payload?: boolean
  reason?: string
  reason_code?: string
  debug_info?: { approximate_connection_time?: number; host?: string }
  connection_info?: { app_id?: string }
  num_connections?: number
  payload?: any
}

/** Events API 事件体（宽松形）。 */
interface SlackEvent {
  type?: string
  channel?: string
  channel_type?: string
  user?: string
  text?: string
  ts?: string
  thread_ts?: string
  bot_id?: string
  subtype?: string
  username?: string
  event_id?: string
  files?: Array<{ name?: string; title?: string; mimetype?: string }>
  attachments?: unknown[]
}

export interface SlackAdapterOptions {
  /** Bot User OAuth Token（xoxb-），出站 Web API 用。 */
  botToken: string
  /** App Level Token（xapp-，含 connections:read），Socket Mode 用。 */
  appToken: string
  apiBase?: string
  /** 测试注入点；缺省用全局 fetch。 */
  fetchImpl?: FetchLike
  /** 测试注入点；缺省用全局 WebSocket。 */
  WebSocketImpl?: WSFactory
  editThrottleMs?: number
  reconnectBaseMs?: number
  logger?: (msg: string) => void
}

/**
 * body.ok=false 且带明确 error 码 —— 服务端明确拒绝，可安全告知用户
 * （含 rate_limited / invalid_auth / channel_not_found / message_not_found…）。
 */
export class SlackApiError extends Error {
  constructor(
    message: string,
    readonly error: string,
  ) {
    super(message)
  }
}

/** 结果不明（网络异常/超时/5xx/无响应体/WS 断连）——D7：引擎禁自动重发。 */
export class SlackUncertainError extends Error {}

// —— mrkdwn 转换 ——————————————————————————————————————————

/** 标准 markdown → Slack mrkdwn；代码段原样保留，标题/表格按 Slack 无该面降级。 */
export function toSlackMrkdwn(markdown: string): string {
  if (markdown === '') return ''
  const store: string[] = []
  const keep = (chunk: string): string => {
    store.push(chunk)
    return `\u0000${store.length - 1}\u0000`
  }
  // 1) 围栏代码块与行内代码：Slack 语法一致，先保护免得被强调规则误伤。
  let out = markdown.replace(/```[\s\S]*?```/g, (m) => keep(m))
  out = out.replace(/`[^`\n]*`/g, (m) => keep(m))
  // 2) 图片 → 链接面（Slack 无内联图片语法，URL 交给 unfurl 预览）。
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt: string, url: string) => keep(link(url, alt)))
  // 3) 链接 [text](url) → <url|text>（Slack 手工链接形）。
  out = out.replace(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, text: string, url: string) => keep(link(url, text)))
  // 4) 标题：Slack 无标题语法 → 整行加粗（剥掉内层强调，避免嵌套星号失真）。
  out = out.replace(/^#{1,6}[ \t]*(.+?)[ \t]*$/gm, (_m, text: string) => keep(`*${text.replace(/[*_~]/g, '')}*`))
  // 5) 表格：Slack 不渲染 markdown 表格 → 转竖排「*表头*: 值」逐行（独立实现）。
  out = convertMarkdownTables(out, keep)
  // 6) 删除线 ~~x~~ → ~x~。
  out = out.replace(/~~([^~\n]+)~~/g, (_m, text: string) => `~${text}~`)
  // 7) 粗体 **x** → *x*（结果保护，免得再被下一步单星号斜体吃掉）。
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, text: string) => keep(`*${text}*`))
  // 8) 斜体 *x* → _x_，__x__ → _x_（Slack 斜体是下划线对）。
  out = out.replace(/\*([^*\n]+)\*/g, (_m, text: string) => `_${text}_`)
  out = out.replace(/__([^_\n]+)__/g, (_m, text: string) => `_${text}_`)
  // 9) 还原占位（多轮：占位内容里可能嵌占位）。
  let prev = ''
  let cur = out
  while (cur !== prev) {
    prev = cur
    cur = cur.replace(/\u0000(\d+)\u0000/g, (_m, idx: string) => store[Number(idx)] ?? '')
  }
  return cur
}

function link(url: string, label: string): string {
  const text = label.trim()
  return text === '' ? `<${url}>` : `<${url}|${text}>`
}

const isTableRow = (line: string | undefined): boolean =>
  typeof line === 'string' && line.trim().startsWith('|') && line.includes('|', line.indexOf('|') + 1)

const isTableSeparator = (line: string | undefined): boolean =>
  typeof line === 'string' && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)

function parseRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/** 表格块 → `*表头*: 值` 竖排（表头缺失时退化为 `列N`）；加粗标记走 keep 保护。 */
function convertMarkdownTables(text: string, keep: (chunk: string) => string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let index = 0
  while (index < lines.length) {
    if (isTableRow(lines[index]) && isTableSeparator(lines[index + 1])) {
      const header = parseRow(lines[index])
      index += 2
      const rows: string[][] = []
      while (index < lines.length && isTableRow(lines[index])) {
        rows.push(parseRow(lines[index]))
        index += 1
      }
      for (const row of rows) {
        for (let col = 0; col < row.length; col += 1) {
          const key = header[col] !== undefined && header[col] !== '' ? header[col] : `列${col + 1}`
          if (row[col] === '') continue
          out.push(`${keep(`*${key}*`)}: ${row[col]}`)
        }
        out.push('')
      }
      continue
    }
    out.push(lines[index])
    index += 1
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 明确「消息不在了/不可编辑」——走补发接替路径，不算投递失败。 */
function isMessageGone(error: SlackApiError): boolean {
  return /^(message_not_found|message_deleted|not_found|invalid_ts|cant_update_message|cannot_edit_a_message_from_other_user)$/i.test(
    error.error,
  )
}

export class SlackAdapter implements ChannelAdapter {
  readonly id = 'slack'
  readonly label = 'Slack'
  readonly caps: ChannelCaps = {
    editStream: true,
    nativeStream: false,
    nativeChoices: false,
    statusReaction: false,
    typing: false,
    imageIn: false,
    fileIn: false,
    fileOut: false,
    threads: true,
    voice: false,
    maxMessageLength: SLACK_MAX_MESSAGE,
  }

  connected = false
  private readonly botToken: string
  private readonly appToken: string
  private readonly apiBase: string
  private readonly fetchImpl: FetchLike
  private readonly wsFactory: WSFactory
  private readonly editThrottleMs: number
  private readonly reconnectBaseMs: number
  private readonly log: (msg: string) => void

  private ws: WSLike | undefined
  private listeners: MessageListener[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private leaseTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempts = 0
  /** 主动 disconnect() 置位：拆除期禁重连。 */
  private stopped = false
  /** auth.test 结果：mention 自检用（bot 的 user id 形如 U…/W…，bot_id 形如 B…）。 */
  private botUserId = ''
  private botId = ''
  /** envelope_id（回退 event_id）排重：Socket Mode 未 ACK 会在 3s 后重投。 */
  private readonly seenKeys = new Set<string>()

  constructor(options: SlackAdapterOptions) {
    if (typeof options.botToken !== 'string' || options.botToken === '') {
      throw new Error('slack: botToken 缺失（xoxb- Bot User OAuth Token）')
    }
    if (typeof options.appToken !== 'string' || options.appToken === '') {
      throw new Error('slack: appToken 缺失（xapp- App Level Token，Socket Mode 必需）')
    }
    this.botToken = options.botToken
    this.appToken = options.appToken
    this.apiBase = options.apiBase ?? API_BASE
    this.fetchImpl = options.fetchImpl ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike)
    const globalWS = (globalThis as { WebSocket?: { new (url: string): WSLike } }).WebSocket
    this.wsFactory =
      options.WebSocketImpl ??
      ((url: string) => {
        if (globalWS === undefined) throw new SlackUncertainError('slack: 宿主运行时缺全局 WebSocket，无法建 Socket Mode 连接')
        return new globalWS(url)
      })
    this.editThrottleMs = options.editThrottleMs ?? EDIT_THROTTLE_MS
    this.reconnectBaseMs = options.reconnectBaseMs ?? RECONNECT_BASE_MS
    this.log = options.logger ?? (() => {})
  }

  // —— 连接生命周期 ——————————————————————————————————————

  async connect(signal?: AbortSignal): Promise<void> {
    this.stopped = false
    // 1) auth.test（bot token）：拿 bot 身份，供入站 mentionedBot 自检。
    await this.ensureIdentity(signal)
    // 2) apps.connections.open（app token）+ WS：hello 即 app token 面可用的实证。
    await this.openSocket(signal)
  }

  async disconnect(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    if (this.leaseTimer !== undefined) clearTimeout(this.leaseTimer)
    this.leaseTimer = undefined
    const ws = this.ws
    this.ws = undefined
    this.connected = false
    try {
      ws?.close()
    } catch {
      /* 关闭失败无副作用 */
    }
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  private async ensureIdentity(signal?: AbortSignal): Promise<void> {
    if (this.botUserId !== '' || this.botId !== '') return
    const result = await this.api('auth.test', {}, this.botToken, signal)
    this.botUserId = str(result.user_id)
    this.botId = str(result.bot_id)
  }

  private async openSocket(signal?: AbortSignal): Promise<void> {
    // App Level Token 只能走 Authorization 头（作文档明确的错误用法会被拒）。
    const opened = await this.api('apps.connections.open', {}, this.appToken, signal)
    const url = str(opened.url)
    if (url === '') throw new SlackUncertainError('slack: apps.connections.open 未返回 socket url，结果不明')
    const ws = this.wsFactory(url)
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        this.connected = false
        reject(error)
      }
      const succeed = (): void => {
        if (settled) return
        settled = true
        this.connected = true
        this.reconnectAttempts = 0
        resolve()
      }
      ws.addEventListener('message', (event: { data?: string }) => {
        this.handleFrame(event?.data, succeed)
      })
      ws.addEventListener('error', () => fail(new SlackUncertainError('slack: Socket Mode 建连失败')))
      ws.addEventListener('close', () => {
        this.connected = false
        if (this.ws !== ws) return // 陈旧 socket（已重开/已拆除），不参与重连判定
        if (!settled) {
          fail(new SlackUncertainError('slack: Socket Mode 在收到 hello 前被关闭'))
          return
        }
        this.scheduleReconnect()
      })
      signal?.addEventListener('abort', () => fail(new Error('slack: connect aborted')), { once: true })
    })
    this.scheduleLeaseRefresh()
  }

  /** hello 帧 debug_info.approximate_connection_time（秒），未知则 0（不预约）。 */
  private leaseSeconds = 0

  /**
   * Socket Mode 的 ticket 有效期约 1 小时（hello 帧 debug_info.approximate_connection_time
   * 给近似租期秒数）；到期前主动换 ticket 重开，避免服务端硬断。
   */
  private scheduleLeaseRefresh(): void {
    if (this.leaseTimer !== undefined) clearTimeout(this.leaseTimer)
    const seconds = this.leaseSeconds
    if (seconds <= 0) return
    const lead = Math.max(60_000, (seconds - 300) * 1000)
    this.leaseTimer = setTimeout(() => {
      this.log('slack: Socket Mode ticket 租期将满，主动重连')
      this.restartSocket()
    }, lead)
    this.leaseTimer.unref?.()
  }

  private scheduleReconnect(): void {
    this.teardownSocket()
    if (this.stopped) return
    const delay = Math.min(this.reconnectBaseMs * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS)
    this.reconnectAttempts += 1
    this.reopenIn(delay)
  }

  /**
   * 服务端主动回收（disconnect 帧，以及同类 canary 帧）：立即换 ticket 重开。
   * 注：canary 帧面在 https://api.slack.com/apis/connections/socket 当前正文未列出
   * （文档只列 hello/disconnect/events_api/interactive/slash_commands），
   * 台账给出的 reason_code 语义按「服务端要求重连」同类处理，不做猜测式 ACK。
   */
  private restartSocket(): void {
    const stale = this.ws
    this.teardownSocket()
    if (this.stopped) return
    try {
      stale?.close()
    } catch {
      /* 已回收的连接关不上无副作用 */
    }
    this.reopenIn(0)
  }

  private reopenIn(delay: number): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.stopped) return
      void this.openSocket().catch((error: unknown) => {
        this.log(`slack: 重连失败（${error instanceof Error ? error.message : String(error)}），稍后再试`)
        if (!this.stopped) {
          const backoff = Math.min(this.reconnectBaseMs * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS)
          this.reconnectAttempts += 1
          this.reopenIn(backoff)
        }
      })
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private teardownSocket(): void {
    this.ws = undefined
    this.connected = false
    if (this.leaseTimer !== undefined) {
      clearTimeout(this.leaseTimer)
      this.leaseTimer = undefined
    }
  }

  // —— 入站帧处理 ——————————————————————————————————————

  private handleFrame(raw: string | undefined, onHello: () => void): void {
    if (typeof raw !== 'string' || raw === '') return
    let frame: SlackFrame
    try {
      frame = JSON.parse(raw) as SlackFrame
    } catch {
      this.log('slack: 收到非法 JSON 帧，忽略')
      return
    }
    switch (frame.type) {
      case 'hello': {
        this.leaseSeconds = Number(frame.debug_info?.approximate_connection_time ?? 0) || 0
        onHello()
        return
      }
      case 'disconnect':
      case 'canary': {
        const reason = str(frame.reason ?? frame.reason_code)
        this.log(`slack: 收到 ${frame.type} 帧（reason=${reason === '' ? 'n/a' : reason}），重连 Socket Mode`)
        this.restartSocket()
        return
      }
      case 'events_api': {
        // ACK 先行：未 ACK 的 envelope 会被服务端 3s 重投并计入重试次数。
        this.ack(frame)
        const key = str(frame.envelope_id ?? frame.payload?.event_id)
        if (key !== '' && !this.remember(key)) return
        this.dispatchEvents(frame.payload)
        return
      }
      case 'interactive':
      case 'slash_commands': {
        // 首版不消费交互面，但必须 ACK，否则服务端持续重投同一 envelope。
        this.ack(frame)
        return
      }
      default: {
        if (str(frame.envelope_id) !== '') this.ack(frame)
        return
      }
    }
  }

  private ack(frame: SlackFrame): void {
    const envelopeId = str(frame.envelope_id)
    if (envelopeId === '' || this.ws === undefined) return
    try {
      // 文档形：ACK 只需 envelope_id + payload（payload 无内容时给空对象）。
      this.ws.send(JSON.stringify({ envelope_id: envelopeId, payload: {} }))
    } catch {
      this.log('slack: ACK 帧发送失败，等待服务端重投')
    }
  }

  private remember(key: string): boolean {
    if (this.seenKeys.has(key)) return false
    this.seenKeys.add(key)
    if (this.seenKeys.size > SEEN_LIMIT) {
      const oldest = this.seenKeys.values().next().value
      if (oldest !== undefined) this.seenKeys.delete(oldest)
    }
    return true
  }

  /** events_api 的 payload 是单个事件对象（event_callback 形）；容忍数组形。 */
  private dispatchEvents(payload: any): void {
    const events: SlackEvent[] = Array.isArray(payload?.events)
      ? (payload.events as SlackEvent[])
      : payload?.event !== undefined && payload?.event !== null
        ? [payload.event as SlackEvent]
        : []
    for (const event of events) {
      const semantic = this.normalize(event)
      if (semantic === undefined) continue
      for (const listener of [...this.listeners]) {
        try {
          listener(semantic)
        } catch (error) {
          this.log(`slack: 入站监听器异常（${error instanceof Error ? error.message : String(error)}）`)
        }
      }
    }
  }

  private normalize(event: SlackEvent | undefined): SemanticMessage | undefined {
    if (event === undefined || event === null) return undefined
    const type = str(event.type)
    if (type !== 'message' && type !== 'app_mention') return undefined
    // 机器人回声：bot_id 非空（含本 bot 自己发的）一律丢弃，防自激循环。
    if (str(event.bot_id) !== '') return undefined
    // subtype 另成体系（channel_join/message_changed/file_share/thread_created…），首版不解析。
    if (str(event.subtype) !== '') return undefined
    const userId = str(event.user)
    if (userId === '') return undefined

    const chatId = str(event.channel) !== '' ? str(event.channel) : userId
    const kind = this.classify(event.channel_type, chatId)
    const address: ChatAddress = { channel: 'slack', kind, chatId }
    // thread 模型：thread_ts 存在且不等于本条 ts → 线程内回复（线程即独立会话）。
    const threadTs = str(event.thread_ts)
    if (threadTs !== '' && threadTs !== str(event.ts)) address.threadId = threadTs

    let text = str(event.text)
    const fileCount = (event.files?.length ?? 0) + (event.attachments?.length ?? 0)
    if (fileCount > 0) {
      // imageIn/fileIn=false：不下载字节（需 conversations.history + files.url 带鉴权），
      // 但绝不丢事件 —— 用占位文案告知有附件。
      const firstName = str(event.files?.[0]?.name ?? event.files?.[0]?.title)
      const label = firstName === '' ? 'attachment' : firstName
      text = text === '' ? `[${label}]` : `${text}\n[${label} +${fileCount - 1} more，未下载]`
    }
    if (text === '') return undefined

    const ts = Number(event.ts)
    const semantic: SemanticMessage = {
      address,
      userId,
      text,
      mentionedBot: this.detectMention(kind, type, text),
    }
    // Slack message 事件不带发送者显示名（需 users.info 另一次调用），首版不填。
    if (Number.isFinite(ts)) semantic.timestamp = Math.round(ts * 1000)
    return semantic
  }

  /** channel_type → 会话类型；channel_type 缺失时按频道 id 前缀回退（D=im）。 */
  private classify(channelType: string | undefined, chatId: string): 'dm' | 'group' {
    switch (str(channelType)) {
      case 'im':
        return 'dm'
      case 'channel':
      case 'private_channel':
      case 'group':
      case 'mpim':
        return 'group'
      default:
        return chatId.startsWith('D') ? 'dm' : 'group'
    }
  }

  /**
   * DM 恒 false（单聊本身就是点名）；app_mention 事件恒 true；
   * 频道消息 Slack 默认不 @ 也回调 → 只有正文出现本 bot 的 mention 标记才算被 @。
   */
  private detectMention(kind: 'dm' | 'group', type: string, text: string): boolean {
    if (kind === 'dm') return false
    if (type === 'app_mention') return true
    for (const id of [this.botUserId, this.botId]) {
      if (id === '') continue
      if (new RegExp(`<@${id}(?:\\|[^>]*)?>`).test(text)) return true
    }
    return false
  }

  // —— 出站 ——————————————————————————————————————————

  /**
   * Web API POST：判定必须看 body.ok（HTTP 200 也可能是 ok:false）。
   * 网络/超时/5xx/无响应体 → SlackUncertainError；明确 error 码 → SlackApiError。
   */
  private async api(
    method: string,
    body: Record<string, unknown>,
    token: string,
    signal?: AbortSignal,
  ): Promise<Record<string, any>> {
    let response: { ok: boolean; status: number; json(): Promise<unknown> }
    try {
      response = await this.fetchImpl(`${this.apiBase}/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (error) {
      if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error))
      throw new SlackUncertainError(`slack: ${method} 请求未送达（${error instanceof Error ? error.message : String(error)}）`)
    }
    let payload: Record<string, any>
    try {
      payload = (await response.json()) as Record<string, any>
    } catch {
      throw new SlackUncertainError(`slack: ${method} 响应体不可解析（HTTP ${response.status}），结果不明`)
    }
    if (payload === null || payload === undefined || typeof payload !== 'object') {
      throw new SlackUncertainError(`slack: ${method} 响应形不可用（HTTP ${response.status}），结果不明`)
    }
    if (payload.ok !== true) {
      const code = str(payload.error)
      if (code === '') {
        // 无明确拒绝码（多为网关 5xx / 内部错误页）：服务端未定论 → uncertain。
        throw new SlackUncertainError(`slack: ${method} 失败（HTTP ${response.status}，无错误码），结果不明`)
      }
      // rate_limited / ratelimited 等明确拒绝：确定性可告知（不是结果不明）。
      throw new SlackApiError(`slack: ${method} 被拒绝（${code}）`, code)
    }
    return payload
  }

  /** markdown → mrkdwn + 长度上限（Slack 超 40000 会被服务端截断）。 */
  private renderBody(text: string): string {
    return truncate(toSlackMrkdwn(text), this.caps.maxMessageLength)
  }

  private async post(address: ChatAddress, text: string, signal?: AbortSignal): Promise<string> {
    const body: Record<string, unknown> = { channel: address.chatId, text: this.renderBody(text) }
    // thread 内回复必须挂父消息 ts（用其父而非回复的 ts，文档要求）。
    if (address.threadId !== undefined) body.thread_ts = address.threadId
    const result = await this.api('chat.postMessage', body, this.botToken, signal)
    return str(result.ts)
  }

  private async edit(ts: string, address: ChatAddress, text: string, signal?: AbortSignal): Promise<void> {
    // chat.update 必填 channel + ts；线程内消息同样可编辑。
    await this.api('chat.update', { channel: address.chatId, ts, text: this.renderBody(text) }, this.botToken, signal)
  }

  async reply(address: ChatAddress, text: string, signal?: AbortSignal): Promise<Receipt> {
    const ts = await this.post(address, text, signal)
    return { ...(ts === '' ? {} : { platformMessageId: ts }), uncertain: false }
  }

  /**
   * 编辑流式：先发占位消息，随后 chat.update 逐次刷新（节流 ≥1s/条）。
   * 「消息不在了」类错误 → 补发新消息接替（不算投递失败）；
   * rate_limited 等明确拒绝与 uncertain 一律原样上抛，交给引擎/用户判定。
   */
  async beginStream(address: ChatAddress, signal?: AbortSignal): Promise<ReplyStream> {
    let ts: string | undefined
    let lastEditAt = 0
    let pending: Promise<void> = Promise.resolve()
    let aborted = false
    let replacements = 0
    const send = async (text: string): Promise<void> => {
      const id = await this.post(address, text, signal)
      if (id !== '') ts = id
    }
    const edit = async (text: string): Promise<void> => {
      if (ts === undefined) {
        await send(text)
        return
      }
      try {
        await this.edit(ts, address, text, signal)
      } catch (error) {
        if (error instanceof SlackApiError && isMessageGone(error) && replacements < 3) {
          replacements += 1
          await send(text)
          return
        }
        throw error
      }
    }
    const queued = (text: string): Promise<void> => {
      pending = pending.then(async () => {
        if (aborted) return
        const wait = this.editThrottleMs - (Date.now() - lastEditAt)
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
        if (aborted) return
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
        return ts === undefined ? { uncertain: false } : { platformMessageId: ts, uncertain: false }
      },
      abort(): void {
        aborted = true
      },
    }
  }

  // —— 准入与诊断 ——————————————————————————————————————

  /** 准入红线 D6：渠道不越权，白名单归网关。 */
  authorize(): boolean | undefined {
    return undefined
  }

  /**
   * 诊断三态：两个 token 分别实探，hint 零 token 回显（绝不输出 token 片段）。
   * - bot-token：auth.test 实探；
   * - app-token-socket：以 Socket Mode 已连通为证，未连通时实探 apps.connections.open；
   * - roundtrip：恒 unverified（需真机在 Slack 客户端收发消息）。
   */
  async diagnose(signal?: AbortSignal): Promise<ChannelDiagnosisCheck[]> {
    const checks: ChannelDiagnosisCheck[] = []
    // 1) bot token
    if (this.botToken === '') {
      checks.push({ name: 'bot-token', status: 'failed', hint: 'Bot Token（xoxb-）未入库' })
    } else {
      const started = Date.now()
      try {
        const result = await this.api('auth.test', {}, this.botToken, signal)
        this.botUserId = str(result.user_id)
        this.botId = str(result.bot_id)
        checks.push({
          name: 'bot-token',
          status: 'passed',
          hint: `bot 用户 ${str(result.user) || str(result.user_id) || '未知'}（team ${str(result.team_id)}）`,
          elapsedMs: Date.now() - started,
        })
      } catch (error) {
        const failed = error instanceof SlackApiError
        checks.push({
          name: 'bot-token',
          status: failed ? 'failed' : 'unverified',
          hint: failed
            ? `auth.test 被拒绝（${error instanceof SlackApiError ? error.error : ''}）：检查 token 与 bot 是否在频道内`
            : 'auth.test 网络/响应不明，未能判定',
          elapsedMs: Date.now() - started,
        })
      }
    }
    // 2) app token（Socket Mode 面）
    if (this.appToken === '') {
      checks.push({ name: 'app-token-socket', status: 'failed', hint: 'App Token（xapp-）未入库' })
    } else if (this.connected) {
      checks.push({ name: 'app-token-socket', status: 'passed', hint: 'Socket Mode 长连接已建立（hello 已收）' })
    } else {
      const started = Date.now()
      try {
        const result = await this.api('apps.connections.open', {}, this.appToken, signal)
        checks.push({
          name: 'app-token-socket',
          status: str(result.url) === '' ? 'unverified' : 'passed',
          hint: str(result.url) === '' ? 'apps.connections.open 未返回 socket url' : 'apps.connections.open 可用（未建 WS）',
          elapsedMs: Date.now() - started,
        })
      } catch (error) {
        const failed = error instanceof SlackApiError
        checks.push({
          name: 'app-token-socket',
          status: failed ? 'failed' : 'unverified',
          hint: failed
            ? `apps.connections.open 被拒绝（${error instanceof SlackApiError ? error.error : ''}）：需要 App Level Token 与 connections:read`
            : 'apps.connections.open 网络/响应不明，未能判定',
          elapsedMs: Date.now() - started,
        })
      }
    }
    // 3) roundtrip
    checks.push({
      name: 'roundtrip',
      status: 'unverified',
      hint: '收发 round-trip 需真机验证（在 Slack 频道 @ 本 bot 或私聊发消息）',
    })
    return checks
  }
}

/**
 * 工厂：Socket Mode 双 token 都是必需（xoxb- 出站 / xapp- 入站长连接），
 * 缺一即构造抛错——不做「单边可用」的假降级。meta.slack 只有凭据面，故不读 config。
 */
export function createSlackAdapter(options: {
  accountId: string
  config: Record<string, string>
  secrets: Record<string, string | undefined>
}): SlackAdapter {
  const botToken = typeof options.secrets.botToken === 'string' ? options.secrets.botToken.trim() : ''
  const appToken = typeof options.secrets.appToken === 'string' ? options.secrets.appToken.trim() : ''
  if (botToken === '') throw new Error(`slack 账号 ${options.accountId}: botToken 未入库（Bot User OAuth Token xoxb-）`)
  if (appToken === '') throw new Error(`slack 账号 ${options.accountId}: appToken 未入库（App Level Token xapp-，Socket Mode 必需）`)
  return new SlackAdapter({ botToken, appToken })
}
