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
 *
 * 运行时依赖零：Node≥22 全局 fetch/WebSocket/AbortController（宿主 engines 已锁），
 * 测试全量注入 fetchImpl/WebSocketImpl。
 */
import type { ChatAddress } from '../engine/router.js'
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

const INTENTS = {
  GUILDS: 1 << 0,
  DIRECT_MESSAGES: 1 << 12,
  GUILD_MESSAGES: 1 << 15,
  MESSAGE_CONTENT: 1 << 24,
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
type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<FetchResponseLike>

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
  private listeners: MessageListener[] = []
  private ws: WSLike | undefined
  private botUserId = ''
  private lastSeq: number | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private readonly closeController = new AbortController()

  constructor(options: DiscordAdapterOptions) {
    if (typeof options.token !== 'string' || options.token === '') {
      throw new Error('discord: botToken 缺失（凭据库解析失败或未配置账号）')
    }
    this.token = options.token
    this.apiBase = options.apiBase ?? 'https://discord.com/api/v10'
    this.fetchImpl = options.fetchImpl ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike)
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
    const me = (await this.rest('GET', '/users/@me', undefined, signal)) as { id?: string }
    this.botUserId = String(me.id ?? '')
    const gateway = (await this.rest('GET', '/gateway', undefined, signal)) as { url?: string }
    const url = String(gateway.url ?? 'wss://gateway.discord.gg/?v=10&encoding=json')
    const wsUrl = url.includes('?') ? `${url}&encoding=json` : `${url}/?v=10&encoding=json`
    const ws = this.wsFactory(wsUrl)
    this.ws = ws
    ws.addEventListener('message', (event: { data: string }) => this.handleGatewayFrame(String(event.data)))
    ws.addEventListener('close', () => {
      this.connected = false
      this.stopHeartbeat()
      if (!this.closeController.signal.aborted) this.log('discord Gateway 断开（上层重连策略归 T2.5）')
    })
    ws.addEventListener('error', () => {
      this.connected = false
    })
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat()
    this.closeController.abort()
    try {
      this.ws?.close()
    } catch {
      // 已断开即目标达成。
    }
    this.ws = undefined
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
        this.sendIdentify()
        return
      }
      case OP.HEARTBEAT_ACK:
        return
      case OP.RECONNECT:
        this.log('discord Gateway 要求重连（当前实现退IDENTIFY重建）')
        try {
          this.ws?.close()
        } catch {
          // ignore
        }
        return
      case OP.INVALID_SESSION: {
        this.connected = false
        this.stopHeartbeat()
        if (frame.d === true) {
          this.log('discord 会话可续（RESUME 归后续迭代），当前直接重 IDENTIFY')
        }
        this.sendIdentify()
        return
      }
      case OP.DISPATCH: {
        if (frame.t === 'READY') {
          this.connected = true
          return
        }
        if (frame.t === 'MESSAGE_CREATE') {
          const message = this.normalize(frame.d)
          if (message !== undefined) {
            // 图片入站（T1.7）：下载后投递；失败降级无图文本，不丢整条。
            void this.fillAttachments(message, frame.d).then(() => {
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
        intents: INTENTS.GUILD_MESSAGES | INTENTS.DIRECT_MESSAGES | INTENTS.MESSAGE_CONTENT,
        properties: { os: 'dsh-plugin', browser: 'dsh-im-union', device: 'dsh-im-union' },
      },
    })
  }

  private sendHeartbeat(): void {
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
    // 协议事实：MESSAGE_CREATE 不带被引用消息正文，引用需额外 GET /messages/{id}；
    // 上下文增强归 T3.6，这里不伪填充。
    return semantic
  }

  /** 图片附件（content_type 判图）：url 优先（公开 CDN），proxy_url 回退；上限 4 张。 */
  private async fillAttachments(message: SemanticMessage, raw: DiscordMessageLike | undefined): Promise<void> {
    const attachments = raw?.attachments
    if (!Array.isArray(attachments) || attachments.length === 0) return
    const images: Array<{ name: string; data: Uint8Array; mimeType: string }> = []
    for (const attachment of attachments) {
      if (images.length >= 4) break
      const contentType = typeof attachment?.content_type === 'string' ? attachment.content_type : ''
      if (!contentType.startsWith('image/')) continue
      const url =
        typeof attachment?.url === 'string' ? attachment.url : typeof attachment?.proxy_url === 'string' ? attachment.proxy_url : undefined
      if (url === undefined) continue
      try {
        const response = await this.fetchImpl(url)
        const buffer = typeof response.arrayBuffer === 'function' ? await response.arrayBuffer() : undefined
        if (buffer !== undefined && buffer.byteLength > 0) {
          images.push({ name: String(attachment?.filename ?? 'image'), data: new Uint8Array(buffer), mimeType: contentType })
        }
      } catch (error) {
        this.log(`图片下载失败（降级跳过）: ${(error as Error).message}`)
      }
    }
    if (images.length > 0) message.images = images
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
    return checks
  }

  /** 文件回传：multipart（payload_json + files[0]），无 FormData 面时明确抛（不静默）。 */
  async sendFile(address: ChatAddress, file: OutboundFile, signal?: AbortSignal): Promise<Receipt> {
    const FormDataCtor = (globalThis as { FormData?: typeof FormData }).FormData
    const BlobCtor = (globalThis as { Blob?: typeof Blob }).Blob
    if (typeof globalThis.fetch !== 'function' || FormDataCtor === undefined || BlobCtor === undefined) {
      throw new Error('discord sendFile: 宿主运行时缺 fetch/FormData/Blob 面')
    }
    const form = new FormDataCtor()
    form.append(
      'payload_json',
      JSON.stringify({ content: file.name, allowed_mentions: { parse: [] } }),
    )
    form.append('files[0]', new BlobCtor([file.data], { type: file.mimeType ?? 'application/octet-stream' }), file.name)
    let response: FetchResponseLike
    try {
      response = await (globalThis.fetch as unknown as (u: string, i?: unknown) => Promise<FetchResponseLike>)(
        `${this.apiBase}/channels/${address.chatId}/messages`,
        {
          method: 'POST',
          headers: { authorization: `Bot ${this.token}` },
          body: form,
          signal: signal ?? this.closeController.signal,
        },
      )
    } catch (error) {
      throw new DiscordUncertainError(`discord sendFile: 网络异常 ${(error as Error).message}`)
    }
    if (response.status >= 500) throw new DiscordUncertainError(`discord sendFile: HTTP ${response.status}`)
    const payload = (await response.json().catch(() => undefined)) as { id?: string; message?: string } | undefined
    if (!response.ok) throw new DiscordApiError(`discord sendFile: ${payload?.message ?? '被拒'}`, response.status)
    return typeof payload?.id === 'string' ? { platformMessageId: payload.id, uncertain: false } : { uncertain: false }
  }
}

function capLength(text: string): string {
  if (text.length <= DISCORD_MAX_MESSAGE) return text
  return `${text.slice(0, DISCORD_MAX_MESSAGE - 1)}…`
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
}): DiscordAdapter {
  const token = options.secrets.botToken
  if (typeof token !== 'string' || token === '') {
    throw new Error(`discord 账号 ${options.accountId}: botToken 未入库（检查凭据配置）`)
  }
  const apiBase = options.config.apiBaseUrl
  return new DiscordAdapter({ token, ...(apiBase !== undefined && apiBase !== '' ? { apiBase } : {}) })
}

interface DiscordMessageLike {
  channel_id?: string
  guild_id?: string | null
  author?: { id?: string; username?: string; global_name?: string | null }
  content?: string
  timestamp?: string
  mentions?: Array<{ id?: string } | undefined>
  attachments?: Array<{ id?: string; filename?: string; content_type?: string; url?: string; proxy_url?: string }>
}
