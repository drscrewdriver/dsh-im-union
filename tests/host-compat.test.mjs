import test from 'node:test'
import assert from 'node:assert/strict'
import {
  detectSettingsGeneration,
  installSettingsSectionCompat,
  volatileField,
  isLiveValue,
  unwrapLive,
  settingsNamespaceCompat,
} from '../lib/host-compat/settings-compat.js'
import { detectCapabilities, optionalService } from '../lib/host-compat/services.js'
import { messageSourceFor } from '../lib/host-compat/session-source.js'
import { readFileBytes } from '../lib/host-compat/fs-api.js'

const fakeLogger = () => ({ debug() {}, info() {}, warn() {}, error() {} })

test('设置面代际：gen2 优先 ctx.settings.installSection', () => {
  const ctx = { logger: fakeLogger, settings: { installSection() {} } }
  assert.equal(detectSettingsGeneration(ctx), 'gen2')
})

test('设置面代际：gen1 = 宿主模块级 installSettingsSection', () => {
  const ctx = { logger: fakeLogger }
  assert.equal(detectSettingsGeneration(ctx, { installSettingsSection() {} }), 'gen1')
})

test('设置面代际：两者皆无 = gen3（volatile 声明式）', () => {
  const ctx = { logger: fakeLogger }
  assert.equal(detectSettingsGeneration(ctx, {}), 'gen3')
})

test('installSettingsSectionCompat：gen3 到达即抛（分派错误不静默）', () => {
  const ctx = { logger: fakeLogger }
  assert.throws(() => installSettingsSectionCompat(ctx, 'ns', {}, {}, {}), /分派错误/)
})

test('installSettingsSectionCompat：gen2 走 ctx.settings.installSection', () => {
  let called = 0
  const ctx = { logger: fakeLogger, settings: { installSection: () => void called++ } }
  installSettingsSectionCompat(ctx, 'ns', {}, {}, {})
  assert.equal(called, 1)
})

test('volatileField：无 .volatile() 的旧 schemastery 原样返回', () => {
  const old = { type: 'string' }
  assert.equal(volatileField(old), old)
  let marked = false
  const neu = { type: 'string', volatile() { marked = true; return this } }
  volatileField(neu)
  assert.equal(marked, true)
})

test('isLiveValue/unwrapLive：volatile 稳定引用取快照', () => {
  assert.equal(isLiveValue({ get: () => 7 }), true)
  assert.equal(isLiveValue(7), false)
  assert.equal(unwrapLive({ get: () => 'x' }), 'x')
  assert.equal(unwrapLive('x'), 'x')
})

test('settingsNamespaceCompat：无助手时裸字符串透传', () => {
  assert.equal(settingsNamespaceCompat('im-union', {}), 'im-union')
  assert.equal(settingsNamespaceCompat('im-union', { settingsNamespace: (v) => `ns:${v}` }), 'ns:im-union')
})

test('optionalService：ctx.get 抛错归一 undefined（未注册服务禁直读）', () => {
  const ctx = { logger: fakeLogger, get: () => { throw new Error('not registered') } }
  assert.equal(optionalService(ctx, 'anything'), undefined)
  const ctx2 = { logger: fakeLogger, get: (n) => (n === 'webServer' ? { register() {} } : undefined) }
  assert.deepEqual(Object.keys(optionalService(ctx2, 'webServer')), ['register'])
})

test('detectCapabilities：一次求值冻结并按 ctx 缓存', () => {
  const ctx = {
    logger: fakeLogger,
    get: (name) => {
      if (name === 'connection') return { requestRejection: () => undefined }
      if (name === 'credentials') return { set: () => {}, resolve: () => {} }
      if (name === 'agents') return { create: () => {} }
      if (name === 'sessionController') return { prompt: () => {} }
      return undefined
    },
  }
  const first = detectCapabilities(ctx)
  assert.equal(detectCapabilities(ctx), first, '同一 ctx 必须命中缓存')
  assert.equal(first.sessionBackend, 'native')
  assert.equal(first.hasRequestRejection, true)
  assert.notEqual(first.credentials, undefined)
  assert.equal(Object.isFrozen(first), true)
})

test('messageSourceFor：gen3 用生产者自有署名，老线旧形制', () => {
  assert.deepEqual(messageSourceFor({ settingsGeneration: 'gen3' }), { kind: 'plugin:dsh-im-union' })
  assert.deepEqual(messageSourceFor({ settingsGeneration: 'gen2' }), { kind: 'plugin', plugin: 'dsh-im-union' })
})

test('readFileBytes：readBytes 优先、readAll 回退、双缺显式降级', async () => {
  assert.deepEqual(await readFileBytes({ readBytes: () => new Uint8Array([1]) }, 'p'), new Uint8Array([1]))
  assert.deepEqual(await readFileBytes({ readAll: () => 'hi' }, 'p'), new TextEncoder().encode('hi'))
  await assert.rejects(() => readFileBytes({}, 'p'), /UnsupportedError|缺少/)
})
