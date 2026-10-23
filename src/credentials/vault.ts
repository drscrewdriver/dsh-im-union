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
    if (value !== null && typeof value === 'object') {
      // 宿主锚点（dsh-repo packages/credentials/credentials lib/types）：resolve 回
      // ResolvedCredential { value, source }；im-connect 兼容形声明同为 { value }；
      // 更早变体 { secret }。缝规则：空串=未存储，视作 undefined。
      const unwrapped = value as { value?: unknown; secret?: unknown }
      const inner =
        typeof unwrapped.value === 'string' && unwrapped.value !== ''
          ? unwrapped.value
          : typeof unwrapped.secret === 'string' && unwrapped.secret !== ''
            ? unwrapped.secret
            : undefined
      if (inner !== undefined) return inner
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

/**
 * 迁移包装（0.3.3）：desktop/Electron 线修复 inject 接线后，credentials 服务从
 * 软读丢失变为可达——vault 主存从文件切到宿主凭据库，**旧文件库里已存的 secret
 * 会被孤儿化**（真机实证：微信 botToken 缺失、bot 掉线）。本包装在主库 resolve
 * 未命中时查旧文件库，命中即搬迁进主库再返回；写/删双清旧文件副本防复活。
 */
class MigratingVault implements SecretVault {
  readonly kind: SecretVault['kind']
  constructor(
    private readonly primary: SecretVault,
    private readonly legacy: SecretVault,
    private readonly logWarn: (msg: string) => void,
  ) {
    this.kind = primary.kind
  }

  /**
   * 写主库并回读校验：只有主库确认可读才允许清理旧副本。0.3.3 的教训——
   * 主库写入面与读取面形态不一致时（真机实证：resolve 解包漏 {value}），
   * 先 unset 旧副本会把唯一副本删成永久丢失。
   * 返回 true=主库已确认持久化；false=回读失败（调用方保留旧副本并告警）。
   */
  private async setPrimaryVerified(ref: string, secret: string): Promise<boolean> {
    await this.primary.set(ref, secret)
    try {
      return (await this.primary.resolve(ref)) !== undefined
    } catch {
      return false
    }
  }

  async resolve(ref: string): Promise<string | undefined> {
    const value = await this.primary.resolve(ref)
    if (value !== undefined) return value
    const legacyValue = await this.legacy.resolve(ref)
    if (legacyValue === undefined) return undefined
    try {
      const persisted = await this.setPrimaryVerified(ref, legacyValue)
      if (persisted) {
        try {
          await this.legacy.unset(ref)
        } catch {
          // 旧副本清理失败不影响迁移结果。
        }
        this.logWarn(`凭据 ${ref} 已从文件 vault 迁移到宿主凭据库`)
      } else {
        // 本次仍按旧值应答；旧副本保留，下次访问再试。
        this.logWarn(`凭据 ${ref} 迁移后主库回读失败，保留旧文件副本防丢失`)
      }
    } catch (error) {
      // 迁移失败不阻断使用：本次仍按旧值应答，下次访问再试。
      this.logWarn(`凭据 ${ref} 迁移失败（本次按旧文件值应答）: ${(error as Error).message}`)
    }
    return legacyValue
  }

  async set(ref: string, secret: string): Promise<void> {
    const persisted = await this.setPrimaryVerified(ref, secret)
    if (!persisted) {
      // 写入不可回读：不丢旧副本，但调用方必须知道主库可能没落盘。
      this.logWarn(`凭据 ${ref} 写入后主库回读失败——旧文件副本保留，请检查宿主凭据服务`)
    }
    try {
      if (persisted) await this.legacy.unset(ref)
    } catch {
      // 旧副本清理失败不影响主写。
    }
  }

  async unset(ref: string): Promise<void> {
    await this.primary.unset(ref)
    try {
      await this.legacy.unset(ref)
    } catch {
      // 同上。
    }
  }

  async describe(): Promise<VaultDescriptor[]> {
    return this.primary.describe()
  }
}

/** 依能力选 vault：credentials 服务在 → 主存（带文件库迁移）；否则文件回退（原子写+0600）。 */
export function createVault(
  credentials: CredentialsLike | undefined,
  stateDir: string,
  logWarn?: (msg: string) => void,
): SecretVault {
  const fileVault = new FileVault(join(stateDir, 'secrets.json'))
  if (credentials !== undefined && typeof credentials.set === 'function' && typeof credentials.resolve === 'function') {
    return new MigratingVault(new ServiceVault(credentials, fileVault), fileVault, logWarn ?? (() => undefined))
  }
  return fileVault
}
