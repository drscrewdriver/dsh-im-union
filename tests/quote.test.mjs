// T3.6 上下文增强 + 会话渠道 Logo 前缀：quote 纯函数边界 / channelBadge 全渠道 /
// sessionTitle 形态 / createSession title 透传（native create+rename）/
// 网关标题与引用拼接触点。网络面零真实请求（stub 注入）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  QUOTE_MAX_CODEPOINTS,
  capCodepoints,
  mergeQuote,
  quoteMarker,
  withQuoteContext,
} from '../lib/engine/quote.js'
import { channelBadge, sessionTitle, SESSION_TITLE_BODY_MAX } from '../lib/host-compat/session-source.js'
import { createSessionApi } from '../lib/host-compat/session-api.js'
import { ImUnionEngine, addressOf } from '../lib/engine/gateway.js'
import { ChatRouter } from '../lib/engine/router.js'

const fakeLogger = () => ({ debug() {}, info() {}, warn() {}, error() {} })

// —— mergeQuote：优先序 / 标记 / 码点截断 ——————————————————

test('mergeQuote：现有值优先，不被回取结果覆盖；无新值原样回', () => {
  assert.equal(mergeQuote('渠道自带摘要', '取回的长原文', 'm1'), '渠道自带摘要\n[引用#m1]')
  assert.equal(mergeQuote('已有摘要', undefined, 'm1'), '已有摘要\n[引用#m1]', 'fetched 缺失时原样保留 existing')
  assert.equal(mergeQuote('   ', '原文', 'm1'), '原文\n[引用#m1]', '空白 existing 视同无值')
  assert.equal(mergeQuote(undefined, undefined, 'm1'), '', '两皆空回空串（调用方据此不写 quoteText）')
  assert.equal(mergeQuote(undefined, '  ', 'm1'), '', '空白 fetched 不产出占位')
})

test('mergeQuote：refId 为空只截正文不加标记；同标记不重复追加', () => {
  assert.equal(mergeQuote(undefined, '原文', ''), '原文')
  assert.equal(mergeQuote('原文\n[引用#m1]', undefined, 'm1'), '原文\n[引用#m1]', '幂等：已含标记不再叠')
  assert.equal(quoteMarker(' m1 '), '\n[引用#m1]', 'refId 两端空白裁掉')
  assert.equal(quoteMarker(''), '', '空 refId 无标记')
})

test('mergeQuote：800 码点上限，标记位优先保留（截正文不截标记）', () => {
  const merged = mergeQuote(undefined, '字'.repeat(1000), 'm-42')
  assert.equal(Array.from(merged).length, QUOTE_MAX_CODEPOINTS)
  assert.ok(merged.endsWith('\n[引用#m-42]'), '尾部标记完整')
  assert.ok(merged.includes('…'), '正文被截断处有省略号')
  const short = mergeQuote(undefined, '短原文', 'm-42')
  assert.equal(short, '短原文\n[引用#m-42]')
})

test('capCodepoints：按码点截断，代理对（emoji）不被劈半', () => {
  const emoji = '🐧'.repeat(10) // 每个 2 个 UTF-16 单元
  assert.equal(capCodepoints(emoji, 5), '🐧🐧🐧🐧…')
  assert.equal(Array.from(capCodepoints(emoji, 5)).length, 5)
  assert.equal(capCodepoints(emoji, 10), emoji, '未超限原样回')
  assert.equal(capCodepoints('abc', 0), '')
  assert.equal(capCodepoints(undefined, 10), '')
})

test('withQuoteContext：无引用原样回正文；有引用以「引用上下文：」领起', () => {
  assert.equal(withQuoteContext('干活', undefined), '干活')
  assert.equal(withQuoteContext('干活', '   '), '干活')
  assert.equal(withQuoteContext('看看这条', '张三: 原文\n[引用#m1]'), '看看这条\n\n引用上下文：\n张三: 原文\n[引用#m1]')
  assert.equal(withQuoteContext('', '原文'), '引用上下文：\n原文', '空正文只给引用块')
})

// —— channelBadge：全渠道覆盖（id 与 adapter.id 对齐）——————————

test('channelBadge：11 渠道 id → 约定角标', () => {
  const table = {
    telegram: 'TG',
    weixin: 'WX',
    feishu: 'FS',
    discord: 'DC',
    wecom: 'WC',
    'wecom-app': 'WC',
    dingtalk: 'Ding',
    qq: 'QQ',
    slack: 'SL',
    whatsapp: 'WA',
    imessage: 'IM',
    matrix: 'MX',
  }
  for (const [id, badge] of Object.entries(table)) {
    assert.equal(channelBadge(id), badge, `渠道 ${id}`)
  }
})

test('channelBadge：大小写/空白容错，未知渠道退化不伪装，空 id 回空串', () => {
  assert.equal(channelBadge(' Telegram '), 'TG')
  assert.equal(channelBadge('WECOM-APP'), 'WC')
  assert.equal(channelBadge('signal'), 'SIG', '未知渠道取 id 前 3 字母大写')
  assert.equal(channelBadge(''), '')
})

test('sessionTitle：`[角标] 首条正文前 30 字`，折叠空白/单行/码点安全', () => {
  assert.equal(sessionTitle('telegram', '帮我看看 这份\n日志'), '[TG] 帮我看看 这份 日志')
  assert.equal(sessionTitle('slack', 'x'.repeat(50)).slice(0, '[SL] '.length + 30), `[SL] ${'x'.repeat(30)}`)
  assert.equal(Array.from(sessionTitle('qq', '字'.repeat(50))).length, '[QQ] '.length + SESSION_TITLE_BODY_MAX)
  assert.equal(sessionTitle('feishu', '   '), '[FS]', '空正文只留角标')
  assert.equal(sessionTitle('', '正文'), '正文', '无角标不吐空方括号')
  assert.equal(sessionTitle('', '   '), '')
  assert.equal(sessionTitle('signal', '正文\n第二行'), '[SIG] 正文 第二行')
})

// —— createSession title 透传（native 面 create+rename）———————

function nativeCtx(services) {
  return { logger: fakeLogger, get: (name) => services[name] }
}
const nativeCaps = { sessionBackend: 'native' }

test('createSession：title 经 rename 落地并回 SessionInfo.title', async () => {
  const calls = []
  const ctx = nativeCtx({
    agents: {
      create: (request) => {
        calls.push({ face: 'agents.create', request })
        return { sessionId: 's-1' }
      },
    },
    sessionController: {
      prompt: () => {},
      rename: (request) => {
        calls.push({ face: 'rename', request })
        return { title: request.title, seq: 1 }
      },
    },
  })
  const api = createSessionApi(ctx, nativeCaps)
  const info = await api.createSession({ sessionIdHint: 'im:union:telegram:dm:c1', title: '[TG] 干活' })
  assert.equal(info.id, 's-1')
  assert.equal(info.title, '[TG] 干活')
  assert.deepEqual(calls[0].request, { seed: [], meta: { origin: 'dsh-im-union', workspace: undefined } }, 'create 面不塞 title')
  assert.deepEqual(calls[1], { face: 'rename', request: { sessionId: 's-1', title: '[TG] 干活' } })
})

test('createSession：rename 面缺位/被拒时不伪装成功，标题退回宿主回包', async () => {
  const noFace = createSessionApi(
    nativeCtx({ agents: { create: () => ({ sessionId: 's-2' }) }, sessionController: { prompt: () => {} } }),
    nativeCaps,
  )
  const a = await noFace.createSession({ title: '[TG] 干活' })
  assert.equal(a.id, 's-2')
  assert.equal(a.title, undefined, '无 rename 面 → 不谎称列表可见')

  const rejected = createSessionApi(
    nativeCtx({
      agents: { create: () => ({ sessionId: 's-3', title: '宿主原标题' }) },
      sessionController: {
        prompt: () => {},
        rename: () => {
          throw new Error('session/title-invalid')
        },
      },
    }),
    nativeCaps,
  )
  const b = await rejected.createSession({ title: '[TG] 干活' })
  assert.equal(b.title, '宿主原标题', 'rename 被拒 → 退回 create 回包 title，不抛错')
})

test('createSession：无 title 入参时不发 rename 调用', async () => {
  let renames = 0
  const api = createSessionApi(
    nativeCtx({
      agents: { create: () => ({ id: 's-4' }) },
      sessionController: {
        prompt: () => {},
        rename: () => {
          renames += 1
          return { title: 'x', seq: 1 }
        },
      },
    }),
    nativeCaps,
  )
  const info = await api.createSession({ sessionIdHint: 'im:union:slack:group:c1' })
  assert.equal(info.id, 's-4')
  assert.equal(renames, 0)
  assert.equal(info.title, undefined)
})

// —— 网关触点：标题透传 + 引用拼接进 prompt ————————————————

function turnSession() {
  const state = { listener: undefined, prompted: [], created: [] }
  return {
    backend: 'native',
    state,
    async createSession(options) {
      state.created.push(options)
      return { id: 'host-1', title: options.title }
    },
    async prompt(sessionId, input) {
      state.prompted.push({ sessionId, input })
    },
    follow(sessionId, onEvent) {
      state.listener = onEvent
      return () => {}
    },
    async cancel() {},
    async listSessions() {
      return []
    },
    async selectModel() {},
    emit(event) {
      state.listener?.(event)
    },
  }
}

function engineWith(session) {
  const adapter = {
    id: 'telegram',
    label: 'Telegram',
    caps: { maxMessageLength: 4096 },
    connected: true,
    async connect() {},
    async disconnect() {},
    onMessage() {
      return () => {}
    },
    async reply() {
      return { uncertain: false }
    },
    authorize: () => undefined,
  }
  const router = new ChatRouter()
  const engine = new ImUnionEngine({
    ctx: { logger: fakeLogger, get: () => undefined },
    caps: { settingsGeneration: 'gen3', sessionBackend: 'native' },
    sessionApi: session,
    router,
    turnTimeoutMs: 500,
  })
  engine.registerAccount(adapter, 'acct-1', { dmAllowlist: new Set(['u1']) })
  return { engine, router, adapter }
}

const waitUntil = async (fn, ms = 2000) => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('waitUntil 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('runTurn：首次建会话把 `[TG] 首条正文` 作为 title 透传给 createSession', async () => {
  const session = turnSession()
  const { engine } = engineWith(session)
  const message = {
    address: addressOf('telegram', 'dm', 'c1'),
    userId: 'u1',
    text: '帮我看看这份日志里的报错',
    mentionedBot: false,
  }
  const inflight = engine.handleInbound('acct-1', message)
  await waitUntil(() => session.state.prompted.length === 1)
  session.emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await inflight
  assert.equal(session.state.created.length, 1)
  assert.equal(session.state.created[0].title, '[TG] 帮我看看这份日志里的报错')
  assert.equal(session.state.created[0].sessionIdHint, 'im:union:telegram:dm:c1')
})

test('runTurn：quoteText 在位时拼进 prompt，缺位时正文原样', async () => {
  const session = turnSession()
  const { engine } = engineWith(session)
  const inflight = engine.handleInbound('acct-1', {
    address: addressOf('telegram', 'dm', 'c1'),
    userId: 'u1',
    text: '总结这条',
    mentionedBot: false,
    quoteText: 'Bob: 原文正文\n[引用#123]',
  })
  await waitUntil(() => session.state.prompted.length === 1)
  session.emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await inflight
  assert.equal(session.state.prompted[0].input, '总结这条\n\n引用上下文：\nBob: 原文正文\n[引用#123]')
})
