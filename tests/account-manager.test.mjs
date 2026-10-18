// T1.8 账号管理：文件态 CRUD / secret 单向入库零回显 / 暂停恢复 / 多账号独立性。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountManager, AccountValidationError } from '../lib/engine/account-manager.js'
import { CHANNEL_META } from '../lib/channels/meta.js'
import { credentialRef } from '../lib/credentials/vault.js'

function fakeVault() {
  const store = new Map()
  return {
    kind: 'file',
    store,
    async set(ref, value) {
      store.set(ref, value)
    },
    async resolve(ref) {
      return store.get(ref)
    },
    async describe() {
      return [...store.keys()].map((ref) => ({ ref, configured: true }))
    },
    async unset(ref) {
      store.delete(ref)
    },
  }
}

function fakeAdapter(channel = 'telegram') {
  const state = { connected: false, events: [], diagnoseCalls: 0 }
  return {
    id: channel,
    label: channel,
    caps: { maxMessageLength: 100 },
    state,
    get connected() {
      return state.connected
    },
    async connect() {
      state.events.push('connect')
      state.connected = true
    },
    async disconnect() {
      state.events.push('disconnect')
      state.connected = false
    },
    onMessage() {
      return () => {}
    },
    async reply() {
      return { uncertain: false }
    },
    async diagnose() {
      state.diagnoseCalls += 1
      return [{ name: 'token-valid', status: 'passed' }]
    },
  }
}

function fakeEngine() {
  return {
    registered: [],
    unregistered: [],
    registerAccount(adapter, accountId, policy) {
      this.registered.push({ adapter, accountId, policy })
    },
    unregister(accountId) {
      this.unregistered.push(accountId)
    },
  }
}

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'imu-accounts-'))
  return join(dir, 'accounts.json')
}

function makeManager(extra = {}) {
  const vault = fakeVault()
  const engine = fakeEngine()
  const adapters = []
  const warns = []
  const manager = new AccountManager({
    stateFile: tempFile(),
    vault,
    engine,
    logWarn: (m) => warns.push(String(m)),
    adapterFactory: (record) => {
      const adapter = fakeAdapter(record.channel)
      adapters.push(adapter)
      return adapter
    },
    ...extra,
  })
  return { manager, vault, engine, adapters, warns }
}

const rec = (over = {}) => ({ accountId: 'a1', channel: 'telegram', ...over })

test('策略字段按 type 归位：notifyOnly 渠道 upsert 剥除白名单/群开关，setAllowlist 拒写', async () => {
  const { manager } = makeManager()
  // 用真实已实现的纯出站渠道（探针假渠道过不了 hasChannel 实装闸）；paused 免建适配器。
  await manager.upsert({ accountId: 'dn1', channel: 'dingtalk-notify', paused: true, dmAllowlist: ['u1'], groupEnabled: true })
  const stored = manager.list().find((r) => r.accountId === 'dn1')
  assert.equal(stored.dmAllowlist, undefined, '存储态已剥除 dmAllowlist')
  assert.equal(stored.groupEnabled, undefined, '存储态已剥除 groupEnabled')
  const pub = await manager.listPublic()
  const row = pub.find((r) => r.accountId === 'dn1')
  assert.deepEqual(row.dmAllowlist, [], '回显视图不带策略字段')
  assert.equal(row.groupEnabled, undefined, '回显视图 groupEnabled 缺席')
  await assert.rejects(() => manager.setAllowlist('dn1', ['u2']), /纯出站通知类/)
})

test('upsert：secret 单向入库 + 文件态持久化 + 非暂停即连接', async () => {
  const { manager, vault, engine, adapters } = makeManager()
  await manager.upsert(rec(), { botToken: 'T0KKN' })
  assert.equal(vault.store.get(credentialRef('telegram', 'a1.botToken')), 'T0KKN')
  const persisted = JSON.parse(readFileSync(manager.deps.stateFile, 'utf8'))
  assert.equal(persisted[0].accountId, 'a1')
  assert.equal(adapters.length, 1)
  assert.equal(adapters[0].state.connected, true)
  assert.equal(engine.registered[0].accountId, 'a1')
})

test('listPublic：零 secret 值只报 configured；alias/paused 透传', async () => {
  const { manager } = makeManager()
  await manager.upsert(rec({ alias: '主号' }), { botToken: 'SECRET-VALUE' })
  const rows = await manager.listPublic()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].alias, '主号')
  assert.equal(rows[0].secretFields[0].key, 'botToken')
  assert.equal(rows[0].secretFields[0].configured, true)
  assert.ok(!JSON.stringify(rows).includes('SECRET-VALUE'), '任何视图不得携带 secret 值')
})

test('校验：accountId 形态/未知渠道/未实现渠道三路拒', async () => {
  const { manager } = makeManager()
  await assert.rejects(manager.upsert(rec({ accountId: 'bad id!' })), AccountValidationError)
  await assert.rejects(manager.upsert(rec({ channel: 'myspace' })), /未知渠道/)
  // 未实现样本动态构造（meta 登记但 registry 无工厂）：P1/P2 渠道逐个落地后
  // 自然样本会耗尽（slack 即最后一个是实证），静态写死渠道名必漂移。
  CHANNEL_META.imaginary = { id: 'imaginary', label: { zh: '假想', en: 'Imaginary' }, bind: 'credentials', fields: [] }
  try {
    await assert.rejects(manager.upsert(rec({ channel: 'imaginary' })), /尚未实现/)
  } finally {
    delete CHANNEL_META.imaginary
  }
})

test('重复 upsert：旧适配器先断后重建（重启生效）', async () => {
  const { manager, engine, adapters } = makeManager()
  await manager.upsert(rec(), { botToken: 'x' })
  await manager.upsert(rec({ alias: '改名' }), {})
  assert.deepEqual(adapters[0].state.events, ['connect', 'disconnect'])
  assert.equal(adapters[1].state.connected, true)
  assert.equal(engine.unregistered[0], 'a1')
  const rows = await manager.listPublic()
  assert.equal(rows[0].alias, '改名')
})

test('remove：断连 + secret 清库 + 文件移除', async () => {
  const { manager, vault, engine } = makeManager()
  await manager.upsert(rec(), { botToken: 'x' })
  const removed = await manager.remove('a1')
  assert.equal(removed, true)
  assert.equal(vault.store.size, 0)
  assert.equal(engine.unregistered.includes('a1'), true)
  assert.deepEqual(manager.list(), [])
  assert.equal(await manager.remove('nope'), false)
})

test('setPaused：暂停断连、恢复重连；startAll 跳过暂停号', async () => {
  const { manager, adapters } = makeManager()
  await manager.upsert(rec(), { botToken: 'x' })
  await manager.upsert(rec({ accountId: 'a2', paused: true }))
  assert.equal(adapters.length, 1, 'paused 账号启动时不建适配器')
  assert.equal(await manager.setPaused('a1', true), true)
  assert.deepEqual(adapters[0].state.events, ['connect', 'disconnect'])
  assert.equal(await manager.setPaused('a1', false), true)
  assert.equal(adapters[1].state.connected, true)
  assert.equal(await manager.setPaused('ghost', true), false)
  await manager.startAll()
  assert.equal(adapters.length, 2, 'startAll 不重复建已在位/暂停号')
})

test('setAllowlist：整值替换并重注引擎策略（D6 数据源）', async () => {
  const { manager, engine } = makeManager()
  await manager.upsert(rec({ dmAllowlist: ['u1'] }), { botToken: 'x' })
  const ok = await manager.setAllowlist('a1', ['u2', 'u3'])
  assert.equal(ok, true)
  const last = engine.registered.at(-1)
  assert.deepEqual([...last.policy.dmAllowlist], ['u2', 'u3'])
  assert.deepEqual(manager.list()[0].dmAllowlist, ['u2', 'u3'])
})

test('check：在位账号走诊断；无适配器临时构建；不存在抛校验错', async () => {
  const { manager, adapters } = makeManager()
  await manager.upsert(rec(), { botToken: 'x' })
  const checks = await manager.check('a1')
  assert.deepEqual(checks, [{ name: 'token-valid', status: 'passed' }])
  await manager.setPaused('a1', true)
  const checks2 = await manager.check('a1')
  assert.equal(checks2.length, 1, '暂停号检查临时构建诊断，不保持连接')
  assert.equal(adapters.length, 2)
  await assert.rejects(manager.check('ghost'), AccountValidationError)
})

test('文件态重载：新实例读回既有账号（重启不丢配置）', async () => {
  const first = makeManager()
  await first.manager.upsert(rec({ alias: '持久' }), { botToken: 'x' })
  const stateFile = first.manager.deps.stateFile
  const vault2 = fakeVault()
  vault2.store.set(credentialRef('telegram', 'a1.botToken'), 'x')
  const second = new AccountManager({
    stateFile,
    vault: vault2,
    engine: fakeEngine(),
    logWarn: () => {},
    adapterFactory: () => fakeAdapter(),
  })
  assert.equal(second.list()[0].alias, '持久')
  const rows = await second.listPublic()
  assert.equal(rows[0].secretFields[0].configured, true)
})
