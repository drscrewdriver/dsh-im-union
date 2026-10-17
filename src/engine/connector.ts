/**
 * AI Office Connector（M2 T2.7）：设备凭据 / Job 租约 / 审批等待 / 并发上限，强制 HTTPS。
 *
 * 宿主协议面查实结论（先于写码，工作副本 e:\test\rewrite-agently\dsh-repo）：
 * - 对各包 src 目录（packages 下逐包）大小写不敏感搜索 `connector|aiOffice|ai-office|deviceCredential|jobLease`，
 *   仅 3 处命中且都与本模块无关（client/ui-primitives/src/icons/index.tsx:691 图标「连线」几何注释、
 *   web/web-fetch-http/src/network.ts:255 与 tests/fetch-http.spec.ts:218 的 DNS connector lookup）；
 *   `lease` 命中=session-query/src/observation.ts:38,75-77 观测快照引用计数，与 Job 租约无关；
 *   `approval` 命中=packages/interaction/user-approval/src/index.ts:1-50 宿主审批 capability（会话内工具裁决，
 *   无 Job/设备配对形态）。
 * - **即：宿主无公开的 connector / AI Office 设备配对与 Job 租约协议面。** 因此本模块是
 *   「插件侧自建离线 Job 队列 + 诚实诊断」：不臆造宿主字段、不臆造远端端点路径。
 *   fetchImpl 只服务 base URL 本体的可达性探测（不拼造 /v1/xxx 业务路径）；设备令牌由调用方
 *   带外取得后注入 vault；未接面一律报 unverified，绝不伪称已连（E1/E5 姿态）。
 *
 * 红线：
 * - D4 零明文落盘：配对码/设备令牌只经注入的 SecretVault（credentials/vault.ts）单向存取，
 *   connector.json 只存非敏感元数据（配对状态/设备名/ref 键名/更新时间），且装载时按白名单重建
 *   （手改文件塞进来的多余键一律丢弃，不外溢到任何回包）；
 * - 强制 HTTPS：base URL 在**构造期**校验，http 仅在显式 allowInsecureLocal 且主机为本机回环时放行，
 *   其余抛 ConnectorConfigError——这是拒载（红线），不是降级；URL 内嵌 user:pass 一律拒绝（那本身就是明文凭据）；
 * - 损坏不 brick：状态文件解析失败 → warn + 改名 `.corrupt-<ts>` + 从空表继续（与 delivery-log 同姿态，
 *   与 vault 的「损坏即抛、绝不覆盖唯一副本」刻意不同——这是可重建的运行态，不是凭据库）；
 * - 对外回包零凭据零内部异常原文：错误只出粗分类（'approval-timeout'/'cancelled'/…），细节只进注入的 logWarn。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChannelDiagnosisCheck } from '../channels/types.js'
import { credentialRef } from '../credentials/vault.js'
import type { SecretVault } from '../credentials/vault.js'

// —— 形态 ——————————————————————————————————————————————————

export const JOB_STATES = ['queued', 'leased', 'awaiting-approval', 'done', 'failed', 'expired'] as const
export type ConnectorJobState = (typeof JOB_STATES)[number]

/** 占槽态（在途）：leased 与 awaiting-approval 都计入同 kind 并发上限。 */
const ACTIVE_STATES: readonly ConnectorJobState[] = ['leased', 'awaiting-approval']
/** 终态：不再占槽，不再被回收/排队触碰。 */
const TERMINAL_STATES: readonly ConnectorJobState[] = ['done', 'failed', 'expired']

export interface ConnectorJob {
  id: string
  kind: string
  state: ConnectorJobState
  attempts: number
  createdAtMs: number
  updatedAtMs: number
  /** 租约截止（绝对毫秒）。仅 leased 态有意义。 */
  leaseUntilMs?: number
  /** 审批引用（本地生成的非敏感关联键，供上层接审批面回填）。 */
  approvalRef?: string
  /** 审批超时截止（绝对毫秒）。仅 awaiting-approval 态有意义。 */
  approvalDeadlineMs?: number
  requiresApproval?: boolean
  /** 用户可见标签（清洗后 ≤120 字符，零 secret）。 */
  label?: string
  /** 失败粗分类，非异常原文。 */
  error?: string
}

export interface ConnectorSubmitInput {
  kind: string
  label?: string
  requiresApproval?: boolean
  approvalRef?: string
}

export interface ConnectorPairingMeta {
  paired: boolean
  deviceName?: string
  /** 配对码是否已入库（只报存在性，永不报值）。 */
  pairingCodeStored: boolean
  /** vault 键名（非敏感）；令牌值只在 vault 里。 */
  deviceTokenRef?: string
  updatedAtMs: number
}

export interface ConnectorKindStat {
  kind: string
  active: number
  queued: number
  limit: number
}

export interface ConnectorStatus {
  paired: boolean
  deviceName?: string
  pairingCodeStored: boolean
  deviceTokenConfigured: boolean
  deviceTokenRef?: string
  /** 已归一的安全 base URL（零凭据）。 */
  baseUrl: string
  httpsEnforced: boolean
  vaultKind: 'service' | 'file'
  counts: Record<ConnectorJobState, number>
  kinds: ConnectorKindStat[]
  limits: {
    leaseTtlMs: number
    approvalTimeoutMs: number
    maxConcurrentPerKind: number
    maxAttempts: number
  }
  updatedAtMs: number
}

// —— 注入面 ————————————————————————————————————————————————

export interface ConnectorFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

export interface ConnectorFetchResponse {
  status: number
  ok?: boolean
}

export type ConnectorFetchImpl = (url: string, init?: ConnectorFetchInit) => Promise<ConnectorFetchResponse>

export interface ConnectorDeps {
  vault: SecretVault
  /** 状态文件绝对路径（非敏感元数据）。 */
  stateFile: string
  /** 远端 base URL；构造期强制 https。 */
  baseUrl: string
  now?: () => number
  logWarn?: (msg: string) => void
  /** 可达性探测面；缺位 → 探测项报 unverified（不伪称已连）。 */
  fetchImpl?: ConnectorFetchImpl
  /** 测试专用：显式放行本机回环 http。生产不传。 */
  allowInsecureLocal?: boolean
  /** 租约时长（默认 60s）。 */
  leaseTtlMs?: number
  /** 审批超时（默认 5 分钟）。 */
  approvalTimeoutMs?: number
  /** 同 kind 并发上限（默认 2）。 */
  maxConcurrentPerKind?: number
  /** 按 kind 覆写上限。 */
  kindLimits?: Record<string, number>
  /** 租约到期重排次数上限（超出 → expired，默认 3）。 */
  maxAttempts?: number
  /** start() 的 tick 间隔（默认 30s）。 */
  tickIntervalMs?: number
}

// —— 错误 ——————————————————————————————————————————————————

/** 配置红线违例（含 https）。消息文本面向用户，零内部细节。 */
export class ConnectorConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectorConfigError'
  }
}

/** 入参校验错（可安全回显，均为本模块自撰文案）。 */
export class ConnectorInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectorInputError'
  }
}

// —— 常量 / 纯工具 —————————————————————————————————————————

export const DEFAULT_LEASE_TTL_MS = 60_000
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000
export const DEFAULT_MAX_CONCURRENT_PER_KIND = 2
export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_TICK_INTERVAL_MS = 30_000
/** 状态文件 schema 位（不承诺宿主协议，仅本插件自用）。 */
export const CONNECTOR_STATE_VERSION = 1

export const PAIRING_CODE_REF = credentialRef('ai-office', 'pairing-code')
export const DEVICE_TOKEN_REF = credentialRef('ai-office', 'device-token')

const KIND_RE = /^[A-Za-z0-9_.-]{1,48}$/
const ID_RE = /^[A-Za-z0-9_.-]{1,80}$/
const LABEL_MAX = 120
/** http 仅放行本机回环（红线例外面收窄到测试注入）。 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function clampText(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  const flat = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (flat === '') return undefined
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function isJobState(value: unknown): value is ConnectorJobState {
  return typeof value === 'string' && (JOB_STATES as readonly string[]).includes(value)
}

function isTerminal(state: ConnectorJobState): boolean {
  return TERMINAL_STATES.includes(state)
}

/**
 * 强制 HTTPS（构造期红线）。
 * - https → 归一返回（去尾斜杠、拒查询/片段/内嵌凭据）；
 * - http  → 仅当 allowInsecureLocal 且主机为 localhost/127.0.0.1/::1 放行，否则抛 ConnectorConfigError；
 * - 其他协议（file:/data:/ws:/…）→ 一律抛，override 也不放行。
 */
export function normalizeSecureBaseUrl(raw: string, opts?: { allowInsecureLocal?: boolean }): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConnectorConfigError('connector baseUrl 不能为空')
  }
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new ConnectorConfigError('connector baseUrl 不是合法 URL')
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConnectorConfigError('connector baseUrl 禁止内嵌凭据（user:pass@）')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new ConnectorConfigError('connector baseUrl 不接受查询串或片段')
  }
  const protocol = url.protocol
  if (protocol === 'https:') return url.href.replace(/\/+$/, '')
  if (protocol !== 'http:') {
    throw new ConnectorConfigError(`connector baseUrl 协议必须是 https（收到 ${protocol.replace(':', '')}）`)
  }
  const host = stripBrackets(url.hostname.toLowerCase())
  if (opts?.allowInsecureLocal !== true || !LOOPBACK_HOSTS.has(host)) {
    throw new ConnectorConfigError(
      'connector baseUrl 必须使用 https：仅本机回环（localhost/127.0.0.1/::1）允许注入测试面显式放行 http',
    )
  }
  return url.href.replace(/\/+$/, '')
}

// —— 状态文件序列化 ————————————————————————————————————————

interface SerializedState {
  version: number
  pairing: ConnectorPairingMeta
  jobs: ConnectorJob[]
  nextSeq: number
}

/** 按白名单重建 pairing/jobs——多余键（含被塞进来的疑似 secret）一律丢弃。 */
function normalizePairing(value: unknown, now: number): ConnectorPairingMeta {
  if (value === null || typeof value !== 'object') {
    return { paired: false, pairingCodeStored: false, updatedAtMs: now }
  }
  const p = value as Record<string, unknown>
  const meta: ConnectorPairingMeta = {
    paired: p.paired === true,
    pairingCodeStored: p.pairingCodeStored === true,
    updatedAtMs: typeof p.updatedAtMs === 'number' ? p.updatedAtMs : now,
  }
  const deviceName = clampText(p.deviceName, 64)
  if (deviceName !== undefined) meta.deviceName = deviceName
  // ref 只认本模块的两个已知键名，不接受任意字符串（防把值当 ref 混进来）。
  if (p.deviceTokenRef === DEVICE_TOKEN_REF) meta.deviceTokenRef = DEVICE_TOKEN_REF
  if (meta.paired && meta.deviceTokenRef === undefined) meta.deviceTokenRef = DEVICE_TOKEN_REF
  return meta
}

function normalizeJob(value: unknown): ConnectorJob | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const r = value as Record<string, unknown>
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return undefined
  if (typeof r.kind !== 'string' || !KIND_RE.test(r.kind)) return undefined
  if (!isJobState(r.state)) return undefined
  const job: ConnectorJob = {
    id: r.id,
    kind: r.kind,
    state: r.state,
    attempts: typeof r.attempts === 'number' && r.attempts >= 0 ? Math.floor(r.attempts) : 0,
    createdAtMs: typeof r.createdAtMs === 'number' ? r.createdAtMs : 0,
    updatedAtMs: typeof r.updatedAtMs === 'number' ? r.updatedAtMs : 0,
  }
  if (typeof r.leaseUntilMs === 'number') job.leaseUntilMs = r.leaseUntilMs
  if (typeof r.approvalDeadlineMs === 'number') job.approvalDeadlineMs = r.approvalDeadlineMs
  // approvalRef 同 ref 纪律：只收本模块前缀形态。
  if (typeof r.approvalRef === 'string' && /^apr_[A-Za-z0-9_.-]{1,64}$/.test(r.approvalRef)) {
    job.approvalRef = r.approvalRef
  }
  if (r.requiresApproval === true) job.requiresApproval = true
  const label = clampText(r.label, LABEL_MAX)
  if (label !== undefined) job.label = label
  if (typeof r.error === 'string' && /^[a-z-]{1,32}$/.test(r.error)) job.error = r.error
  return job
}

function cloneJob(job: ConnectorJob): ConnectorJob {
  return JSON.parse(JSON.stringify(job)) as ConnectorJob
}

// —— 服务 —————————————————————————————————————————————————

export class ConnectorService {
  private readonly now: () => number
  private readonly logWarn: (msg: string) => void
  private readonly leaseTtlMs: number
  private readonly approvalTimeoutMs: number
  private readonly maxConcurrentPerKind: number
  private readonly kindLimits: Record<string, number>
  private readonly maxAttempts: number
  private readonly tickIntervalMs: number
  private readonly baseUrl: string
  private pairing: ConnectorPairingMeta
  private jobs: ConnectorJob[] = []
  private nextSeq = 1
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly deps: ConnectorDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.logWarn = deps.logWarn ?? (() => undefined)
    // 红线在构造期：不合规直接拒载（不接受运行中降级）。
    this.baseUrl = normalizeSecureBaseUrl(deps.baseUrl, { allowInsecureLocal: deps.allowInsecureLocal })
    this.leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
    this.approvalTimeoutMs = deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
    this.maxConcurrentPerKind = deps.maxConcurrentPerKind ?? DEFAULT_MAX_CONCURRENT_PER_KIND
    this.kindLimits = deps.kindLimits ?? {}
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
    this.pairing = { paired: false, pairingCodeStored: false, updatedAtMs: this.now() }
    this.load()
  }

  // —— 文件态 ——

  private load(): void {
    if (!existsSync(this.deps.stateFile)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.deps.stateFile, 'utf8'))
    } catch (error) {
      this.quarantineCorrupt((error as Error).message)
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.quarantineCorrupt('期望 JSON object')
      return
    }
    const raw = parsed as Record<string, unknown>
    this.pairing = normalizePairing(raw.pairing, this.now())
    this.jobs = (Array.isArray(raw.jobs) ? raw.jobs : [])
      .map(normalizeJob)
      .filter((job): job is ConnectorJob => job !== undefined)
    const maxSeq = this.jobs.reduce((max, job) => {
      const n = Number.parseInt(job.id.replace(/^job-/, ''), 10)
      return Number.isFinite(n) ? Math.max(max, n) : max
    }, 0)
    this.nextSeq = Math.max(1, typeof raw.nextSeq === 'number' ? raw.nextSeq : maxSeq + 1)
    // 装载即回收一次：进程重启留下的过期租约不继续占槽。
    this.reclaim()
  }

  private quarantineCorrupt(reason: string): void {
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-')
    const corrupt = `${this.deps.stateFile}.corrupt-${stamp}`
    try {
      renameSync(this.deps.stateFile, corrupt)
    } catch {
      // 改名失败也不阻塞运行（与 delivery-log 同姿态）。
    }
    this.pairing = { paired: false, pairingCodeStored: false, updatedAtMs: this.now() }
    this.jobs = []
    this.nextSeq = 1
    this.logWarn(`connector.json 损坏，已转存 ${corrupt} 并从空表继续: ${reason}`)
  }

  private persist(): void {
    const payload: SerializedState = {
      version: CONNECTOR_STATE_VERSION,
      pairing: this.pairing,
      jobs: this.jobs,
      nextSeq: this.nextSeq,
    }
    const dir = dirname(this.deps.stateFile)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = `${this.deps.stateFile}.tmp-${process.pid}-${this.now()}`
    try {
      writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.deps.stateFile)
    } catch (error) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        // 清理失败不额外抛
      }
      this.logWarn(`connector.json 写入失败: ${(error as Error).message}`)
      throw error
    }
  }

  // —— 设备凭据（单向入 vault，零明文落盘）——

  /** 配对码入 vault；状态文件只记 pairingCodeStored 布尔。 */
  async storePairingCode(code: string): Promise<void> {
    if (typeof code !== 'string' || code.trim() === '') throw new ConnectorInputError('配对码不能为空')
    const value = code.trim()
    if (value.length > 256) throw new ConnectorInputError('配对码长度超限')
    await this.deps.vault.set(PAIRING_CODE_REF, value)
    this.pairing = { ...this.pairing, pairingCodeStored: true, updatedAtMs: this.now() }
    this.persist()
  }

  /** 取回配对码（内存态，供带外换发）；一次性消费后即从 vault 抹除。 */
  async consumePairingCode(): Promise<string | undefined> {
    const value = await this.deps.vault.resolve(PAIRING_CODE_REF)
    if (typeof value === 'string' && value !== '') {
      try {
        await this.deps.vault.unset(PAIRING_CODE_REF)
      } catch (error) {
        this.logWarn(`配对码清除失败: ${(error as Error).message}`)
      }
      this.pairing = { ...this.pairing, pairingCodeStored: false, updatedAtMs: this.now() }
      this.persist()
      return value
    }
    return undefined
  }

  /**
   * 设备令牌入库并置为已配对。令牌由调用方带外取得（宿主无公开换发端点，故本模块不臆造
   * 远端路径去换发）；值只写 vault，状态文件只留 ref 键名与设备名。
   */
  async pair(input: { deviceToken: string; deviceName?: string }): Promise<ConnectorPairingMeta> {
    if (typeof input?.deviceToken !== 'string' || input.deviceToken.trim() === '') {
      throw new ConnectorInputError('设备令牌不能为空')
    }
    if (input.deviceToken.trim().length > 4096) throw new ConnectorInputError('设备令牌长度超限')
    const deviceName = clampText(input.deviceName, 64)
    if (deviceName === undefined) throw new ConnectorInputError('设备名不能为空')
    await this.deps.vault.set(DEVICE_TOKEN_REF, input.deviceToken.trim())
    this.pairing = {
      paired: true,
      deviceName,
      pairingCodeStored: this.pairing.pairingCodeStored,
      deviceTokenRef: DEVICE_TOKEN_REF,
      updatedAtMs: this.now(),
    }
    this.persist()
    return { ...this.pairing }
  }

  /** 解除配对：vault 侧值抹除，状态文件只留非敏感历史。 */
  async unpair(): Promise<void> {
    for (const ref of [DEVICE_TOKEN_REF, PAIRING_CODE_REF]) {
      try {
        await this.deps.vault.unset(ref)
      } catch (error) {
        this.logWarn(`凭据清理失败（${ref}）: ${(error as Error).message}`)
      }
    }
    this.pairing = { paired: false, pairingCodeStored: false, updatedAtMs: this.now() }
    this.persist()
  }

  /** 令牌只供上层出站请求内部使用，绝不进 status()/回包。 */
  async resolveDeviceToken(): Promise<string | undefined> {
    const value = await this.deps.vault.resolve(DEVICE_TOKEN_REF)
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  // —— Job 队列 ——

  private limitFor(kind: string): number {
    const override = this.kindLimits[kind]
    const limit = typeof override === 'number' ? override : this.maxConcurrentPerKind
    return Math.max(1, Math.floor(limit))
  }

  private countOf(kind: string, states: readonly ConnectorJobState[]): number {
    return this.jobs.reduce((n, job) => (job.kind === kind && states.includes(job.state) ? n + 1 : n), 0)
  }

  private touch(job: ConnectorJob): void {
    job.updatedAtMs = this.now()
  }

  private nextId(): string {
    return `job-${this.nextSeq++}`
  }

  /** 入队（FIFO）；随即尝试提升，槽位不足则留在 queued。 */
  submit(input: ConnectorSubmitInput): ConnectorJob {
    if (input === null || typeof input !== 'object') throw new ConnectorInputError('请求体需为 JSON 对象')
    const kind = typeof input.kind === 'string' ? input.kind.trim() : ''
    if (!KIND_RE.test(kind)) throw new ConnectorInputError('kind 只允许字母/数字/下划线/点/连字符（1-48 位）')
    if (this.maxAttempts < 1) throw new ConnectorInputError('maxAttempts 需 ≥1')
    const now = this.now()
    const job: ConnectorJob = {
      id: this.nextId(),
      kind,
      state: 'queued',
      attempts: 0,
      createdAtMs: now,
      updatedAtMs: now,
    }
    const label = clampText(input.label, LABEL_MAX)
    if (label !== undefined) job.label = label
    if (input.requiresApproval === true) {
      job.requiresApproval = true
      const ref = typeof input.approvalRef === 'string' ? input.approvalRef.trim() : ''
      if (ref !== '') {
        if (!/^apr_[A-Za-z0-9_.-]{1,64}$/.test(ref)) throw new ConnectorInputError('approvalRef 形态需为 apr_ 前缀标识符')
        job.approvalRef = ref
      }
    } else if (input.approvalRef !== undefined) {
      throw new ConnectorInputError('未声明 requiresApproval 的 Job 不接受 approvalRef')
    }
    this.jobs.push(job)
    this.pump()
    this.persist()
    return cloneJob(job)
  }

  /** 取槽提升：同 kind 内保持 FIFO，满额即整条链等待（不越过队首）。 */
  pump(): number {
    const now = this.now()
    let promoted = 0
    const kinds = Array.from(new Set(this.jobs.filter((job) => job.state === 'queued').map((job) => job.kind)))
    for (const kind of kinds) {
      let active = this.countOf(kind, ACTIVE_STATES)
      const limit = this.limitFor(kind)
      for (const job of this.jobs) {
        if (job.kind !== kind || job.state !== 'queued') continue
        if (active >= limit) break
        active += 1
        promoted += 1
        job.attempts += 1
        job.leaseUntilMs = now + this.leaseTtlMs
        job.error = undefined
        if (job.requiresApproval === true) {
          job.state = 'awaiting-approval'
          if (job.approvalRef === undefined) job.approvalRef = `apr_${job.id}`
          job.approvalDeadlineMs = now + this.approvalTimeoutMs
        } else {
          job.state = 'leased'
          job.approvalDeadlineMs = undefined
        }
        this.touch(job)
      }
    }
    if (promoted > 0) this.persist()
    return promoted
  }

  /** 回收：过期租约重排（或 expired 终态）、审批超时 failed。返回受影响数。 */
  reclaim(): number {
    const now = this.now()
    let changed = 0
    for (const job of this.jobs) {
      if (job.state === 'leased') {
        const until = job.leaseUntilMs
        if (typeof until === 'number' && until <= now) {
          if (job.attempts >= this.maxAttempts) {
            job.state = 'expired'
            job.error = 'lease-expired'
          } else {
            job.state = 'queued'
            job.error = undefined
          }
          job.leaseUntilMs = undefined
          this.touch(job)
          changed += 1
        }
        continue
      }
      if (job.state === 'awaiting-approval') {
        const deadline = job.approvalDeadlineMs
        if (typeof deadline === 'number' && deadline <= now) {
          job.state = 'failed'
          job.error = 'approval-timeout'
          job.leaseUntilMs = undefined
          this.touch(job)
          changed += 1
        }
      }
    }
    if (changed > 0) this.persist()
    return changed
  }

  /** 时钟推进入口（start() 定时器与测试假时钟共用）。 */
  tick(): void {
    this.reclaim()
    this.pump()
  }

  get(jobId: string): ConnectorJob | undefined {
    const job = this.find(jobId)
    return job === undefined ? undefined : cloneJob(job)
  }

  /** 倒序最近 n 条（可按 kind/state 过滤），回包前已过脱敏形态。 */
  list(filter?: { kind?: string; state?: ConnectorJobState; limit?: number }): ConnectorJob[] {
    const cap = Math.max(1, Math.min(500, Math.floor(filter?.limit ?? 50)))
    const rows = this.jobs.filter((job) => {
      if (filter?.kind !== undefined && filter.kind !== '' && job.kind !== filter.kind) return false
      if (filter?.state !== undefined && job.state !== filter.state) return false
      return true
    })
    return rows.slice(-cap).reverse().map(cloneJob)
  }

  private find(jobId: string): ConnectorJob | undefined {
    const id = typeof jobId === 'string' ? jobId.trim() : ''
    if (!ID_RE.test(id)) return undefined
    return this.jobs.find((job) => job.id === id)
  }

  /** 租约续期（在途 Job 汇报心跳）。 */
  renewLease(jobId: string, ttlMs?: number): ConnectorJob | undefined {
    const job = this.find(jobId)
    if (job === undefined || job.state !== 'leased') return undefined
    job.leaseUntilMs = this.now() + (ttlMs ?? this.leaseTtlMs)
    this.touch(job)
    this.persist()
    return cloneJob(job)
  }

  /** leased → awaiting-approval（挂审批引用与超时）。 */
  requestApproval(jobId: string, approvalRef?: string): ConnectorJob | undefined {
    const job = this.find(jobId)
    if (job === undefined || job.state !== 'leased') return undefined
    if (approvalRef !== undefined) {
      const ref = approvalRef.trim()
      if (!/^apr_[A-Za-z0-9_.-]{1,64}$/.test(ref)) throw new ConnectorInputError('approvalRef 形态需为 apr_ 前缀标识符')
      job.approvalRef = ref
    }
    if (job.approvalRef === undefined) job.approvalRef = `apr_${job.id}`
    job.state = 'awaiting-approval'
    job.approvalDeadlineMs = this.now() + this.approvalTimeoutMs
    this.touch(job)
    this.persist()
    return cloneJob(job)
  }

  /** 审批回填：approved→done，驳回→failed(approval-rejected)。 */
  resolveApproval(jobId: string, approved: boolean): ConnectorJob | undefined {
    const job = this.find(jobId)
    if (job === undefined || job.state !== 'awaiting-approval') return undefined
    job.state = approved ? 'done' : 'failed'
    if (!approved) job.error = 'approval-rejected'
    job.leaseUntilMs = undefined
    job.approvalDeadlineMs = undefined
    this.touch(job)
    this.persist()
    return cloneJob(job)
  }

  /** 在途 Job 正常收尾。 */
  complete(jobId: string): ConnectorJob | undefined {
    const job = this.find(jobId)
    if (job === undefined || !ACTIVE_STATES.includes(job.state)) return undefined
    job.state = 'done'
    job.leaseUntilMs = undefined
    job.approvalDeadlineMs = undefined
    job.error = undefined
    this.touch(job)
    this.persist()
    return cloneJob(job)
  }

  /** 用户可见取消（终态 failed + reason=cancelled）。 */
  cancel(jobId: string): boolean {
    const job = this.find(jobId)
    if (job === undefined || isTerminal(job.state)) return false
    job.state = 'failed'
    job.error = 'cancelled'
    job.leaseUntilMs = undefined
    job.approvalDeadlineMs = undefined
    this.touch(job)
    this.persist()
    return true
  }

  // —— 统计与诊断 ——

  status(): ConnectorStatus {
    const counts = Object.fromEntries(JOB_STATES.map((state) => [state, 0])) as Record<ConnectorJobState, number>
    for (const job of this.jobs) counts[job.state] += 1
    const kinds = new Map<string, ConnectorKindStat>()
    for (const job of this.jobs) {
      const stat = kinds.get(job.kind) ?? { kind: job.kind, active: 0, queued: 0, limit: this.limitFor(job.kind) }
      if (ACTIVE_STATES.includes(job.state)) stat.active += 1
      else if (job.state === 'queued') stat.queued += 1
      kinds.set(job.kind, stat)
    }
    const status: ConnectorStatus = {
      paired: this.pairing.paired,
      pairingCodeStored: this.pairing.pairingCodeStored,
      deviceTokenConfigured: this.pairing.deviceTokenRef !== undefined && this.pairing.paired,
      baseUrl: this.baseUrl,
      httpsEnforced: this.baseUrl.startsWith('https://'),
      vaultKind: this.deps.vault.kind,
      counts,
      kinds: Array.from(kinds.values()).sort((a, b) => a.kind.localeCompare(b.kind)),
      limits: {
        leaseTtlMs: this.leaseTtlMs,
        approvalTimeoutMs: this.approvalTimeoutMs,
        maxConcurrentPerKind: this.maxConcurrentPerKind,
        maxAttempts: this.maxAttempts,
      },
      updatedAtMs: this.pairing.updatedAtMs,
    }
    if (this.pairing.deviceName !== undefined) status.deviceName = this.pairing.deviceName
    if (this.pairing.deviceTokenRef !== undefined) status.deviceTokenRef = this.pairing.deviceTokenRef
    return status
  }

  /**
   * 诊断三态（零凭据零异常原文）：
   * - 未配对 → unverified（hint 引导去设置页配对）；
   * - 已配对但远端不可达 → failed；
   * - 探测通过 → passed；探测面缺位/结果不明 → unverified（不据此判死）。
   * 注：remote-reachability 只证明 base URL 的 TLS 端点可达，**不证明协议兼容**
   * （宿主无公开 connector 协议面）；office-roundtrip 恒 unverified——需真机与远端互操作验证。
   */
  async diagnose(signal?: AbortSignal): Promise<ChannelDiagnosisCheck[]> {
    const checks: ChannelDiagnosisCheck[] = []
    const startedAt = this.now()
    if (!this.pairing.paired) {
      checks.push({
        name: 'device-pairing',
        status: 'unverified',
        hint: '尚未配对：请提供设备名与带外取得的设备令牌完成配对（凭据只入本机凭据库）',
      })
    } else {
      checks.push({ name: 'device-pairing', status: 'passed', hint: `已配对设备「${this.pairing.deviceName ?? '未命名'}」` })
    }
    checks.push({
      name: 'transport',
      status: this.baseUrl.startsWith('https://') ? 'passed' : 'unverified',
      hint: this.baseUrl.startsWith('https://')
        ? '远端强制 https'
        : '本机回环测试面放行 http（生产不适用此例外）',
    })
    if (!this.pairing.paired) {
      checks.push({ name: 'remote-reachability', status: 'unverified', hint: '未配对，跳过远端探测' })
    } else if (this.deps.fetchImpl === undefined) {
      checks.push({ name: 'remote-reachability', status: 'unverified', hint: '宿主未注入 fetch 面，未探测远端可达性' })
    } else {
      try {
        const response = await this.deps.fetchImpl(this.baseUrl, {
          method: 'GET',
          ...(signal !== undefined ? { signal } : {}),
        })
        const reachable = typeof response?.status === 'number' && response.status > 0 && response.status < 500
        checks.push({
          name: 'remote-reachability',
          status: reachable ? 'passed' : 'failed',
          hint: reachable
            ? `远端可达（HTTP ${response.status}；仅证明 TLS 端点连通，不证明协议兼容）`
            : `远端返回不可用状态（HTTP ${response?.status ?? '未知'}）`,
        })
      } catch (error) {
        // 细节只进本机日志，hint 零异常原文。
        this.logWarn(`connector 探测失败: ${(error as Error)?.message ?? String(error)}`)
        checks.push({ name: 'remote-reachability', status: 'failed', hint: '远端不可达（DNS/TLS/连接层失败，详情见本机日志）' })
      }
    }
    checks.push({
      name: 'office-roundtrip',
      status: 'unverified',
      hint: 'Office 侧真实收发需人工验证（宿主无公开 connector 协议面，本模块未声明兼容）',
    })
    const elapsedMs = this.now() - startedAt
    if (elapsedMs >= 0) checks[checks.length - 1].elapsedMs = elapsedMs
    return checks
  }

  // —— 生命周期 ——

  /** 挂定时器推进租约/审批；重复调用无副作用。 */
  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      try {
        this.tick()
      } catch (error) {
        this.logWarn(`connector tick 失败: ${(error as Error)?.message ?? String(error)}`)
      }
    }, this.tickIntervalMs)
    const unref = (this.timer as unknown as { unref?: () => void }).unref
    if (typeof unref === 'function') unref.call(this.timer)
    this.logWarn(`connector 已启动：${this.baseUrl}`)
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }
}

// —— HTTP 面（纯函数，供主会话接 admin 路由）————————————————

export interface ConnectorHttpRequest {
  method: string
  /** 已剥离 admin BASE_PATH 的路径，以 / 开头。 */
  path: string
  body?: unknown
  query?: Record<string, string>
}

export interface ConnectorHttpResponse {
  status: number
  json: unknown
}

/** handleHttp 只依赖服务的这组方法（便于测试与后续替换实现）。 */
export type ConnectorHttpTarget = Pick<
  ConnectorService,
  'submit' | 'get' | 'list' | 'cancel' | 'status' | 'resolveApproval'
>

export interface ConnectorHttpDeps {
  service: ConnectorHttpTarget
  logWarn?: (msg: string) => void
}

const ROUTE_JOBS = '/connector/jobs'
const ROUTE_CANCEL_RE = /^\/connector\/jobs\/([A-Za-z0-9_.-]{1,80})\/cancel$/
/** 路由清单（供主会话接 admin 时核对，与 proactive 的 PROACTIVE_PATHS 同形态）。 */
export const CONNECTOR_ROUTES = Object.freeze(['/connector/jobs', '/connector/jobs/:id/cancel'] as const)

function notFound(): ConnectorHttpResponse {
  return { status: 404, json: { ok: false, error: '未找到该接口' } }
}

function methodNotAllowed(): ConnectorHttpResponse {
  return { status: 405, json: { ok: false, error: '方法不允许' } }
}

function parseStateFilter(value: unknown): ConnectorJobState | undefined {
  return typeof value === 'string' && isJobState(value) ? value : undefined
}

/**
 * 连接器路由处置（与 admin/api.ts 解耦的纯函数）：
 * - POST /connector/jobs        入队 {kind, label?, requiresApproval?, approvalRef?}
 * - GET  /connector/jobs        列表 ?kind=&state=&limit=
 * - POST /connector/jobs/:id/cancel  取消
 * 回包零凭据零内部异常原文；未知路径 404、方法不符 405、入参错 400。
 */
export async function handleHttp(deps: ConnectorHttpDeps, req: ConnectorHttpRequest): Promise<ConnectorHttpResponse> {
  const warn = deps.logWarn ?? (() => undefined)
  const method = typeof req?.method === 'string' ? req.method.toUpperCase() : ''
  const path = typeof req?.path === 'string' ? req.path : ''
  try {
    if (path === ROUTE_JOBS) {
      if (method === 'GET') {
        const query = req.query ?? {}
        const limit = Number.parseInt(String(query.limit ?? ''), 10)
        const jobs = deps.service.list({
          ...(typeof query.kind === 'string' && query.kind !== '' ? { kind: query.kind } : {}),
          ...(parseStateFilter(query.state) !== undefined ? { state: parseStateFilter(query.state) } : {}),
          ...(Number.isFinite(limit) ? { limit } : {}),
        })
        return { status: 200, json: { ok: true, jobs, counts: deps.service.status().counts } }
      }
      if (method === 'POST') {
        const b = (req.body ?? {}) as Record<string, unknown>
        const job = deps.service.submit({
          kind: String(b.kind ?? ''),
          ...(typeof b.label === 'string' ? { label: b.label } : {}),
          ...(b.requiresApproval === true ? { requiresApproval: true } : {}),
          ...(typeof b.approvalRef === 'string' ? { approvalRef: b.approvalRef } : {}),
        })
        return { status: 202, json: { ok: true, job } }
      }
      return methodNotAllowed()
    }
    const cancel = ROUTE_CANCEL_RE.exec(path)
    if (cancel !== null) {
      if (method !== 'POST') return methodNotAllowed()
      const id = cancel[1]
      if (deps.service.get(id) === undefined) return notFound()
      const cancelled = deps.service.cancel(id)
      return {
        status: cancelled ? 200 : 409,
        json: { ok: cancelled, error: cancelled ? undefined : 'Job 已处于终态，无法取消' },
      }
    }
    return notFound()
  } catch (error) {
    if (error instanceof ConnectorInputError) return { status: 400, json: { ok: false, error: error.message } }
    if (error instanceof ConnectorConfigError) {
      return { status: 500, json: { ok: false, error: '连接器配置不被接受：远端必须使用 https' } }
    }
    warn(`connector HTTP 处理失败: ${(error as Error)?.message ?? String(error)}`)
    return { status: 500, json: { ok: false, error: '操作失败，请查看本机日志' } }
  }
}
