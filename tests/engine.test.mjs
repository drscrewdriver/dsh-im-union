import test from 'node:test'
import assert from 'node:assert/strict'
import { ImUnionEngine, addressOf, splitText, extractAssistantText } from '../lib/engine/gateway.js'
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
  const engine = new ImUnionEngine({ ctx, caps, sessionApi, router, turnTimeoutMs: extra.turnTimeoutMs })
  engine.registerAccount(adapter, 'acct-1', policy)
  return { engine, router }
}

const dmMessage = (text, userId = 'u1') => ({
  address: addressOf('telegram', 'dm', 'c1'),
  userId,
  text,
  mentionedBot: false,
})

test('私聊白名单为空即拒（默认拒绝红线）', async () => {
  const adapter = fakeAdapter()
  const { engine } = makeEngine(adapter, { dmAllowlist: new Set() })
  await engine.handleInbound('acct-1', dmMessage('/help'))
  assert.equal(adapter.replies.length, 0)
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
  // T1.1 后：隐式 imu: id 首次使用时 createSession 换宿主真 id（stub 回 'x'）
  assert.equal(session.state.prompted[0].sessionId, 'x')
  const second = engine.handleInbound('acct-1', dmMessage('again'))
  await waitUntil(() => session.state.prompted.length === 2)
  session.emit(turnEnd())
  await second
  assert.equal(session.state.prompted[1].sessionId, 'x', '真 id 已绑定，后续消息复用')
})
