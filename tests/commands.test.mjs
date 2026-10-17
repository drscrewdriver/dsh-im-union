// T1.1 命令面板：解析/分派/降级文案 + 窄腰 request-object/位置参形态回退。
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand, isCommandName, runCommand, chatOverrideKey } from '../lib/engine/commands.js'
import { ChatRouter } from '../lib/engine/router.js'
import { createSessionApi } from '../lib/host-compat/session-api.js'
import { addressOf } from '../lib/engine/gateway.js'

function fakeDeps(overrides = {}) {
  const calls = []
  const o = overrides
  const sessionApi = {
    backend: o.backend ?? 'native',
    async createSession(opts) { calls.push(['createSession', opts]); return { id: 'host1' } },
    async prompt(sid, input) { calls.push(['prompt', sid, input]) },
    async steer(sid, text) { calls.push(['steer', sid, text]); return o.steerOk !== false },
    follow() { return () => {} },
    async cancel(sid) {
      calls.push(['cancel', sid])
      if (o.cancelUnsupported) {
        const err = new Error('缺 sessionController')
        err.name = 'UnsupportedError'
        throw err
      }
    },
    async listSessions() { return o.sessions ?? [] },
    async selectModel(sid, sel) {
      calls.push(['selectModel', sid, sel])
      if (o.selectModelFails) throw new Error(' ValidationError: unknown model')
    },
    async modelCatalog() { return o.catalog },
    async presetsList() { return o.presets ?? [] },
    async presetSelect(name) { return o.presetResult ?? { ok: true } },
  }
  const deps = {
    sessionApi,
    router: new ChatRouter(),
    caps: { settingsGeneration: 'gen3', sessionBackend: o.backend ?? 'native', credentials: undefined },
    selections: new Map(),
    workspaceOverrides: new Map(),
    vaultKind: o.vaultKind ?? 'file',
    logWarn: () => {},
  }
  return { deps, calls }
}

const dm = addressOf('telegram', 'dm', 'c1')

// —— 解析 ——————————————————————————————————————————

test('parseCommand：词+参数解析，大小写归一，非命令文本不触发', () => {
  assert.deepEqual(parseCommand('/help'), { name: 'help', arg: '' })
  assert.deepEqual(parseCommand('/MODEL gpt-4o '), { name: 'model', arg: 'gpt-4o' })
  assert.deepEqual(parseCommand('/steer 停一下，先看错误'), { name: 'steer', arg: '停一下，先看错误' })
  assert.equal(parseCommand('hello'), undefined)
  assert.equal(parseCommand(''), undefined)
})

test('isCommandName：路径样文本不误入命令表', () => {
  assert.equal(isCommandName('help'), true)
  assert.equal(isCommandName('Users'), false, '/Users/foo 粘贴路径不是命令')
  assert.equal(isCommandName('workspace'), true)
})

// —— 分派与降级 ——————————————————————————————————————————

test('/help 与 /menu 同表且覆盖全部登记命令', async () => {
  const { deps } = fakeDeps()
  const help = await runCommand(deps, dm, 'imu:telegram:dm:c1', parseCommand('/help'))
  assert.match(help, /\/steer/)
  assert.match(help, /\/reasoning/)
  const menu = await runCommand(deps, dm, 's', parseCommand('/menu'))
  assert.equal(menu, help)
})

test('/status 展示代际/后端/凭据载体/渠道', async () => {
  const { deps } = fakeDeps({ backend: 'none', vaultKind: 'service' })
  const text = await runCommand(deps, dm, 'imu:telegram:dm:c1', parseCommand('/status'))
  assert.match(text, /gen3/)
  assert.match(text, /会话后端: none/)
  assert.match(text, /宿主凭据库/)
  assert.match(text, /telegram/)
})

test('/stop：可停面调用 cancel；UnsupportedError 走降级文案', async () => {
  const a = fakeDeps()
  const text = await runCommand(a.deps, dm, 'sess-9', parseCommand('/stop'))
  assert.match(text, /已请求停止/)
  assert.deepEqual(a.calls[0], ['cancel', 'sess-9'])

  const b = fakeDeps({ cancelUnsupported: true })
  assert.match(await runCommand(b.deps, dm, 's', parseCommand('/stop')), /不支持会话停止/)
})

test('/steer：注入成功与不可用两文案；空参给用法', async () => {
  const a = fakeDeps()
  assert.match(await runCommand(a.deps, dm, 's', parseCommand('/steer 先看报错')), /插话已注入/)
  const b = fakeDeps({ steerOk: false })
  assert.match(await runCommand(b.deps, dm, 's', parseCommand('/steer x')), /不支持插话/)
  assert.match(await runCommand(a.deps, dm, 's', parseCommand('/steer')), /用法/)
})

test('/models：目录渲染含默认/通道/失败位；无面降级', async () => {
  const catalog = {
    default: { provider: 'p1', model: 'm-main', reasoningEffort: 'high' },
    groups: [{ id: 'p1', name: 'Provider1', models: [{ id: 'm-main' }, { id: 'm-mini' }] }],
    failures: [{ id: 'p2', name: 'Provider2', message: 'key missing' }],
    routableProviders: ['p1'],
  }
  const text = await runCommand(fakeDeps({ catalog }).deps, dm, 's', parseCommand('/models'))
  assert.match(text, /默认: m-main（high）/)
  assert.match(text, /Provider1: m-main, m-mini/)
  assert.match(text, /Provider2 目录加载失败/)
  const none = await runCommand(fakeDeps({ catalog: undefined }).deps, dm, 's', parseCommand('/models'))
  assert.match(none, /未暴露模型目录面/)
})

test('/model：成功记账 selections（chatKey 统一）；provider 前缀解析；失败回文案', async () => {
  const a = fakeDeps()
  assert.match(await runCommand(a.deps, dm, 'sess', parseCommand('/model m-mini')), /已切换模型：m-mini/)
  assert.deepEqual(a.deps.selections.get('imu:telegram:dm:c1'), { model: 'm-mini' })
  const b = fakeDeps()
  await runCommand(b.deps, dm, 'sess', parseCommand('/model provX/m-main'))
  assert.deepEqual(b.deps.selections.get('imu:telegram:dm:c1'), { provider: 'provX', model: 'm-main' })
  assert.deepEqual(b.calls.at(-1)[2], { provider: 'provX', model: 'm-main' })
  const c = fakeDeps({ selectModelFails: true })
  assert.match(await runCommand(c.deps, dm, 'sess', parseCommand('/model bad')), /模型切换失败：bad/)
})

test('/reasoning：有当前模型直接合并；无则取 catalog.default；两缺给引导', async () => {
  const a = fakeDeps()
  a.deps.selections.set('imu:telegram:dm:c1', { provider: 'p1', model: 'm-main' })
  const callsA = []
  a.deps.sessionApi.selectModel = async (sid, sel) => { callsA.push(sel) }
  assert.match(await runCommand(a.deps, dm, 's1', parseCommand('/reasoning low')), /已设置思考强度：low（模型 m-main）/)
  assert.deepEqual(callsA[0], { model: 'm-main', provider: 'p1', reasoningEffort: 'low' })

  const b = fakeDeps({ catalog: { default: { provider: 'p9', model: 'm-def' } } })
  const callsB = []
  b.deps.sessionApi.selectModel = async (sid, sel) => { callsB.push(sel) }
  await runCommand(b.deps, dm, 's2', parseCommand('/reasoning high'))
  assert.deepEqual(callsB[0], { model: 'm-def', provider: 'p9', reasoningEffort: 'high' })

  const c = fakeDeps({ catalog: undefined })
  assert.match(await runCommand(c.deps, dm, 's3', parseCommand('/reasoning x')), /先 \/\S*model <id>/)
})

test('/presets 与 /preset：有面列名，无预设/无面降级，select 结果透传', async () => {
  const a = fakeDeps({ presets: [{ id: 'deep', name: '深度' }, { id: 'fast', name: '快速' }] })
  const text = await runCommand(a.deps, dm, 's', parseCommand('/presets'))
  assert.match(text, /1\. 深度/)
  assert.match(await runCommand(a.deps, dm, 's', parseCommand('/preset 快速')), /已切换预设：快速/)
  const b = fakeDeps({ presetResult: { ok: false, message: '预设不存在：zz' } })
  assert.match(await runCommand(b.deps, dm, 's', parseCommand('/preset zz')), /预设不存在：zz/)
})

test('/sessions 渲染带当前/运行标记', async () => {
  const sessions = [
    { id: 'host-a-0001', running: true },
    { id: 'host-b-0002', title: '修 bug', running: false },
  ]
  const { deps } = fakeDeps({ sessions })
  const text = await runCommand(deps, dm, 'host-a-0001', parseCommand('/sessions'))
  assert.match(text, /host-a-0001/)
  assert.match(text, /←当前/)
  assert.match(text, /\[运行中]/)
  assert.match(text, /修 bug/)
})

test('/session：序号绑定 / id 片段绑定 / 未命中提示', async () => {
  const sessions = [{ id: 'alpha-1' }, { id: 'beta-2' }]
  const a = fakeDeps({ sessions })
  assert.match(await runCommand(a.deps, dm, 'x', parseCommand('/session 2')), /beta-2/)
  assert.equal(a.deps.router.resolve(dm).sessionId, 'beta-2', '绑定即时生效于路由')
  const b = fakeDeps({ sessions })
  assert.match(await runCommand(b.deps, dm, 'x', parseCommand('/session alp')), /alpha-1/)
  const c = fakeDeps({ sessions })
  assert.match(await runCommand(c.deps, dm, 'x', parseCommand('/session zzz')), /未找到匹配会话/)
})

test('/workspaces 聚合 cwd；/workspace 设定与清除覆盖', async () => {
  const sessions = [{ id: 's1', cwd: 'E:/proj-a' }, { id: 's2', cwd: 'E:/proj-a' }, { id: 's3', cwd: 'E:/proj-b' }]
  const a = fakeDeps({ sessions })
  const text = await runCommand(a.deps, dm, 'x', parseCommand('/workspaces'))
  assert.match(text, /1\. E:\/proj-a（2 个会话）/)
  assert.match(text, /E:\/proj-b（1 个会话）/)

  const b = fakeDeps({ sessions })
  assert.match(await runCommand(b.deps, dm, 'x', parseCommand('/workspace E:/proj-b')), /新会话将使用工作区/)
  assert.equal(b.deps.workspaceOverrides.get(chatOverrideKey(dm)), 'E:/proj-b')
  assert.match(await runCommand(b.deps, dm, 'x', parseCommand('/workspace')), /当前默认工作区：E:\/proj-b/)
  assert.match(await runCommand(b.deps, dm, 'x', parseCommand('/workspace -')), /已清除/)
  assert.equal(b.deps.workspaceOverrides.has(chatOverrideKey(dm)), false)
})

// —— 窄腰：request-object 主形 + 位置参回退 ——————————————————————————————————————————

function ctxWith(services) {
  return {
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    get: (name) => {
      if (services[name] === undefined) throw new Error(`service ${name} not registered`)
      return services[name]
    },
  }
}
const nativeCaps = { sessionBackend: 'native', agentPresets: undefined }

test('prompt：宿主收 request 对象（mode/content/requestId）', async () => {
  const seen = []
  const sc = {
    prompt: async (a, b) => {
      if (typeof a !== 'object' || a === null || !Array.isArray(a.content) || a.mode !== 'queue') {
        throw new Error('expected request object')
      }
      seen.push(a)
    },
  }
  const api = createSessionApi(ctxWith({ agents: { create: async () => ({ sessionId: 'z' }) }, sessionController: sc }), nativeCaps)
  await api.prompt('s1', 'hello')
  assert.equal(seen[0].sessionId, 's1')
  assert.deepEqual(seen[0].content, [{ type: 'text', text: 'hello' }])
  assert.match(seen[0].requestId, /^imu-/)
})

test('prompt：老线位置参宿主 → request 形失败后自动回退', async () => {
  const seen = []
  const sc = {
    prompt: async (a, b) => {
      if (typeof a !== 'string') throw new Error('expected positional args')
      seen.push([a, b])
    },
  }
  const api = createSessionApi(ctxWith({ agents: { create: async () => ({ sessionId: 'z' }) }, sessionController: sc }), nativeCaps)
  await api.prompt('s2', 'hi')
  assert.deepEqual(seen, [['s2', 'hi']])
})

test('steer：mode=steer 成功 true；宿主拒绝 false 不伪装', async () => {
  let lastMode
  const sc = {
    prompt: async (a) => {
      if (typeof a !== 'object') throw new Error('bad shape')
      lastMode = a.mode
      if (a.mode === 'steer') throw new Error('steer not allowed while idle')
    },
  }
  const api = createSessionApi(ctxWith({ agents: { create: async () => ({ sessionId: 'z' }) }, sessionController: sc }), nativeCaps)
  assert.equal(await api.steer('s3', '插话'), false)
  assert.equal(lastMode, 'steer')
})

test('cancel/selectModel：request 主形 + 位置参回退', async () => {
  const calls = []
  const sc = {
    cancel: async (a) => {
      if (typeof a !== 'object') throw new Error('want object')
      calls.push(['cancel', a.sessionId])
    },
    selectModel: async (a, b) => {
      if (typeof a === 'object') {
        calls.push(['model', a.sessionId, a.model, a.reasoningEffort])
        return
      }
      throw new Error('want object')
    },
  }
  const api = createSessionApi(ctxWith({ agents: { create: async () => ({ sessionId: 'z' }) }, sessionController: sc }), nativeCaps)
  await api.cancel('s4')
  await api.selectModel('s4', { model: 'm', reasoningEffort: 'low' })
  assert.deepEqual(calls, [['cancel', 's4'], ['model', 's4', 'm', 'low']])
})

test('modelCatalog/presetsList：缺面静默降级为 undefined/空表', async () => {
  const api = createSessionApi(ctxWith({ agents: { create: async () => ({ sessionId: 'z' }) }, sessionController: {} }), nativeCaps)
  assert.equal(await api.modelCatalog(), undefined)
  assert.deepEqual(await api.presetsList(), [])
  const r = await api.presetSelect('x')
  assert.equal(r.ok, false)
})

test('presets：agentPresets 服务在位时 list/select 归一形状', async () => {
  const presets = {
    list: async () => ({ items: [{ id: 'a', name: 'A' }, { name: 'B-only' }, 'junk'] }),
    select: async (req) => {
      if (typeof req !== 'object') throw new Error('want object')
      return req
    },
  }
  const api = createSessionApi(
    ctxWith({ agents: { create: async () => ({ sessionId: 'z' }) }, sessionController: {} }),
    { sessionBackend: 'native', agentPresets: presets },
  )
  assert.deepEqual(await api.presetsList(), [{ id: 'a', name: 'A' }, { id: 'B-only', name: 'B-only' }])
  assert.deepEqual(await api.presetSelect('a'), { ok: true })
})
