/**
 * 跨版本窄腰·会话文件系统读法归一。
 *
 * 断裂面（im-connect 实证）：0.1.5/0.1.6 的会话文件服务暴露 readAll，
 * 0.1.7+ 改 readBytes，且部分 alpha 缺 eof/offset 字段。文件回传/导出只吃
 * 本模块的 readFileBytes 归一口，禁直接触碰原始方法名。
 */
import { UnsupportedError } from './session-api.js'

interface ReadAllLike {
  readAll?: (path: string) => unknown | Promise<unknown>
  readBytes?: (path: string) => unknown | Promise<unknown>
}

function toBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return undefined
}

/** 探测式读取：readBytes 优先（新线），退 readAll（0.1.5/0.1.6），再不行显式降级。 */
export async function readFileBytes(fs: unknown, path: string): Promise<Uint8Array> {
  if (fs === null || typeof fs !== 'object') throw new UnsupportedError('会话文件读取')
  const holder = fs as ReadAllLike
  if (typeof holder.readBytes === 'function') {
    const bytes = toBytes(await holder.readBytes(path))
    if (bytes !== undefined) return bytes
  }
  if (typeof holder.readAll === 'function') {
    const bytes = toBytes(await holder.readAll(path))
    if (bytes !== undefined) return bytes
  }
  throw new UnsupportedError('会话文件读取（readBytes/readAll 均不可用）')
}
