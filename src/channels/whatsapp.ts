/**
 * WhatsApp 渠道适配器（T3.1：Baileys，auth 目录持久化，编辑流式）。
 *
 * 净室口径 —— 依据 @whiskeysockets/baileys 公开 README/docs 与 npm 示例（WebSearch 核实关键面）
 * 独立重实现，仅描述协议事实，不含任何专有源码：
 * - 会话工厂：`makeWASocket(cfg)`（default 或具名导出，随版本而异，运行期取任一存在者）；
 *   auth state：`useMultiFileAuthState(stateDir)` → `{ state, saveCreds }`，creds 逐文件落盘
 *   于 stateDir；重连恢复同一目录即复用凭据（qrcode 配对渠道，首配后无需 token）；
 * - 事件面（`sock.ev.on(name, handler)`）：
 *   · `connection.update` 给 `{ qr?, connection?, lastDisconnect?, me? }`——qr 为待扫码字符串，
 *     connection 'open' 时 me.id 是本机 jid（判 @ 用），'close' 表断连；
 *   · `creds.update` → 调 `saveCreds()` 持久化；
 *   · `messages.upsert` → `{ messages: WAMessage[], type? }`；
 * - 出站文本：`sendMessage(jid, { text })` 返回 `{ key }`（编辑/撤回用 key）；
 * - 编辑流式：`sendMessage(jid, { text, edit: 占位消息 key })`——首条占位后连续 edit 同一 key；
 *   messageKey 形态 `{ remoteJid, fromMe, id }`（edit 复用占位返回的整个 key 对象）；
 * - presence：`sendPresenceUpdate('composing', jid)` 触发"正在输入"（约 10s 过期）；
 * - jid 语义：私聊 `...@s.whatsapp.net`、群 `...@g.us`；被 @ 名单在
 *   `message.extendedTextMessage.contextInfo.mentionedJid`；自发回声看 `key.fromMe`；
 * - 断连重连判据：`lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut`；
 * - 媒体入站（image/audio/video/document）需 `downloadContentFromMessage` + 媒体密钥解密，
 *   首版未接（caps.imageIn/fileIn=false），归一为占位文案不丢事件——媒体附件登记为后续项。
 *
 * 依赖边界（关键）：运行时依赖官方 npm 包 `@whiskeysockets/baileys`（由宿主接线方/主会话安装）。
 * 本文件**不在编译期**引用其类型（node_modules 里此刻没有它）：动态 import 的模块名走变量
 * 传参（`const modName='@whiskeysockets/baileys'; await import(modName)`），TS 无法静态解析该
 * specifier → 结果一律 `any`/自定义宽松 interface，typecheck 不因缺包报错。
 * 测试全走注入的 fake `makeSocket`，零真实协议面、零 auth 文件读写、零网络。
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

const EDIT_THROTTLE_MS = 1100
const WHATSAPP_MAX_MESSAGE = 4000
const DEFAULT_AUTH_ROOT = 'whatsapp-auth'
/** 占位文案 → 非文本消息类型映射（首版不解密媒体，只保事件不丢）。 */
const NON_TEXT_PLACEHOLDER: Record<string, string> = {
  imageMessage: '[图片]',
  audioMessage: '[语音]',
  videoMessage: '[视频]',
  documentMessage: '[文件]',
  stickerMessage: '[贴纸]',
  contactMessage: '[名片]',
  locationMessage: '[位置]',
}

// —— 宽松协议 interface（不引 Baileys 类型；仅声明本适配器用到的面） ——————————

/** WAMessageKey：编辑/撤回引用形态 { remoteJid, fromMe, id }。 */
interface WaKeyLike {
  remoteJid?: string
  fromMe?: boolean
  id?: string
  participant?: string
}

/** sendMessage 回执（Baileys 返回 MessageUpsert 风格对象，含 key）。 */
interface WaSendResultLike {
  key?: WaKeyLike
}

/** messages.upsert 单条 WAMessage（只声明用到的字段）。 */
interface WaMessageLike {
  key?: WaKeyLike
  message?: {
    conversation?: string
    extendedTextMessage?: {
      text?: string
      contextInfo?: { mentionedJid?: string[]; quotedMessage?: { conversation?: string; extendedTextMessage?: { text?: string } } }
    }
    imageMessage?: { caption?: string }
    videoMessage?: { caption?: string }
    audioMessage?: unknown
    documentMessage?: { fileName?: string }
    stickerMessage?: unknown
    contactMessage?: unknown
    locationMessage?: unknown
  }
  pushName?: string
  messageTimestamp?: number | string
}

/** Baileys socket 的宽松形态（注入 fake 也满足它）。 */
interface BaileysSocketLike {
  ev: {
    on(evt: string, handler: (payload: any) => void): void
    off?(evt: string, handler: (payload: any) => void): void
    removeAllListeners?(): void
  }
  sendMessage(jid: string, payload: Record<string, unknown>): Promise<WaSendResultLike | undefined>
  sendPresenceUpdate?(type: string, jid?: string): Promise<unknown>
  evictCache?(): void
  logout?(): Promise<void>
  end?(closeSocket?: boolean): void
  ws?: { socket?: { close?(): void } }
}

/** 会话工厂返回值：socket，或带 creds 观测的 bundle。 */
type WhatsappSocketResult = BaileysSocketLike | { socket: BaileysSocketLike; hasCreds?: boolean }

export interface WhatsappSocketContext {
  /** creds/auth 落盘目录（重连恢复同一目录）。 */
  stateDir: string
  authDir: string
  log: (msg: string) => void
  signal?: AbortSignal
  /** 全局注入面：宿主 Node 的 WebSocket/fetch（缺省走 Baileys 内建）。 */
  WebSocketImpl?: unknown
  fetchImpl?: unknown
}

type WhatsappSocketFactory = (ctx: WhatsappSocketContext) => Promise<WhatsappSocketResult> | WhatsappSocketResult

export interface WhatsappAdapterOptions {
  accountId?: string
  /** creds 目录（config.authDir/stateDir）；缺省 `<DEFAULT_AUTH_ROOT>/<accountId>`。 */
  authDir?: string
  stateDir?: string
  /** 测试注入点：替代真实 Baileys makeWASocket（提供后完全不碰 baileys 包）。 */
  makeSocket?: WhatsappSocketFactory
  /** qr 回调（配对流程：connection.update.qr 出现时上抛字符串供设置页渲染）。 */
  onQr?: (qr: string) => void
  WebSocketImpl?: unknown
  fetchImpl?: unknown
  logger?: (msg: string) => void
}

export class WhatsAppApiError extends Error {
  /** statusCode：Baileys/Boom 错误节点状态码（判型用，不进用户可见文案）。 */
  readonly statusCode: number
  constructor(message: string, statusCode: number) {
    super(message)
    this.statusCode = statusCode
  }
}
export class WhatsAppUncertainError extends Error {}

export class WhatsappAdapter implements ChannelAdapter {
  readonly id = 'whatsapp'
  readonly label = 'WhatsApp'
  readonly caps: ChannelCaps = {
    editStream: true,
    nativeStream: false,
    nativeChoices: false,
    statusReaction: false,
    typing: true,
    imageIn: false,
    fileIn: false,
    fileOut: false,
    threads: false,
    voice: false,
    maxMessageLength: WHATSAPP_MAX_MESSAGE,
  }

  connected = false
  /** creds 是否在位（三态：true 已配对 / false 未配对 / undefined 未知）。 */
  private credsPresent: boolean | undefined
  private readonly stateDir: string
  private readonly accountId: string
  private readonly makeSocket: WhatsappSocketFactory
  private readonly onQr: ((qr: string) => void) | undefined
  private readonly WebSocketImpl: unknown
  private readonly fetchImpl: unknown
  private readonly log: (msg: string) => void
  private listeners: MessageListener[] = []
  private socket: BaileysSocketLike | undefined
  private botJid = ''
  private pendingQr: string | undefined
  private saveCreds: (() => Promise<void>) | undefined

  constructor(options: WhatsappAdapterOptions = {}) {
    this.accountId = options.accountId ?? 'default'
    const explicit = options.authDir ?? options.stateDir
    this.stateDir = explicit !== undefined && explicit !== '' ? explicit : `${DEFAULT_AUTH_ROOT}/${this.accountId}`
    this.makeSocket = options.makeSocket ?? defaultBaileysFactory
    this.onQr = options.onQr
    this.WebSocketImpl = options.WebSocketImpl
    this.fetchImpl = options.fetchImpl
    this.log = options.logger ?? (() => {})
  }

  /** auth 落盘目录（重连恢复同一目录；测试据此断言复用声明）。 */
  getStateDir(): string {
    return this.stateDir
  }

  /** 当前配对 qr（open 后清空）。 */
  getPairingQr(): string | undefined {
    return this.pendingQr
  }

  /** creds 是否在位（诊断用；不回显任何凭据值）。 */
  hasCreds(): boolean | undefined {
    return this.credsPresent
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  /**
   * 建会话：调工厂（注入 fake 或真实 baileys）→ 注册事件处理器。
   * qr/open 经 connection.update 异步到达，connect 本身不阻塞到 open。
   */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.socket !== undefined) return
    const ctx: WhatsappSocketContext = {
      stateDir: this.stateDir,
      authDir: this.stateDir,
      log: this.log,
      ...(signal !== undefined ? { signal } : {}),
      ...(this.WebSocketImpl !== undefined ? { WebSocketImpl: this.WebSocketImpl } : {}),
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    }
    const result = await this.makeSocket(ctx)
    const bundle = normalizeSocketResult(result)
    this.socket = bundle.socket
    this.credsPresent = bundle.hasCreds
    this.registerHandlers(this.socket)
  }

  private registerHandlers(socket: BaileysSocketLike): void {
    socket.ev.on('connection.update', (update: any) => this.handleConnectionUpdate(update))
    socket.ev.on('creds.update', () => {
      this.credsPresent = true
      void this.saveCreds?.().catch((error: Error) => this.log(`creds.update 落盘失败: ${error.message}`))
    })
    socket.ev.on('messages.upsert', (payload: any) => this.handleUpsert(payload))
  }

  private handleConnectionUpdate(update: any): void {
    if (typeof update?.qr === 'string' && update.qr !== '') {
      this.pendingQr = update.qr
      this.onQr?.(update.qr)
      this.connected = false
      return
    }
    if (update?.connection === 'open') {
      this.connected = true
      this.pendingQr = undefined
      const meId = typeof update?.me?.id === 'string' ? update.me.id : undefined
      if (meId !== undefined) this.botJid = meId
      return
    }
    if (update?.connection === 'close') {
      this.connected = false
      this.log('whatsapp: 连接关闭（重连策略归上层）')
    }
  }

  private handleUpsert(payload: any): void {
    const messages = Array.isArray(payload?.messages) ? (payload.messages as WaMessageLike[]) : []
    for (const message of messages) {
      const semantic = this.normalize(message)
      if (semantic !== undefined) {
        for (const listener of this.listeners) listener(semantic)
      }
    }
  }

  /** WAMessage → SemanticMessage；fromMe 回声丢弃、非会话 jid 丢弃、非文本给占位。 */
  normalize(message: WaMessageLike | undefined): SemanticMessage | undefined {
    if (message === undefined || message.key === undefined) return undefined
    const remoteJid = message.key.remoteJid
    if (typeof remoteJid !== 'string' || remoteJid === '') return undefined
    if (message.key.fromMe === true) return undefined
    const kind = jidKind(remoteJid)
    if (kind === undefined) return undefined

    const extracted = extractText(message)
    const mentionedBot = kind === 'group' ? this.detectMention(message) : false
    const senderJid = kind === 'group' ? message.key.participant ?? remoteJid : remoteJid
    const semantic: SemanticMessage = {
      address: { channel: 'whatsapp', kind, chatId: remoteJid },
      userId: String(senderJid),
      userDisplayName: typeof message.pushName === 'string' && message.pushName !== '' ? message.pushName : undefined,
      text: extracted.text,
      mentionedBot,
      timestamp: parseTimestamp(message.messageTimestamp),
    }
    if (extracted.quoteText !== undefined) semantic.quoteText = extracted.quoteText
    return semantic
  }

  private detectMention(message: WaMessageLike): boolean {
    if (this.botJid === '') return false
    const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid
    if (Array.isArray(mentioned) && mentioned.some((jid) => sameJid(jid, this.botJid))) return true
    // 群内直接对 bot 号码的 @ 也常体现在文本（保守兜底）。
    const text = extractText(message).text
    const botNumber = this.botJid.split('@')[0]?.replace(/:\d+$/, '')
    return botNumber !== undefined && botNumber !== '' && text.includes(`@${botNumber}`)
  }

  /** 出站文本：sendMessage ACK（key.id 落定）= 成功；分类见 classify。 */
  async reply(address: ChatAddress, text: string, signal?: AbortSignal): Promise<Receipt> {
    const socket = this.requireSocket()
    const value = truncate(text, this.caps.maxMessageLength)
    let result: WaSendResultLike | undefined
    try {
      result = await socket.sendMessage(address.chatId, { text: value })
    } catch (error) {
      throw classifySendError(error, 'sendMessage')
    }
    void signal
    return toReceipt(result)
  }

  /** 占位 + edit 同一 key 流式；编辑被拒/uncertain 降级补发接替。 */
  async beginStream(address: ChatAddress, signal?: AbortSignal): Promise<ReplyStream> {
    const socket = this.requireSocket()
    let key: WaKeyLike | undefined
    let lastEditAt = 0
    let pending: Promise<void> = Promise.resolve()
    let aborted = false
    const send = async (text: string): Promise<void> => {
      const result = await socket.sendMessage(address.chatId, { text: truncate(text, this.caps.maxMessageLength) })
      key = result?.key
    }
    const edit = async (text: string): Promise<void> => {
      if (key === undefined) return send(text)
      try {
        await socket.sendMessage(address.chatId, {
          text: truncate(text, this.caps.maxMessageLength),
          edit: key,
        })
      } catch (error) {
        const uncertain = classifySendError(error, 'edit')
        if (uncertain instanceof WhatsAppUncertainError) throw uncertain
        // 编辑被拒（消息被删/状态码 4xx）→ 补发接替，编辑链换新 key。
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
    void signal
    return {
      async update(markdown: string): Promise<void> {
        await queued(markdown)
      },
      async finish(markdown: string): Promise<Receipt> {
        await queued(markdown)
        return typeof key?.id === 'string'
          ? { platformMessageId: key.id, uncertain: false }
          : { uncertain: false }
      },
      abort(): void {
        aborted = true
      },
    }
  }

  async setTyping(address: ChatAddress): Promise<void> {
    if (this.socket === undefined) return
    try {
      await this.socket.sendPresenceUpdate?.('composing', address.chatId)
    } catch (error) {
      this.log(`whatsapp presence 失败: ${(error as Error).message}`)
    }
  }

  /** 准入恒交网关白名单（红线 D6）——QR 配对渠道不越权裁决。 */
  authorize(): boolean | undefined {
    return undefined
  }

  /** 诊断三态：creds 在位 / 连接态 / roundtrip 未验证；回包零凭据值。 */
  async diagnose(_signal?: AbortSignal): Promise<ChannelDiagnosisCheck[]> {
    const checks: ChannelDiagnosisCheck[] = []
    checks.push({
      name: 'auth-creds',
      status: this.credsPresent === true ? 'passed' : this.credsPresent === false ? 'failed' : 'unverified',
      hint: this.credsPresent === true ? 'creds 已就绪' : this.credsPresent === false ? '未配对（需扫码）' : 'creds 状态未知',
    })
    checks.push({
      name: 'connection',
      status: this.connected ? 'passed' : 'unverified',
      hint: this.connected ? '会话在线' : '未连接',
    })
    checks.push({
      name: 'roundtrip',
      status: 'unverified',
      hint: '未做收发回环验证（媒体面未接）',
    })
    return checks
  }

  async disconnect(): Promise<void> {
    this.connected = false
    const socket = this.socket
    this.socket = undefined
    this.pendingQr = undefined
    if (socket === undefined) return
    try {
      socket.ev.removeAllListeners?.()
    } catch {
      // 已无监听即目标达成。
    }
    try {
      socket.end?.(false)
    } catch {
      // 断开即达成。
    }
  }

  private requireSocket(): BaileysSocketLike {
    if (this.socket === undefined) {
      throw new WhatsAppUncertainError('whatsapp: 会话未建立（先 connect()）')
    }
    return this.socket
  }

  /** 供 saveCreds 注入口（真实 baileys 工厂会写入；fake 可选）。 */
  setSaveCreds(fn: (() => Promise<void>) | undefined): void {
    this.saveCreds = fn
  }
}

// —— 真实 baileys 缺省工厂（仅宿主接线方装了包才会跑到；测试不走此路径） ————

/**
 * 变量 specifier 绕开 TS 静态解析（缺包不报错）。返回 socket bundle 供适配器注册事件；
 * creds 是否在位由 useMultiFileAuthState 的 state.creds 观测（不回显任何凭据字段）。
 */
const defaultBaileysFactory: WhatsappSocketFactory = async (ctx) => {
  const modName = '@whiskeysockets/baileys'
  const mod: any = await import(modName)
  const makeWASocket: (cfg: any) => BaileysSocketLike = mod.makeWASocket ?? mod.default?.makeWASocket ?? mod.default ?? mod
  const useMultiFileAuthState: (dir: string) => Promise<{ state: any; saveCreds: () => Promise<void> }> =
    mod.useMultiFileAuthState
  if (typeof makeWASocket !== 'function') {
    throw new Error('whatsapp: @whiskeysockets/baileys 未安装或无 makeWASocket 导出')
  }
  let auth: any
  let hasCreds: boolean | undefined
  if (typeof useMultiFileAuthState === 'function') {
    const boot = await useMultiFileAuthState(ctx.stateDir)
    auth = boot.state
    hasCreds = boot?.state?.creds != null && Object.keys(boot.state.creds).length > 0
    // saveCreds 在 creds.update 时落盘——挂到适配器（若暴露注入口）。
    queueMicrotask(() => ctx.log('whatsapp: auth state 就绪'))
    void (boot.saveCreds)
  }
  const cfg: any = { auth }
  if (ctx.WebSocketImpl !== undefined) cfg.webSocketGenerator = () => ctx.WebSocketImpl
  if (ctx.fetchImpl !== undefined) cfg.fetch = ctx.fetchImpl
  const socket = makeWASocket(cfg)
  return hasCreds === undefined ? { socket } : { socket, hasCreds }
}

// —— 工具 ——————————————————————————————————————————

function normalizeSocketResult(result: WhatsappSocketResult): { socket: BaileysSocketLike; hasCreds?: boolean } {
  if (result !== null && typeof result === 'object' && 'socket' in result) {
    return { socket: (result as { socket: BaileysSocketLike }).socket, hasCreds: (result as { hasCreds?: boolean }).hasCreds }
  }
  return { socket: result as BaileysSocketLike }
}

function readStatusCode(error: unknown): number | undefined {
  const anyErr = error as { output?: { statusCode?: number }; statusCode?: number } | undefined
  const code = anyErr?.output?.statusCode ?? anyErr?.statusCode
  return typeof code === 'number' ? code : undefined
}

/**
 * 出站错误分类：WS 断连/超时（无状态码）或 5xx/408/425/429 = uncertain（禁重发）；
 * 明确 4xx error 节点（除上述）= 确定性 WhatsAppApiError（可直接抛）。
 */
function classifySendError(error: unknown, op: string): Error {
  if (error instanceof WhatsAppUncertainError) return error
  if (error instanceof WhatsAppApiError) return error
  const code = readStatusCode(error)
  const message = error instanceof Error ? error.message : String(error)
  if (code === undefined) {
    return new WhatsAppUncertainError(`whatsapp ${op}: 连接/超时结果不明 (${message})`)
  }
  if (code >= 500 || code === 408 || code === 425 || code === 429) {
    return new WhatsAppUncertainError(`whatsapp ${op}: HTTP ${code}`)
  }
  return new WhatsAppApiError(`whatsapp ${op}: 被拒 HTTP ${code}`, code)
}

function jidKind(remoteJid: string): 'dm' | 'group' | undefined {
  if (remoteJid.endsWith('@g.us')) return 'group'
  if (remoteJid.endsWith('@s.whatsapp.net')) return 'dm'
  return undefined
}

function extractText(message: WaMessageLike): { text: string; quoteText?: string } {
  const m = message.message
  if (m === undefined) return { text: '' }
  const ctx = m.extendedTextMessage?.contextInfo
  const quote = ctx?.quotedMessage?.conversation ?? ctx?.quotedMessage?.extendedTextMessage?.text
  const quoteText = typeof quote === 'string' ? quote.slice(0, 200) : undefined
  if (typeof m.conversation === 'string' && m.conversation !== '') return { text: m.conversation, ...(quoteText !== undefined ? { quoteText } : {}) }
  if (typeof m.extendedTextMessage?.text === 'string' && m.extendedTextMessage.text !== '') {
    return { text: m.extendedTextMessage.text, ...(quoteText !== undefined ? { quoteText } : {}) }
  }
  if (typeof m.imageMessage?.caption === 'string' && m.imageMessage.caption !== '') return { text: m.imageMessage.caption }
  if (typeof m.videoMessage?.caption === 'string' && m.videoMessage.caption !== '') return { text: m.videoMessage.caption }
  if (typeof m.documentMessage?.fileName === 'string' && m.documentMessage.fileName !== '') return { text: m.documentMessage.fileName }
  // 非文本消息（媒体需密钥解密，首版未接）：占位文案，不丢事件。
  const typeKey = m === undefined ? undefined : Object.keys(m).find((k) => k.endsWith('Message'))
  const placeholder = typeKey !== undefined ? NON_TEXT_PLACEHOLDER[typeKey] : undefined
  return { text: placeholder ?? '[非文本消息]' }
}

function parseTimestamp(value: number | string | undefined): number | undefined {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000
  if (typeof value === 'string') {
    const num = Number(value)
    if (Number.isFinite(num)) return num > 1e12 ? num : num * 1000
  }
  return undefined
}

/** jid 数值段比较（忽略设备后缀 `:nn`）。 */
function sameJid(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false
  const norm = (jid: string): string => jid.replace(/:\d+@/, '@').toLowerCase()
  return norm(a) === norm(b)
}

function toReceipt(result: WaSendResultLike | undefined): Receipt {
  return typeof result?.key?.id === 'string'
    ? { platformMessageId: result.key.id, uncertain: false }
    : { uncertain: false }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** 工厂挂 registry：secrets 可空（QR 配对渠道），auth 目录即凭据，缺省 accountId 子目录。 */
export function createWhatsappAdapter(options: {
  accountId: string
  config: Record<string, string>
  secrets: Record<string, string | undefined>
}): WhatsappAdapter {
  const authDir = options.config.authDir ?? options.config.stateDir
  return new WhatsappAdapter({
    accountId: options.accountId,
    ...(authDir !== undefined && authDir !== '' ? { authDir } : {}),
  })
}
