import test from 'node:test'
import assert from 'node:assert/strict'
import { ImUnionEngine, addressOf, splitText, extractAssistantText, normalizeCommandExec } from '../lib/engine/gateway.js'
import { ChatRouter } from '../lib/engine/router.js'

const fakeLogger = () => ({ debug() {}, info() {}, warn() {}, error() {} })

function fakeAdapter(overrides = {}) {
  const replies = []
  return {
    id: 'telegram',
    label: 'Telegram',
    caps: { maxMessageLength: 4096 },
    connected: true,
    listeners: [],
    connect: async () => {},
    disconnect: async () => {},
    onMessage(listener) {
      this.listeners.push(listener)
      return () => {}
    },
    async reply(address, text) {
      replies.push({ address, text })
      return { uncertain: false }
    },
    authorize() {
      return undefined
    },
    replies,
    ...overrides,
  }
}

function makeEngine(adapter, policy, extra = {}) {
  const ctx = { logger: extra.logger ?? fakeLogger, get: () => undefined }
  const caps = { settingsGeneration: 'gen3', sessionBackend: extra.sessionApi?.backend ?? 'none', credentials: undefined }
  const sessionApi = extra.sessionApi ?? {
    backend: 'none',
    async createSession() { throw new Error('unused') },
    async prompt() { throw new Error('unused') },
    follow() { return () => {} },
    async cancel() {},
    async listSessions() { return [] },
    async selectModel() {},
  }
  const router = new ChatRouter()
  const engine = new ImUnionEngine({ ctx, caps, sessionApi, router, eventTap: extra.eventTap, turnTimeoutMs: extra.turnTimeoutMs })
  engine.registerAccount(adapter, 'acct-1', policy)
  return { engine, router }
}

const dmMessage = (text, userId = 'u1') => ({
  address: addressOf('telegram', 'dm', 'c1'),
  userId,
  text,
  mentionedBot: false,
})

test('私聊白名单为空即拒（默认拒绝红线）：消息不处理但回一次带 userId 的提示', async () => {
  const adapter = fakeAdapter()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set() })
  await engine.handleInbound('acct-1', dmMessage('/help'))
  // 拒绝可见化：不执行命令（默认拒绝红线不变），但回一次未授权提示便于排障。
  assert.equal(adapter.replies.length, 1)
  assert.match(adapter.replies[0].text, /未授权/)
  assert.match(adapter.replies[0].text, /u1/)
  await engine.handleInbound('acct-1', dmMessage('/help'))
  await engine.handleInbound('acct-1', dmMessage('你好'))
  // 冷却窗口内不重复提示，消息也绝不进会话。
  assert.equal(adapter.replies.length, 1)
})

test('privateAccess=all 接受所有私聊；准入档位经 updatePolicy 原位切换', async () => {
  const adapter = fakeAdapter()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(), privateAccess: 'all' })
  await engine.handleInbound('acct-1', dmMessage('/help'))
  // 命令得到执行（回复不是未授权提示）。
  assert.equal(adapter.replies.length, 1)
  assert.doesNotMatch(adapter.replies[0].text, /未授权/)
  engine.updatePolicy('acct-1', { privateAccess: 'approved' })
  await engine.handleInbound('acct-1', dmMessage('/help'))
  assert.match(adapter.replies[1].text, /未授权/)
})

test('群聊关闭且被 @ 时提示一次；未 @ 静默', async () => {
  const adapter = fakeAdapter()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']), groupEnabled: false })
  const groupMessage = (mentioned) => ({
    address: addressOf('telegram', 'group', 'g1'),
    userId: 'u1',
    text: '@bot 你好',
    mentionedBot: mentioned,
  })
  await engine.handleInbound('acct-1', groupMessage(false))
  assert.equal(adapter.replies.length, 0)
  await engine.handleInbound('acct-1', groupMessage(true))
  assert.equal(adapter.replies.length, 1)
  assert.match(adapter.replies[0].text, /群聊接收已关闭/)
  await engine.handleInbound('acct-1', groupMessage(true))
  assert.equal(adapter.replies.length, 1)
})

test('白名单内 /help 得到命令列表', async () => {
  const adapter = fakeAdapter()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']) })
  await engine.handleInbound('acct-1', dmMessage('/help'))
  assert.equal(adapter.replies.length, 1)
  assert.match(adapter.replies[0].text, /\/status/)
})

test('/status 报告能力快照且不触模型', async () => {
  const adapter = fakeAdapter()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']) })
  await engine.handleInbound('acct-1', dmMessage('/status'))
  assert.match(adapter.replies[0].text, /gen3/)
  assert.match(adapter.replies[0].text, /none/)
})

test('群聊无 @ 不响应；有 @ 但会话后端缺失 → 显式降级文案', async () => {
  const adapter = fakeAdapter()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']) })
  const groupNoMention = { address: addressOf('telegram', 'group', 'g1'), userId: 'u2', text: 'hi', mentionedBot: false }
  await engine.handleInbound('acct-1', groupNoMention)
  assert.equal(adapter.replies.length, 0)

  const groupMention = { ...groupNoMention, mentionedBot: true }
  await engine.handleInbound('acct-1', groupMention)
  assert.equal(adapter.replies.length, 1)
  assert.match(adapter.replies[0].text, /降级|不支持/)
})

// —— 投递状态机（M1 事件流→流式投递）——————————————————————

/** 活的会话 stub：follow 捕获监听器，prompt 记账，emit 注入宿主事件。 */
function liveSession() {
  const state = { listener: undefined, prompted: [], unsubscribed: 0 }
  return {
    backend: 'native',
    async createSession() { return { id: 'x' } },
    async prompt(sessionId, input) { state.prompted.push({ sessionId, input }) },
    follow(sessionId, onEvent) {
      state.listener = onEvent
      return () => {
        state.listener = undefined
        state.unsubscribed += 1
      }
    },
    async cancel() {},
    async listSessions() { return [] },
    async selectModel() {},
    emit(event) { state.listener?.(event) },
    state,
  }
}

const assistantEvent = (text, turn = 1, step = 1) => ({
  type: 'assistant/message',
  data: { turn, step, message: { content: [{ type: 'reasoning', text: '(思考)' }, { type: 'text', text }] } },
})
const turnEnd = (kind = 'completed', turn = 1) => ({ type: 'turn/end', data: { turn, reason: { kind } } })

function streamAdapter(caps = {}) {
  const streams = []
  const adapter = fakeAdapter({
    caps: { editStream: true, nativeStream: false, maxMessageLength: 4096, ...caps },
    async beginStream() {
      const rec = { updates: [], finishes: [], aborted: 0 }
      streams.push(rec)
      return {
        update: async (t) => { rec.updates.push(t) },
        finish: async (t) => { rec.finishes.push(t); return { uncertain: false, platformMessageId: 'm' + streams.length } },
        abort: () => { rec.aborted += 1 },
      }
    },
  })
  adapter.streams = streams
  return adapter
}

const waitUntil = async (fn, ms = 2000) => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('waitUntil 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('edit-stream 模式：step 快照更新，turn/end 收尾，不走 reply', async () => {
  const adapter = streamAdapter()
  const session = liveSession()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']) }, { sessionApi: session })
  const inflight = engine.handleInbound('acct-1', dmMessage('干活'))
  await waitUntil(() => session.state.prompted.length === 1)
  session.emit(assistantEvent('前半'))
  await waitUntil(() => adapter.streams[0]?.updates.length === 1, 500)
  session.emit(assistantEvent('后半', 1, 2))
  await waitUntil(() => adapter.streams[0].updates.length === 2, 500)
  session.emit(turnEnd())
  await inflight
  const rec = adapter.streams[0]
  assert.deepEqual(rec.updates, ['前半', '前半\n\n后半'], '每个落定 step 推一次全量快照')
  assert.deepEqual(rec.finishes, ['前半\n\n后半'])
  assert.equal(adapter.replies.length, 0)
  assert.equal(session.state.unsubscribed, 1, '收轮必退订')
})

test('无流式 caps → 收轮后 reply 投递全文（降级路径）', async () => {
  const adapter = fakeAdapter({ caps: { editStream: false, nativeStream: false, maxMessageLength: 4096 } })
  const session = liveSession()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']) }, { sessionApi: session })
  const inflight = engine.handleInbound('acct-1', dmMessage('go'))
  await waitUntil(() => session.state.prompted.length === 1)
  session.emit(assistantEvent('结果文本'))
  session.emit(turnEnd())
  await inflight
  assert.equal(adapter.replies.length, 1)
  assert.equal(adapter.replies[0].text, '结果文本')
})

test('turn/end 非 completed → 正文后追加状态说明（不泄内部异常）', async () => {
  const adapter = fakeAdapter({ caps: { editStream: false, nativeStream: false, maxMessageLength: 4096 } })
  const session = liveSession()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']) }, { sessionApi: session })
  const inflight = engine.handleInbound('acct-1', dmMessage('go'))
  await waitUntil(() => session.state.prompted.length === 1)
  session.emit(assistantEvent('已产出部分'))
  session.emit(turnEnd('error'))
  await inflight
  assert.match(adapter.replies[0].text, /已产出部分/)
  assert.match(adapter.replies[0].text, /执行失败/)
})

test('本轮无任何 step 落定 → 明示无可见输出', async () => {
  const adapter = fakeAdapter({ caps: { editStream: false, nativeStream: false, maxMessageLength: 4096 } })
  const session = liveSession()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']) }, { sessionApi: session })
  const inflight = engine.handleInbound('acct-1', dmMessage('go'))
  await waitUntil(() => session.state.prompted.length === 1)
  session.emit(turnEnd())
  await inflight
  assert.match(adapter.replies[0].text, /无可见输出/)
})

test('turn/end 丢失 → 看门狗收轮并标注超时', async () => {
  const adapter = fakeAdapter({ caps: { editStream: false, nativeStream: false, maxMessageLength: 4096 } })
  const session = liveSession()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']) }, { sessionApi: session, turnTimeoutMs: 60 })
  await engine.handleInbound('acct-1', dmMessage('go'))
  assert.match(adapter.replies[0].text, /等待超时/)
  assert.equal(session.state.unsubscribed, 1)
})

test('超长度分段：首段收尾，余段补发', async () => {
  const adapter = streamAdapter({ maxMessageLength: 10 })
  const session = liveSession()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']) }, { sessionApi: session })
  const inflight = engine.handleInbound('acct-1', dmMessage('go'))
  await waitUntil(() => session.state.prompted.length === 1)
  session.emit(assistantEvent('aaaaaaaa\n\nbbbbbbbb\n\ncccccccc'))
  session.emit(turnEnd())
  await inflight
  assert.equal(adapter.streams[0].finishes[0], 'aaaaaaaa')
  assert.deepEqual(adapter.replies.map((r) => r.text), ['bbbbbbbb', 'cccccccc'])
})

test('uncertain 回执只记日志不重发（D7）', async () => {
  const warns = []
  const adapter = fakeAdapter({
    caps: { editStream: false, nativeStream: false, maxMessageLength: 4096 },
    async reply() {
      adapter.replies.push({ text: 'x' })
      return { uncertain: true }
    },
  })
  const session = liveSession()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']) }, {
    sessionApi: session,
    logger: () => ({ debug() {}, info() {}, warn: (m) => warns.push(String(m)), error() {} }),
  })
  const inflight = engine.handleInbound('acct-1', dmMessage('go'))
  await waitUntil(() => session.state.prompted.length === 1)
  session.emit(assistantEvent('一段文本'))
  session.emit(turnEnd())
  await inflight
  assert.equal(adapter.replies.length, 1, '只发一次')
  assert.ok(warns.some((w) => /不自动重发/.test(w)))
})

test('prompt 报错 → 参考号文案 + 退订清理', async () => {
  const adapter = fakeAdapter({ caps: { editStream: false, nativeStream: false, maxMessageLength: 4096 } })
  const session = liveSession()
  session.prompt = async () => { throw new Error('boom') }
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']) }, { sessionApi: session })
  await engine.handleInbound('acct-1', dmMessage('go'))
  assert.match(adapter.replies[0].text, /参考号 IMU-/)
  assert.equal(session.state.unsubscribed, 1)
})

test('splitText：段落边界优先/硬切/不分段三态', () => {
  assert.deepEqual(splitText('short', 10), ['short'])
  assert.deepEqual(splitText('abcdefg\n\nhij', 8), ['abcdefg', 'hij'])
  assert.deepEqual(splitText('x'.repeat(25), 10), ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
  assert.deepEqual(splitText('abc', 0), ['abc'], '非正数上限不分段')
})

test('extractAssistantText：只取 text 块，多块拼接', () => {
  assert.equal(extractAssistantText(assistantEvent('甲')), '甲')
  assert.equal(extractAssistantText({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] } } }), 'A\n\nB')
  assert.equal(extractAssistantText({}), '')
})

// —— 路由衔接回归 —————————————————————

// —— 多账号独立性（E3）——————————————————————

test('同渠道双账号：白名单各自独立，入站由来源账号适配器投递', async () => {
  const ctx = { logger: fakeLogger, get: () => undefined }
  const caps = { settingsGeneration: 'gen3', sessionBackend: 'none' }
  const sessionApi = { backend: 'none', async createSession() { throw new Error('u') }, async prompt() { throw new Error('u') }, follow() { return () => {} }, async cancel() {}, async listSessions() { return [] }, async selectModel() {}, async steer() { return false }, async modelCatalog() { return undefined }, async presetsList() { return [] }, async presetSelect() { return { ok: false } } }
  const router = new ChatRouter()
  const engine = new ImUnionEngine({ ctx, caps, sessionApi, router })
  const a = fakeAdapter()
  const b = fakeAdapter()
  engine.registerAccount(a, 'acct-a', { dmAllowlist: new Set() })
  engine.registerAccount(b, 'acct-b', { dmAllowlist: new Set(['u1']) })
  const msg = dmMessage('/help')
  await engine.handleInbound('acct-a', msg)
  // 拒绝可见化：拒一回一次提示（不执行命令），只投到来源账号自己的适配器。
  assert.equal(a.replies.length, 1, 'acct-a 空白名单即拒（带未授权提示）')
  assert.match(a.replies[0].text, /未授权/)
  await engine.handleInbound('acct-b', msg)
  assert.equal(b.replies.length, 1, 'acct-b 白名单内放行且回到自己适配器')
  assert.match(b.replies[0].text, /\/status/)
  engine.unregister('acct-b')
  await engine.handleInbound('acct-b', msg)
  assert.equal(b.replies.length, 1, '注销后账号消息整体丢弃')
})

test('/new 解除绑定后下一条重开宿主真会话并复用', async () => {
  const adapter = fakeAdapter({ caps: { editStream: false, nativeStream: false, maxMessageLength: 4096 } })
  const session = liveSession()
  const { engine, router } = makeEngine(adapter, { dmAllowlist: new Set(['u1']) }, { sessionApi: session })
  router.bind(addressOf('telegram', 'dm', 'c1'), 'legacy')
  await engine.handleInbound('acct-1', dmMessage('/new'))
  assert.match(adapter.replies.at(-1).text, /新会话/)
  const inflight = engine.handleInbound('acct-1', dmMessage('hello'))
  await waitUntil(() => session.state.prompted.length === 1)
  session.emit(turnEnd())
  await inflight
  // T1.1 后：隐式 im:union: id 首次使用时 createSession 换宿主真 id（stub 回 'x'）
  assert.equal(session.state.prompted[0].sessionId, 'x')
  const second = engine.handleInbound('acct-1', dmMessage('again'))
  await waitUntil(() => session.state.prompted.length === 2)
  session.emit(turnEnd())
  await second
  assert.equal(session.state.prompted[1].sessionId, 'x', '真 id 已绑定，后续消息复用')
})

// —— 原生进度显示（T1.6 企微档位）——————————————————

test('statusProgress 渠道：思考中/工具执行附进流式快照，文本落定即清', async () => {
  const adapter = streamAdapter({ statusProgress: true })
  const session = liveSession()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']) }, { sessionApi: session })
  const inflight = engine.handleInbound('acct-1', dmMessage('干活'))
  await waitUntil(() => session.state.prompted.length === 1)
  session.emit({ type: 'step/start', data: { turn: 1, step: 1 } })
  await waitUntil(() => adapter.streams[0]?.updates.length === 1, 500)
  assert.match(adapter.streams[0].updates[0], /思考中/)
  session.emit({ type: 'tool/call', data: { name: 'bash', arguments: '{}' } })
  await waitUntil(() => adapter.streams[0].updates.length === 2, 500)
  assert.match(adapter.streams[0].updates[1], /正在执行：bash/)
  session.emit(assistantEvent('结果文本'))
  await waitUntil(() => adapter.streams[0].updates.length === 3, 500)
  assert.equal(adapter.streams[0].updates[2], '结果文本', '落定后进度尾巴必须消失')
  session.emit(turnEnd())
  await inflight
})

test('无 statusProgress 档位：进度事件不产生额外流式拍（回归防护）', async () => {
  const adapter = streamAdapter() // caps 不含 statusProgress
  const session = liveSession()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']) }, { sessionApi: session })
  const inflight = engine.handleInbound('acct-1', dmMessage('干活'))
  await waitUntil(() => session.state.prompted.length === 1)
  session.emit({ type: 'step/start', data: { turn: 1, step: 1 } })
  session.emit({ type: 'tool/call', data: { name: 'bash' } })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(adapter.streams.length, 0, '无落定文本且非进度档位时不得开流')
  session.emit(assistantEvent('正文'))
  await waitUntil(() => adapter.streams[0]?.updates.length === 1, 500)
  assert.equal(adapter.streams[0].updates[0], '正文')
  session.emit(turnEnd())
  await inflight
})

test('normalizeCommandExec：缺省全开；非布尔键回退', () => {
  assert.deepEqual(normalizeCommandExec(undefined), { dm: true, group: true })
  assert.deepEqual(normalizeCommandExec({ dm: false }), { dm: false, group: true })
  assert.deepEqual(normalizeCommandExec('junk', { dm: false, group: false }), { dm: false, group: false })
  assert.deepEqual(normalizeCommandExec({ dm: 'no', group: 0 }), { dm: true, group: true })
})

test('命令执行开关：关闭只拦 / 命令并明说；/mute 保留逃生门；重开后恢复', async () => {
  const adapter = fakeAdapter()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']), commandExec: { dm: false, group: true } })
  await engine.handleInbound('acct-1', dmMessage('/help'))
  assert.equal(adapter.replies.length, 1)
  assert.match(adapter.replies[0].text, /私聊命令执行已关闭/)
  // /mute 是静音期唯一逃生门：命令开关关闭也不拦（否则永久静默）。
  await engine.handleInbound('acct-1', dmMessage('/mute'))
  assert.equal(adapter.replies.length, 2)
  assert.match(adapter.replies[1].text, /已静音/)
  engine.updatePolicy('acct-1', { commandExec: { dm: true, group: true } })
  await engine.handleInbound('acct-1', dmMessage('/help'))
  assert.equal(adapter.replies.length, 3)
  assert.doesNotMatch(adapter.replies[2].text, /已关闭/)
})

test('群聊命令执行开关独立于私聊档', async () => {
  const adapter = fakeAdapter()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']), commandExec: { dm: true, group: false } })
  await engine.handleInbound('acct-1', dmMessage('/help'))
  assert.equal(adapter.replies.length, 1)
  assert.doesNotMatch(adapter.replies[0].text, /已关闭/)
  await engine.handleInbound('acct-1', {
    address: addressOf('telegram', 'group', 'g1'),
    userId: 'u1',
    text: '/help',
    mentionedBot: true,
  })
  assert.equal(adapter.replies.length, 2)
  assert.match(adapter.replies[1].text, /群聊命令执行已关闭/)
})

test('权限预设：updatePolicy 改权限即对该账号已回路会话补应用；同值重存不重复', async () => {
  const applied = []
  const adapter = fakeAdapter()
  const sessionApi = {
    backend: 'native',
    async createSession() { return { id: 'imu:union:1' } },
    async prompt() {},
    follow() { return () => {} },
    async cancel() {},
    async listSessions() { return [] },
    async selectModel() {},
    async applyPermission(sessionId, preset) { applied.push([sessionId, preset]); return { ok: true } },
  }
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']) }, { sessionApi })
  engine.sessionChats.set('imu:union:1', {
    accountId: 'acct-1',
    address: addressOf('telegram', 'dm', 'c1'),
    userId: 'u1',
  })
  engine.updatePolicy('acct-1', { session: { permission: 'yolo' } })
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(applied, [['imu:union:1', 'yolo']])
  engine.updatePolicy('acct-1', { session: { permission: 'yolo' } })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(applied.length, 1, '同值再存不重复应用')
})

test('相对 cwd 偏好被丢弃：不透传 createSession，会话照常建立；绝对路径正常透传', async () => {
  const session = liveSession()
  const created = []
  session.createSession = async (options) => {
    created.push(options)
    return { id: 's-rel' }
  }
  const adapter = fakeAdapter()
  const { engine, router } = makeEngine(
    adapter,
    { dmAllowlist: new Set(['u1']), session: { cwd: 'rewrite-agently' } },
    { sessionApi: session },
  )
  const inflight = engine.handleInbound('acct-1', dmMessage('你好'))
  await waitUntil(() => session.state.prompted.length === 1)
  session.emit(assistantEvent('好的'))
  session.emit(turnEnd())
  await inflight
  assert.equal(created.length, 1)
  assert.equal(created[0].cwd, undefined, '相对 cwd 不透传')
  assert.equal(session.state.prompted[0].sessionId, 's-rel')

  // 换绝对路径偏好 + 解绑重开（既有显式绑定按设计不重建）。
  engine.updatePolicy('acct-1', { session: { cwd: 'E:/proj/rewrite-agently' } })
  router.unbind(addressOf('telegram', 'dm', 'c1'))
  const inflight2 = engine.handleInbound('acct-1', dmMessage('再来一个'))
  await waitUntil(() => session.state.prompted.length === 2)
  session.emit(turnEnd('completed', 2))
  await inflight2
  assert.equal(created[1].cwd, 'E:/proj/rewrite-agently', '绝对 cwd 照常透传')
})

test('createSession 失败 → prompt 失败时回包带参考号 + 根因链', async () => {
  const session = liveSession()
  session.createSession = async () => {
    throw new Error('workspace 目录不存在')
  }
  session.prompt = async (sessionId) => {
    if (sessionId.startsWith('im:')) throw new Error('session not found: ' + sessionId)
  }
  const adapter = fakeAdapter()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']) }, { sessionApi: session })
  await engine.handleInbound('acct-1', dmMessage('你好'))
  const last = adapter.replies[adapter.replies.length - 1].text
  assert.match(last, /任务提交失败（参考号 IMU-/)
  assert.match(last, /session not found/, '症状错误对用户可见')
  assert.match(last, /会话创建此前已失败：workspace 目录不存在/, '根因链对用户可见')
})

test('事件总线优先：tap 扇出驱动回合投递，总线在位时不走 follow', async () => {
  const session = liveSession()
  let followCalls = 0
  session.follow = () => {
    followCalls += 1
    return () => {}
  }
  const listeners = new Map()
  const tap = {
    subscribe(sessionId, onEvent) {
      listeners.set(sessionId, onEvent)
      return () => listeners.delete(sessionId)
    },
  }
  const adapter = fakeAdapter()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']) }, { sessionApi: session, eventTap: tap })
  const inflight = engine.handleInbound('acct-1', dmMessage('你好'))
  await waitUntil(() => session.state.prompted.length === 1)
  listeners.get('x')?.({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'reasoning', text: '(思考)' }, { type: 'text', text: '总线回答' }] } } })
  listeners.get('x')?.({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await inflight
  assert.equal(followCalls, 0, '总线在位时不走 follow')
  assert.equal(adapter.replies.length, 1)
  assert.match(adapter.replies[0].text, /总线回答/)
})

test('排障基线日志：入站/会话解析（请求 id → 宿主 id）/回合完成摘要落 info', async () => {
  const infos = []
  const adapter = fakeAdapter({ caps: { editStream: false, nativeStream: false, maxMessageLength: 4096 } })
  const session = liveSession()
  session.createSession = async () => ({ id: 'host-real-1' })
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']) }, {
    sessionApi: session,
    logger: () => ({ debug() {}, info: (m) => infos.push(String(m)), warn() {}, error() {} }),
  })
  const inflight = engine.handleInbound('acct-1', dmMessage('你好'))
  await waitUntil(() => session.state.prompted.length === 1)
  session.emit(assistantEvent('回答'))
  session.emit(turnEnd('completed', 1))
  await inflight
  assert.ok(infos.some((x) => /入站：telegram\/dm 自 u1/.test(x)), '入站行（排障对号基线）')
  assert.ok(infos.some((x) => /宿主实际 id host-real-1/.test(x)), '请求 id 与宿主 id 分叉可见')
  assert.ok(infos.some((x) => /回合完成：telegram\/dm turn=1 收轮=completed 投递 \d+ 字/.test(x)), '投递摘要行')
})

test('/new 端到端：运行中被守卫拒绝；空闲轮换后下一条消息落轮换 id', async () => {
  const adapter = fakeAdapter({ caps: { editStream: false, nativeStream: false, maxMessageLength: 4096 } })
  const session = liveSession()
  const prompted = session.state.prompted
  let releasePrompt
  session.prompt = async (sessionId, input) => {
    prompted.push({ sessionId, input })
    if (prompted.length === 1) await new Promise((resolve) => { releasePrompt = resolve })
  }
  session.createSession = async (opts) => ({ id: opts.sessionIdHint })
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set(['u1']) }, { sessionApi: session })

  const first = engine.handleInbound('acct-1', dmMessage('干活'))
  await waitUntil(() => prompted.length === 1)
  const busy = await engine.handleInbound('acct-1', dmMessage('/new'))
  await busy
  assert.match(adapter.replies.at(-1).text, /\/stop/, '回合运行中 /new 被拒')

  releasePrompt()
  session.emit(turnEnd())
  await first

  const rotate = await engine.handleInbound('acct-1', dmMessage('/new'))
  await rotate
  assert.match(adapter.replies.at(-1).text, /已开启新会话/, '空闲时轮换成功')

  const second = engine.handleInbound('acct-1', dmMessage('新会话继续'))
  await waitUntil(() => prompted.length === 2)
  assert.match(prompted[1].sessionId, /^im:union:telegram:dm:c1:\d{13}$/, '下一条消息 prompt 轮换新会话')
  session.emit(turnEnd('completed', 1))
  await second
})
