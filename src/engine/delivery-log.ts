/**
 * 投递日志（T2.5 断线结果恢复的数据底座）。
 *
 * 纪律：
 * - 文件态 `<stateDir>/deliveries.json`：环形 ≤1000 条 + 7 天过期清理，
 *   原子写（tmp+rename，与 accounts.json 同姿态）；
 * - **零 secret 字段**：只存截断摘要/状态/计数，绝不写 token、原始平台响应、
 *   内部异常堆栈（细节进本机日志，D4）；
 * - 损坏不 brick：解析失败 → warn + 改名 `.corrupt-<ts>` 后从空表继续
 *   （这是可丢弃的运行日志，不是凭据库——与 vault 的「损坏即抛」刻意不同）；
 * - 红线 D7：`uncertain` 记录永不可重试；只有确定性失败（`failed`）
 *   在 `attempts < MAX_RETRY` 时可被上层补发。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export type DeliveryStatus = 'delivered' | 'failed' | 'uncertain'

export interface DeliveryRecord {
  /** 全局递增序号（`/delivery retry <n>` 的 n 即此值）。 */
  seq: number
  at: number
  direction: 'in' | 'out'
  accountId?: string
  channel: string
  /** 地址形态（补发时重建 ChatAddress 用：dm/group）。 */
  kind?: 'dm' | 'group'
  chatId?: string
  sessionId?: string
  turn?: number
  status: DeliveryStatus
  attempts: number
  /** 用户可见摘要（≤160 字符，零 secret）。 */
  summary: string
  /** 超时补发判重键（sessionId+turn）；无键=普通投递。 */
  dedupKey?: string
  /** 失败粗分类（'rejected'/'network'/'unsupported'），非异常原文。 */
  error?: string
}

export interface DeliveryLogDeps {
  file: string
  now?: () => number
  logWarn?: (msg: string) => void
  /** 环形上限（默认 1000）。 */
  limit?: number
  /** 过期时长（默认 7 天）。 */
  ttlMs?: number
}

export const MAX_RETRY = 3
const DEFAULT_LIMIT = 1000
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SUMMARY_MAX = 160

function sanitizeSummary(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= SUMMARY_MAX ? flat : `${flat.slice(0, SUMMARY_MAX)}…`
}

export class DeliveryLog {
  private records: DeliveryRecord[] = []
  private nextSeq = 1
  private readonly now: () => number
  private readonly limit: number
  private readonly ttlMs: number

  constructor(private readonly deps: DeliveryLogDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.limit = deps.limit ?? DEFAULT_LIMIT
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
    this.load()
  }

  // —— 文件态 ——————————————————————————————————————————

  private load(): void {
    if (!existsSync(this.deps.file)) {
      this.records = []
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.deps.file, 'utf8'))
    } catch (error) {
      const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-')
      const corrupt = `${this.deps.file}.corrupt-${stamp}`
      try {
        renameSync(this.deps.file, corrupt)
      } catch {
        // 改名失败也不阻塞运行。
      }
      this.deps.logWarn?.(`deliveries.json 损坏，已转存 ${corrupt} 并从空表继续: ${(error as Error).message}`)
      this.records = []
      return
    }
    const rows = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { records?: unknown }).records) ? (parsed as { records: unknown[] }).records : []
    this.records = rows
      .map((row): DeliveryRecord | undefined => {
        if (row === null || typeof row !== 'object') return undefined
        const r = row as Record<string, unknown>
        if (typeof r.seq !== 'number' || typeof r.at !== 'number') return undefined
        const status = r.status === 'failed' || r.status === 'uncertain' ? r.status : 'delivered'
        return {
          seq: r.seq,
          at: r.at,
          direction: r.direction === 'in' ? 'in' : 'out',
          accountId: typeof r.accountId === 'string' ? r.accountId : undefined,
          channel: String(r.channel ?? ''),
          kind: r.kind === 'group' ? 'group' : r.kind === 'dm' ? 'dm' : undefined,
          chatId: typeof r.chatId === 'string' ? r.chatId : undefined,
          sessionId: typeof r.sessionId === 'string' ? r.sessionId : undefined,
          turn: typeof r.turn === 'number' ? r.turn : undefined,
          status,
          attempts: typeof r.attempts === 'number' ? r.attempts : 0,
          summary: typeof r.summary === 'string' ? r.summary : '',
          dedupKey: typeof r.dedupKey === 'string' ? r.dedupKey : undefined,
          error: typeof r.error === 'string' ? r.error : undefined,
        }
      })
      .filter((row): row is DeliveryRecord => row !== undefined)
    this.nextSeq = this.records.reduce((max, r) => Math.max(max, r.seq + 1), 1)
    this.prune()
  }

  private persist(): void {
    const tmp = `${this.deps.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf8')
    renameSync(tmp, this.deps.file)
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs
    this.records = this.records.filter((r) => r.at >= cutoff)
    if (this.records.length > this.limit) this.records = this.records.slice(-this.limit)
  }

  // —— 写入 ——————————————————————————————————————————

  /** 追加一条投递结果；返回带 seq 的记录（无 dedupKey 时总是新记录）。 */
  append(input: Omit<DeliveryRecord, 'seq' | 'at' | 'attempts' | 'summary'> & { summary: string; attempts?: number }): DeliveryRecord {
    const record: DeliveryRecord = {
      seq: this.nextSeq++,
      at: this.now(),
      direction: input.direction,
      accountId: input.accountId,
      channel: input.channel,
      kind: input.kind,
      chatId: input.chatId,
      sessionId: input.sessionId,
      turn: input.turn,
      status: input.status,
      attempts: input.attempts ?? 1,
      summary: sanitizeSummary(input.summary),
      dedupKey: input.dedupKey,
      error: input.error,
    }
    this.records.push(record)
    this.prune()
    this.persist()
    return record
  }

  /** sessionId → 最近一次出站时间（admin /channels 渠道 rail 的「最近活动」源）。 */
  lastOutBySession(): Map<string, number> {
    const out = new Map<string, number>()
    for (const r of this.records) {
      if (r.direction !== 'out' || r.sessionId === undefined) continue
      const prev = out.get(r.sessionId)
      if (prev === undefined || r.at > prev) out.set(r.sessionId, r.at)
    }
    return out
  }

  /** 更新既有记录（补发结果回写）；找不到回 undefined。 */
  mark(seq: number, patch: Partial<Pick<DeliveryRecord, 'status' | 'attempts' | 'error' | 'summary'>>): DeliveryRecord | undefined {
    const record = this.records.find((r) => r.seq === seq)
    if (record === undefined) return undefined
    if (patch.status !== undefined) record.status = patch.status
    if (patch.attempts !== undefined) record.attempts = patch.attempts
    if (patch.error !== undefined) record.error = patch.error
    if (patch.summary !== undefined) record.summary = sanitizeSummary(patch.summary)
    this.persist()
    return record
  }

  // —— 读取 ——————————————————————————————————————————

  get(seq: number): DeliveryRecord | undefined {
    return this.records.find((r) => r.seq === seq)
  }

  /** 最近 n 条（可按聊天/会话过滤，倒序）。 */
  recent(n = 10, filter?: { chatId?: string; channel?: string; sessionId?: string }): DeliveryRecord[] {
    const rows = this.records.filter((r) => {
      if (filter?.chatId !== undefined && r.chatId !== filter.chatId) return false
      if (filter?.channel !== undefined && r.channel !== filter.channel) return false
      if (filter?.sessionId !== undefined && r.sessionId !== filter.sessionId) return false
      return true
    })
    return rows.slice(-Math.max(1, n)).reverse()
  }

  /** 判重：该 dedupKey 是否已投递过（T2.9 超时补发用）。 */
  seen(dedupKey: string): boolean {
    return this.records.some((r) => r.dedupKey === dedupKey && r.status === 'delivered')
  }

  /** 可补发集合：确定性失败且未达上限；uncertain 绝不出现（D7）。 */
  retryable(): DeliveryRecord[] {
    return this.records.filter((r) => r.status === 'failed' && r.direction === 'out' && r.attempts < MAX_RETRY)
  }
}
