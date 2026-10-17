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
import type { AccountPolicy, ImUnionEngine } from './gateway.js'

export interface AccountRecord {
  accountId: string
  channel: string
  alias?: string
  config?: Record<string, string>
  dmAllowlist?: string[]
  groupEnabled?: boolean
  paused?: boolean
}

export interface PublicAccount {
  accountId: string
  channel: string
  alias?: string
  paused: boolean
  connected: boolean
  secretFields: Array<{ key: string; configured: boolean }>
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
    return (CHANNEL_META[record.channel]?.fields ?? [])
      .filter((f) => f.secret)
      .map((f) => credentialRef(record.channel, `${record.accountId}.${f.key}`))
  }

  private async secretsOf(record: AccountRecord): Promise<Record<string, string | undefined>> {
    const secrets: Record<string, string | undefined> = {}
    for (const field of CHANNEL_META[record.channel]?.fields ?? []) {
      if (!field.secret) continue
      secrets[field.key] = await this.deps.vault.resolve(credentialRef(record.channel, `${record.accountId}.${field.key}`))
    }
    return secrets
  }

  // —— CRUD ——————————————————————————————————————————

  /** 新增或整体替换账号；secrets 单向入 vault（键=meta 的 secret 字段名）；随后重启生效。 */
  async upsert(record: AccountRecord, secrets?: Record<string, string>): Promise<void> {
    this.validate(record)
    const index = this.records.findIndex((r) => r.accountId === record.accountId)
    if (index >= 0) {
      await this.teardown(record.accountId)
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
    if (record.paused !== true) {
      await this.ensureConnected(record.accountId)
    }
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

  /** 白名单整值替换（账号级私聊准入，红线 D6 的数据源）。 */
  async setAllowlist(accountId: string, userIds: string[]): Promise<boolean> {
    const record = this.records.find((r) => r.accountId === accountId)
    if (record === undefined) return false
    record.dmAllowlist = userIds
    this.persist()
    const live = this.live.get(accountId)
    if (live?.adapter !== undefined) {
      this.deps.engine.registerAccount(live.adapter, accountId, {
        dmAllowlist: new Set(userIds),
        groupEnabled: record.groupEnabled,
      })
    }
    return true
  }

  list(): AccountRecord[] {
    return this.records.map((r) => ({ ...r }))
  }

  /** 脱敏视图：零 secret 值，只报 configured（D4）。 */
  async listPublic(): Promise<PublicAccount[]> {
    const rows: PublicAccount[] = []
    for (const record of this.records) {
      const fields: Array<{ key: string; configured: boolean }> = []
      for (const field of CHANNEL_META[record.channel]?.fields ?? []) {
        if (!field.secret) continue
        const value = await this.deps.vault.resolve(credentialRef(record.channel, `${record.accountId}.${field.key}`))
        fields.push({ key: field.key, configured: value !== undefined })
      }
      const live = this.live.get(record.accountId)
      rows.push({
        accountId: record.accountId,
        channel: record.channel,
        alias: record.alias,
        paused: record.paused === true,
        connected: live?.adapter?.connected === true,
        secretFields: fields,
      })
    }
    return rows
  }

  /** 连接检查：适配器不在位则临时构建（不保持连接）；诊断已过脱敏纪律（E5）。 */
  async check(accountId: string): Promise<unknown[]> {
    const record = this.records.find((r) => r.accountId === accountId)
    if (record === undefined) throw new AccountValidationError(`账号不存在：${accountId}`)
    let adapter = this.live.get(accountId)?.adapter
    if (adapter === undefined) {
      adapter = await this.buildAdapter(record)
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
      })
      await adapter.connect()
      this.live.set(accountId, { record, adapter, connected: true })
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
