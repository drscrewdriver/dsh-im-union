/**
 * 多账号管理（T1.8 服务侧）：accounts.json 文件态 + 适配器生命周期 + 脱敏视图。
 *
 * 红线：
 * - secret 只单向入库（vault.set），任何对外视图/listPublic/check 回包零 secret 值
 *   （只报 configured 布尔——存在性可示，内容不可示，D4）；
 * - 文件态原子写（tmp+rename），损坏即抛不覆盖（与 vault 同一姿态）；
 * - 同渠道多账号独立：凭据/连接状态/白名单互不影响（E3），引擎按 accountId 键控。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { ChannelAdapter } from '../channels/types.js'
import { CHANNEL_META } from '../channels/meta.js'
import { createAdapter, hasChannel } from '../channels/registry.js'
import { credentialRef, type SecretVault } from '../credentials/vault.js'
import { normalizeCommandExec, type AccountPolicy, type AccountSessionPrefs, type ImUnionEngine } from './gateway.js'

export interface AccountRecord {
  accountId: string
  channel: string
  alias?: string
  config?: Record<string, string>
  dmAllowlist?: string[]
  groupEnabled?: boolean
  paused?: boolean
  /** 私聊准入档位：approved（缺省）=仅白名单；all=接受所有私聊。 */
  privateAccess?: 'approved' | 'all'
  /** 命令执行开关（私聊/群聊各一档；缺省/缺键=开）。 */
  commandExec?: { dm: boolean; group: boolean }
  /** 账号级会话偏好：仅在该账号新建会话时应用。 */
  session?: AccountSessionPrefs
}

export interface PublicAccount {
  accountId: string
  channel: string
  alias?: string
  paused: boolean
  connected: boolean
  /** 渠道会话态不可自愈故障（微信 -14 过期）：true 时设置页红条提示重扫。 */
  sessionExpired?: boolean
  /** 最近一次出站发送（设置卡诊断位：「发送失败」vs「受理未送达」一眼可辨）。 */
  lastSendAt?: number
  lastSendOk?: boolean
  /** 凭据键的入库状态；required=false 的可选键（语音 DashScope Key、扫码 botToken）
   * 缺失不得算入「凭据缺失」——只是未开通可选项，不影响连接。 */
  secretFields: Array<{ key: string; configured: boolean; required: boolean }>
  /** 白名单是管理员自录配置（非平台回流的原始用户标识），设置页需回显编辑。 */
  dmAllowlist: string[]
  groupEnabled?: boolean
  /** 管理员自录明文配置回显（仅 meta 的 plain 字段；secret 永不在此，D4）。 */
  config: Record<string, string>
  /** 私聊准入档位回显（设置页编辑预填）。 */
  privateAccess: 'approved' | 'all'
  /** 命令执行开关回显（设置页编辑预填；缺键=开）。 */
  commandExec: { dm: boolean; group: boolean }
  /** 会话偏好回显（全部为管理员自录字符串；缺失键=宿主默认）。 */
  session: AccountSessionPrefs
}

const SESSION_PREF_KEYS: ReadonlyArray<keyof AccountSessionPrefs> = ['cwd', 'agentPreset', 'provider', 'model', 'reasoningEffort', 'permission']

/** 连接相关形态比较：渠道或任一 config 键值变化即视为需要重建适配器。 */
function configRelevantChanged(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  const ka = Object.keys(a ?? {}).sort()
  const kb = Object.keys(b ?? {}).sort()
  if (ka.length !== kb.length) return true
  const fa = a ?? {}
  const fb = b ?? {}
  for (const key of ka) {
    if (fa[key] !== fb[key]) return true
  }
  return false
}

function hasSecretValues(secrets: Record<string, string> | undefined): boolean {
  if (secrets === undefined) return false
  for (const value of Object.values(secrets)) {
    if (typeof value === 'string' && value !== '') return true
  }
  return false
}

function sanitizeSessionPrefs(input: AccountRecord['session']): AccountSessionPrefs {
  const out: AccountSessionPrefs = {}
  if (input === undefined || input === null || typeof input !== 'object') return out
  const raw = input as Record<string, unknown>
  for (const key of SESSION_PREF_KEYS) {
    const value = raw[key]
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

interface LiveAccount {
  record: AccountRecord
  adapter: ChannelAdapter | undefined
  connected: boolean
}

const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export interface AccountManagerDeps {
  stateFile: string
  vault: SecretVault
  engine: ImUnionEngine
  logWarn: (msg: string) => void
  /** 连接器生命周期日志入口（info 级进 plugin.log）；缺省静默（测试无宿主日志面）。 */
  logInfo?: (msg: string) => void
  /** 账号状态目录（连接器游标等协议态落盘位；缺省不传=纯内存态）。 */
  stateDir?: string
  /** 测试注入点；缺省走 registry.createAdapter（懒加载工厂表）。 */
  adapterFactory?: (record: AccountRecord, secrets: Record<string, string | undefined>) => Promise<ChannelAdapter> | ChannelAdapter
}

export class AccountValidationError extends Error {}

export class AccountManager {
  private records: AccountRecord[] = []
  private live = new Map<string, LiveAccount>()
  private readonly fallbackFactory = async (record: AccountRecord, secrets: Record<string, string | undefined>) =>
    createAdapter(record.channel, {
      accountId: record.accountId,
      config: record.config ?? {},
      secrets,
      // 连接器生命周期（轮询退出/-14 过期/退避）此前无人接线，排障死角（desktop 实证）。
      logger: (msg: string) => {
        this.deps.logInfo?.(msg)
      },
      ...(this.deps.stateDir !== undefined && this.deps.stateDir !== '' ? { stateDir: this.deps.stateDir } : {}),
    })

  constructor(private readonly deps: AccountManagerDeps) {
    this.load()
  }

  // —— 文件态 ——————————————————————————————————————————

  private load(): void {
    if (!existsSync(this.deps.stateFile)) {
      this.records = []
      return
    }
    const parsed = JSON.parse(readFileSync(this.deps.stateFile, 'utf8')) as unknown
    if (!Array.isArray(parsed)) throw new Error('accounts.json 形态错误：期望数组')
    this.records = parsed as AccountRecord[]
  }

  private persist(): void {
    const tmp = `${this.deps.stateFile}.tmp`
    writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf8')
    renameSync(tmp, this.deps.stateFile)
  }

  // —— 校验 ——————————————————————————————————————————

  private validate(record: AccountRecord): void {
    if (!ACCOUNT_ID_RE.test(record.accountId)) {
      throw new AccountValidationError('accountId 只允许字母/数字/下划线/连字符（1-64 位）')
    }
    if (CHANNEL_META[record.channel] === undefined) {
      throw new AccountValidationError(`未知渠道：${record.channel}`)
    }
    if (!hasChannel(record.channel)) {
      throw new AccountValidationError(`渠道 ${record.channel} 尚未实现（分期见计划台账）`)
    }
  }

  private secretRefsOf(record: AccountRecord): string[] {
    const refs: string[] = []
    for (const f of CHANNEL_META[record.channel]?.fields ?? []) {
      if (!f.secret) continue
      refs.push(credentialRef(record.channel, `${record.accountId}.${f.key}`))
      refs.push(...this.secretRefAliases(record, f.key))
    }
    return refs
  }

  /**
   * 旧版引用别名：某些历史写入路径把 ref 拼成 `channel-accountId` 双前缀
   * （真机实证：desktop 的 .credentials.yaml 里是 IM_UNION_WEIXIN_WEIXIN_<id>_BOTTOKEN，
   * 而规范 ref 是单前缀——值在库里、读取永远 miss）。读取兼容别名并在命中时
   * 自愈归一到规范 ref。
   */
  private secretRefAliases(record: AccountRecord, key: string): string[] {
    const primary = credentialRef(record.channel, `${record.accountId}.${key}`)
    const doubled = credentialRef(record.channel, `${record.channel}-${record.accountId}.${key}`)
    return doubled === primary ? [] : [doubled]
  }

  /** 规范 ref 优先，旧别名兜底；别名命中即写回规范 ref（归一失败不阻断本次应答）。 */
  private async resolveSecret(record: AccountRecord, key: string): Promise<string | undefined> {
    const primary = credentialRef(record.channel, `${record.accountId}.${key}`)
    const value = await this.deps.vault.resolve(primary)
    if (value !== undefined) return value
    for (const alias of this.secretRefAliases(record, key)) {
      const legacyValue = await this.deps.vault.resolve(alias)
      if (legacyValue === undefined) continue
      try {
        await this.deps.vault.set(primary, legacyValue)
        this.deps.logWarn(`凭据引用已归一：${alias} -> ${primary}`)
      } catch (error) {
        this.deps.logWarn(`凭据引用归一失败（${primary}，本次按旧别名值应答）: ${(error as Error).message}`)
      }
      return legacyValue
    }
    return undefined
  }

  private async secretsOf(record: AccountRecord): Promise<Record<string, string | undefined>> {
    const secrets: Record<string, string | undefined> = {}
    for (const field of CHANNEL_META[record.channel]?.fields ?? []) {
      if (!field.secret) continue
      secrets[field.key] = await this.resolveSecret(record, field.key)
    }
    return secrets
  }

  // —— CRUD ——————————————————————————————————————————

  /** 新增或整体替换账号；secrets 单向入 vault（键=meta 的 secret 字段名）；随后重启生效。
   * skipConnect：扫码类渠道先建档后取凭据（微信 iLink），建档期不建适配器。 */
  /** 策略字段按 type 归位：纯出站通知类无入站语义，dmAllowlist/groupEnabled 不落不报。 */
  private isNotifyOnly(channel: string): boolean {
    return CHANNEL_META[channel]?.notifyOnly === true
  }

  async upsert(record: AccountRecord, secrets?: Record<string, string>, opts?: { skipConnect?: boolean }): Promise<void> {
    this.validate(record)
    if (this.isNotifyOnly(record.channel)) {
      record = { ...record, dmAllowlist: undefined, groupEnabled: undefined, commandExec: undefined }
    }
    const index = this.records.findIndex((r) => r.accountId === record.accountId)
    const existing = index >= 0 ? this.records[index] : undefined
    // 重建判据（只看连接相关事实）：渠道变化 / config 变化 / 有新 secret 值。
    // 别名/白名单/准入档位/会话偏好/暂停态等编辑**不断连**——修掉「改个名字
    // 也触发适配器重建」的替换凭据体感。
    const needsRebuild =
      existing !== undefined &&
      (existing.channel !== record.channel ||
        configRelevantChanged(existing.config, record.config) ||
        hasSecretValues(secrets))
    if (needsRebuild) {
      await this.teardown(record.accountId)
    }
    if (index >= 0) {
      this.records[index] = record
    } else {
      this.records.push(record)
    }
    if (secrets !== undefined) {
      for (const field of CHANNEL_META[record.channel]?.fields ?? []) {
        if (!field.secret) continue
        const value = secrets[field.key]
        if (typeof value === 'string' && value !== '') {
          await this.deps.vault.set(credentialRef(record.channel, `${record.accountId}.${field.key}`), value)
        }
      }
    }
    this.persist()
    if (needsRebuild || existing === undefined) {
      // 新账号或连接事实变化：按暂停/跳过语义重建连接。
      if (record.paused !== true && opts?.skipConnect !== true) {
        await this.ensureConnected(record.accountId)
      }
      return
    }
    // 凭据无关编辑：原位同步策略与暂停态，在线适配器不动。
    await this.syncPolicy(record)
    const live = this.live.get(record.accountId)
    if (record.paused === true && live?.adapter !== undefined) {
      await this.teardown(record.accountId)
    } else if (record.paused !== true && live?.adapter === undefined && opts?.skipConnect !== true) {
      await this.ensureConnected(record.accountId)
    }
  }

  /**
   * QQ 群管理(/qq)授权成员集：由账号 config.groupAdminUsers（逗号/空白分隔）派生。
   * 单源于此，registerAccount（初注）与 syncPolicy（原位同步）两处共用，避免一侧漏改。
   */
  private groupAdminSet(record: AccountRecord): Set<string> {
    return new Set((record.config?.groupAdminUsers ?? '')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s !== ''))
  }

  /** 编辑后的策略原位下发（引擎 updatePolicy，不重复挂 onMessage）。 */
  private async syncPolicy(record: AccountRecord): Promise<void> {
    const live = this.live.get(record.accountId)
    if (live?.adapter === undefined) return
    const notify = this.isNotifyOnly(record.channel)
    this.deps.engine.updatePolicy(record.accountId, {
      dmAllowlist: new Set(notify ? [] : record.dmAllowlist ?? []),
      groupEnabled: record.groupEnabled ?? true,
      privateAccess: record.privateAccess === 'all' ? 'all' : 'approved',
      commandExec: normalizeCommandExec(record.commandExec),
      // 别名同步给引擎（0.4.7）：/relay 等命令面可用别名代替代理键；空串=清空。
      alias: record.alias ?? '',
      // QQ 群管理授权名单（P6/F6）：config.groupAdminUsers 逗号/空白分隔→/qq 命令放行集。
      groupAdminOpenids: this.groupAdminSet(record),
      ...(record.session !== undefined ? { session: sanitizeSessionPrefs(record.session) } : {}),
    })
  }

  async remove(accountId: string): Promise<boolean> {
    const index = this.records.findIndex((r) => r.accountId === accountId)
    if (index < 0) return false
    const record = this.records[index]
    await this.teardown(accountId)
    this.records.splice(index, 1)
    for (const ref of this.secretRefsOf(record ?? { accountId, channel: '' })) {
      try {
        await this.deps.vault.unset(ref)
      } catch (error) {
        this.deps.logWarn(`secret 清理失败（${ref}）: ${(error as Error).message}`)
      }
    }
    this.persist()
    return true
  }

  async setPaused(accountId: string, paused: boolean): Promise<boolean> {
    const record = this.records.find((r) => r.accountId === accountId)
    if (record === undefined) return false
    record.paused = paused
    this.persist()
    if (paused) {
      await this.teardown(accountId)
    } else {
      await this.ensureConnected(accountId)
    }
    return true
  }

  /** 白名单整值替换（账号级私聊准入，红线 D6 的数据源）；通知类无此概念。 */
  async setAllowlist(accountId: string, userIds: string[]): Promise<boolean> {
    const record = this.records.find((r) => r.accountId === accountId)
    if (record === undefined) return false
    if (this.isNotifyOnly(record.channel)) {
      throw new AccountValidationError('该渠道为纯出站通知类，无私聊准入概念')
    }
    record.dmAllowlist = userIds
    this.persist()
    const live = this.live.get(accountId)
    if (live?.adapter !== undefined) {
      // updatePolicy 原位下发（registerAccount 会重复挂 onMessage → 消息双投，禁用）。
      this.deps.engine.updatePolicy(accountId, {
        dmAllowlist: new Set(userIds),
        groupEnabled: record.groupEnabled ?? true,
        privateAccess: record.privateAccess === 'all' ? 'all' : 'approved',
      })
    }
    return true
  }

  list(): AccountRecord[] {
    return this.records.map((r) => ({ ...r }))
  }

  /** 按账号 id 取在位适配器（主动投递 T2.6：多账号 E3 下精确定位，不取「渠道首个」凑数）。 */
  liveAdapter(accountId: string): ChannelAdapter | undefined {
    return this.live.get(accountId)?.adapter
  }

  /** 指定渠道的在位适配器（第三方回调路由分发给各账号实例用）。 */
  liveAdapters(channel: string): ChannelAdapter[] {
    const out: ChannelAdapter[] = []
    for (const record of this.records) {
      if (record.channel !== channel || record.paused === true) continue
      const adapter = this.live.get(record.accountId)?.adapter
      if (adapter !== undefined) out.push(adapter)
    }
    return out
  }

  /** 最近发送诊断位（不含内容/无 secret，D4）；适配器未暴露时不落字段。 */
  private lastSendBits(adapter: ChannelAdapter | undefined): { lastSendAt?: number; lastSendOk?: boolean } {
    const send = (adapter as { lastSend?: { at: number; ok: boolean } } | undefined)?.lastSend
    return send === undefined ? {} : { lastSendAt: send.at, lastSendOk: send.ok }
  }

  /** 脱敏视图：零 secret 值，只报 configured（D4）。 */
  async listPublic(): Promise<PublicAccount[]> {
    const rows: PublicAccount[] = []
    for (const record of this.records) {
      const fields: Array<{ key: string; configured: boolean; required: boolean }> = []
      for (const field of CHANNEL_META[record.channel]?.fields ?? []) {
        if (!field.secret) continue
        const value = await this.resolveSecret(record, field.key)
        fields.push({ key: field.key, configured: value !== undefined, required: field.required !== false })
      }
      // 明文配置按 meta plain 字段白名单过滤后回显（设置页编辑预填）；
      // meta 之外的杂键与 secret 键一律不出现（D4 同源纪律）。
      const plainKeys = new Set(
        (CHANNEL_META[record.channel]?.fields ?? []).filter((f) => !f.secret).map((f) => f.key),
      )
      const config: Record<string, string> = {}
      for (const [key, value] of Object.entries(record.config ?? {})) {
        if (plainKeys.has(key) && typeof value === 'string') config[key] = value
      }
      const live = this.live.get(record.accountId)
      const notify = this.isNotifyOnly(record.channel)
      rows.push({
        accountId: record.accountId,
        channel: record.channel,
        alias: record.alias,
        paused: record.paused === true,
        connected: live?.adapter?.connected === true,
        ...((live?.adapter as { authExpired?: boolean } | undefined)?.authExpired === true
          ? { sessionExpired: true }
          : {}),
        ...this.lastSendBits(live?.adapter),
        secretFields: fields,
        // 通知类不回显策略字段（存储态也已剥除，双向一致）。
        dmAllowlist: notify ? [] : record.dmAllowlist ?? [],
        groupEnabled: notify ? undefined : record.groupEnabled,
        config,
        privateAccess: record.privateAccess === 'all' ? 'all' : 'approved',
        commandExec: normalizeCommandExec(record.commandExec),
        session: sanitizeSessionPrefs(record.session),
      })
    }
    return rows
  }

  /** 连接检查：适配器不在位则临时构建（不保持连接）；诊断已过脱敏纪律（E5）。
   * 构建失败（如凭据缺失工厂即抛）不再上抛 500——转诊断行，面板直接可见原因。 */
  async check(accountId: string): Promise<unknown[]> {
    const record = this.records.find((r) => r.accountId === accountId)
    if (record === undefined) throw new AccountValidationError(`账号不存在：${accountId}`)
    let adapter = this.live.get(accountId)?.adapter
    if (adapter === undefined) {
      try {
        adapter = await this.buildAdapter(record)
      } catch (error) {
        return [{ name: 'connect', status: 'failed', hint: `适配器构建失败：${(error as Error).message}` }]
      }
    }
    if (typeof adapter.diagnose !== 'function') return [{ name: 'diagnose', status: 'unverified', hint: '渠道未实现诊断面' }]
    return adapter.diagnose()
  }

  // —— 生命周期 ——————————————————————————————————————————

  private async buildAdapter(record: AccountRecord): Promise<ChannelAdapter> {
    const secrets = await this.secretsOf(record)
    const factory = this.deps.adapterFactory ?? this.fallbackFactory
    return factory(record, secrets)
  }

  /** 建适配器并入引擎；连接失败记 warn（下次操作可重试），不影响其余账号。 */
  async ensureConnected(accountId: string): Promise<boolean> {
    const record = this.records.find((r) => r.accountId === accountId)
    if (record === undefined || record.paused === true) return false
    const live = this.live.get(accountId)
    if (live?.adapter !== undefined && live.adapter.connected) return true
    try {
      const adapter = live?.adapter ?? (await this.buildAdapter(record))
      this.deps.engine.registerAccount(adapter, accountId, {
        dmAllowlist: new Set(record.dmAllowlist ?? []),
        groupEnabled: record.groupEnabled,
        privateAccess: record.privateAccess === 'all' ? 'all' : 'approved',
        commandExec: normalizeCommandExec(record.commandExec),
        ...(record.alias !== undefined && record.alias !== '' ? { alias: record.alias } : {}),
        // QQ 群管理授权名单初始即下发（与 alias 对称）：不等后续 syncPolicy，新建账号首次 /qq 即可裁决。
        groupAdminOpenids: this.groupAdminSet(record),
        ...(record.session !== undefined ? { session: sanitizeSessionPrefs(record.session) } : {}),
      })
      await adapter.connect()
      this.live.set(accountId, { record, adapter, connected: true })
      this.deps.logInfo?.(`账号 ${accountId}（${record.channel}）已连接`)
      return true
    } catch (error) {
      this.deps.logWarn(`账号 ${accountId} 连接失败: ${(error as Error).message}`)
      return false
    }
  }

  async startAll(): Promise<void> {
    for (const record of this.records) {
      if (record.paused !== true) await this.ensureConnected(record.accountId)
    }
  }

  async stopAll(): Promise<void> {
    for (const accountId of [...this.live.keys()]) {
      await this.teardown(accountId)
    }
  }

  private async teardown(accountId: string): Promise<void> {
    const live = this.live.get(accountId)
    this.deps.engine.unregister(accountId)
    this.live.delete(accountId)
    try {
      await live?.adapter?.disconnect()
    } catch (error) {
      this.deps.logWarn(`账号 ${accountId} 断开异常: ${(error as Error).message}`)
    }
  }
}
