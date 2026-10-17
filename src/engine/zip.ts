/**
 * 零依赖 ZIP 写出器（T2.5 `/export`）。
 *
 * 只用 Node≥22 内置 `node:zlib`：
 * - 压缩法二选一：`deflate`（deflateRawSync）/ `store`（原样）——
 *   store 法对已压缩内容更省，deflate 对文本记录更省，两者都是合法 PKZIP 方法；
 * - CRC32：优先 `zlib.crc32`（Node 22 内置，实测 v22.22.1 存在），
 *   缺失时用自实现表法回退——保证老 runtime 也不炸；
 * - 结构：local file header + file data + central directory + EOCD，
 *   文件名按 UTF-8 并置 general purpose flag bit11（0x0800，中文会话名必需）。
 */
import { crc32 as nodeCrc32, deflateRawSync } from 'node:zlib'

export interface ZipInputEntry {
  name: string
  data: Uint8Array | string
  /** 单条目压缩法；缺省沿用全局 opts.method。 */
  method?: 'deflate' | 'store'
}

export interface ZipOptions {
  method?: 'deflate' | 'store'
  /** 固定时间戳（dos time），便于测试确定性；缺省用当前时间。 */
  now?: Date
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const VERSION = 20
const FLAG_UTF8 = 0x0800

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? new Uint8Array(Buffer.from(data, 'utf8')) : data
}

/** 自实现 CRC32（表法）——zlib.crc32 不可用时的回退。 */
let table: Uint32Array | undefined
function crc32Table(data: Uint8Array): number {
  table ??= (() => {
    const t = new Uint32Array(256)
    for (let i = 0; i < 256; i += 1) {
      let c = i
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[i] = c >>> 0
    }
    return t
  })()
  let crc = 0xffffffff
  for (const byte of data) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export function checksum(data: Uint8Array): number {
  const fn = (nodeCrc32 as unknown as ((buf: Uint8Array) => number) | undefined)
  if (typeof fn === 'function') {
    try {
      return Number(fn(data)) >>> 0
    } catch {
      // 平台差异（签名/入参形态）→ 退回表法，不阻塞导出。
    }
  }
  return crc32Table(data)
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f),
  }
}

function u16(value: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(value & 0xffff, 0)
  return b
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value >>> 0, 0)
  return b
}

/** 生成 ZIP 包字节（多条目，无目录项、无注释）。 */
export function zipSync(entries: ZipInputEntry[], opts?: ZipOptions): Uint8Array {
  const when = dosDateTime(opts?.now ?? new Date())
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/^\/+/, ''), 'utf8')
    const raw = toBytes(entry.data)
    const method = entry.method ?? opts?.method ?? 'deflate'
    const body = method === 'store' ? Buffer.from(raw) : Buffer.from(deflateRawSync(raw))
    const methodId = method === 'store' ? 0 : 8
    const crc = checksum(raw)
    const header = Buffer.concat([
      u32(SIG_LOCAL),
      u16(VERSION),
      u16(FLAG_UTF8),
      u16(methodId),
      u16(when.time),
      u16(when.date),
      u32(crc),
      u32(body.length),
      u32(raw.length),
      u16(name.length),
      u16(0),
      name,
    ])
    locals.push(header, body)

    centrals.push(
      Buffer.concat([
        u32(SIG_CENTRAL),
        u16(VERSION),
        u16(VERSION),
        u16(FLAG_UTF8),
        u16(methodId),
        u16(when.time),
        u16(when.date),
        u32(crc),
        u32(body.length),
        u32(raw.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    )
    offset += header.length + body.length
  }

  const central = Buffer.concat(centrals)
  const eocd = Buffer.concat([
    u32(SIG_EOCD),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ])
  const out = Buffer.concat([...locals, central, eocd])
  return new Uint8Array(out)
}
