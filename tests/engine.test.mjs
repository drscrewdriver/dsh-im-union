import test from 'node:test'
import assert from 'node:assert/strict'
import { ImUnionEngine, addressOf } from '../lib/engine/gateway.js'
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

function makeEngine(adapter, policy) {
  const ctx = { logger: fakeLogger, get: () => undefined }
  const caps = { settingsGeneration: 'gen3', sessionBackend: 'none', credentials: undefined }
  const sessionApi = {
    backend: 'none',
    async createSession() { throw new Error('unused') },
    async prompt() { throw new Error('unused') },
    follow() { return () => {} },
    async cancel() {},
    async listSessions() { return [] },
    async selectModel() {},
  }
  const router = new ChatRouter()
  const engine = new ImUnionEngine({ ctx, caps, sessionApi, router })
  engine.registerAccount(adapter, 'acct-1', policy)
  return engine
}

const dmMessage = (text, userId = 'u1') => ({
  address: addressOf('telegram', 'dm', 'c1'),
  userId,
  text,
  mentionedBot: false,
})

test('私聊白名单为空即拒（默认拒绝红线）', async () => {
  const adapter = fakeAdapter()
  const engine = makeEngine(adapter, { dmAllowlist: new Set() })
  await engine.handleInbound('acct-1', dmMessage('/help'))
  assert.equal(adapter.replies.length, 0)
})

test('白名单内 /help 得到命令列表', async () => {
  const adapter = fakeAdapter()
  const engine = makeEngine(adapter, { dmAllowlist: new Set(['u1']) })
  await engine.handleInbound('acct-1', dmMessage('/help'))
  assert.equal(adapter.replies.length, 1)
  assert.match(adapter.replies[0].text, /\/status/)
})

test('/status 报告能力快照且不触模型', async () => {
  const adapter = fakeAdapter()
  const engine = makeEngine(adapter, { dmAllowlist: new Set(['u1']) })
  await engine.handleInbound('acct-1', dmMessage('/status'))
  assert.match(adapter.replies[0].text, /gen3/)
  assert.match(adapter.replies[0].text, /none/)
})

test('群聊无 @ 不响应；有 @ 但会话后端缺失 → 显式降级文案', async () => {
  const adapter = fakeAdapter()
  const engine = makeEngine(adapter, { dmAllowlist: new Set(['u1']) })
  const groupNoMention = { address: addressOf('telegram', 'group', 'g1'), userId: 'u2', text: 'hi', mentionedBot: false }
  await engine.handleInbound('acct-1', groupNoMention)
  assert.equal(adapter.replies.length, 0)

  const groupMention = { ...groupNoMention, mentionedBot: true }
  await engine.handleInbound('acct-1', groupMention)
  assert.equal(adapter.replies.length, 1)
  assert.match(adapter.replies[0].text, /降级|不支持/)
})

test('/new 解除绑定后下一条重开隐式会话', async () => {
  const adapter = fakeAdapter()
  const ctx = { logger: fakeLogger, get: () => undefined }
  const prompts = []
  const sessionApi = {
    backend: 'native',
    async createSession() { return { id: 'x' } },
    async prompt(sessionId, text) { prompts.push({ sessionId, text }) },
    follow() { return () => {} },
    async cancel() {},
    async listSessions() { return [] },
    async selectModel() {},
  }
  const router = new ChatRouter()
  const engine = new ImUnionEngine({ ctx, caps: { settingsGeneration: 'gen3', sessionBackend: 'native' }, sessionApi, router })
  engine.registerAccount(adapter, 'acct-1', { dmAllowlist: new Set(['u1']) })
  router.bind(addressOf('telegram', 'dm', 'c1'), 'legacy')
  await engine.handleInbound('acct-1', dmMessage('/new'))
  assert.match(adapter.replies.at(-1).text, /新会话/)
  await engine.handleInbound('acct-1', dmMessage('hello'))
  // M0 骨架：prompt 用回 imu: 隐式 id 而非 legacy
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionId, 'imu:telegram:dm:c1')
})
