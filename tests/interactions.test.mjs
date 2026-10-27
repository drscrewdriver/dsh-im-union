// T1.9 审批/提问闭环：接管/委派、发起者限定、fail-closed、超时、abort、按钮面。
import test from 'node:test'
import assert from 'node:assert/strict'
import { InteractionBroker, sessionIdOfAgent } from '../lib/engine/interactions.js'
import { addressOf } from '../lib/engine/gateway.js'

const dm = addressOf('telegram', 'dm', 'c1')
const group = addressOf('telegram', 'group', 'g9')

function fakeAdapter(overrides = {}) {
  const replies = []
  return {
    id: 'telegram',
    label: 'Telegram',
    caps: { nativeChoices: false, maxMessageLength: 4096 },
    connected: true,
    async connect() {},
    async disconnect() {},
    onMessage() { return () => {} },
    async reply(address, text) {
      replies.push({ address, text })
      if (overrides.replyFails === true) throw new Error('403 bot blocked')
      return overrides.uncertain === true ? { uncertain: true } : { uncertain: false }
    },
    replies,
    ...overrides,
  }
}

function makeBroker(opts = {}) {
  const adapter = opts.adapter ?? fakeAdapter()
  const chatRef = opts.chat ?? { accountId: 'acct-1', address: dm, userId: 'u1' }
  const warns = []
  const broker = new InteractionBroker({
    resolveChat: (sid) => (opts.noChat === true ? undefined : sid === 'sess-1' ? chatRef : undefined),
    getAdapter: (accountId) => (accountId === 'acct-1' ? adapter : undefined),
    timeoutMs: opts.timeoutMs ?? 30,
    logWarn: (m) => warns.push(String(m)),
  })
  const nextCalls = []
  const next = async () => {
    nextCalls.push(1)
    return 'unavailable'
  }
  return { broker, adapter, next, nextCalls, warns, chatRef }
}

const waitUntil = async (fn, ms = 1500) => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('waitUntil 超时')
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('sessionIdOfAgent：agent.session.id / agent.sessionId / 非法输入', () => {
  assert.equal(sessionIdOfAgent({ session: { id: 's-a' } }), 's-a')
  assert.equal(sessionIdOfAgent({ sessionId: 's-b' }), 's-b')
  assert.equal(sessionIdOfAgent(undefined), undefined)
  assert.equal(sessionIdOfAgent('junk'), undefined)
})

test('委派路径：会话查不到 / 已有 pending → next()', async () => {
  const a = makeBroker({ noChat: true })
  const outcome = await a.broker.handleApproval({ agent: { session: { id: 'unknown' } }, toolName: 'bash' }, a.next)
  assert.equal(outcome, 'unavailable')
  assert.equal(a.nextCalls.length, 1)

  const b = makeBroker()
  const inflight = b.broker.handleApproval({ agent: { session: { id: 'sess-1' } }, toolName: 'bash' }, b.next)
  await waitUntil(() => b.adapter.replies.length === 1)
  const second = await b.broker.handleApproval({ agent: { session: { id: 'sess-1' } }, toolName: 'rm' }, b.next)
  assert.equal(second, 'unavailable', '同聊天并发审批不叠挂：委派网页')
  b.broker.consumeInbound('acct-1', dm, 'u1', '1')
  assert.equal(await inflight, 'allowed-once')
})

test('文本菜单闭环：1 允许 / 2 拒绝 / c 取消；无效回复只提示不终结', async () => {
  const a = makeBroker()
  const p1 = a.broker.handleApproval({ agent: { session: { id: 'sess-1' } }, toolName: 'write_file', reason: '覆盖配置' }, a.next)
  await waitUntil(() => a.adapter.replies.length === 1)
  assert.match(a.adapter.replies[0].text, /write_file/)
  assert.match(a.adapter.replies[0].text, /覆盖配置/)

  // 无效回复：消费但不 resolve
  assert.equal(a.broker.consumeInbound('acct-1', dm, 'u1', '也许吧'), true)
  assert.equal(a.adapter.replies.length, 2, '回了用法提示')
  assert.match(a.adapter.replies[1].text, /请回复 1/)

  assert.equal(a.broker.consumeInbound('acct-1', dm, 'u1', 'Y'), true)
  assert.equal(await p1, 'allowed-once')

  const p2 = a.broker.handleApproval({ agent: { session: { id: 'sess-1' } }, toolName: 'x' }, a.next)
  await waitUntil(() => a.adapter.replies.length === 3)
  a.broker.consumeInbound('acct-1', dm, 'u1', '拒绝')
  assert.equal(await p2, 'rejected')

  const p3 = a.broker.handleApproval({ agent: { session: { id: 'sess-1' } }, toolName: 'x' }, a.next)
  await waitUntil(() => a.adapter.replies.length === 4)
  a.broker.consumeInbound('acct-1', dm, 'u1', 'c')
  assert.equal(await p3, 'cancelled')
})

test('仅发起者可答：他人回复不消费（落回正常会话流）', async () => {
  const a = makeBroker({ chat: { accountId: 'acct-1', address: group, userId: 'owner' } })
  const inflight = a.broker.handleApproval({ agent: { session: { id: 'sess-1' } }, toolName: 'bash' }, a.next)
  await waitUntil(() => a.adapter.replies.length === 1)
  assert.equal(a.broker.consumeInbound('acct-1', group, 'other', '1'), false, '非发起者不消费')
  assert.equal(a.broker.hasPending(group), true, 'pending 仍在')
  assert.equal(a.broker.consumeInbound('acct-1', group, 'owner', '2'), true)
  assert.equal(await inflight, 'rejected')
})

test('投递明确失败 → 立即 rejected（D5 失败按拒绝）', async () => {
  const a = makeBroker({ adapter: fakeAdapter({ replyFails: true }) })
  const outcome = await a.broker.handleApproval({ agent: { session: { id: 'sess-1' } }, toolName: 'bash' }, a.next)
  assert.equal(outcome, 'rejected')
  assert.equal(a.nextCalls.length, 0, '接管了但裁决拒绝，不是委派')
})

test('投递 uncertain → 不立即否定，等回复；超时才 cancelled（fail-closed）', async () => {
  const a = makeBroker({ adapter: fakeAdapter({ uncertain: true }), timeoutMs: 40 })
  const inflight = a.broker.handleApproval({ agent: { session: { id: 'sess-1' } }, toolName: 'bash' }, a.next)
  await waitUntil(() => a.adapter.replies.length === 1)
  assert.equal(a.warns.some((w) => /结果不明/.test(w)), true)
  assert.equal(await inflight, 'cancelled', '无人回复，超时取消')
})

test('超时 30ms → cancelled；宿主 signal abort → cancelled', async () => {
  const a = makeBroker()
  const inflight = a.broker.handleApproval({ agent: { session: { id: 'sess-1' } }, toolName: 'bash' }, a.next)
  assert.equal(await inflight, 'cancelled')

  const ac = new AbortController()
  const b = makeBroker({ timeoutMs: 5000 })
  const inflightB = b.broker.handleApproval({ agent: { session: { id: 'sess-1' } }, toolName: 'bash', signal: ac.signal }, b.next)
  await waitUntil(() => b.adapter.replies.length === 1)
  ac.abort()
  assert.equal(await inflightB, 'cancelled')
})

test('按钮面（nativeChoices+askChoices）：答案映射；uncertain 映射 cancelled', async () => {
  const asked = []
  const adapter = fakeAdapter({
    caps: { nativeChoices: true, maxMessageLength: 4096 },
    async askChoices(address, question, options) {
      asked.push({ question, options })
      return { answer: '允许一次', uncertain: false }
    },
  })
  const a = makeBroker({ adapter })
  const outcome = await a.broker.handleApproval({ agent: { session: { id: 'sess-1' } }, toolName: 'bash' }, a.next)
  assert.equal(outcome, 'allowed-once')
  assert.equal(asked[0].options.join(','), '允许一次,拒绝')
  assert.equal(a.adapter.replies.length, 0, '按钮面成功就不再发文本菜单')

  const adapterU = fakeAdapter({
    caps: { nativeChoices: true },
    async askChoices() {
      return { answer: '', uncertain: true }
    },
  })
  const b = makeBroker({ adapter: adapterU })
  assert.equal(await b.broker.handleApproval({ agent: { session: { id: 'sess-1' } }, toolName: 'x' }, b.next), 'cancelled')

  // askChoices 抛错 → 回落文本菜单
  const adapterF = fakeAdapter({
    caps: { nativeChoices: true },
    async askChoices() {
      throw new Error('按钮发送失败')
    },
  })
  const c = makeBroker({ adapter: adapterF })
  const inflightC = c.broker.handleApproval({ agent: { session: { id: 'sess-1' } }, toolName: 'x' }, c.next)
  await waitUntil(() => adapterF.replies.length === 1)
  c.broker.consumeInbound('acct-1', dm, 'u1', '2')
  assert.equal(await inflightC, 'rejected')
})

test('按钮面期间文本回复同样定夺（竞速）：打字不会被当成新任务', async () => {
  let asked = 0
  const adapter = fakeAdapter({
    caps: { nativeChoices: true },
    // 永不回包：模拟用户只打字不点按钮
    askChoices: async () => {
      asked += 1
      return new Promise(() => undefined)
    },
  })
  const a = makeBroker({ adapter, timeoutMs: 5000 })
  const inflight = a.broker.handleApproval({ agent: { session: { id: 'sess-1' } }, toolName: 'bash' }, a.next)
  await waitUntil(() => asked === 1)
  assert.equal(adapter.replies.length, 0, '按钮面不另发文本菜单')
  assert.equal(a.broker.consumeInbound('acct-1', dm, 'u1', '2'), true, '文本回复被审批消费')
  assert.equal(await inflight, 'rejected')
})

test('提问闭环：单选序号 / custom 文本 / 多选逗号', async () => {
  const q = {
    id: 'q1',
    question: '选哪个方案',
    options: [{ label: '甲' }, { label: '乙' }],
  }
  const a = makeBroker()
  const inflight = a.broker.handleQuestion({ agent: { session: { id: 'sess-1' } }, questions: [q] }, a.next)
  await waitUntil(() => a.adapter.replies.length === 1)
  assert.match(a.adapter.replies[0].text, /1\. 甲/)
  a.broker.consumeInbound('acct-1', dm, 'u1', '2')
  assert.deepEqual(await inflight, { answers: [{ id: 'q1', selected: ['乙'] }] })

  const b = makeBroker()
  const inflightB = b.broker.handleQuestion({ agent: { session: { id: 'sess-1' } }, questions: [q] }, b.next)
  await waitUntil(() => b.adapter.replies.length === 1)
  b.broker.consumeInbound('acct-1', dm, 'u1', '用丙方案，理由略')
  assert.deepEqual(await inflightB, { answers: [{ id: 'q1', selected: [], custom: '用丙方案，理由略' }] })

  const multi = { ...q, multiSelect: true }
  const c = makeBroker()
  const inflightC = c.broker.handleQuestion({ agent: { session: { id: 'sess-1' } }, questions: [multi] }, c.next)
  await waitUntil(() => c.adapter.replies.length === 1)
  c.broker.consumeInbound('acct-1', dm, 'u1', '1,2')
  assert.deepEqual(await inflightC, { answers: [{ id: 'q1', selected: ['甲', '乙'] }] })
})

test('多题逐问收集：answers 聚合两题结果', async () => {
  const a = makeBroker()
  const req = {
    agent: { session: { id: 'sess-1' } },
    questions: [
      { id: 'q1', question: '一', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'q2', question: '二', options: [{ label: 'C' }, { label: 'D' }] },
    ],
  }
  const inflight = a.broker.handleQuestion(req, a.next)
  await waitUntil(() => a.adapter.replies.length === 1)
  a.broker.consumeInbound('acct-1', dm, 'u1', '1')
  await waitUntil(() => a.adapter.replies.length === 2)
  a.broker.consumeInbound('acct-1', dm, 'u1', '2')
  const answer = await inflight
  assert.deepEqual(answer.answers, [
    { id: 'q1', selected: ['A'] },
    { id: 'q2', selected: ['D'] },
  ])
})

test('dropAccount：pending 审批按 cancelled 终结（账号拆除 fail-closed）', async () => {
  const a = makeBroker({ timeoutMs: 5000 })
  const inflight = a.broker.handleApproval({ agent: { session: { id: 'sess-1' } }, toolName: 'bash' }, a.next)
  await waitUntil(() => a.adapter.replies.length === 1)
  a.broker.dropAccount('acct-1')
  assert.equal(await inflight, 'cancelled')
})

test('提问超时返回空答（不阻塞宿主链路）', async () => {
  const a = makeBroker({ timeoutMs: 30 })
  const inflight = a.broker.handleQuestion(
    { agent: { session: { id: 'sess-1' } }, questions: [{ id: 'q9', question: '无人回答' }] },
    a.next,
  )
  const answer = await inflight
  assert.deepEqual(answer.answers, [{ id: 'q9', selected: [], custom: '' }])
})
