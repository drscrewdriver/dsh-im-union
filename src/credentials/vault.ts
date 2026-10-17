/**
 * 凭据层（安全红线 D1）。
 *
 * - 主存储：宿主 ctx.credentials（capability 里有就用）；
 * - 回退：profile 状态目录下文件 vault——原子写（tmp+rename）、POSIX 0600、
 *   Windows 继承父目录 ACL；**解析损坏即抛错，绝不覆盖唯一副本**；
 * - credentialRef 归一为 POSIX 标识符风格（IM_UNION_<CHANNEL>_<KEY>），
 *   禁斜杠/连字符——宿主凭据库对 ref 字符集有硬约束。
 */
import { existsSync, readFileSync } from 'node:fs'
import { chmod, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CredentialsLike } from '../types.js'

export interface VaultDescriptor {
  ref: string
  configured: boolean
}

export interface SecretVault {
  kind: 'service' | 'file'
  set(ref: string, secret: string): Promise<void>
  resolve(ref: string): Promise<string | undefined>
  describe(): Promise<VaultDescriptor[]>
  unset(ref: string): Promise<void>
}

/** channel/key → 大写 POSIX ref。非 [A-Za-z0-9_] 一律替换为下划线。 */
export function credentialRef(channel: string, key: string): string {
  const sanitize = (value: string): string =>
    value
      .replace(/[^a-zA-Z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase()
  return `IM_UNION_${sanitize(channel)}_${sanitize(key)}`
}

class ServiceVault implements SecretVault {
  readonly kind = 'service' as const
  constructor(private readonly credentials: CredentialsLike, private readonly fallback: SecretVault) {}

  async set(ref: string, secret: string): Promise<void> {
    // 先写 secret 本体再让上层落 ref 引用；失败异常直接上抛（调用方回滚）。
    await this.credentials.set!(ref, secret)
  }

  async resolve(ref: string): Promise<string | undefined> {
    const value = await this.credentials.resolve!(ref)
    if (typeof value === 'string') return value
    if (value !== null && typeof value === 'object' && typeof (value as { secret?: unknown }).secret === 'string') {
      return (value as { secret: string }).secret
    }
    return undefined
  }

  async describe(): Promise<VaultDescriptor[]> {
    // describe 形态跨代有差异，拿不到就交给调用方按已注册 ref 清单展示。
    return []
  }

  async unset(ref: string): Promise<void> {
    if (typeof this.credentials.unset === 'function') {
      await this.credentials.unset(ref)
      return
    }
    await this.fallback.unset(ref)
  }
}

class FileVault implements SecretVault {
  readonly kind = 'file' as const
  private cached: Record<string, string> | undefined

  constructor(private readonly filePath: string) {}

  private load(): Record<string, string> {
    if (this.cached !== undefined) return this.cached
    if (!existsSync(this.filePath)) {
      this.cached = {}
      return this.cached
    }
    // 损坏即抛——静默重置等于丢掉用户全部机器人凭据。
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('secrets vault 格式损坏：期望 JSON object，拒绝覆盖')
    }
    const record: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') record[key] = value
    }
    this.cached = record
    return record
  }

  private async persist(record: Record<string, string>): Promise<void> {
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, JSON.stringify(record, null, 2), { mode: 0o600 })
    if (process.platform !== 'win32') {
      // writeFile 的 mode 受 umask 影响，显式钉死 0600。
      await chmod(tmp, 0o600)
    }
    await rename(tmp, this.filePath)
    this.cached = record
  }

  async set(ref: string, secret: string): Promise<void> {
    const record = { ...this.load(), [ref]: secret }
    await this.persist(record)
  }

  async resolve(ref: string): Promise<string | undefined> {
    return this.load()[ref]
  }

  async describe(): Promise<VaultDescriptor[]> {
    return Object.keys(this.load()).map((ref) => ({ ref, configured: true }))
  }

  async unset(ref: string): Promise<void> {
    const record = { ...this.load() }
    delete record[ref]
    await this.persist(record)
  }
}

/** 依能力选 vault：credentials 服务在 → 主存；否则文件回退（原子写+0600）。 */
export function createVault(credentials: CredentialsLike | undefined, stateDir: string): SecretVault {
  const fileVault = new FileVault(join(stateDir, 'secrets.json'))
  if (credentials !== undefined && typeof credentials.set === 'function' && typeof credentials.resolve === 'function') {
    return new ServiceVault(credentials, fileVault)
  }
  return fileVault
}
