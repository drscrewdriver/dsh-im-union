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
    // Phase 7/8：CommandDeps 新增必填面，缺位会 TypeError（旧测试不传=兼容空表）。
    modelWhitelist: o.modelWhitelist ?? [],
    goals: new Map(),
    ...(o.relay !== undefined ? { relay: o.relay } : {}),
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
  const help = await runCommand(deps, dm, 'im:union:telegram:dm:c1', parseCommand('/help'))
  assert.match(help, /\/steer/)
  assert.match(help, /\/reasoning/)
  const menu = await runCommand(deps, dm, 's', parseCommand('/menu'))
  assert.equal(menu, help)
})

test('/status 展示代际/后端/凭据载体/渠道', async () => {
  const { deps } = fakeDeps({ backend: 'none', vaultKind: 'service' })
  const text = await runCommand(deps, dm, 'im:union:telegram:dm:c1', parseCommand('/status'))
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
  assert.deepEqual(a.deps.selections.get('im:union:telegram:dm:c1'), { model: 'm-mini' })
  const b = fakeDeps()
  await runCommand(b.deps, dm, 'sess', parseCommand('/model provX/m-main'))
  assert.deepEqual(b.deps.selections.get('im:union:telegram:dm:c1'), { provider: 'provX', model: 'm-main' })
  assert.deepEqual(b.calls.at(-1)[2], { provider: 'provX', model: 'm-main' })
  const c = fakeDeps({ selectModelFails: true })
  assert.match(await runCommand(c.deps, dm, 'sess', parseCommand('/model bad')), /模型切换失败：bad/)
})

test('/reasoning：有当前模型直接合并；无则取 catalog.default；两缺给引导', async () => {
  const a = fakeDeps()
  a.deps.selections.set('im:union:telegram:dm:c1', { provider: 'p1', model: 'm-main' })
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

test('/sessions 渲染带当前/运行标记（默认口径按 im:union: 前缀过滤）', async () => {
  const sessions = [
    { id: 'im:union:telegram:dm:c1', running: true },
    { id: 'im:union:telegram:dm:c2', title: '修 bug', running: false },
    { id: 'host-b-0002', title: '网页会话', running: false },
  ]
  const { deps } = fakeDeps({ sessions })
  const text = await runCommand(deps, dm, 'im:union:telegram:dm:c1', parseCommand('/sessions'))
  assert.match(text, /^1\. c1 ←当前\[运行中\]$/m)
  assert.match(text, /←当前/)
  assert.match(text, /\[运行中]/)
  assert.match(text, /修 bug/)
  assert.doesNotMatch(text, /host-b-0002/, '默认口径不列宿主普通会话')
})

test('/session：序号绑定 / id 片段绑定 / 未命中提示', async () => {
  const sessions = [{ id: 'im:union:telegram:dm:alpha-1' }, { id: 'im:union:telegram:dm:beta-2' }]
  const a = fakeDeps({ sessions })
  assert.match(await runCommand(a.deps, dm, 'x', parseCommand('/session 2')), /beta-2/)
  assert.equal(a.deps.router.resolve(dm).sessionId, 'im:union:telegram:dm:beta-2', '绑定即时生效于路由')
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

// —— /new 轮换 + /sessions 过滤（0.4.0）——————————————————

test('/new：busy 拒绝；成功轮换回执；失败保旧绑定', async () => {
  const rotated = 'im:union:telegram:dm:c1:1729600000000'
  const busy = fakeDeps()
  busy.deps.rotateSession = async () => { throw new Error('不应被调用') }
  busy.deps.isChatBusy = () => true
  assert.match(await runCommand(busy.deps, dm, 'sess', parseCommand('/new')), /\/stop/, '运行中先 /stop')

  const ok = fakeDeps()
  ok.deps.rotateSession = async () => rotated
  const okText = await runCommand(ok.deps, dm, 'sess', parseCommand('/new'))
  assert.match(okText, /已开启新会话/)
  assert.match(okText, /旧会话已保留/)

  const fail = fakeDeps()
  fail.deps.rotateSession = async () => { throw new Error('workspace 目录不存在') }
  const failText = await runCommand(fail.deps, dm, 'sess', parseCommand('/new'))
  assert.match(failText, /新会话创建失败/)
  assert.match(failText, /原会话保持可用/)
  assert.match(failText, /workspace 目录不存在/)
})

test('/new 无轮换面：降级旧行为（仅解绑）', async () => {
  const { deps } = fakeDeps()
  deps.router.bind(dm, 'old-session')
  const text = await runCommand(deps, dm, 'old-session', parseCommand('/new'))
  assert.match(text, /已解除会话绑定/)
  assert.equal(deps.router.resolve(dm).sessionId, 'im:union:telegram:dm:c1')
})

test('/sessions：默认只列 im:union: 会话 + 标注；all 展开宿主全量', async () => {
  const sessions = [
    { id: 'im:union:telegram:dm:c1', title: '当前', running: false },
    { id: 'im:union:telegram:dm:c9', title: '轮换旧', running: false },
    { id: 'host-web-1', title: '网页会话', running: true },
  ]
  const a = fakeDeps({ sessions })
  // c9 标记为历史（被轮下的旧会话），c1 为当前绑定
  a.deps.router.rotate(dm, 'im:union:telegram:dm:c1', 'im:union:telegram:dm:c9')
  const text = await runCommand(a.deps, dm, 'im:union:telegram:dm:c1', parseCommand('/sessions'))
  assert.match(text, /本插件会话/)
  assert.match(text, /←当前/)
  assert.match(text, /\[已解绑\]/)
  assert.doesNotMatch(text, /host-web-1/, '默认不列宿主普通会话')
  assert.doesNotMatch(text, /\[运行中\]/, '运行中的网页会话不在默认口径')

  const b = fakeDeps({ sessions })
  const allText = await runCommand(b.deps, dm, 'im:union:telegram:dm:c1', parseCommand('/sessions all'))
  assert.match(allText, /宿主会话/)
  assert.match(allText, /host-web-1/)
  assert.match(allText, /\[运行中\]/)
})

test('/sessions 分页：页码超界收末页、序号接续；缓存供 /session 序号命中', async () => {
  const sessions = Array.from({ length: 12 }, (_, i) => ({ id: `im:union:telegram:dm:c${i}`, title: `会话${i}` }))
  const a = fakeDeps({ sessions })
  a.deps.sessionChoices = new Map()
  const p1 = await runCommand(a.deps, dm, 'none', parseCommand('/sessions'))
  assert.match(p1, /第 1\/2 页/)
  assert.match(p1, /^10\. /m, '第一页 1-10')
  const p2 = await runCommand(a.deps, dm, 'none', parseCommand('/sessions 99'))
  assert.match(p2, /第 2\/2 页/, '超界收末页')
  assert.match(p2, /^12\. /m, '第二页序号接续到 12')
  const bound = await runCommand(a.deps, dm, 'none', parseCommand('/session 12'))
  assert.match(bound, /c11/, '/session 12 命中缓存列表（所见即所绑）')
  assert.equal(a.deps.router.resolve(dm).sessionId, 'im:union:telegram:dm:c11')
})

test('/session 序号：缓存过期回退现算（默认口径），id 片段不走缓存', async () => {
  const sessions = [{ id: 'im:union:telegram:dm:live', title: '新' }]
  const a = fakeDeps({ sessions })
  a.deps.sessionChoices = new Map([['im:union:telegram:dm:c1', { ids: ['im:union:telegram:dm:stale'], at: Date.now() - 16 * 60 * 1000 }]])
  const text = await runCommand(a.deps, dm, 'none', parseCommand('/session 1'))
  assert.match(text, /live/, '过期缓存不取用，回退现算默认口径')
  const b = fakeDeps({ sessions })
  b.deps.sessionChoices = new Map([['im:union:telegram:dm:c1', { ids: ['im:union:telegram:dm:stale'], at: Date.now() }]])
  const frag = await runCommand(b.deps, dm, 'none', parseCommand('/session live'))
  assert.match(frag, /live/, 'id 片段路径不受缓存影响')
})

// —— Phase 7/8：标题优先、白名单、relay 抄送面 ——————————————

test('/sessions 标题优先：有 title 行首列标题，无 title 回退 chatId 段而非裸 id', async () => {
  const sessions = [
    { id: 'im:union:telegram:dm:8823114477', title: '月度报表' },
    { id: 'im:union:feishu:dm:oc_zh', running: true },
  ]
  const { deps } = fakeDeps({ sessions })
  const text = await runCommand(deps, dm, 'im:union:telegram:dm:8823114477', parseCommand('/sessions'))
  assert.match(text, /^1\. 月度报表 ←当前$/m, '标题取代 id 尾段')
  assert.doesNotMatch(text, /^1\. 8823114477/m, '不再裸显数字 chatId 尾段')
  assert.match(text, /^2\. oc_zh \[运行中\]$/m, '无标题回退 chatId 段')
  assert.match(text, /^im:union:telegram:dm:8823114477$/m, '标题行下仍附全 id（便于 /session 片段绑定）')
})

test('/models 白名单非空：只列白名单内模型（裸 id 与 provider/id 条目都命中）', async () => {
  const catalog = {
    groups: [{ id: 'p1', name: 'Provider1', models: [{ id: 'm-main' }, { id: 'm-mini' }, { id: 'm-odd' }] }],
  }
  const a = fakeDeps({ catalog, modelWhitelist: ['p1/m-mini', 'm-main'] })
  const text = await runCommand(a.deps, dm, 's', parseCommand('/models'))
  assert.match(text, /Provider1: m-main, m-mini/, '列表按目录原序')
  assert.doesNotMatch(text, /m-odd/, '白名单外模型不展示')
  const b = fakeDeps({ catalog, modelWhitelist: ['nope'] })
  assert.match(await runCommand(b.deps, dm, 's', parseCommand('/models')), /白名单内无可用模型/)
  const c = fakeDeps({ catalog })
  assert.match(await runCommand(c.deps, dm, 's', parseCommand('/models')), /m-odd/, '空白名单=不限（现状兼容）')
})

test('/model 白名单非空：越界拒绝（文案含「白名单」与可用项，不触宿主）；界内放行', async () => {
  const a = fakeDeps({ modelWhitelist: ['m-mini', 'provX/m-main'] })
  const rej = await runCommand(a.deps, dm, 'sess', parseCommand('/model gpt-5'))
  assert.match(rej, /不在白名单内/)
  assert.match(rej, /m-mini, provX\/m-main/, '拒绝文案给出可用项')
  assert.equal(a.calls.length, 0, '拒绝路径不调 selectModel')
  assert.match(await runCommand(a.deps, dm, 'sess', parseCommand('/model m-mini')), /已切换模型：m-mini/)
  assert.match(await runCommand(a.deps, dm, 'sess', parseCommand('/model provX/m-main')), /已切换模型：provX\/m-main/)
  // 白名单条目带 provider，用户只输裸 model id 也算命中
  const b = fakeDeps({ modelWhitelist: ['provX/m-main'] })
  assert.match(await runCommand(b.deps, dm, 'sess', parseCommand('/model m-main')), /已切换模型：m-main/)
})

test('/relay 三态：无参=list、有账号=bind、- 为 unbind；relay 面缺位=降级文案', async () => {
  const seen = []
  const relay = {
    async list(sid) { seen.push(['list', sid]); return '本会话未绑定抄送通知。' },
    async bind(sid, notifyAccountId) { seen.push(['bind', sid, notifyAccountId]); return `已绑定抄送通知：${notifyAccountId}。` },
    async unbind(sid) { seen.push(['unbind', sid]); return '已解除抄送绑定。' },
  }
  const a = fakeDeps({ relay })
  assert.match(await runCommand(a.deps, dm, 'sess-7', parseCommand('/relay')), /未绑定抄送/)
  assert.match(await runCommand(a.deps, dm, 'sess-7', parseCommand('/relay qq-notify')), /已绑定抄送通知：qq-notify/)
  assert.match(await runCommand(a.deps, dm, 'sess-7', parseCommand('/relay -')), /已解除/)
  assert.deepEqual(seen, [['list', 'sess-7'], ['bind', 'sess-7', 'qq-notify'], ['unbind', 'sess-7']])
  // targetId 形（账号:目标）透传不动，拆分在 gateway 接线侧
  await runCommand(a.deps, dm, 'sess-7', parseCommand('/relay qq-notify:oX123'))
  assert.deepEqual(seen.at(-1), ['bind', 'sess-7', 'qq-notify:oX123'])
  const b = fakeDeps()
  assert.match(await runCommand(b.deps, dm, 'sess-7', parseCommand('/relay x')), /抄送面未启用/)
})
