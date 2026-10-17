/**
 * Telegram 渠道适配器（M1 P0 首渠道）。
 *
 * 协议事实（Bot API 公开规范独立重实现，净室口径）：
 * - 入站：getUpdates 长轮询（timeout≤50，本页取 25），offset=已见最大 update_id+1；
 * - 出站：sendMessage；流式=先占位消息、editMessageText 逐步编辑（编辑限流
 *   ~1s/条，"message is not modified" 400 是幂等成功不是错误）；
 * - 富文本回退链：parse_mode Markdown（legacy，容忍度高）→ 400 即纯文本重发；
 * - Receipt 语义：网络错/5xx/超时 = uncertain（禁自动重发）；4xx 确定性失败 = 抛；
 * - 私聊白名单裁决在网关 dmAllowlist（红线 D6），本适配器 authorize 恒交全局。
 *
 * 零运行时依赖：只用宿主 Node≥22 的全局 fetch（测试注入 fetchImpl）。
 */
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
import type { ChatAddress } from '../engine/router.js'

const TELEGRAM_ERROR_UNCERTAIN_STATUS = 495
const EDIT_THROTTLE_MS = 1100
const POLL_TIMEOUT_S = 25

/** 可注入的 fetch 形态（只声明用到的能力）。 */
type FetchLike = (url: string, init?: RequestInitLike) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer?(): Promise<ArrayBuffer> }>
interface RequestInitLike {
  method?: string
  body?: string | Uint8Array
  headers?: Record<string, string>
  signal?: AbortSignal
}

export interface TelegramAdapterOptions {
  token: string
  apiBase?: string
  /** 测试注入点；缺省用全局 fetch。 */
  fetchImpl?: FetchLike
  logger?: (msg: string) => void
}

interface TelegramFileRef {
  name: string
  path: string
}

export class TelegramAdapter implements ChannelAdapter {
  readonly id = 'telegram'
  readonly label = 'Telegram'
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
    maxMessageLength: 4096,
  }

  connected = false
  private readonly token: string
  private readonly apiBase: string
  private readonly fetchImpl: FetchLike
  private readonly log: (msg: string) => void
  private listeners: MessageListener[] = []
  private offset = 0
  private pollAbort: AbortController | undefined
  private botUsername = ''
  private readonly pollController: AbortController

  constructor(options: TelegramAdapterOptions) {
    if (typeof options.token !== 'string' || options.token === '') {
      throw new Error('telegram: botToken 缺失（凭据库解析失败或未配置账号）')
    }
    this.token = options.token
    this.apiBase = options.apiBase ?? 'https://api.telegram.org'
    this.fetchImpl = options.fetchImpl ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike)
    this.log = options.logger ?? (() => {})
    this.pollController = new AbortController()
  }

  private api(method: string): string {
    return `${this.apiBase}/bot${this.token}/${method}`
  }

  /** Bot API POST：返回 result 或确定性抛错；网络/5xx 抛 TelegramUncertainError。 */
  private async call(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    let response: { ok: boolean; status: number; json(): Promise<unknown> }
    try {
      response = await this.fetchImpl(this.api(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: signal ?? this.pollController.signal,
      })
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error
      throw new TelegramUncertainError(`telegram ${method}: 网络异常 ${(error as Error).message}`)
    }
    if (response.status >= 500) {
      throw new TelegramUncertainError(`telegram ${method}: HTTP ${response.status}`)
    }
    const body = (await response.json().catch(() => undefined)) as
      | { ok?: boolean; result?: unknown; description?: string; error_code?: number }
      | undefined
    if (body === undefined || body.ok !== true) {
      if (response.status >= 495 || body === undefined) {
        throw new TelegramUncertainError(`telegram ${method}: 结果不明 HTTP ${response.status}`)
      }
      throw new TelegramApiError(
        `telegram ${method}: ${body?.description ?? body?.error_code ?? '未知错误'}`,
        String(body?.description ?? ''),
      )
    }
    return body.result
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  async connect(signal?: AbortSignal): Promise<void> {
    const me = (await this.call('getMe', {}, signal)) as { username?: string }
    this.botUsername = (me.username ?? '').toLowerCase()
    this.connected = true
    void this.pollLoop(signal)
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.pollController.abort()
  }

  private async pollLoop(signal?: AbortSignal): Promise<void> {
    let backoffMs = 1000
    const link = this.pollController.signal
    while (!link.aborted && !signal?.aborted) {
      try {
        const updates = (await this.call(
          'getUpdates',
          { offset: this.offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] },
          link,
        )) as TelegramUpdate[]
        backoffMs = 1000
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1)
          const message = this.normalize(update.message)
          if (message !== undefined) {
            // 图片入站（T1.7）：下载失败降级为无图文本消息，不丢整条。
            await this.fillImages(message, update.message)
            for (const listener of this.listeners) listener(message)
          }
        }
      } catch (error) {
        if (link.aborted || (error as Error).name === 'AbortError') return
        this.log(`getUpdates 失败，${backoffMs}ms 后重试: ${(error as Error).message}`)
        await new Promise((resolve) => setTimeout(resolve, backoffMs))
        backoffMs = Math.min(backoffMs * 2, 30_000)
      }
    }
  }

  /** photo 取最大档（数组末位）；telegram 服务端转 jpeg，mime 固定。 */
  private async fillImages(message: SemanticMessage, raw: TelegramMessage | undefined): Promise<void> {
    const photo = raw?.photo
    if (!Array.isArray(photo) || photo.length === 0) return
    try {
      const largest = photo[photo.length - 1]
      if (largest?.file_id === undefined) return
      const ref = await this.resolveFileRef(largest.file_id, 'photo.jpg')
      const response = await this.fetchImpl(this.downloadUrl(ref))
      const buffer = typeof response.arrayBuffer === 'function' ? await response.arrayBuffer() : undefined
      if (buffer !== undefined && buffer.byteLength > 0) {
        message.images = [{ name: ref.name, data: new Uint8Array(buffer), mimeType: 'image/jpeg' }]
      }
    } catch (error) {
      this.log(`图片下载失败（降级为纯文本）: ${(error as Error).message}`)
    }
  }

  /** update.message → SemanticMessage；非会话类（channel_post 等）返回 undefined。 */
  normalize(message: TelegramMessage | undefined): SemanticMessage | undefined {
    if (message === undefined || message.from === undefined || message.chat === undefined) return undefined
    const kind = chatKind(message.chat.type)
    if (kind === undefined) return undefined
    const address: ChatAddress = {
      channel: 'telegram',
      kind,
      chatId: String(message.chat.id),
    }
    if (message.is_topic_message === true && typeof message.message_thread_id === 'number') {
      address.threadId = String(message.message_thread_id)
    }
    const text = message.text ?? message.caption ?? ''
    const semantic: SemanticMessage = {
      address,
      userId: String(message.from.id),
      userDisplayName: [message.from.first_name, message.from.username].filter(Boolean).join(' ') || undefined,
      text,
      mentionedBot: this.detectMention(message),
      timestamp: typeof message.date === 'number' ? message.date * 1000 : undefined,
    }
    if (message.reply_to_message?.text !== undefined) {
      semantic.quoteText = message.reply_to_message.text.slice(0, 200)
    }
    return semantic
  }

  private detectMention(message: TelegramMessage): boolean {
    if (this.botUsername === '') return false
    const lower = (message.text ?? message.caption ?? '').toLowerCase()
    if (lower.includes(`@${this.botUsername}`)) return true
    // /cmd@botname 形式也算显式点名。
    return new RegExp(`^/\\S+@${escapeRegExp(this.botUsername)}`, 'i').test(lower)
  }

  /** 富文本回退链：Markdown → 400 纯文本；uncertain 直接上抛（不重试）。 */
  async reply(address: ChatAddress, text: string, signal?: AbortSignal): Promise<Receipt> {
    const base = { chat_id: address.chatId, text: truncate(text, this.caps.maxMessageLength) }
    try {
      const sent = (await this.call('sendMessage', { ...base, parse_mode: 'Markdown' }, signal)) as TelegramMessageLike
      return receipt(sent)
    } catch (error) {
      if (error instanceof TelegramUncertainError) throw error
      if (!(error instanceof TelegramApiError) || !isFormatError(error)) throw error
      const sent = (await this.call('sendMessage', base, signal)) as TelegramMessageLike
      return receipt(sent)
    }
  }

  /** 占位消息 + editMessageText 流式；编辑失败降级"删旧发新"，仍不确定则停止编辑。 */
  async beginStream(address: ChatAddress, signal?: AbortSignal): Promise<ReplyStream> {
    let messageId: number | undefined
    let lastEditAt = 0
    let pending: Promise<void> = Promise.resolve()
    let aborted = false
    const send = async (text: string): Promise<void> => {
      const sent = (await this.replyOnce(address, text, signal)) as TelegramMessageLike
      messageId = sent?.message_id
    }
    const edit = async (text: string): Promise<void> => {
      if (messageId === undefined) return send(text)
      try {
        await this.editOnce(address, messageId, text, signal)
      } catch (error) {
        if (error instanceof TelegramUncertainError) throw error
        // 消息被删/格式拒绝 → 补发新消息接替。
        await send(text)
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
        return messageId === undefined
          ? { uncertain: false }
          : { platformMessageId: String(messageId), uncertain: false }
      },
      abort(): void {
        aborted = true
      },
    }
  }

  private async replyOnce(address: ChatAddress, text: string, signal?: AbortSignal): Promise<unknown> {
    const body = { chat_id: address.chatId, text: truncate(text, this.caps.maxMessageLength) }
    try {
      return await this.call('sendMessage', { ...body, parse_mode: 'Markdown' }, signal)
    } catch (error) {
      if (error instanceof TelegramUncertainError) throw error
      if (error instanceof TelegramApiError && isFormatError(error)) {
        return this.call('sendMessage', body, signal)
      }
      throw error
    }
  }

  private async editOnce(address: ChatAddress, messageId: number, text: string, signal?: AbortSignal): Promise<unknown> {
    const body = {
      chat_id: address.chatId,
      message_id: messageId,
      text: truncate(text, this.caps.maxMessageLength),
    }
    try {
      return await this.call('editMessageText', { ...body, parse_mode: 'Markdown' }, signal)
    } catch (error) {
      if (error instanceof TelegramApiError && isNotModified(error)) return undefined
      if (error instanceof TelegramUncertainError) throw error
      if (error instanceof TelegramApiError && isFormatError(error)) {
        return this.call('editMessageText', body, signal)
      }
      throw error
    }
  }

  async sendFile(address: ChatAddress, file: OutboundFile, signal?: AbortSignal): Promise<Receipt> {
    const form = buildMultipart(file)
    let response: { ok: boolean; status: number; json(): Promise<unknown> }
    try {
      response = await this.fetchImpl(this.api('sendDocument'), {
        method: 'POST',
        body: form.body,
        headers: { 'content-type': form.contentType },
        signal,
      })
    } catch (error) {
      throw new TelegramUncertainError(`telegram sendDocument: 网络异常 ${(error as Error).message}`)
    }
    if (response.status >= 500 || response.status >= TELEGRAM_ERROR_UNCERTAIN_STATUS) {
      throw new TelegramUncertainError(`telegram sendDocument: HTTP ${response.status}`)
    }
    const body = (await response.json()) as { ok?: boolean; result?: TelegramMessageLike; description?: string }
    if (body.ok !== true) throw new TelegramApiError(`telegram sendDocument: ${body.description ?? '未知错误'}`, '')
    return receipt(body.result)
  }

  async setTyping(address: ChatAddress): Promise<void> {
    try {
      await this.call('sendChatAction', { chat_id: address.chatId, action: 'typing' })
    } catch (error) {
      if (error instanceof TelegramUncertainError) return
      this.log(`sendChatAction 失败: ${(error as Error).message}`)
    }
  }

  /** 私聊准入恒交网关白名单（红线 D6），群 @ 由网关裁决——渠道不越权。 */
  authorize(): boolean | undefined {
    return undefined
  }

  async diagnose(signal?: AbortSignal): Promise<ChannelDiagnosisCheck[]> {
    const checks: ChannelDiagnosisCheck[] = []
    const start = Date.now()
    try {
      const me = (await this.call('getMe', {}, signal)) as { username?: string }
      checks.push({ name: 'token-valid', status: 'passed', hint: me.username, elapsedMs: Date.now() - start })
    } catch (error) {
      const uncertain = error instanceof TelegramUncertainError
      checks.push({
        name: 'token-valid',
        status: uncertain ? 'unverified' : 'failed',
        hint: uncertain ? '网络不稳定，稍后复测' : 'token 无效或被 BotFather 吊销',
        elapsedMs: Date.now() - start,
      })
    }
    checks.push({
      name: 'long-poll',
      status: this.connected ? 'passed' : 'unverified',
      hint: this.connected ? `offset=${this.offset}` : '未连接',
    })
    return checks
  }

  /** getFile → file_path 下载引用（图片/文件入站用，M1 附件层消费）。 */
  async resolveFileRef(fileId: string, name: string): Promise<TelegramFileRef> {
    const file = (await this.call('getFile', { file_id: fileId })) as { file_path?: string }
    if (typeof file.file_path !== 'string') {
      throw new TelegramApiError(`telegram getFile: 无 file_path（${name}）`, '')
    }
    return { name, path: file.file_path }
  }

  downloadUrl(ref: TelegramFileRef): string {
    return `${this.apiBase}/file/bot${this.token}/${ref.path}`
  }
}

class TelegramApiError extends Error {
  /** description：Bot API 原文（判型用，不进用户可见文案）。 */
  constructor(
    message: string,
    readonly description: string,
  ) {
    super(message)
  }
}
class TelegramUncertainError extends Error {}

function isFormatError(error: TelegramApiError): boolean {
  return /can't parse|invalid entity|parse/i.test(error.message)
}

function isNotModified(error: TelegramApiError): boolean {
  return /not modified/i.test(error.message)
}

function chatKind(type: string): 'dm' | 'group' | undefined {
  if (type === 'private') return 'dm'
  if (type === 'group' || type === 'supergroup') return 'group'
  return undefined
}

function receipt(message: TelegramMessageLike | undefined): Receipt {
  return typeof message?.message_id === 'number'
    ? { platformMessageId: String(message.message_id), uncertain: false }
    : { uncertain: false }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 极简 multipart（无第三方依赖；仅 sendDocument 用）。 */
function buildMultipart(file: OutboundFile): { body: Uint8Array; contentType: string } {
  const boundary = `----imu${Date.now().toString(16)}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${file.name.replace(/"/g, '')}"\r\n` +
      `Content-Type: ${file.mimeType ?? 'application/octet-stream'}\r\n\r\n`,
    'utf8',
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  return { body: Buffer.concat([head, Buffer.from(file.data), tail]), contentType: `multipart/form-data; boundary=${boundary}` }
}

/** 工厂挂 registry：懒加载（本文件被动态 import 时 SDK 面只有全局 fetch）。 */
export function createTelegramAdapter(options: {
  accountId: string
  config: Record<string, string>
  secrets: Record<string, string | undefined>
}): TelegramAdapter {
  const token = options.secrets.botToken
  if (typeof token !== 'string' || token === '') {
    throw new Error(`telegram 账号 ${options.accountId}: botToken 未入库（检查凭据配置）`)
  }
  const apiBase = options.config.apiBaseUrl
  return new TelegramAdapter({ token, ...(apiBase !== undefined && apiBase !== '' ? { apiBase } : {}) })
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

interface TelegramMessageLike {
  message_id?: number
}

interface TelegramMessage extends TelegramMessageLike {
  date?: number
  text?: string
  caption?: string
  chat: { id: number; type: string }
  from?: { id: number; first_name?: string; username?: string }
  reply_to_message?: { text?: string }
  is_topic_message?: boolean
  message_thread_id?: number
  photo?: Array<{ file_id: string; file_size?: number; width?: number; height?: number }>
}
