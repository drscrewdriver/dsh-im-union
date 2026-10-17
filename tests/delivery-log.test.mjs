// T2.5 投递日志 + zip：环形/TTL/损坏转存/retryable 排除 uncertain/D7 判重/ZIP 结构。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { DeliveryLog, MAX_RETRY } from '../lib/engine/delivery-log.js'
import { zipSync, checksum } from '../lib/engine/zip.js'

const nowFixed = () => new Date('2026-10-18T12:00:00Z').getTime()

function makeLog(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'imu-del-'))
  const file = join(dir, 'deliveries.json')
  const warns = []
  const log = new DeliveryLog({ file, now: nowFixed, logWarn: (m) => warns.push(m), ...opts })
  return { log, file, warns, dir }
}

const outRow = (over = {}) => ({
  direction: 'out',
  channel: 'telegram',
  kind: 'dm',
  chatId: 'c1',
  accountId: 'a1',
  status: 'delivered',
  summary: '正文',
  ...over,
})

test('append：seq 递增 + 摘要截断 160 + 原子文件往返', () => {
  const { log, file } = makeLog()
  const long = 'x'.repeat(300)
  const r1 = log.append(outRow({ summary: long }))
  const r2 = log.append(outRow({ status: 'failed', summary: '短' }))
  assert.equal(r1.seq, 1)
  assert.equal(r2.seq, 2)
  assert.equal(r1.summary.length, 161) // 160 + 省略号
  assert.ok(r1.summary.endsWith('…'))
  const rows = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].kind, 'dm', 'kind 往返（补发重建地址用）')
  // 新实例读回
  const log2 = new DeliveryLog({ file, now: nowFixed })
  assert.equal(log2.get(1)?.summary, r1.summary)
  assert.equal(log2.get(3), undefined)
})

test('环形上限与 TTL：过期行清、超界裁旧、seq 不回卷', () => {
  const { log } = makeLog({ limit: 3, ttlMs: 1000 })
  for (let i = 0; i < 5; i += 1) log.append(outRow({ summary: `s${i}` }))
  assert.equal(log.recent(99).length, 3)
  assert.equal(log.recent(99)[0].summary, 's4', '倒序首条是最新')
  // 时钟推进过期
  const dir = mkdtempSync(join(tmpdir(), 'imu-del2-'))
  const file = join(dir, 'deliveries.json')
  let t = nowFixed()
  const l = new DeliveryLog({ file, now: () => t, ttlMs: 1000 })
  l.append(outRow({ summary: 'old' }))
  t += 2000
  l.append(outRow({ summary: 'new' }))
  assert.equal(l.recent(10).length, 1)
  assert.equal(l.recent(10)[0].summary, 'new')
  assert.equal(l.get(1), undefined, '过期即出表')
  assert.equal(l.append(outRow({ summary: 'x' })).seq, 3, 'nextSeq 不因裁剪回卷')
})

test('retryable/seen：确定性失败限额内可补；uncertain 绝不出现（D7）', () => {
  const { log } = makeLog()
  const failed = log.append(outRow({ status: 'failed' }))
  log.append(outRow({ status: 'uncertain' }))
  log.append(outRow({ status: 'delivered' }))
  const low = log.append(outRow({ status: 'failed', attempts: MAX_RETRY }))
  const list = log.retryable()
  assert.deepEqual(list.map((r) => r.seq), [failed.seq], 'attempts 达上限的排除')
  log.mark(failed.seq, { attempts: MAX_RETRY })
  assert.equal(log.retryable().length, 0)
  assert.equal(log.mark(999, { status: 'delivered' }), undefined)
  const keyed = log.append(outRow({ status: 'delivered', dedupKey: 'k1' }))
  assert.equal(log.seen('k1'), true)
  assert.equal(log.seen('k2'), false)
  const unKeyed = log.append(outRow({ status: 'uncertain', dedupKey: 'k3' }))
  assert.equal(log.seen('k3'), false, '非 delivered 不算已投')
  void keyed; void unKeyed; void low
})

test('损坏不 brick：非法 JSON → warn + .corrupt 转存 + 空表继续', () => {
  const { log, file, warns, dir } = makeLog()
  log.append(outRow({ summary: 'keep-me-before-corrupt' }))
  writeFileSync(file, '{ not json', 'utf8')
  const log2 = new DeliveryLog({ file, now: nowFixed, logWarn: (m) => warns.push(m) })
  assert.equal(log2.recent(5).length, 0)
  assert.equal(warns.length, 1)
  const { existsSync, readdirSync } = require_node_fs()
  assert.ok(!existsSync(file), '原损坏文件已改名让位')
  const corrupt = readdirSync(dir).filter((f) => f.includes('.corrupt-'))
  assert.equal(corrupt.length, 1, '损坏件转存留证')
  log2.append(outRow({ summary: 'fresh' })) // 后续写入从空表起点，不留 .tmp
  assert.ok(existsSync(file))
})

function require_node_fs() {
  return { existsSync, readdirSync }
}

// —— ZIP ——————————————————————————————————————————————

test('zipSync：PK 魔数 + EOCD 条目数 + deflate 内容回读 + UTF-8 名', () => {
  const bytes = zipSync(
    [
      { name: 'a.txt', data: 'hello hello hello hello' },
      { name: '中文/记录.json', data: JSON.stringify({ ok: 1 }) },
      { name: 'raw.bin', data: new Uint8Array([1, 2, 3]), method: 'store' },
    ],
    { now: new Date('2026-10-18T12:00:00Z') },
  )
  const view = Buffer.from(bytes)
  assert.equal(view.readUInt32LE(0), 0x04034b50, 'local header 魔数')
  const eocdAt = view.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(eocdAt > 0, 'EOCD 存在')
  assert.equal(view.readUInt16LE(eocdAt + 10), 3, '条目数')
  // 逐条目扫 central directory 校验 CRC 与解压回读
  let p = view.readUInt32LE(eocdAt + 16) === 0 ? 0 : 0
  void p
  const entries = []
  let q = 0
  while (q < eocdAt && view.readUInt32LE(q) === 0x04034b50) {
    const method = view.readUInt16LE(q + 8)
    const crc = view.readUInt32LE(q + 14)
    const compSize = view.readUInt32LE(q + 18)
    const uncompSize = view.readUInt32LE(q + 22)
    const nameLen = view.readUInt16LE(q + 26)
    const extraLen = view.readUInt16LE(q + 28)
    const name = view.subarray(q + 30, q + 30 + nameLen).toString('utf8')
    const dataStart = q + 30 + nameLen + extraLen
    const raw = view.subarray(dataStart, dataStart + compSize)
    const content = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    assert.equal(content.length, uncompSize)
    assert.equal(checksum(new Uint8Array(content)), crc >>> 0, `CRC ${name}`)
    entries.push(name)
    q = dataStart + compSize
  }
  assert.deepEqual(entries, ['a.txt', '中文/记录.json', 'raw.bin'])
})

test('zipSync：前导斜杠剥除 + 空表仍是合法包', () => {
  const bytes = zipSync([{ name: '/evil/../x.txt', data: 'x' }])
  const view = Buffer.from(bytes)
  assert.ok(view.subarray(0, 64).includes(Buffer.from('evil/../x.txt', 'utf8')), '名内相对段保留、仅剥前导斜杠')
  const empty = zipSync([])
  assert.equal(Buffer.from(empty).readUInt32LE(0), 0x06054b50, '空包只剩 EOCD')
  assert.equal(Buffer.from(empty).length, 22)
})
