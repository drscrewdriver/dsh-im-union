/**
 * Email 渠道适配器（id=email：SMTP 发送 nodemailer / IMAP 收取 imapflow，轮询 UNSEEN）。
 *
 * 净室口径 —— 依据 nodemailer@10、imapflow@2.5 公开 README/docs（MIT）描述协议事实：
 * - 收：IMAP 登录 → INBOX → 轮询 UNSEEN（config.pollIntervalSec 默认 60s；失败退避 2 倍
 *   封顶 10min，成功即复位），逐封 UID FETCH BODY[]（source）自解析 RFC822/MIME
 *   （multipart 递归取叶子：text/plain 优先，仅 html 时粗剥标签——注释口径见 stripHtml；
 *   base64/quoted-printable 解码；RFC2047 头解码），处理后 setMessageFlags 标 \Seen；
 *   源码取回失败 → 降级占位文本，不丢信；
 * - 线程键（chatId）：References 最后一个（=根 Message-ID）→ 回退 In-Reply-To →
 *   回退发件人小写地址；userId=发件人地址；回复方向/来信 Message-ID/主题存线程表；
 * - 发：createTransport + sendMail；回复带 In-Reply-To/References=来信 Message-ID，
 *   主题 Re: 前缀去重（已有 Re: 不叠）；分段=多封邮件，长度上限 50000 交引擎，本档不截；
 * - 自环过滤（必做）：from 等于本账号 address（大小写不敏感）→ 丢弃——邮件桥回环是最大事故源；
 * - Receipt（D7）：SMTP 5xx / 认证类确定性 → EmailApiError；网络断/超时/4xx 临时 →
 *   EmailUncertainError（**绝不自动重发**——邮件无「编辑替换」语义，重发=用户收双份）；
 * - 诊断两查：imap-login-list（connect+LIST）与 smtp-verify（transport.verify()），
 *   各三态：缺凭据 unverified / 失败 failed / 通过 passed；hint 脱敏零密码回显。
 *
 * 依赖边界（学 whatsapp.ts 手法）：编译期不引用 nodemailer/imapflow 类型——动态 import 的
 * 模块名走变量传参（`const modName='imapflow'; await import(modName)`），TS 静态解析不到
 * specifier → 结果宽松 interface；未配 email 账号永不触包。构造面可注入
 * imapFactory/transport，测试全 fake、零网络。
 */
import type { ChatAddress } from '../engine/router.js'
import type {
  ChannelAdapter,
  ChannelCaps,
  ChannelDiagnosisCheck,
  MessageListener,
  OutboundFile,
  Receipt,
  SemanticMessage,
} from './types.js'

const EMAIL_MAX_MESSAGE = 50000
const DEFAULT_POLL_SEC = 60
const MAX_BACKOFF_MS = 10 * 60 * 1000
const QUOTE_MAX_CODEPOINTS = 800
const DEFAULT_SMTP_PORT = 465
const DEFAULT_IMAP_PORT = 993
const MAILBOX = 'INBOX'

// —— 宽松协议 interface（不引 nodemailer/imapflow 类型；注入 fake 亦满足） ——————————

/** nodemailer transport 用到的面。 */
export interface EmailTransportLike {
  sendMail(mail: Record<string, unknown>): Promise<{ messageId?: string; response?: string }>
  verify?(): Promise<unknown>
  close?(): Promise<void>
}

export interface EmailTransportFactory {
  (): Promise<EmailTransportLike> | EmailTransportLike
}

/** imapflow client 用到的面（search/fetch 均为 uid 语义）。 */
export interface EmailImapClientLike {
  connect(): Promise<void>
  logout?(): Promise<void>
  close?(): Promise<void>
  on?(event: string, handler: (error: unknown) => void): void
  getMailboxList?(options?: Record<string, unknown>): Promise<Array<{ path?: string; name?: string; specialUse?: string }>>
  search(criteria: unknown, options?: Record<string, unknown>): Promise<Array<number | string>>
  fetch(
    range: unknown,
    query: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): AsyncIterable<{ uid?: number | string; source?: Buffer | string; flags?: string[] }>
  setMessageFlags?(cid: unknown, mode?: string, flags?: unknown, options?: Record<string, unknown>): Promise<unknown>
}

export interface EmailImapConnectConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  logger: false
}

export type EmailImapFactory = (config: EmailImapConnectConfig) => Promise<EmailImapClientLike> | EmailImapClientLike

export interface EmailAdapterOptions {
  accountId?: string
  /** 本账号邮件地址（自环过滤 + SMTP AUTH user + From 头）。 */
  address?: string
  password?: string
  smtpHost?: string
  smtpPort?: number
  imapHost?: string
  imapPort?: number
  /** 轮询间隔（秒），默认 60。 */
  pollIntervalSec?: number
  /** 测试注入点：替代 nodemailer createTransport（提供后不触包）。 */
  transport?: EmailTransportLike
  /** 测试注入点：替代 imapflow 构造（提供后不触包）。 */
  imapFactory?: EmailImapFactory
  logger?: (msg: string) => void
}

export class EmailApiError extends Error {
  /** SMTP 响应码/错误 code（判型用，不进用户可见文案）。 */
  readonly statusCode: number | undefined
  constructor(message: string, statusCode?: number) {
    super(message)
    this.statusCode = statusCode
  }
}
export class EmailUncertainError extends Error {}

/** 来信方向缓存：回复要用收件人地址、来信 Message-ID（References 链）与原主题。 */
interface ThreadState {
  to: string
  messageId?: string
  references?: string
  subject?: string
}

export class EmailAdapter implements ChannelAdapter {
  readonly id = 'email'
  readonly label = 'Email'
  readonly caps: ChannelCaps = {
    // 邮件无「编辑同一条」原语；分段=多封邮件，长度上限交引擎
    editStream: false,
    nativeStream: false,
    nativeChoices: false,
    statusReaction: false,
    typing: false,
    imageIn: true,
    fileIn: true,
    fileOut: true,
    // 线程键（References 根）即原生 thread 模型
    threads: true,
    voice: false,
    maxMessageLength: EMAIL_MAX_MESSAGE,
  }

  connected = false
  private readonly accountId: string
  private readonly address: string
  private readonly password: string
  private readonly smtpHost: string
  private readonly smtpPort: number
  private readonly imapHost: string
  private readonly imapPort: number
  private readonly baseIntervalMs: number
  private readonly logger: (msg: string) => void
  private readonly injectedTransport: EmailTransportLike | undefined
  private readonly imapFactory: EmailImapFactory
  private transport: EmailTransportLike | undefined
  private client: EmailImapClientLike | undefined
  private listeners: MessageListener[] = []
  private readonly threads = new Map<string, ThreadState>()
  private stopped = true
  private currentIntervalMs: number
  private failures = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private abortSignal: AbortSignal | undefined

  constructor(options: EmailAdapterOptions = {}) {
    this.accountId = options.accountId ?? 'default'
    this.address = (options.address ?? '').trim()
    this.password = options.password ?? ''
    this.smtpHost = options.smtpHost ?? ''
    this.smtpPort = options.smtpPort ?? DEFAULT_SMTP_PORT
    this.imapHost = options.imapHost ?? ''
    this.imapPort = options.imapPort ?? DEFAULT_IMAP_PORT
    this.baseIntervalMs = Math.max(1, options.pollIntervalSec ?? DEFAULT_POLL_SEC) * 1000
    this.currentIntervalMs = this.baseIntervalMs
    this.logger = options.logger ?? (() => {})
    this.injectedTransport = options.transport
    this.transport = options.transport
    this.imapFactory = options.imapFactory ?? defaultImapFactory
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  /**
   * 建连：SMTP transport 懒建（注入面优先）、IMAP client connect，随后起轮询循环。
   * 循环体每轮 pollOnce；异常退避 2 倍封顶 10min，成功复位基准间隔。
   */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.connected) return
    this.abortSignal = signal
    await this.ensureClient()
    await this.requireClient().connect()
    if (this.injectedTransport === undefined && this.transport === undefined) {
      this.transport = await defaultTransportFactory(this.smtpConfig())
    }
    this.connected = true
    this.stopped = false
    // 首轮轮询也走基准间隔（避免 connect 后即时抓取与调用方手动 pollOnce 竞争）。
    this.scheduleNext(this.baseIntervalMs)
  }

  /** 单轮收取（测试直调；轮询循环亦走它）。返回上抛的消息条数。 */
  async pollOnce(): Promise<number> {
    const client = this.requireClient()
    let emitted = 0
    const uids = await client.search('UNSEEN', { mailbox: MAILBOX })
    for (const uid of uids) {
      let parsed: SemanticMessage | undefined
      let sawSource = false
      try {
        for await (const fetched of client.fetch([uid], { source: true, uid: true }, { mailbox: MAILBOX })) {
          const raw = toBuffer(fetched.source)
          if (raw.length === 0) continue
          sawSource = true
          parsed = this.ingest(raw, String(uid))
          if (parsed !== undefined) {
            emitted += 1
            for (const listener of this.listeners) listener(parsed)
          }
        }
      } catch (error) {
        this.logger(`email: FETCH uid=${uid} 失败: ${this.redact(errMessage(error))}`)
      }
      if (!sawSource) {
        // fetch source 失败/空 → 降级占位文本，不丢信（线程键退位 uid，方向未知不回复）。
        const placeholder = this.placeholder(String(uid))
        emitted += 1
        for (const listener of this.listeners) listener(placeholder)
      }
      try {
        await client.setMessageFlags?.(uid, 'add', 'seen', { mailbox: MAILBOX })
      } catch (error) {
        this.logger(`email: 标 \\Seen 失败 uid=${uid}: ${this.redact(errMessage(error))}`)
      }
    }
    return emitted
  }

  /** 原始 RFC822 → SemanticMessage；自环/无效来信丢弃。 */
  private ingest(raw: Buffer, uidFallback: string): SemanticMessage | undefined {
    const email = parseRawEmail(raw)
    const from = parseFromAddress(getHeader(email.headers, 'from'))
    if (from.addr === '') return undefined
    // —— 自环过滤（邮件桥回环是最大事故源，回归用例必测）：
    // from 等于本账号 address（大小写不敏感）→ 丢弃。
    if (this.address !== '' && from.addr.toLowerCase() === this.address.toLowerCase()) return undefined

    const messageId = normalizeMsgIdToken(getHeader(email.headers, 'message-id'))
    const inReplyTo = normalizeMsgIdToken(firstMsgIdToken(getHeader(email.headers, 'in-reply-to')))
    const references = normalizeReferences(getHeader(email.headers, 'references'))
    const chatId = threadKeyOf(references, inReplyTo, from.addr) ?? `uid:${uidFallback}`
    const subject = decodeRfc2047(getHeader(email.headers, 'subject') ?? '')
    const dateHeader = getHeader(email.headers, 'date')
    const timestamp = dateHeader !== undefined ? Date.parse(dateHeader) : NaN

    const bodies = pickBodies(email.parts)
    let text: string
    if (bodies.plain !== undefined) text = bodies.plain
    else if (bodies.html !== undefined) text = stripHtml(bodies.html)
    else text = ''

    const semantic: SemanticMessage = {
      address: { channel: 'email', kind: 'dm', chatId, threadId: from.addr },
      userId: from.addr,
      userDisplayName: from.name !== '' ? from.name : undefined,
      text,
      mentionedBot: false,
      timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
    }
    const quoteText = extractQuotedLines(text)
    if (quoteText !== undefined) semantic.quoteText = quoteText
    if (inReplyTo !== undefined) semantic.quoteId = inReplyTo
    if (bodies.images.length > 0) semantic.images = bodies.images
    if (bodies.files.length > 0) semantic.files = bodies.files

    // 回复方向/引用链/原主题入线程表（reply 据此填 To/In-Reply-To/References/Re:）。
    this.threads.set(chatId, {
      to: from.addr,
      ...(messageId !== undefined ? { messageId } : {}),
      ...(references !== undefined ? { references } : {}),
      ...(subject !== '' ? { subject } : {}),
    })
    return semantic
  }

  private placeholder(uid: string): SemanticMessage {
    return {
      address: { channel: 'email', kind: 'dm', chatId: `uid:${uid}` },
      userId: '',
      text: '[邮件正文取回失败]',
      mentionedBot: false,
    }
  }

  /**
   * 出站文本邮件。回复语义：In-Reply-To/References=来信 Message-ID（线程表），
   * 主题 Re: 前缀去重。错误分类见 classifySendError（D7：uncertain 禁重发——
   * 邮件无编辑替换语义，结果不明时重发=用户收双份）。
   */
  async reply(address: ChatAddress, text: string, signal?: AbortSignal): Promise<Receipt> {
    void signal
    const transport = await this.ensureTransport()
    const thread = this.threads.get(address.chatId)
    const to = address.threadId ?? thread?.to ?? address.chatId
    const mail: Record<string, unknown> = {
      from: this.address !== '' ? this.address : undefined,
      to,
      subject: replySubject(thread?.subject),
      text,
    }
    if (thread?.messageId !== undefined) mail.inReplyTo = thread.messageId
    const refs = referencesFor(thread)
    if (refs !== undefined) mail.references = refs
    let info: { messageId?: string }
    try {
      info = await transport.sendMail(mail)
    } catch (error) {
      throw classifySendError(error)
    }
    return typeof info.messageId === 'string' && info.messageId !== ''
      ? { platformMessageId: info.messageId, uncertain: false }
      : { uncertain: false }
  }

  /** 文件回传：附件邮件（nodemailer attachments={filename,content}）；判型同 reply。 */
  async sendFile(address: ChatAddress, file: OutboundFile, signal?: AbortSignal): Promise<Receipt> {
    void signal
    const transport = await this.ensureTransport()
    const thread = this.threads.get(address.chatId)
    const to = address.threadId ?? thread?.to ?? address.chatId
    const mail: Record<string, unknown> = {
      from: this.address !== '' ? this.address : undefined,
      to,
      subject: replySubject(thread?.subject),
      text: `附件: ${file.name}`,
      attachments: [{ filename: file.name, content: Buffer.from(file.data), contentType: file.mimeType ?? 'application/octet-stream' }],
    }
    if (thread?.messageId !== undefined) mail.inReplyTo = thread.messageId
    const refs = referencesFor(thread)
    if (refs !== undefined) mail.references = refs
    let info: { messageId?: string }
    try {
      info = await transport.sendMail(mail)
    } catch (error) {
      throw classifySendError(error)
    }
    return typeof info.messageId === 'string' && info.messageId !== ''
      ? { platformMessageId: info.messageId, uncertain: false }
      : { uncertain: false }
  }

  /** 准入恒交网关白名单（红线 D6）。 */
  authorize(): boolean | undefined {
    return undefined
  }

  /**
   * 诊断两查：imap-login-list（connect + LIST 含 INBOX）与 smtp-verify。
   * 缺凭据 unverified / 失败 failed / 通过 passed；hint 经 redact，零密码回显。
   */
  async diagnose(signal?: AbortSignal): Promise<ChannelDiagnosisCheck[]> {
    void signal
    const checks: ChannelDiagnosisCheck[] = []
    const hasCreds = this.address !== '' && this.password !== ''

    // IMAP：connect + getMailboxList
    let start = Date.now()
    if (!hasCreds && this.client === undefined) {
      checks.push({ name: 'imap-login-list', status: 'unverified', hint: '缺少 address 或 password，未验证' })
    } else {
      try {
        const client = await this.ensureClient()
        await client.connect()
        const list = (await client.getMailboxList?.({ close: false })) ?? []
        const hit = list.some((m) => (m.path ?? m.name ?? '').toUpperCase() === MAILBOX)
        start = Date.now() - start
        checks.push({
          name: 'imap-login-list',
          status: hit ? 'passed' : 'failed',
          hint: hit ? 'IMAP 登录成功，INBOX 可见' : 'IMAP 登录成功但未列出 INBOX',
          elapsedMs: start,
        })
      } catch (error) {
        checks.push({
          name: 'imap-login-list',
          status: 'failed',
          hint: this.redact(errMessage(error)).slice(0, 160),
          elapsedMs: Date.now() - start,
        })
      }
    }

    // SMTP：transport.verify()
    start = Date.now()
    if (!hasCreds && this.transport === undefined) {
      checks.push({ name: 'smtp-verify', status: 'unverified', hint: '缺少 address 或 password，未验证' })
    } else {
      try {
        const transport = await this.ensureTransport()
        if (typeof transport.verify !== 'function') {
          checks.push({ name: 'smtp-verify', status: 'unverified', hint: '注入的 transport 无 verify()，无法验证' })
        } else {
          await transport.verify()
          checks.push({ name: 'smtp-verify', status: 'passed', hint: 'SMTP 认证通过', elapsedMs: Date.now() - start })
        }
      } catch (error) {
        checks.push({
          name: 'smtp-verify',
          status: 'failed',
          hint: this.redact(errMessage(error)).slice(0, 160),
          elapsedMs: Date.now() - start,
        })
      }
    }
    return checks
  }

  async disconnect(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.connected = false
    const client = this.client
    this.client = undefined
    if (client === undefined) return
    try {
      await client.logout?.()
    } catch {
      try {
        await client.close?.()
      } catch {
        // 断开即达成。
      }
    }
  }

  /** 退避纯函数：base × 2^failures，封顶 10min（导出供回归）。 */
  static backoffMs(baseMs: number, failures: number): number {
    return Math.min(baseMs * 2 ** Math.max(0, failures), MAX_BACKOFF_MS)
  }

  getPollIntervalMs(): number {
    return this.currentIntervalMs
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.runPoll()
    }, delayMs)
    this.timer.unref?.()
  }

  private async runPoll(): Promise<void> {
    if (this.stopped) return
    if (this.abortSignal?.aborted === true) {
      this.stopped = true
      return
    }
    try {
      await this.pollOnce()
      this.failures = 0
      this.currentIntervalMs = this.baseIntervalMs
    } catch (error) {
      this.failures += 1
      this.currentIntervalMs = EmailAdapter.backoffMs(this.baseIntervalMs, this.failures)
      this.logger(`email: 轮询失败，退避 ${this.currentIntervalMs}ms: ${this.redact(errMessage(error))}`)
    }
    this.scheduleNext(this.currentIntervalMs)
  }

  private requireClient(): EmailImapClientLike {
    if (this.client === undefined) throw new EmailUncertainError('email: IMAP 会话未建立（先 connect()）')
    return this.client
  }

  private async ensureClient(): Promise<EmailImapClientLike> {
    if (this.client !== undefined) return this.client
    this.client = await this.imapFactory({
      host: this.imapHost,
      port: this.imapPort,
      secure: true,
      user: this.address,
      pass: this.password,
      logger: false,
    })
    // imapflow 连接期错误走事件面：挂 noop 防未处理 'error' 崩进程。
    this.client.on?.('error', (error: unknown) => this.logger(`email: IMAP 事件: ${this.redact(errMessage(error))}`))
    return this.client
  }

  private async ensureTransport(): Promise<EmailTransportLike> {
    if (this.transport !== undefined) return this.transport
    if (this.address === '' || this.password === '') {
      throw new EmailApiError('email: 缺少 address 或 password，无法建 SMTP transport')
    }
    this.transport = await defaultTransportFactory(this.smtpConfig())
    return this.transport
  }

  private smtpConfig(): SmtpConnectConfig {
    return {
      host: this.smtpHost,
      port: this.smtpPort,
      secure: this.smtpPort === 465,
      user: this.address,
      pass: this.password,
    }
  }

  /** hint/日志脱敏：绝不让 password 出现在任何回显里。 */
  private redact(text: string): string {
    if (this.password === '') return text
    return text.split(this.password).join('***')
  }
}

// —— 真实包缺省工厂（仅宿主装了包且配置了 email 账号才会跑到；测试不走此路径） ————

/** 变量 specifier 绕开 TS 静态解析（缺包不报错），手法同 whatsapp.ts。 */
const defaultImapFactory: EmailImapFactory = async (config) => {
  const modName = 'imapflow'
  const mod: any = await import(modName)
  const ImapFlow = mod.ImapFlow ?? mod.default
  if (typeof ImapFlow !== 'function') throw new Error('email: imapflow 未安装或无 ImapFlow 导出')
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  }) as EmailImapClientLike
}

interface SmtpConnectConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
}

/** 变量 specifier 绕开 TS 静态解析（缺包不报错），手法同 whatsapp.ts。 */
const defaultTransportFactory = async (smtp: SmtpConnectConfig): Promise<EmailTransportLike> => {
  const modName = 'nodemailer'
  const mod: any = await import(modName)
  const nm = mod.createTransport ? mod : mod.default
  if (typeof nm?.createTransport !== 'function') throw new Error('email: nodemailer 未安装或无 createTransport 导出')
  return nm.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
  }) as EmailTransportLike
}

// —— RFC822/MIME 最小解析（净室自持；注释口径：base64/qp/7bit 传输按 ASCII 安全切分，
// 未编码裸 8bit 二进制附件罕见，退化为 latin1 字节映射） ————————————————

export interface ParsedEmail {
  headers: Record<string, string>
  parts: Array<{ headers: Record<string, string>; content: Buffer }>
}

export function parseRawEmail(raw: Buffer): ParsedEmail {
  const text = raw.toString('latin1')
  const split = splitHeadersBody(text)
  const headers = parseHeaderBlock(split.head)
  const parts: ParsedEmail['parts'] = []
  collectLeafParts(split.body, headers, parts, 0)
  return { headers, parts }
}

function splitHeadersBody(text: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(text)
  if (m === null) return { head: text, body: '' }
  return { head: text.slice(0, m.index), body: text.slice(m.index + m[0].length) }
}

function parseHeaderBlock(block: string): Record<string, string> {
  const headers: Record<string, string> = {}
  let lastKey = ''
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && lastKey !== '') {
      headers[lastKey] = `${headers[lastKey] ?? ''} ${line.trim()}`
      continue
    }
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    lastKey = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (headers[lastKey] === undefined) headers[lastKey] = value
  }
  return headers
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const value = headers[name.toLowerCase()]
  return value !== undefined && value !== '' ? value : undefined
}

function collectLeafParts(body: string, headers: Record<string, string>, out: ParsedEmail['parts'], depth: number): void {
  const contentType = getHeader(headers, 'content-type') ?? 'text/plain'
  const boundary = contentType.toLowerCase().startsWith('multipart/') ? getContentTypeParam(contentType, 'boundary') : undefined
  if (boundary !== undefined && depth < 4) {
    for (const block of splitMultipart(body, boundary)) {
      const split = splitHeadersBody(block)
      const partHeaders = parseHeaderBlock(split.head)
      collectLeafParts(split.body, partHeaders, out, depth + 1)
    }
    return
  }
  const encoding = (getHeader(headers, 'content-transfer-encoding') ?? '7bit').trim().toLowerCase()
  out.push({ headers, content: decodeCte(encoding, body) })
}

function splitMultipart(body: string, boundary: string): string[] {
  const blocks: string[] = []
  let current: string[] | undefined
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trimEnd()
    if (trimmed === `--${boundary}`) {
      if (current !== undefined) blocks.push(current.join('\r\n'))
      current = []
      continue
    }
    if (trimmed === `--${boundary}--`) {
      if (current !== undefined) blocks.push(current.join('\r\n'))
      current = undefined
      break
    }
    current?.push(line)
  }
  if (current !== undefined && current.length > 0) blocks.push(current.join('\r\n'))
  return blocks
}

function decodeCte(encoding: string, body: string): Buffer {
  if (encoding === 'base64') {
    return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  }
  if (encoding === 'quoted-printable') {
    return decodeQuotedPrintable(body)
  }
  return Buffer.from(body, 'latin1')
}

function decodeQuotedPrintable(input: string): Buffer {
  const cleaned = input.replace(/=\r?\n/g, '')
  const bytes: number[] = []
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i]!
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
      bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(ch.charCodeAt(0) & 0xff)
    }
  }
  return Buffer.from(bytes)
}

/** Content-Type 参数取值（boundary/charset/name/filename 等，支持带引号参数）。 */
function getContentTypeParam(value: string, name: string): string | undefined {
  const re = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i')
  const m = re.exec(value)
  if (m === null) return undefined
  return m[1] ?? m[2]
}

function decodePartText(part: { headers: Record<string, string>; content: Buffer }): string {
  const contentType = getHeader(part.headers, 'content-type') ?? 'text/plain'
  const charset = (getContentTypeParam(contentType, 'charset') ?? 'utf-8').replace(/^"|"$/g, '')
  try {
    return new TextDecoder(charset.toLowerCase()).decode(part.content)
  } catch {
    return part.content.toString('utf-8')
  }
}

// —— 归一辅助 ——————————————————————————————————————

/** 从 From 头取显示名与地址（多收件人/组格式只取首个地址）。 */
export function parseFromAddress(from: string | undefined): { name: string; addr: string } {
  if (from === undefined) return { name: '', addr: '' }
  const decoded = decodeRfc2047(from)
  const m = /<([^<>()\[\],;:\s]+@[^<>()\[\],;:\s@"]+)>/.exec(decoded)
  if (m !== null && m[1] !== undefined) {
    const name = decoded.slice(0, m.index).trim().replace(/^"|"$/g, '')
    return { name, addr: m[1].trim().toLowerCase() }
  }
  const bare = decoded.split(/[,;]/)[0]?.trim() ?? ''
  return { name: '', addr: bare.includes('@') ? bare.toLowerCase() : '' }
}

function normalizeMsgIdToken(token: string | undefined): string | undefined {
  if (token === undefined) return undefined
  const t = token.trim()
  if (t === '') return undefined
  return t.startsWith('<') ? t : `<${t}>`
}

function firstMsgIdToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return value.trim().split(/\s+/)[0]
}

/** References 规整为空格分隔的 <id> 串；空则 undefined。 */
function normalizeReferences(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const tokens = value.match(/<[^<>]+>/g)
  if (tokens === null || tokens.length === 0) return undefined
  return tokens.join(' ')
}

/** 线程键三级回退：References 最后一个（根）→ In-Reply-To → 发件人小写地址。 */
export function threadKeyOf(references: string | undefined, inReplyTo: string | undefined, fromAddr: string): string | undefined {
  if (references !== undefined) {
    const last = references.split(/\s+/).filter((t) => t !== '')
    const root = last[last.length - 1]
    if (root !== undefined) return root
  }
  if (inReplyTo !== undefined && inReplyTo !== '') return inReplyTo
  return fromAddr !== '' ? fromAddr : undefined
}

/** 叶子 parts → plain/html 正文与附件分档：image/* 进 images、其余进 files。 */
function pickBodies(parts: ParsedEmail['parts']): {
  plain?: string
  html?: string
  images: Array<{ name: string; data: Uint8Array; mimeType: string }>
  files: Array<{ name: string; data: Uint8Array }>
} {
  const result: {
    plain?: string
    html?: string
    images: Array<{ name: string; data: Uint8Array; mimeType: string }>
    files: Array<{ name: string; data: Uint8Array }>
  } = { images: [], files: [] }
  let index = 0
  for (const part of parts) {
    index += 1
    const contentType = (getHeader(part.headers, 'content-type') ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase()
    const disposition = (getHeader(part.headers, 'content-disposition') ?? '').toLowerCase()
    const filename = getContentTypeParam(part.headers['content-type'] ?? '', 'name') ?? getContentTypeParam(part.headers['content-disposition'] ?? '', 'filename')
    const isAttachment = disposition.includes('attachment') || (disposition.includes('inline') && filename !== undefined)
    if (contentType === 'text/plain' && !isAttachment && filename === undefined) {
      if (result.plain === undefined) result.plain = decodePartText(part)
      continue
    }
    if (contentType === 'text/html' && !isAttachment && filename === undefined) {
      if (result.html === undefined) result.html = decodePartText(part)
      continue
    }
    const name = filename ?? `attachment-${index}`
    if (contentType.startsWith('image/')) {
      result.images.push({ name, data: new Uint8Array(part.content), mimeType: contentType })
    } else if (disposition.includes('attachment') || disposition.includes('inline') || filename !== undefined || !contentType.startsWith('text/')) {
      result.files.push({ name, data: new Uint8Array(part.content) })
    }
  }
  return result
}

/** 粗剥 HTML（注释口径：去 script/style/注释/标签，br/块级闭合转换行，实体解码，压空白）。 */
export function stripHtml(html: string): string {
  let s = html
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)\s*>/gi, '\n')
  s = s.replace(/<[^>]*>/g, '')
  s = decodeEntities(s)
  const NL = String.fromCharCode(10)
  s = s.replace(/[ \t]+$/gm, '')
  s = s.replace(new RegExp(NL + '{3,}', 'g'), NL + NL)
  return s.trim()
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeFromCodePoint(Number(dec)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function safeFromCodePoint(cp: number): string {
  return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
}

/** RFC2047 词头解码（=?charset?B|Q?...?=），From/Subject 显示名用。 */
export function decodeRfc2047(value: string): string {
  if (!value.includes('=?')) return value
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, kind: string, data: string) => {
    let bytes: Buffer
    if (kind.toUpperCase() === 'B') {
      bytes = Buffer.from(data.replace(/\s/g, ''), 'base64')
    } else {
      const bytesList: number[] = []
      for (let i = 0; i < data.length; i += 1) {
        const ch = data[i]!
        if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(data.slice(i + 1, i + 3))) {
          bytesList.push(parseInt(data.slice(i + 1, i + 3), 16))
          i += 2
        } else if (ch === '_') {
          bytesList.push(0x20)
        } else {
          bytesList.push(ch.charCodeAt(0))
        }
      }
      bytes = Buffer.from(bytesList)
    }
    try {
      return new TextDecoder(charset.toLowerCase()).decode(bytes)
    } catch {
      return bytes.toString('utf-8')
    }
  })
}

/** 引用行（'>' 前缀，允许前导空白）提取，≤800 码点截断（按码点，不劈代理对）。 */
export function extractQuotedLines(text: string): string | undefined {
  const quoted = text
    .split(/\r?\n/)
    .filter((line) => /^\s*>/.test(line))
    .map((line) => line.replace(/^\s+/, ''))
    .join('\n')
  if (quoted === '') return undefined
  const cps = Array.from(quoted)
  return cps.length <= QUOTE_MAX_CODEPOINTS ? quoted : cps.slice(0, QUOTE_MAX_CODEPOINTS).join('')
}

/** 主题 Re: 前缀去重：已有 Re:/RE: 不叠加，否则补 'Re: '。 */
export function replySubject(originalSubject: string | undefined): string {
  const subject = originalSubject ?? ''
  if (/^\s*(re\s*:\s*)+/i.test(subject)) return subject
  return subject === '' ? 'Re:' : `Re: ${subject}`
}

/** 出站 References：来信 References + 来信 Message-ID（标准回复链）。 */
function referencesFor(thread: ThreadState | undefined): string | undefined {
  const parts = [thread?.references, thread?.messageId].filter((v): v is string => v !== undefined && v !== '')
  return parts.length > 0 ? parts.join(' ') : undefined
}

function toBuffer(source: Buffer | string | undefined): Buffer {
  if (source === undefined) return Buffer.alloc(0)
  return typeof source === 'string' ? Buffer.from(source, 'latin1') : Buffer.from(source)
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 出站错误分类（D7 口径）：
 * - SMTP 5xx（永久拒绝）/ 认证失败（EAUTH）= 确定性 → EmailApiError；
 * - 网络断/超时（无响应码）或 4xx（临时拒绝/灰名单）= 结果不明 → EmailUncertainError。
 *   uncertain 时引擎禁自动重发：邮件无「编辑替换」语义，重发=用户收双份。
 */
export function classifySendError(error: unknown): Error {
  if (error instanceof EmailApiError || error instanceof EmailUncertainError) return error
  const e = error as { code?: string; response?: string; responseCode?: number } | undefined
  const message = errMessage(error)
  let responseCode: number | undefined
  if (typeof e?.responseCode === 'number') {
    responseCode = e.responseCode
  } else if (typeof e?.response === 'string') {
    const m = /^\s*(\d{3})/.exec(e.response)
    if (m?.[1] !== undefined) responseCode = Number(m[1])
  }
  if (e?.code === 'EAUTH') return new EmailApiError(`email smtp: 认证失败 (${message})`)
  if (responseCode !== undefined) {
    if (responseCode >= 500 && responseCode < 600) return new EmailApiError(`email smtp: 永久拒绝 ${responseCode}`, responseCode)
    if (responseCode >= 400 && responseCode < 500) return new EmailUncertainError(`email smtp: 临时拒绝 ${responseCode}（D7 禁自动重发）`)
  }
  return new EmailUncertainError(`email smtp: 连接/超时结果不明 (${message})（D7 禁自动重发）`)
}

// —— 工厂 ——————————————————————————————————————

/**
 * 工厂挂 registry 用（registry/meta 接线归后续任务，本文件不动既有文件）。
 * 明文 config：address/smtpHost/smtpPort/imapHost/imapPort/pollIntervalSec；secret：password。
 * 缺 password 或 address → 抛校验错。第二参 overrides 仅供测试注入 fake 构造面。
 */
export function createEmailAdapter(
  options: { accountId: string; config: Record<string, string>; secrets: Record<string, string | undefined> },
  overrides?: Partial<EmailAdapterOptions>,
): EmailAdapter {
  const address = (options.config.address ?? '').trim()
  const password = options.secrets.password ?? ''
  if (address === '') throw new Error('email: config 缺少 address（本账号邮件地址）')
  if (password === '') throw new Error('email: secrets 缺少 password（邮箱密码/授权码）')
  const smtpPort = parsePort(options.config.smtpPort)
  const imapPort = parsePort(options.config.imapPort)
  const pollIntervalSec = parsePositiveInt(options.config.pollIntervalSec)
  return new EmailAdapter({
    accountId: options.accountId,
    address,
    password,
    ...(options.config.smtpHost !== undefined ? { smtpHost: options.config.smtpHost } : {}),
    ...(smtpPort !== undefined ? { smtpPort } : {}),
    ...(options.config.imapHost !== undefined ? { imapHost: options.config.imapHost } : {}),
    ...(imapPort !== undefined ? { imapPort } : {}),
    ...(pollIntervalSec !== undefined ? { pollIntervalSec } : {}),
    ...overrides,
  })
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const num = Number(value)
  return Number.isInteger(num) && num > 0 && num < 65536 ? num : undefined
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const num = Number(value)
  return Number.isFinite(num) && num >= 1 ? num : undefined
}
