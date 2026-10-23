// 惰性会话后端：desktop/Electron 线实证——会话子系统晚于插件 apply 提供，
// apply 期冻结探测必然误判 none 且永不恢复。本面须在子系统上线后自动升级。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionApi, probeSessionBackend } from '../lib/host-compat/session-api.js'

const fakeLogger = () => ({ debug() {}, info() {}, warn() {}, error() {} })

test('惰性后端：apply 时 none，子系统上线后自动升级 native 并粘住', async () => {
  const store = {}
  const ctx = { logger: fakeLogger, get: (name) => store[name] }
  const caps = { sessionBackend: 'none' }
  const api = createSessionApi(ctx, caps)

  // 子系统未提供：none 面，各方法按原降级语义应答。
  assert.equal(api.backend, 'none')
  assert.equal(probeSessionBackend(ctx), 'none')
  await assert.rejects(() => api.prompt('s1', 'hello'), /sessionController\.prompt/)
  assert.equal(await api.steer('s1', 'x'), false)
  assert.deepEqual(await api.listSessions(), [])

  // desktop 时序：会话子系统晚于 apply 提供。
  let seen
  store.agents = { create() { return { sessionId: 'session-real' } } }
  store.sessionController = {
    prompt(request) { seen = request },
    follow(_sessionId, onEvent) {
      onEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
      return () => {}
    },
  }

  assert.equal(api.backend, 'native', 'backend 访问即重探并升级')
  assert.equal(probeSessionBackend(ctx), 'native')
  assert.match(api.backend, /native/)

  // 升级后方法委托原生面（request 对象形）。
  await api.prompt('s1', 'hello')
  assert.equal(seen.sessionId, 's1')
  assert.equal(seen.mode, 'queue')

  // 粘住不回退：即使某次软读暂时拿不到（严格宿主抖动），已升级面保持 native。
  const backendAfter = api.backend
  assert.equal(backendAfter, 'native')
})

test('原生分支：apply 时已 native 则直接构建（web 线原路径不回归）', async () => {
  const store = {
    agents: { create() { return { sessionId: 'session-x' } } },
    sessionController: { prompt() {}, follow() { return () => {} } },
    agentPresets: { list() { return [{ id: 'standard', name: '标准模式' }] } },
  }
  const ctx = { logger: fakeLogger, get: (name) => store[name] }
  const api = createSessionApi(ctx, { sessionBackend: 'native' })
  assert.equal(api.backend, 'native')
  assert.deepEqual(await api.presetsList(), [{ id: 'standard', name: '标准模式' }])
})

test('权限预设：目录读 names+optionOf；应用走 sessions.get + permissionPresets.set；create 面自落', async () => {
  const setCalls = []
  const store = {
    agents: { create() { return { sessionId: 'session-x' } } },
    sessionController: { prompt() {}, follow() { return () => {} } },
    permissionPresets: {
      names: ['standard', 'yolo'],
      defaultPreset: 'standard',
      optionOf(name) {
        return { value: name, name: name === 'standard' ? '标准' : '全自动', description: name + '-desc' }
      },
      set(session, name) {
        if (name !== 'standard' && name !== 'yolo') throw new Error(`未知权限预设: ${name}`)
        setCalls.push([session.id, name])
      },
    },
    sessions: { get: (id) => (id === 'nope' ? undefined : { id }) },
  }
  const ctx = { logger: fakeLogger, get: (name) => store[name] }
  const api = createSessionApi(ctx, { sessionBackend: 'native' })

  assert.deepEqual(await api.permissionCatalog(), {
    options: [
      { id: 'standard', name: '标准', description: 'standard-desc' },
      { id: 'yolo', name: '全自动', description: 'yolo-desc' },
    ],
    default: 'standard',
  })
  assert.deepEqual(await api.applyPermission('s-live', 'yolo'), { ok: true })
  assert.ok(setCalls.some(([id, name]) => id === 's-live' && name === 'yolo'))
  assert.equal((await api.applyPermission('nope', 'yolo')).ok, false, '会话不在册如实回 false')
  const bad = await api.applyPermission('s-live', 'ghost')
  assert.equal(bad.ok, false)
  assert.match(bad.message, /ghost/)

  // create 面自落：createSession 带 permission → 拿到 id 后应用一次。
  await api.createSession({ permission: 'standard' })
  assert.ok(setCalls.some(([id, name]) => id === 'session-x' && name === 'standard'))
})

test('权限预设：服务缺位/后端未就绪时如实降级（不伪装成功）', async () => {
  const store = {
    agents: { create() { return { sessionId: 'session-x' } } },
    sessionController: { prompt() {}, follow() { return () => {} } },
  }
  const ctx = { logger: fakeLogger, get: (name) => store[name] }
  const api = createSessionApi(ctx, { sessionBackend: 'native' })
  assert.equal(await api.permissionCatalog(), undefined)
  assert.equal((await api.applyPermission('s1', 'standard')).ok, false)

  const lazy = createSessionApi({ logger: fakeLogger, get: () => undefined }, { sessionBackend: 'none' })
  assert.equal(await lazy.permissionCatalog(), undefined)
  assert.equal((await lazy.applyPermission('s1', 'standard')).ok, false)
})

test('0.2.x 形态：prompt 收 (request, signal)；follow 走流帧泵（event 投喂，snapshot 忽略）', async () => {
  const seen = {}
  async function* frames() {
    yield { type: 'event', event: { type: 'step/start', data: { turn: 1, step: 1 } } }
    yield { type: 'snapshot', records: [] }
    yield { type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } }
    yield { type: 'assistant-stream', frame: {} }
  }
  const store = {
    agents: { create() { return { sessionId: 'session-x' } } },
    sessionController: {
      prompt(request, signal) {
        seen.prompt = { request, signalOk: signal instanceof AbortSignal && !signal.aborted }
        return Promise.resolve()
      },
      follow(request, signal) {
        seen.follow = { request, signalOk: signal instanceof AbortSignal }
        return frames()
      },
    },
  }
  const ctx = { logger: fakeLogger, get: (name) => store[name] }
  const api = createSessionApi(ctx, { sessionBackend: 'native' })

  await api.prompt('s1', 'hello')
  assert.equal(seen.prompt.request.sessionId, 's1')
  assert.equal(seen.prompt.signalOk, true, 'prompt 必须带未中止 signal（宿主进门即 throwIfAborted）')
  assert.ok(typeof seen.prompt.request.clientTimeZone === 'string')

  const events = []
  const unsub = api.follow('s1', (e) => events.push(e))
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(events, [
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ])
  assert.equal(seen.follow.request.address.kind, 'session')
  assert.equal(seen.follow.request.address.sessionId, 's1')
  assert.equal(seen.follow.signalOk, true)
  assert.equal(typeof unsub, 'function')
})
