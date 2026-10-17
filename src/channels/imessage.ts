/**
 * iMessage 渠道适配器（P2 T3.3）——macOS 本机：chat.db 只读轮询收 + AppleScript 发，仅文本私聊。
 *
 * 装载侧硬拒（平台闸）：构造期 `platform !== 'darwin'` 即抛 ImessageUnsupportedError。
 * meta.hostRequirement='macos' 只让设置页灰显（展示侧），真正的「不装载」在此；
 * AccountManager.buildAdapter/ensureConnected 会 catch 并 logWarn —— 工厂抛 = 明确拒载该渠道，
 * 不是静默降级（红线 E1：声明即实现，缺位显式失败）。
 *
 * 平台/协议事实（公开知识，来源逐条见文末「来源」段）：
 * 1. 收：`~/Library/Messages/chat.db`（SQLite，只读打开 URI `file:…?mode=ro`）
 *    - `message(ROWID, text, is_from_me, handle_id, date)`：`date` 为自 2001-01-01
 *      00:00:00 UTC 起的**纳秒**（Apple / Mac Absolute Time），换算 ms =
 *      `date / 1e9 + 978307200` 秒（= 978307200000 ms 偏移）；
 *    - `handle(HANDLE_ID, ID)`：`ID` = 电话号码或 Apple ID 邮箱；对端地址按
 *      `message.handle_id = handle.HANDLE_ID` join 取得；
 *    - `chat` / `chat_message_join` / `attachment` / `message_attachment_join` 存在但
 *      首版不消费——群聊与附件面【登记为不做】：caps.threads/imageIn/fileIn/fileOut=false；
 *      附件消息常表现为 `text` 为 NULL，本实现直接跳过（不伪造空消息喂下游）；
 *    - macOS 11(Ventura)+ 起部分正文改存 `message.attributedBody` BLOB（gzip+UTF-16），
 *      `text` 列可能为空 → 首版只读 `text`，BLOB 兜底只做 UTF-16LE 解码，不做 plist 解析；
 *    - 读该库要求宿主进程具备「完全磁盘访问权限」；文件缺失/无权限 = 明确失败态
 *      （connect/diagnose 报 failed 并给授权指引），绝不静默空轮询；
 *    - 游标：`ROWID` 单调递增，只取 `ROWID > cursor` 的新行；首轮先立基线（MAX(ROWID)），
 *      不回放历史（skipHistory 默认 true）。
 * 2. 发：AppleScript——`osascript -e 'tell application "Messages" to send …' to buddy "<handle>"`
 *    是公开标准做法（Messages.app 有 AppleScript dictionary，无官方公开 API，靠
 *    「自动化」权限）。安全红线：**用户文本绝不进脚本字符串拼接**——脚本写成
 *    `on run argv` handler 固定形态，文本与 handle 作为 osascript 的位置参数传入
 *    （man osascript：给出 -e 后不再把后续参数当 programfile，其余参数进入 run handler 的
 *    argv 列表），因此引号/换行/`"`/`'`/AppleScript 关键字均无注入面。
 *    结果判定：退出码 0 = 平台接受（uncertain=false）；非 0（stderr 含 Messages/
 *    AppleScript 错误，如 -1708/-1728/未授权）= 确定性失败 ImessageApiError；
 *    spawn 失败（ENOENT，无 osascript）/ 超时被杀 / 无退出码 = 结果不确定
 *    ImessageUncertainError（D7：引擎禁自动重发，宁可漏发不双发）。
 * 3. 能力面（诚实声明）：仅文本私聊——入站/出站 kind 恒 dm；无编辑流式、无原生流式、
 *    无原生按钮（引擎退化为数字菜单走 reply）、无状态表情回应、无 typing、无附件、
 *    无话题、无语音；maxMessageLength 保守取 4000。
 *
 * 运行时依赖零：`node:sqlite` 懒 import（避免非 macOS/未配置即吃实验警告与装载成本）+
 * `node:child_process` execFile(osascript)，且 platform / DatabaseSyncImpl / execFileImpl /
 * fileExistsImpl / homedirImpl / pollIntervalMs 全可注入——单测零真机。
 *
 * 来源（公开知识，2026-10 检索核实）：
 * - chat.db 表结构与 date 纳秒/2001 纪元：spin.atomicobject.com《Searching Your iMessage
 *   Database (Chat.db file) with SQL》（message/handle/chat/attachment + join 表职责，含
 *   Ventura 起正文改存 blob 的更新说明）；cnblogs《AppleScript 实现短信自动转发》给出
 *   `date/1000000000 + 978307200` 的 SQL 换算式；sspai.com/post/88076（timestamp/1e9 + 2001-01-01）。
 * - 只读打开 mode=ro + 完全磁盘访问前提：github.com/steipete/imsg README（"Read-only DB
 *   access ("mode=ro")"、"Full Disk Access for your terminal to read ~/Library/Messages/chat.db"）。
 * - osascript 发送：github.com/steipete/imsg（"send uses AppleScript (no private APIs)"）、
 *   gist.github.com/eplt/027c99215e37a3a138c32b19a944b05d（`osascript -e 'tell application
 *   "Messages" to send "Hello World!" to buddy "+11234567890"'`）。
 * - argv 传参语义：man osascript / ss64.com/mac/osascript.html（"If -e is given, osascript
 *   will not look for a filename in the argument list"；其余参数进 `on run argv`）。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChatAddress } from '../engine/router.js'
import type {
  ChannelAdapter,
  ChannelCaps,
  ChannelDiagnosisCheck,
  MessageListener,
  Receipt,
  SemanticMessage,
} from './types.js'

/** 任务口径：保守取 4000（iMessage 单条实际远大于此，留分段余量）。 */
export const IMESSAGE_MAX_MESSAGE = 4000
/** Apple epoch（2001-01-01 UTC）到 Unix epoch 的毫秒偏移。 */
export const APPLE_EPOCH_OFFSET_MS = 978_307_200_000
const APPLE_NS_PER_MS = 1_000_000
const DEFAULT_POLL_INTERVAL_MS = 2_000
/** 单轮最多取多少行（游标推进按行内最大 ROWID，剩余下轮续取）。 */
const POLL_BATCH_LIMIT = 200
/** busy_timeout：Messages 持有写锁时读侧等待上限（ms）。 */
const DEFAULT_DB_BUSY_TIMEOUT_MS = 1_000
const DEFAULT_OSA_TIMEOUT_MS = 15_000
const DEFAULT_DIAGNOSE_OSA_TIMEOUT_MS = 5_000

export const CHANNEL_ID = 'imessage'

// —— 错误四型 ——————————————————————————————————————————

/** 非 macOS 宿主：装载侧硬拒（工厂/构造期抛，账号管理器 catch 记 warn）。 */
export class ImessageUnsupportedError extends Error {
  constructor(message = 'iMessage 渠道仅支持 macOS 宿主') {
    super(message)
  }
}
/** chat.db 缺失/不可读：明确失败态（含完全磁盘访问指引），不是空轮询。 */
export class ImessageDbError extends Error {}
/** 确定性失败（平台/脚本可判错误，禁盲改内容重发）。 */
export class ImessageApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message)
  }
}
/** 结果不确定（spawn 失败/超时/无退出码）——D7：引擎禁自动重发。 */
export class ImessageUncertainError extends Error {}

// —— 注入面类型（全部结构化，真机实现由懒 import 提供） ——————————————

export type SqlParam = string | number | bigint | null

export interface StatementLike {
  all(...params: SqlParam[]): Array<Record<string, unknown>>
  get(...params: SqlParam[]): Record<string, unknown> | undefined
}

export interface DatabaseSyncLike {
  prepare(sql: string): StatementLike
  close(): void
}

/** node:sqlite DatabaseSync 的最小结构面（构造参数只用到 path + readOnly/timeout）。 */
export type DatabaseSyncCtor = new (path: string, options?: Record<string, unknown>) => DatabaseSyncLike

export interface ExecFileResult {
  /** 进程退出码；null = 被信号终止/无退出码（结果不可判）。 */
  code: number | null
  stdout: string
  stderr: string
}

export interface ExecFileOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export type ExecFileLike = (file: string, args: readonly string[], options?: ExecFileOptions) => Promise<ExecFileResult>

// —— SQL（导出供单测直验 join 与游标谓词） ————————————————

export const SQL_MAX_ROWID = 'SELECT MAX(ROWID) AS max_rowid FROM message'

export const SQL_NEW_MESSAGES = [
  'SELECT m.ROWID AS rowid, m.text AS text, m.is_from_me AS is_from_me, m.date AS date, h.id AS handle',
  'FROM message m',
  'LEFT JOIN handle h ON h.HANDLE_ID = m.handle_id',
  'WHERE m.ROWID > ? ORDER BY m.ROWID ASC LIMIT ?',
].join(' ')

const SQL_DB_PROBE = 'SELECT 1 AS ok FROM message LIMIT 1'

// —— AppleScript 发送脚本（固定串，永不含用户内容） ————————————

/**
 * 脚本本体：`on run argv` handler 形态。argv[1]=文本，argv[2]=handle。
 * 每行独立作为 `-e` 参数传给 osascript（man osascript：多 -e 拼装成多行脚本）。
 */
export const SEND_SCRIPT_LINES: readonly string[] = [
  'on run argv',
  '  set theText to (item 1 of argv) as text',
  '  set theHandle to (item 2 of argv) as text',
  '  tell application "Messages"',
  '    send theText to buddy theHandle',
  '  end tell',
  '  return "ok"',
  'end run',
]

const DIAGNOSE_OSA_SCRIPT = 'tell application "Messages" to get name'

export interface OsascriptInvocation {
  file: string
  args: string[]
}

/**
 * 组装 osascript 调用：脚本行全部走 `-e`，用户文本与 handle 作为尾部位置参数传入。
 * 安全红线在此实现——不存在任何把 text/handle 拼进脚本文本的代码路径。
 */
export function buildSendInvocation(text: string, handle: string): OsascriptInvocation {
  const args: string[] = []
  for (const line of SEND_SCRIPT_LINES) args.push('-e', line)
  args.push(text, handle)
  return { file: 'osascript', args }
}

// —— 纯函数（导出供单测直验） ————————————————————————————

export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/** message.date（Apple epoch 纳秒）→ Unix epoch 毫秒；0/负值视为无效。 */
export function appleNanoToMs(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'bigint') {
    const ms = Number(value / BigInt(APPLE_NS_PER_MS))
    return ms <= 0 ? undefined : ms + APPLE_EPOCH_OFFSET_MS
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined
    return Math.floor(value / APPLE_NS_PER_MS) + APPLE_EPOCH_OFFSET_MS
  }
  const num = toNumber(value)
  if (num === undefined || num <= 0) return undefined
  return Math.floor(num / APPLE_NS_PER_MS) + APPLE_EPOCH_OFFSET_MS
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * handle 归一：邮箱小写（Apple ID 大小写不敏感），电话去空白与书写分隔符（空格/-/()/ .）。
 * 同一函数用于入站定址与出站 buddy，保证「收到的地址」可直接「发回同一地址」。
 * 不做 E.164 补全（跨格式匹配需用户在 config.selfHandle/白名单里给出规范地址）。
 */
export function normalizeHandle(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.replace(/[\u00A0\u2007\u202F]/g, ' ').trim()
  if (trimmed === '') return ''
  if (EMAIL_RE.test(trimmed)) return trimmed.toLowerCase() // 邮箱先判，避免去掉域名点
  return trimmed.replace(/[\s\-().]/g, '')
}

/** text 列三形态：TEXT → 原样；BLOB → UTF-16LE 兜底解码；NULL/数字 → 不消费。 */
export function decodeTextCell(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) {
    let text = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf16le')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return text.replace(/\u0000+$/g, '')
  }
  return undefined
}

/** chat.db 只读 URI（SQLite 需 SQLITE_OPEN_URI，node:sqlite 打开时已带该标志）。 */
export function toReadOnlyUri(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const absolute = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file:${absolute}?mode=ro`
}

// —— 默认实现（懒 import，仅真机路径触达） ————————————————————

const defaultExecFile: ExecFileLike = async (file, args, options) => {
  const { execFile } = await import('node:child_process')
  return await new Promise<ExecFileResult>((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', timeout: options?.timeoutMs ?? 0, maxBuffer: 4 * 1024 * 1024, ...(options?.signal !== undefined ? { signal: options.signal } : {}) },
      (error, stdout, stderr) => {
        if (error !== null && error !== undefined) {
          const code = typeof error.code === 'number' ? error.code : null
          const wrapped = Object.assign(new Error(`${file}: ${String(error.message)}`), {
            code,
            killed: error.killed === true,
            cause: error,
          }) as Error & { code: number | null; killed: boolean }
          reject(wrapped)
          return
        }
        resolve({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })
}

// —— 适配器 ——————————————————————————————————————————————

export interface ImessageAdapterOptions {
  accountId?: string
  /** 缺省 ~/Library/Messages/chat.db（macOS 固定位置）。 */
  chatDbPath?: string
  /** 本机账号地址（可选）：入站命中即按回声丢弃，作 is_from_me 的兜底。 */
  selfHandle?: string
  /** 轮询间隔 ms；<=0 = 不启后台循环（只由 pollOnce 手动驱动，测试/受控调度用）。 */
  pollIntervalMs?: number
  /** 首轮是否跳过历史（默认 true：只收连接后的新消息）。 */
  skipHistory?: boolean
  /** 平台注入（测试零真机）；缺省 process.platform。 */
  platform?: string
  /** node:sqlite DatabaseSync 注入（测试用 fake sqlite）。 */
  DatabaseSyncImpl?: DatabaseSyncCtor
  /** execFile 注入（测试用 fake osascript）。 */
  execFileImpl?: ExecFileLike
  fileExistsImpl?: (path: string) => boolean
  homedirImpl?: () => string
  logger?: (msg: string) => void
}

export class ImessageAdapter implements ChannelAdapter {
  readonly id = CHANNEL_ID
  readonly label = 'iMessage'
  readonly caps: ChannelCaps = {
    editStream: false,
    nativeStream: false,
    nativeChoices: false,
    statusReaction: false,
    statusProgress: false,
    typing: false,
    imageIn: false,
    fileIn: false,
    fileOut: false,
    threads: false,
    voice: false,
    maxMessageLength: IMESSAGE_MAX_MESSAGE,
  }

  connected = false

  readonly accountId: string
  readonly chatDbPath: string
  readonly selfHandle: string
  private readonly pollIntervalMs: number
  private readonly skipHistory: boolean
  private readonly DatabaseSyncImpl: DatabaseSyncCtor | undefined
  private readonly execFileImpl: ExecFileLike
  private readonly fileExists: (path: string) => boolean
  private readonly log: (msg: string) => void

  private listeners: MessageListener[] = []
  private db: DatabaseSyncLike | undefined
  /** 入站游标（已消费的最大 ROWID）；undefined = 尚未立基线。 */
  private cursor: number | undefined
  private pollController: AbortController | undefined

  constructor(options: ImessageAdapterOptions = {}) {
    const platform = options.platform ?? process.platform
    if (platform !== 'darwin') throw new ImessageUnsupportedError()
    const home = options.homedirImpl !== undefined ? options.homedirImpl() : homedir()
    this.accountId = options.accountId ?? 'imessage'
    this.chatDbPath = options.chatDbPath !== undefined && options.chatDbPath !== '' ? options.chatDbPath : join(home, 'Library', 'Messages', 'chat.db')
    this.selfHandle = normalizeHandle(options.selfHandle)
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.skipHistory = options.skipHistory !== false
    this.DatabaseSyncImpl = options.DatabaseSyncImpl
    this.execFileImpl = options.execFileImpl ?? defaultExecFile
    this.fileExists = options.fileExistsImpl ?? ((path) => existsSync(path))
    this.log = options.logger ?? (() => {})
  }

  // —— 生命周期 ——————————————————————————————————————————

  async connect(signal?: AbortSignal): Promise<void> {
    const db = await this.openDatabase()
    this.db = db
    if (this.cursor === undefined) this.cursor = await this.establishBaseline(db)
    this.connected = true
    // 连接即跑一轮：skipHistory=false 时先排空历史，默认档位下基线已覆盖（无新行）。
    try {
      await this.pollOnce()
    } catch (error) {
      this.log(`imessage: 首轮轮询失败：${String((error as Error).message ?? error)}`)
    }
    if (this.pollIntervalMs > 0) {
      this.pollController = new AbortController()
      if (signal !== undefined) signal.addEventListener('abort', () => this.pollController?.abort(), { once: true })
      void this.pollLoop(this.pollController.signal)
    }
  }

  async disconnect(): Promise<void> {
    this.pollController?.abort()
    this.pollController = undefined
    this.connected = false
    const db = this.db
    this.db = undefined
    if (db !== undefined) {
      try {
        db.close()
      } catch (error) {
        this.log(`imessage: chat.db 关闭异常（${String(error)}）`)
      }
    }
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  // —— 入站轮询（chat.db 只读） ————————————————————————————

  /** 懒开库：文件缺失 = 明确失败态（授权指引），不静默返回空集。 */
  private async openDatabase(): Promise<DatabaseSyncLike> {
    if (this.db !== undefined) return this.db
    if (!this.fileExists(this.chatDbPath)) {
      throw new ImessageDbError(
        `iMessage: 未找到 chat.db（${this.chatDbPath}）——请为宿主进程授予「完全磁盘访问权限」（系统设置 → 隐私与安全性 → 完全磁盘访问），并在「信息」中登录 Apple ID 后重试`,
      )
    }
    const Ctor = this.DatabaseSyncImpl ?? ((await import('node:sqlite')).DatabaseSync as unknown as DatabaseSyncCtor)
    try {
      return new Ctor(toReadOnlyUri(this.chatDbPath), { readOnly: true, timeout: DEFAULT_DB_BUSY_TIMEOUT_MS })
    } catch (error) {
      throw new ImessageDbError(
        `iMessage: chat.db 只读打开失败（${String(error)}）——多为「完全磁盘访问权限」缺失或数据库被锁定`,
      )
    }
  }

  /** 首轮基线：默认取 MAX(ROWID)（不回放历史）；skipHistory=false 时从 0 起读全量。 */
  private async establishBaseline(db: DatabaseSyncLike): Promise<number> {
    if (!this.skipHistory) return 0
    const row = db.prepare(SQL_MAX_ROWID).get()
    return toNumber(row?.max_rowid) ?? 0
  }

  /**
   * 单轮拉取：取 ROWID > cursor 的新行，归一后广播，游标推进到本批最大 ROWID。
   * 导出为公共方法供受控调度/单测手动驱动（pollIntervalMs<=0 时即纯手动）。
   */
  async pollOnce(): Promise<number> {
    const db = await this.openDatabase()
    if (this.cursor === undefined) this.cursor = await this.establishBaseline(db)
    const rows = db.prepare(SQL_NEW_MESSAGES).all(this.cursor, POLL_BATCH_LIMIT) as Array<Record<string, unknown>>
    let maxSeen = this.cursor
    let emitted = 0
    for (const row of rows) {
      const rowid = toNumber(row.rowid) ?? 0
      if (rowid > maxSeen) maxSeen = rowid
      const message = this.normalizeRow(row)
      if (message === undefined) continue
      emitted += 1
      for (const listener of [...this.listeners]) listener(message)
    }
    this.cursor = maxSeen
    return emitted
  }

  /**
   * 行 → SemanticMessage（导出供单测直验）：
   * is_from_me 回声丢弃、handle 归一定址、Apple epoch 换算、空正文（附件类）跳过。
   */
  normalizeRow(row: Record<string, unknown>): SemanticMessage | undefined {
    const fromMe = toNumber(row.is_from_me)
    if (fromMe !== undefined && fromMe !== 0) return undefined // 本机发出/其他设备同步回声
    const handle = normalizeHandle(row.handle)
    if (handle === '') return undefined // join 不上 handle 的行无法定址（首版不猜地址）
    if (this.selfHandle !== '' && handle === this.selfHandle) return undefined // 自发自聊兜底
    const text = decodeTextCell(row.text)
    if (text === undefined || text.trim() === '') return undefined // 附件/贴纸等无正文行：首版不消费
    const address: ChatAddress = { channel: CHANNEL_ID, kind: 'dm', chatId: handle }
    const timestamp = appleNanoToMs(row.date)
    return {
      address,
      userId: handle,
      text,
      mentionedBot: false,
      ...(timestamp !== undefined ? { timestamp } : {}),
    }
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0
    while (!signal.aborted && this.connected) {
      try {
        await this.pollOnce()
        consecutiveFailures = 0
      } catch (error) {
        if (signal.aborted || !this.connected) return
        consecutiveFailures += 1
        this.log(`imessage: 轮询失败（连续 ${consecutiveFailures} 次）：${String((error as Error).message ?? error)}`)
        // 库句柄可能已失效（Messages 轮换/WAL/权限未补）：丢弃后下轮重开，
        // 失败态由退避休眠兜底（不热自旋，也不伪装成已连接失败）。
        const stale = this.db
        this.db = undefined
        if (stale !== undefined) {
          try {
            stale.close()
          } catch {
            /* 已失效句柄，忽略 */
          }
        }
      }
      if (signal.aborted || !this.connected) return
      await this.sleep(this.pollIntervalMs + Math.min(consecutiveFailures, 5) * this.pollIntervalMs, signal)
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }

  // —— 出站（AppleScript） —————————————————————————————————

  async reply(address: ChatAddress, text: string, signal?: AbortSignal): Promise<Receipt> {
    // 诚实边界：首版只发文本私聊（群/话题需 chat id 定位，未实现）。
    if (address.kind !== 'dm') {
      throw new ImessageApiError('iMessage 首版仅支持文本私聊（kind=dm）：群聊/话题投递未实现')
    }
    const handle = normalizeHandle(address.chatId)
    if (handle === '') throw new ImessageApiError('iMessage: 收件人 handle 为空，无法定位 buddy')
    if (typeof text !== 'string' || text.trim() === '') throw new ImessageApiError('iMessage: 文本为空，拒绝发送')

    const { file, args } = buildSendInvocation(text, handle)
    let result: ExecFileResult
    try {
      result = await this.execFileImpl(file, args, { timeoutMs: DEFAULT_OSA_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) })
    } catch (error) {
      throw this.classifyExecFailure(error)
    }
    if (result.code === 0) return { uncertain: false }
    if (result.code === null || result.code === undefined) {
      throw new ImessageUncertainError('iMessage: osascript 无退出码（进程被信号终止），投递结果不确定，禁自动重发')
    }
    throw new ImessageApiError(
      `iMessage: AppleScript 发送失败（osascript 退出码 ${result.code}）：${snippet(result.stderr) || 'stderr 为空——请检查「信息」登录态与「自动化」授权'}`,
      result.code,
    )
  }

  /** 失败分类：数字退出码=确定性；ENOENT/超时被杀/取消=不确定（D7 禁重发）。 */
  private classifyExecFailure(error: unknown): Error {
    const err = error as { code?: number | string; killed?: boolean; message?: string; name?: string }
    if (typeof err.code === 'number') {
      return new ImessageApiError(`iMessage: AppleScript 发送被拒（osascript 退出码 ${err.code}）：${String(err.message ?? '')}`, err.code)
    }
    if (err.code === 'ENOENT') {
      return new ImessageUncertainError('iMessage: 未找到 osascript 可执行文件（宿主非 macOS 或 PATH 缺失），消息未发出')
    }
    if (err.killed === true || err.name === 'TimeoutError') {
      return new ImessageUncertainError(`iMessage: osascript 超时被杀（${DEFAULT_OSA_TIMEOUT_MS}ms），投递结果不确定，禁自动重发`)
    }
    return new ImessageUncertainError(`iMessage: osascript 调用传输失败（${String(err.message ?? err)}），投递结果不确定，禁自动重发`)
  }

  // —— 诊断三态 ——————————————————————————————————————————

  async diagnose(signal?: AbortSignal): Promise<ChannelDiagnosisCheck[]> {
    const checks: ChannelDiagnosisCheck[] = []

    // 1) chat.db 存在且可读
    const dbStarted = Date.now()
    if (!this.fileExists(this.chatDbPath)) {
      checks.push({
        name: 'chat-db',
        status: 'failed',
        hint: `未找到 chat.db（${this.chatDbPath}）——请授予「完全磁盘访问权限」并在「信息」中登录 Apple ID`,
        elapsedMs: Date.now() - dbStarted,
      })
    } else {
      let ownDb: DatabaseSyncLike | undefined
      try {
        const db = this.db ?? (ownDb = await this.openDatabase())
        db.prepare(SQL_DB_PROBE).get()
        checks.push({ name: 'chat-db', status: 'passed', elapsedMs: Date.now() - dbStarted })
      } catch (error) {
        checks.push({
          name: 'chat-db',
          status: 'failed',
          hint: String((error as Error).message ?? error),
          elapsedMs: Date.now() - dbStarted,
        })
      } finally {
        if (ownDb !== undefined) {
          try {
            ownDb.close()
          } catch {
            /* 探针句柄 */
          }
        }
      }
    }

    // 2) osascript / Messages 可控（只判可用性，判不出即 unverified 不判死）
    const osaStarted = Date.now()
    try {
      const result = await this.execFileImpl('osascript', ['-e', DIAGNOSE_OSA_SCRIPT], {
        timeoutMs: DEFAULT_DIAGNOSE_OSA_TIMEOUT_MS,
        ...(signal !== undefined ? { signal } : {}),
      })
      const osaCheck: ChannelDiagnosisCheck = {
        name: 'osascript',
        status: result.code === 0 ? 'passed' : 'unverified',
        elapsedMs: Date.now() - osaStarted,
      }
      if (result.code !== 0) {
        osaCheck.hint = `osascript 退出码 ${result.code}：${snippet(result.stderr) || 'stderr 为空'}——需在「系统设置 → 隐私与安全性 → 自动化」放行宿主进程控制「信息」，并确认已登录 Apple ID`
      }
      checks.push(osaCheck)
    } catch (error) {
      const err = error as { message?: string; code?: number | string }
      checks.push({
        name: 'osascript',
        status: 'unverified',
        hint: `osascript 不可用（${String(err.message ?? err)}）——需 macOS「自动化」授权，未据此判死`,
        elapsedMs: Date.now() - osaStarted,
      })
    }

    // 3) round-trip 恒 unverified（真机收发需人工实测，T1.10 验收面）
    checks.push({ name: 'roundtrip', status: 'unverified', hint: '真机收发需 macOS 已登录「信息」账号并人工互发验证' })
    return checks
  }
}

function snippet(stderr: string | undefined): string {
  return String(stderr ?? '').trim().replace(/\s+/g, ' ').slice(0, 200)
}

/** 额外注入面（platform/DatabaseSyncImpl/execFileImpl/…）：注册表走 ChannelFactory 形态时缺省为空。 */
export interface ImessageInjection {
  platform?: string
  DatabaseSyncImpl?: DatabaseSyncCtor
  execFileImpl?: ExecFileLike
  fileExistsImpl?: (path: string) => boolean
  homedirImpl?: () => string
  pollIntervalMs?: number
}

/**
 * 工厂：config 可含 chatDbPath（默认 ~/Library/Messages/chat.db）与 selfHandle，
 * 另有可选 pollIntervalMs（<=0 关闭后台轮询）。iMessage 是本机渠道，零 secret
 * （meta.ts 未登记该渠道字段面——禁改既有文件，本迭代走明文 config）。
 * 非 darwin 平台构造即抛 ImessageUnsupportedError：装载侧「明确拒载该渠道」。
 */
export function createImessageAdapter(
  options: { accountId: string; config: Record<string, string>; secrets: Record<string, string | undefined>; signal?: AbortSignal },
  injection: ImessageInjection = {},
): ImessageAdapter {
  const config = options.config ?? {}
  const pollInterval = toNumber(config.pollIntervalMs)
  return new ImessageAdapter({
    accountId: options.accountId,
    ...(config.chatDbPath !== undefined && config.chatDbPath !== '' ? { chatDbPath: config.chatDbPath } : {}),
    ...(config.selfHandle !== undefined && config.selfHandle !== '' ? { selfHandle: config.selfHandle } : {}),
    ...(pollInterval !== undefined ? { pollIntervalMs: pollInterval } : {}),
    platform: injection.platform,
    DatabaseSyncImpl: injection.DatabaseSyncImpl,
    execFileImpl: injection.execFileImpl,
    fileExistsImpl: injection.fileExistsImpl,
    homedirImpl: injection.homedirImpl,
    ...(injection.pollIntervalMs !== undefined ? { pollIntervalMs: injection.pollIntervalMs } : {}),
  })
}
