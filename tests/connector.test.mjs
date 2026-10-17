/**
 * AI Office Connector（M2 T2.7）验收面：
 * https 强制拒绝 / 租约过期回收（假时钟）/ 并发上限排队 / 审批超时 failed /
 * 状态文件原子写往返 / 零 secret 回显。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVault } from '../lib/credentials/vault.js'
import {
  ConnectorConfigError,
  ConnectorInputError,
  ConnectorService,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_PER_KIND,
  DEVICE_TOKEN_REF,
  PAIRING_CODE_REF,
  handleHttp,
  normalizeSecureBaseUrl,
} from '../lib/engine/connector.js'

const T0 = 1_700_000_000_000
const BASE = 'https://office.example.invalid'

/** 假时钟：所有时间语义由它推进，测试内零 sleep。 */
function makeClock(start = T0) {
  let t = start
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
      return t
    },
  }
}

async function makeService(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'imu-conn-'))
  const clock = overrides.clock ?? makeClock()
  const warnings = []
  const stateFile = join(dir, 'connector.json')
  const service = new ConnectorService({
    vault: createVault(undefined, dir),
    stateFile,
    baseUrl: BASE,
    now: clock.now,
    logWarn: (msg) => warnings.push(msg),
    ...overrides,
  })
  return { dir, clock, warnings, service, stateFile }
}

function buildService(dir, stateFile, clock, overrides = {}) {
  const warnings = []
  const service = new ConnectorService({
    vault: createVault(undefined, dir),
    stateFile,
    baseUrl: BASE,
    now: clock.now,
    logWarn: (msg) => warnings.push(msg),
    ...overrides,
  })
  return { service, warnings }
}

// —— 1. 强制 HTTPS（红线：拒载，不是降级）————————————————

test('https 红线：非回环 http / 怪协议 / 内嵌凭据 / 查询串一律拒载', () => {
  const rejected = [
    'http://office.example.com',
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://localhost.evil.com',
    'ftp://office.example.com',
    'file:///c:/office',
    'data:text/plain,x',
    'https://user:pass@office.example.com',
    'https://office.example.com?token=abc',
    'https://office.example.com#frag',
    'not a url',
    '',
    '   ',
  ]
  for (const bad of rejected) {
    assert.throws(() => normalizeSecureBaseUrl(bad), ConnectorConfigError, `应拒绝：${bad}`)
  }
  // 构造期同样抛（不留「起来了但静默走 http」的形态）
  assert.throws(
    () =>
      new ConnectorService({
        vault: { kind: 'file', set: async () => {}, resolve: async () => '', describe: async () => [], unset: async () => {} },
        stateFile: join(tmpdir(), 'imu-conn-none.json'),
        baseUrl: 'http://office.example.com',
      }),
    ConnectorConfigError,
  )
})

test('https 红线：归一形态与本机回环例外', () => {
  assert.equal(normalizeSecureBaseUrl('https://office.example.com/'), 'https://office.example.com')
  assert.equal(normalizeSecureBaseUrl('https://office.example.com/office'), 'https://office.example.com/office')
  assert.equal(normalizeSecureBaseUrl('http://localhost:8080', { allowInsecureLocal: true }), 'http://localhost:8080')
  assert.equal(normalizeSecureBaseUrl('http://[::1]:9999', { allowInsecureLocal: true }), 'http://[::1]:9999')
  // override 只放行回环 http，救不了非回环与非 http 协议
  assert.throws(() => normalizeSecureBaseUrl('http://office.example.com', { allowInsecureLocal: true }), ConnectorConfigError)
  assert.throws(() => normalizeSecureBaseUrl('http://LOCALHOST.evil.com', { allowInsecureLocal: true }), ConnectorConfigError)
  assert.throws(() => normalizeSecureBaseUrl('ftp://127.0.0.1', { allowInsecureLocal: true }), ConnectorConfigError)
})

test('回环例外只影响诊断：httpsEnforced=false 且 transport 报 unverified 不判死', async () => {
  const { service, dir } = await makeService({ baseUrl: 'http://localhost:8080', allowInsecureLocal: true })
  try {
    assert.equal(service.status().baseUrl, 'http://localhost:8080')
    assert.equal(service.status().httpsEnforced, false)
    const transport = (await service.diagnose()).find((c) => c.name === 'transport')
    assert.equal(transport.status, 'unverified')
    assert.match(transport.hint, /生产不适用/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('https 正路：httpsEnforced=true，ref 键名归一为 POSIX 形态', async () => {
  const { service, dir } = await makeService()
  try {
    assert.equal(service.status().httpsEnforced, true)
    const transport = (await service.diagnose()).find((c) => c.name === 'transport')
    assert.equal(transport.status, 'passed')
    assert.equal(PAIRING_CODE_REF, 'IM_UNION_AI_OFFICE_PAIRING_CODE')
    assert.equal(DEVICE_TOKEN_REF, 'IM_UNION_AI_OFFICE_DEVICE_TOKEN')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// —— 2. Job 租约 ————————————————————————————————————————

test('租约到期自动回收重排，重排用尽转 expired', async () => {
  const { service, clock, dir } = await makeService({ leaseTtlMs: 500, maxConcurrentPerKind: 1, maxAttempts: 2 })
  try {
    const j1 = service.submit({ kind: 'doc.export' })
    assert.equal(j1.state, 'leased')
    assert.equal(j1.attempts, 1)
    assert.equal(j1.leaseUntilMs, T0 + 500)
    const j2 = service.submit({ kind: 'doc.export' })
    assert.equal(j2.state, 'queued')

    clock.advance(500)
    assert.equal(service.reclaim(), 1)
    const reclaimed = service.get(j1.id)
    assert.equal(reclaimed.state, 'queued')
    assert.equal(reclaimed.attempts, 1)
    assert.equal(reclaimed.leaseUntilMs, undefined)
    assert.equal(service.get(j2.id).state, 'queued')

    assert.equal(service.pump(), 1)
    assert.equal(service.get(j1.id).state, 'leased')
    assert.equal(service.get(j1.id).attempts, 2)

    clock.advance(500)
    service.reclaim()
    const expired = service.get(j1.id)
    assert.equal(expired.state, 'expired')
    assert.equal(expired.error, 'lease-expired')
    assert.equal(service.get(j2.id).state, 'queued')
    assert.equal(service.pump(), 1)
    assert.equal(service.get(j2.id).state, 'leased')
    assert.equal(service.reclaim(), 0, '终态/租约内的 Job 不被回收触碰')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tick 合一推进 + renewLease/complete/cancel 生命周期', async () => {
  const { service, clock, dir } = await makeService({ leaseTtlMs: 1000, maxConcurrentPerKind: 2, maxAttempts: 2 })
  try {
    const a = service.submit({ kind: 'doc.export' })
    const b = service.submit({ kind: 'doc.export' })
    assert.equal(service.get(b.id).state, 'leased')
    assert.equal(service.renewLease(b.id, 4000).leaseUntilMs, T0 + 4000)

    clock.advance(1000)
    service.tick()
    // a 到期 → 回收重排（b 仍占一槽，a 抢回空槽并续新租约）
    assert.equal(service.get(a.id).state, 'leased')
    assert.equal(service.get(a.id).attempts, 2)
    assert.equal(service.get(a.id).leaseUntilMs, T0 + 2000)

    clock.advance(3000)
    service.tick()
    assert.equal(service.get(a.id).state, 'expired')
    assert.equal(service.get(b.id).state, 'leased')
    assert.equal(service.get(b.id).attempts, 2)

    const done = service.submit({ kind: 'sheet.sync' })
    assert.equal(service.complete(done.id).state, 'done')
    assert.equal(service.complete(done.id), undefined, '终态不可重复收尾')
    assert.equal(service.cancel(done.id), false, '终态不可取消')
    assert.equal(service.cancel(a.id), false, 'expired 亦终态')
    assert.equal(service.cancel('nope-999'), false, '不存在的 Job')
    assert.equal(service.get('bad id'), undefined)
    assert.equal(service.renewLease(done.id), undefined)
    assert.equal(service.status().counts.done, 1)
    assert.equal(service.status().counts.expired, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// —— 3. 同 kind 并发上限 —————————————————————————————————

test('同 kind 并发上限（默认 2）满额 queued 等待，跨 kind 互不占用', async () => {
  const { service, dir } = await makeService()
  try {
    assert.equal(DEFAULT_MAX_CONCURRENT_PER_KIND, 2)
    assert.equal(service.status().limits.maxConcurrentPerKind, DEFAULT_MAX_CONCURRENT_PER_KIND)
    const ids = ['a', 'b', 'c', 'd'].map((label) => service.submit({ kind: 'doc.export', label }).id)
    assert.deepEqual(
      ids.map((id) => service.get(id).state),
      ['leased', 'leased', 'queued', 'queued'],
    )
    assert.equal(service.get(ids[2]).leaseUntilMs, undefined)
    assert.equal(service.submit({ kind: 'slide.render' }).state, 'leased', '另一 kind 独立计数')

    const stat = service.status().kinds.find((k) => k.kind === 'doc.export')
    assert.deepEqual({ active: stat.active, queued: stat.queued, limit: stat.limit }, { active: 2, queued: 2, limit: 2 })

    // 释放一个槽位 → FIFO 只放行队首，不越过排队者
    service.complete(ids[0])
    assert.equal(service.pump(), 1)
    assert.equal(service.get(ids[2]).state, 'leased')
    assert.equal(service.get(ids[3]).state, 'queued')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('kindLimits 覆写按 kind 生效，非法值夹到 1', async () => {
  const { service, dir } = await makeService({ maxConcurrentPerKind: 5, kindLimits: { 'doc.export': 1, 'sheet.sync': 0 } })
  try {
    assert.equal(service.submit({ kind: 'doc.export' }).state, 'leased')
    assert.equal(service.submit({ kind: 'doc.export' }).state, 'queued')
    assert.equal(service.submit({ kind: 'sheet.sync' }).state, 'leased')
    assert.equal(service.submit({ kind: 'sheet.sync' }).state, 'queued')
    assert.equal(service.status().kinds.find((k) => k.kind === 'sheet.sync').limit, 1)
    assert.equal(service.status().kinds.find((k) => k.kind === 'doc.export').limit, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// —— 4. 审批等待 ————————————————————————————————————————

test('审批：默认 5 分钟超时 → failed(approval-timeout)；resolveApproval 推进终态', async () => {
  const { service, clock, dir } = await makeService({ maxConcurrentPerKind: 1 })
  try {
    assert.equal(DEFAULT_APPROVAL_TIMEOUT_MS, 300_000)
    assert.equal(service.status().limits.approvalTimeoutMs, DEFAULT_APPROVAL_TIMEOUT_MS)

    const p1 = service.submit({ kind: 'doc.share', requiresApproval: true })
    assert.equal(p1.state, 'awaiting-approval')
    assert.equal(p1.approvalRef, `apr_${p1.id}`)
    assert.equal(p1.approvalDeadlineMs, T0 + 300_000)
    const blocked = service.submit({ kind: 'doc.share', requiresApproval: true })
    assert.equal(blocked.state, 'queued', '审批中仍占并发槽')

    clock.advance(299_999)
    assert.equal(service.reclaim(), 0)
    assert.equal(service.get(p1.id).state, 'awaiting-approval')

    clock.advance(1)
    assert.equal(service.reclaim(), 1)
    const timedOut = service.get(p1.id)
    assert.equal(timedOut.state, 'failed')
    assert.equal(timedOut.error, 'approval-timeout')
    assert.equal(service.resolveApproval(p1.id, true), undefined, '已超时的审批不可回填')

    // p1 让槽 → 排队的 blocked 取槽并挂审批
    assert.equal(service.pump(), 1)
    assert.equal(service.get(blocked.id).state, 'awaiting-approval')
    assert.equal(service.cancel(blocked.id), true)

    const p2 = service.submit({ kind: 'doc.share', requiresApproval: true, approvalRef: 'apr_manual_2' })
    assert.equal(p2.state, 'awaiting-approval')
    assert.equal(p2.approvalRef, 'apr_manual_2')
    assert.equal(service.resolveApproval(p2.id, true).state, 'done', '审批通过 → done')
    assert.equal(service.resolveApproval(p2.id, true), undefined, '终态不可重复回填')

    const p3 = service.submit({ kind: 'doc.share', requiresApproval: true })
    assert.equal(service.resolveApproval(p3.id, false).state, 'failed')
    assert.equal(service.get(p3.id).error, 'approval-rejected')
    assert.equal(service.resolveApproval(p3.id, true), undefined)
    assert.equal(service.status().counts.failed, 3)
    assert.equal(service.status().counts.done, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('requestApproval 让在途 leased 挂审批引用与超时', async () => {
  const { service, clock, dir } = await makeService({ approvalTimeoutMs: 60_000 })
  try {
    const j = service.submit({ kind: 'doc.export' })
    assert.equal(j.state, 'leased')
    assert.equal(j.approvalRef, undefined)
    const held = service.requestApproval(j.id, 'apr_x9')
    assert.equal(held.state, 'awaiting-approval')
    assert.equal(held.approvalRef, 'apr_x9')
    assert.equal(held.approvalDeadlineMs, T0 + 60_000)
    assert.equal(service.requestApproval(j.id), undefined, '非 leased 不再挂审批')

    const j2 = service.submit({ kind: 'doc.export' })
    assert.equal(j2.state, 'leased')
    assert.throws(() => service.requestApproval(j2.id, 'bad-ref'), ConnectorInputError)
    assert.equal(service.get(j2.id).state, 'leased', '校验失败不得改态')

    clock.advance(60_000)
    service.tick()
    assert.equal(service.get(j.id).state, 'failed')
    assert.equal(service.get(j.id).error, 'approval-timeout')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('submit 入参校验：kind 形态、approvalRef 需 requiresApproval、label 清洗截断', async () => {
  const { service, dir } = await makeService()
  try {
    for (const kind of ['', '   ', 'bad kind', 'x'.repeat(49), '../etc', 'a/b']) {
      assert.throws(() => service.submit({ kind }), ConnectorInputError, `应拒绝 kind：${JSON.stringify(kind)}`)
    }
    assert.throws(() => service.submit({ kind: 'doc.export', approvalRef: 'apr_1' }), ConnectorInputError)
    assert.throws(
      () => service.submit({ kind: 'doc.export', requiresApproval: true, approvalRef: 'nope_1' }),
      ConnectorInputError,
    )
    assert.throws(() => service.submit(null), ConnectorInputError)
    const noisy = service.submit({ kind: 'doc.export', label: `a\u0000b\u0000${'c'.repeat(300)}` })
    assert.ok(!noisy.label.includes('\u0000'), '控制字符必须被清洗')
    assert.ok(noisy.label.length <= 121, `label 需截断：${noisy.label.length}`)
    assert.ok(noisy.label.endsWith('…'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// —— 5. 状态文件：原子写往返 / 损坏不 brick / 白名单重建 ——————

test('状态文件原子写往返：重启后配对态与 Job 表复原，id 不重号，无 tmp 残留', async () => {
  const { service, clock, dir, stateFile } = await makeService()
  try {
    await service.pair({ deviceToken: 'ROUNDTRIP-TOK-1', deviceName: 'Desk-PC' })
    const j1 = service.submit({ kind: 'doc.export' })
    const j2 = service.submit({ kind: 'doc.share', requiresApproval: true })
    service.submit({ kind: 'doc.export' })
    service.complete(j1.id)

    const { service: revived } = buildService(dir, stateFile, clock)
    const status = revived.status()
    assert.equal(status.paired, true)
    assert.equal(status.deviceName, 'Desk-PC')
    assert.equal(status.deviceTokenRef, DEVICE_TOKEN_REF)
    assert.equal(status.httpsEnforced, true)
    const revivedRows = revived.list({ limit: 10 })
    assert.deepEqual(
      revivedRows.map((job) => [job.id, job.state]),
      [
        ['job-3', 'leased'],
        ['job-2', 'awaiting-approval'],
        ['job-1', 'done'],
      ],
    )
    assert.equal(revived.get('job-3').kind, 'doc.export')
    assert.equal(revived.get('job-3').attempts, 1)
    assert.equal(revived.get('job-2').approvalRef, 'apr_job-2')
    // 号段续接：新 Job 不复用既有 id
    assert.equal(revived.submit({ kind: 'doc.export' }).id, 'job-4')

    const names = await readdir(dir)
    assert.deepEqual(names.filter((n) => n.includes('connector.json.tmp')), [], '原子写不留 tmp')
    assert.ok(existsSync(stateFile))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('状态文件损坏不 brick：warn + 转存 .corrupt-* + 从空表继续', async () => {
  const { service, dir, stateFile, warnings, clock } = await makeService()
  try {
    service.submit({ kind: 'doc.export' })
    await writeFile(stateFile, '{ this is not json', 'utf8')
    const { service: revived, warnings: warn2 } = buildService(dir, stateFile, clock)
    assert.equal(warn2.filter((m) => /connector\.json 损坏/.test(m)).length, 1)
    const names = await readdir(dir)
    assert.ok(names.some((n) => n.startsWith('connector.json.corrupt-')), `应留下隔离件：${names}`)
    assert.equal(revived.status().paired, false)
    assert.equal(revived.list({ limit: 5 }).length, 0)
    assert.equal(revived.submit({ kind: 'doc.export' }).id, 'job-1')
    assert.equal(warnings.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('装载按白名单重建：塞进状态文件的多余键/异常 ref 一律丢弃且不再写回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imu-conn-'))
  const stateFile = join(dir, 'connector.json')
  const clock = makeClock()
  try {
    await writeFile(
      stateFile,
      JSON.stringify({
        version: 1,
        pairing: { paired: true, deviceName: 'Desk-PC', deviceToken: 'PLAINTEXT-LEAK', updatedAtMs: T0 },
        jobs: [
          {
            id: 'job-9',
            kind: 'doc.export',
            state: 'leased',
            attempts: 1,
            createdAtMs: T0,
            updatedAtMs: T0,
            token: 'LEAK-2',
            approvalRef: 'evil-ref',
            secretPayload: { nested: 'LEAK-3' },
          },
        ],
        nextSeq: 10,
      }),
      'utf8',
    )
    const { service } = buildService(dir, stateFile, clock)
    assert.equal(service.status().paired, true)
    assert.equal(service.status().deviceTokenRef, DEVICE_TOKEN_REF, 'ref 只认白名单键名')
    assert.equal(service.get('job-9').approvalRef, undefined, '非 apr_ 形态 ref 丢弃')
    service.submit({ kind: 'doc.export' })
    const persisted = await readFile(stateFile, 'utf8')
    for (const leak of ['PLAINTEXT-LEAK', 'LEAK-2', 'LEAK-3', 'evil-ref', 'secretPayload']) {
      assert.ok(!persisted.includes(leak), `状态文件不应含 ${leak}`)
    }
    assert.ok(!JSON.stringify(service.status()).includes('PLAINTEXT-LEAK'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// —— 6. 零 secret 回显 —————————————————————————————————

test('凭据只经 vault：配对码一次性消费、令牌零明文落盘、所有回包零值零异常原文', async () => {
  const TOKEN = 'DEVTOK-super-secret-XYZ'
  const CODE = 'PAIR-9f2c-keepme'
  const STACK = 'INTERNAL-STACK-token=LEAK'
  const { service, dir, warnings } = await makeService({
    fetchImpl: async () => {
      throw new Error(STACK)
    },
  })
  try {
    assert.equal(service.status().vaultKind, 'file')
    await service.storePairingCode(CODE)
    assert.equal(service.status().pairingCodeStored, true)
    const secretsPath = join(dir, 'secrets.json')
    assert.match(await readFile(secretsPath, 'utf8'), /PAIR-9f2c-keepme/, '配对码进 vault（0600 文件库）')
    assert.equal(await service.consumePairingCode(), CODE)
    assert.equal(service.status().pairingCodeStored, false)
    assert.ok(!(await readFile(secretsPath, 'utf8')).includes(CODE), '一次性消费后即抹除')
    await assert.rejects(() => service.storePairingCode(''), ConnectorInputError)
    await assert.rejects(() => service.pair({ deviceToken: '' }), ConnectorInputError)
    await assert.rejects(() => service.pair({ deviceToken: TOKEN }), ConnectorInputError, '缺设备名不配对')

    const meta = await service.pair({ deviceToken: TOKEN, deviceName: '  Desk-PC  ' })
    assert.equal(meta.paired, true)
    assert.equal(meta.deviceName, 'Desk-PC')
    assert.equal(await service.resolveDeviceToken(), TOKEN)

    const job = service.submit({ kind: 'doc.share', requiresApproval: true })
    const snapshots = [
      JSON.stringify(service.status()),
      JSON.stringify(await service.diagnose()),
      JSON.stringify(service.list({ limit: 20 })),
      JSON.stringify(service.get(job.id)),
      JSON.stringify(await handleHttp({ service }, { method: 'GET', path: '/connector/jobs' })),
      JSON.stringify(await handleHttp({ service }, { method: 'POST', path: '/connector/jobs', body: { kind: 'slide.render' } })),
      await readFile(join(dir, 'connector.json'), 'utf8'),
    ]
    for (const [i, text] of snapshots.entries()) {
      assert.ok(!text.includes(TOKEN), `快照 ${i} 泄漏设备令牌`)
      assert.ok(!text.includes(CODE), `快照 ${i} 泄漏配对码`)
      assert.ok(!text.includes(STACK), `快照 ${i} 泄漏内部异常原文`)
    }
    assert.ok(snapshots[0].includes(DEVICE_TOKEN_REF), 'ref 键名可示，值不可示')

    const reach = (await service.diagnose()).find((c) => c.name === 'remote-reachability')
    assert.equal(reach.status, 'failed', '已配对但远端不可达 → failed')
    assert.match(reach.hint, /详情见本机日志/)
    assert.ok(warnings.some((m) => m.includes(STACK)), '异常细节只进本机日志')

    await service.unpair()
    assert.equal(service.status().paired, false)
    assert.equal(service.status().deviceTokenConfigured, false)
    assert.ok(!(await readFile(secretsPath, 'utf8')).includes(TOKEN), '解除配对抹除令牌')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('诊断三态：未配对 unverified / 探测通过 passed / 无 fetch 面 unverified', async () => {
  const bare = await makeService()
  try {
    const checks = await bare.service.diagnose()
    assert.deepEqual(checks.map((c) => c.name), ['device-pairing', 'transport', 'remote-reachability', 'office-roundtrip'])
    assert.equal(checks.find((c) => c.name === 'device-pairing').status, 'unverified')
    assert.match(checks.find((c) => c.name === 'device-pairing').hint, /配对/)
    assert.equal(checks.find((c) => c.name === 'remote-reachability').status, 'unverified')
    assert.equal(checks.find((c) => c.name === 'office-roundtrip').status, 'unverified', '未声明协议兼容')
  } finally {
    await rm(bare.dir, { recursive: true, force: true })
  }

  const probed = await makeService({ fetchImpl: async (url, init) => ({ status: url === BASE && init.method === 'GET' ? 200 : 503 }) })
  try {
    await probed.service.pair({ deviceToken: 'TOK-PROBE', deviceName: 'Laptop-1' })
    const checks = await probed.service.diagnose()
    assert.equal(checks.find((c) => c.name === 'device-pairing').status, 'passed')
    assert.equal(checks.find((c) => c.name === 'remote-reachability').status, 'passed')
    assert.match(checks.find((c) => c.name === 'remote-reachability').hint, /不证明协议兼容/)
    assert.equal(probed.warnings.length, 0, '探测通过路径零告警')
  } finally {
    await rm(probed.dir, { recursive: true, force: true })
  }

  const noFetch = await makeService()
  try {
    await noFetch.service.pair({ deviceToken: 'TOK-NOFETCH', deviceName: 'Laptop-2' })
    const reach = (await noFetch.service.diagnose()).find((c) => c.name === 'remote-reachability')
    assert.equal(reach.status, 'unverified')
    assert.match(reach.hint, /未注入 fetch 面/)
  } finally {
    await rm(noFetch.dir, { recursive: true, force: true })
  }
})

// —— 7. HTTP 面（{status,json} 形态）——————————————————————

test('handleHttp：三条路由的码值与脱敏回包', async () => {
  const { service, dir } = await makeService({ maxConcurrentPerKind: 1 })
  const deps = { service, logWarn: () => undefined }
  try {
    const created = await handleHttp(deps, { method: 'post', path: '/connector/jobs', body: { kind: 'doc.export', label: '月报' } })
    assert.equal(created.status, 202)
    assert.equal(created.json.ok, true)
    assert.equal(created.json.job.state, 'leased')
    assert.equal(created.json.job.label, '月报')
    assert.equal(created.json.job.attempts, 1)
    const firstId = created.json.job.id

    const held = await handleHttp(deps, { method: 'POST', path: '/connector/jobs', body: { kind: 'doc.export' } })
    assert.equal(held.json.job.state, 'queued')
    const approval = await handleHttp(deps, {
      method: 'POST',
      path: '/connector/jobs',
      body: { kind: 'doc.share', requiresApproval: true, approvalRef: 'apr_http_1' },
    })
    assert.equal(approval.json.job.state, 'awaiting-approval', 'doc.share 是另一 kind，自有额度不受 doc.export 拥堵影响，入队即取槽并挂审批')
    assert.equal(approval.json.job.approvalRef, 'apr_http_1')

    const listed = await handleHttp(deps, { method: 'GET', path: '/connector/jobs' })
    assert.equal(listed.status, 200)
    assert.equal(listed.json.jobs[0].id, approval.json.job.id, '倒序最近优先')
    assert.equal(Object.keys(listed.json.counts).length, 6)

    const filtered = await handleHttp(deps, {
      method: 'GET',
      path: '/connector/jobs',
      query: { kind: 'doc.export', state: 'queued', limit: '5' },
    })
    assert.deepEqual(filtered.json.jobs.map((j) => j.id), [held.json.job.id])

    const bogusState = await handleHttp(deps, { method: 'GET', path: '/connector/jobs', query: { state: 'nope' } })
    assert.equal(bogusState.status, 200, '未知 state 过滤值忽略而非报错')

    const badKind = await handleHttp(deps, { method: 'POST', path: '/connector/jobs', body: { kind: 'bad kind' } })
    assert.equal(badKind.status, 400)
    assert.match(badKind.json.error, /kind/)
    const noBody = await handleHttp(deps, { method: 'POST', path: '/connector/jobs' })
    assert.equal(noBody.status, 400)

    const cancel = await handleHttp(deps, { method: 'POST', path: `/connector/jobs/${firstId}/cancel` })
    assert.equal(cancel.status, 200)
    assert.equal(cancel.json.ok, true)
    assert.equal(service.get(firstId).error, 'cancelled')
    const recancel = await handleHttp(deps, { method: 'POST', path: `/connector/jobs/${firstId}/cancel` })
    assert.equal(recancel.status, 409)
    assert.equal(recancel.json.ok, false)
    const missing = await handleHttp(deps, { method: 'POST', path: '/connector/jobs/job-999/cancel' })
    assert.equal(missing.status, 404)
    const wrongMethod = await handleHttp(deps, { method: 'GET', path: `/connector/jobs/${held.json.job.id}/cancel` })
    assert.equal(wrongMethod.status, 405)

    assert.equal((await handleHttp(deps, { method: 'GET', path: '/connector/nope' })).status, 404)
    assert.equal((await handleHttp(deps, { method: 'GET', path: '' })).status, 404)
    assert.equal((await handleHttp(deps, { method: 'PUT', path: '/connector/jobs' })).status, 405)
    assert.equal((await handleHttp({}, { method: 'GET', path: '/connector/jobs' })).status, 500, 'deps 缺位不裸抛')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('handleHttp 错误零回显：内部异常原文只进 logWarn，回包通用文案', async () => {
  const warned = []
  const exploding = {
    submit: () => {
      throw new Error('EXPLODED internals at /home/user/.dsh/secrets.json')
    },
    list: () => [],
    get: () => undefined,
    cancel: () => true,
    status: () => ({ counts: {} }),
    resolveApproval: () => undefined,
  }
  const res = await handleHttp({ service: exploding, logWarn: (m) => warned.push(m) }, { method: 'POST', path: '/connector/jobs', body: { kind: 'doc.export' } })
  assert.equal(res.status, 500)
  assert.equal(res.json.error, '操作失败，请查看本机日志')
  assert.ok(!JSON.stringify(res).includes('EXPLODED'))
  assert.ok(warned.some((m) => m.includes('EXPLODED')), '细节进本机日志')

  const configErr = {
    submit: () => {
      throw new ConnectorConfigError('connector baseUrl 必须使用 https')
    },
    list: () => [],
    get: () => undefined,
    cancel: () => true,
    status: () => ({ counts: {} }),
    resolveApproval: () => undefined,
  }
  const mapped = await handleHttp({ service: configErr }, { method: 'POST', path: '/connector/jobs', body: { kind: 'x' } })
  assert.equal(mapped.status, 500)
  assert.match(mapped.json.error, /https/)
})

// —— 8. 生命周期 ————————————————————————————————————————

test('start/dispose 幂等，dispose 后不再推进队列', async () => {
  const { service, clock, dir } = await makeService({ leaseTtlMs: 100, tickIntervalMs: 5, maxConcurrentPerKind: 1, maxAttempts: 1 })
  try {
    const j1 = service.submit({ kind: 'doc.export' })
    const j2 = service.submit({ kind: 'doc.export' })
    assert.equal(j1.id, 'job-1')
    assert.equal(j1.state, 'leased')
    assert.equal(j2.state, 'queued')
    service.start()
    service.start()
    clock.advance(100)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(service.get(j1.id).state, 'expired', '定时器已推进租约回收')
    assert.equal(service.get(j2.id).state, 'leased', '定时器已重排排队 Job')
    const heldLease = service.get(j2.id).leaseUntilMs
    service.dispose()
    service.dispose()
    clock.advance(10_000)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(service.get(j2.id).leaseUntilMs, heldLease, 'dispose 后定时器已停')
    assert.equal(service.get(j2.id).state, 'leased')
    assert.equal(service.status().limits.leaseTtlMs, 100)
  } finally {
    service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
