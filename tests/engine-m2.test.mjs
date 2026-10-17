// T2.4/T2.5/T2.8/T2.9 网关接线回归：文件入站 parts / 产物回传 / 投递记录与补发 /
// 超时迟到补投 / 静音 / 碎片续写 / 导出 ZIP / queue·goal 文案。全 fake 注入零网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImUnionEngine, addressOf } from '../lib/engine/gateway.js'
import { ChatRouter } from '../lib/engine/router.js'
import { DeliveryLog } from '../lib/engine/delivery-log.js'
import { FragmentBuffer } from '../lib/engine/fragments.js'

const fakeLogger = { info() {}, warn() {}, error() {} }
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

function adapterStub(over = {}) {
  const replies = []
  const sentFiles = []
  const adapter = {
    id: 'telegram',
    label: 'Telegram',
    caps: {
      editStream: false,
      nativeStream: false,
      maxMessageLength: 4096,
      nativeChoices: false,
      statusReaction: false,
      typing: false,
      fileIn: true,
      fileOut: true,
      ...(over.caps ?? {}),
    },
    connected: true,
    async connect() {},
    async disconnect() {},
    onMessage: () => () => undefined,
    async reply(address, text) {
      if (over.replyHook !== undefined) {
        const forced = over.replyHook(text, replies.length)
        if (forced instanceof Error) throw forced
        if (forced === 'uncertain') {
          replies.push({ address, text })
          return { uncertain: true }
        }
      }
      replies.push({ address, text })
      return { uncertain: false, platformMessageId: `m${replies.length}` }
    },
    async sendFile(address, file) {
      sentFiles.push({ address, file })
      return { uncertain: false }
    },
    replies,
    sentFiles,
  }
  return adapter
}

function sessionStub() {
  const prompts = []
  const listeners = new Set()
  const api = {
    backend: 'native',
    prompts,
    emit(event) {
      for (const cb of [...listeners]) cb(event)
    },
    listenerCount: () => listeners.size,
    async createSession() {
      return { id: 'host-1' }
    },
    async prompt(sessionId, input) {
      prompts.push({ sessionId, input })
    },
    follow(sessionId, cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    async cancel() {},
    async steer() {
      return false
    },
    async listSessions() {
      return []
    },
    async selectModel() {},
    async modelCatalog() {
      return undefined
    },
    async presetsList() {
      return []
    },
    async presetSelect() {
      return { ok: false }
    },
    async fork() {
      return 'forked-1'
    },
    async rename() {
      return true
    },
  }
  return api
}

function makeEngine(over = {}) {
  const adapter = over.adapter ?? adapterStub()
  const sessionApi = over.sessionApi ?? sessionStub()
  const ctx = { logger: () => fakeLogger, get: () => undefined }
  const caps = {
    settingsGeneration: 'gen3',
    sessionBackend: 'native',
    credentials: undefined,
    workspaceFiles: undefined,
    fileUploads: undefined,
    connection: undefined,
    ...(over.caps ?? {}),
  }
  const router = new ChatRouter()
  const dir = mkdtempSync(join(tmpdir(), 'imu-m2-'))
  const deliveryLog = over.noDeliveryLog ? undefined : (over.deliveryLog ?? new DeliveryLog({ file: join(dir, 'deliveries.json') }))
  let engine
  const fragments =
    over.fragments === false
      ? undefined
      : new FragmentBuffer({
          submit: (key, text) => engine.submitFragment(key, text),
          windowMs: over.fragmentWindowMs ?? 30,
          logWarn: () => undefined,
        })
  engine = new ImUnionEngine({
    ctx,
    caps,
    sessionApi,
    router,
    vaultKind: 'file',
    deliveryLog,
    uploads: over.uploads,
    deliverables: over.deliverables,
    fragments,
    exportDir: join(dir, 'exports'),
    turnTimeoutMs: over.turnTimeoutMs,
    onInboundDm: over.onInboundDm,
  })
  engine.registerAccount(adapter, 'a1', { dmAllowlist: new Set(['u1']) })
  const dm = (text, extra = {}) => ({
    address: addressOf('telegram', 'dm', 'c1'),
    userId: 'u1',
    text,
    timestamp: Date.now(),
    ...extra,
  })
  return { engine, adapter, sessionApi, router, deliveryLog, dir, dm }
}

const assistantEvent = (text) => ({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text }] } } })
const turnEnd = () => ({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

// —— T2.4 文件入站 ——————————————————————————————————

test('文件入站：上传面在位 → prompt parts 含 {type:file,receiptId}', async () => {
  const uploads = { mode: 'stream', upload: async (_sid, file) => ({ receiptId: `r-${file.name}` }) }
  const { engine, sessionApi, dm } = makeEngine({ uploads })
  const inflight = engine.handleInbound('a1', dm('看下这个', { files: [{ name: 'a.pdf', data: new Uint8Array(8) }] }))
  await tick()
  assert.equal(sessionApi.prompts.length, 1)
  const input = sessionApi.prompts[0].input
  assert.ok(Array.isArray(input))
  assert.deepEqual(input[0], { type: 'text', text: '看下这个' })
  assert.deepEqual(input[1], { type: 'file', receiptId: 'r-a.pdf' })
  sessionApi.emit(turnEnd())
  await inflight
})

test('文件入站：上传面缺位 → 文件名清单进 prompt、不假装可读', async () => {
  const { engine, sessionApi, dm } = makeEngine({ uploads: { mode: 'none', upload: async () => ({}) } })
  const inflight = engine.handleInbound('a1', dm('读一下', { files: [{ name: 'b.log', data: new Uint8Array(8) }] }))
  await tick()
  const input = sessionApi.prompts[0].input
  // 降级形态：仍走 parts（文本块内含清单说明）——不断言纯串
  assert.ok(Array.isArray(input))
  const textAll = input.filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('\n')
  assert.match(textAll, /b\.log/)
  assert.match(textAll, /附件暂不可用/)
  assert.ok(!input.some((p) => p?.type === 'file'), '缺位时不得伪称已上传')
  sessionApi.emit(turnEnd())
  await inflight
})

// —— T2.4 产物回传 ——————————————————————————————————

test('产物回传：present 事件 + fileOut 渠道 → sendFile 实投', async () => {
  const deliverables = {
    mode: 'workspace',
    read: async (_sid, ref) => ({ name: ref.name, data: new Uint8Array([1, 2, 3]) }),
    status: () => ({ name: 'file-out', status: 'passed' }),
  }
  const { engine, adapter, sessionApi, dm } = makeEngine({ deliverables })
  const inflight = engine.handleInbound('a1', dm('生成报告'))
  await tick()
  sessionApi.emit(assistantEvent('报告如下'))
  sessionApi.emit({ type: 'deliverables/presented', data: { turn: 1, files: [{ path: 'out/report.md' }] } })
  sessionApi.emit(turnEnd())
  await inflight
  assert.equal(adapter.sentFiles.length, 1)
  assert.equal(adapter.sentFiles[0].file.name, 'report.md')
})

test('产物回传缺面：fileOut=false → 文字替代清单（E1 降级不抛）', async () => {
  const deliverables = {
    mode: 'workspace',
    read: async (_sid, ref) => ({ name: ref.name, data: new Uint8Array([1]) }),
    status: () => ({ name: 'file-out', status: 'passed' }),
  }
  const adapter = adapterStub({ caps: { fileOut: false } })
  const { engine, sessionApi, dm } = makeEngine({ adapter, deliverables })
  const inflight = engine.handleInbound('a1', dm('生成'))
  await tick()
  sessionApi.emit({ type: 'deliverables/presented', data: { files: [{ path: 'x/y.bin' }] } })
  sessionApi.emit(turnEnd())
  await inflight
  assert.equal(adapter.sentFiles.length, 0)
  assert.match(adapter.replies.at(-1).text, /本回合产出文件/)
  assert.match(adapter.replies.at(-1).text, /y\.bin/)
})

// —— T2.5 投递记录与补发 ——————————————————————————————————

test('确定性失败入可补发集：/delivery retry 补发成功且标记不回卷', async () => {
  const adapter = adapterStub({
    replyHook: (text, n) => (text === '答案' && n === 0 ? new Error('403 blocked') : undefined),
  })
  const { engine, sessionApi, deliveryLog, dm } = makeEngine({ adapter })
  const inflight = engine.handleInbound('a1', dm('答题'))
  await tick()
  sessionApi.emit(assistantEvent('答案'))
  sessionApi.emit(turnEnd())
  await inflight
  const rec = deliveryLog.retryable()
  assert.equal(rec.length, 1, '失败正文入 outbox 可补发')
  assert.equal(rec[0].summary, '答案')
  const result = await engine.retryDelivery(rec[0].seq)
  assert.match(result, /补发成功/)
  assert.equal(deliveryLog.get(rec[0].seq).status, 'delivered')
  assert.equal(deliveryLog.retryable().length, 0)
})

test('uncertain 绝不补发（D7）', async () => {
  const adapter = adapterStub({ replyHook: () => 'uncertain' })
  const { engine, sessionApi, deliveryLog, dm } = makeEngine({ adapter })
  const inflight = engine.handleInbound('a1', dm('hi'))
  await tick()
  sessionApi.emit(assistantEvent('回复'))
  sessionApi.emit(turnEnd())
  await inflight
  const row = deliveryLog.recent(1)[0]
  assert.equal(row.status, 'uncertain')
  const result = await engine.retryDelivery(row.seq)
  assert.match(result, /仅确定性失败可补发/)
})

test('/export：记录打 ZIP 走 sendFile；渠道无面时落导出目录', async () => {
  const { engine, adapter, sessionApi, deliveryLog, dm, dir } = makeEngine()
  const inflight = engine.handleInbound('a1', dm('hi'))
  await tick()
  sessionApi.emit(assistantEvent('正文'))
  sessionApi.emit(turnEnd())
  await inflight
  assert.ok(deliveryLog.recent(1).length > 0)
  const out = await engine.handleInbound('a1', dm('/export'))
  void out
  await tick()
  assert.equal(adapter.sentFiles.length, 1)
  assert.match(adapter.sentFiles[0].file.name, /imu-export-telegram-c1-.*\.zip$/)
  // 无文件面退落盘
  const adapter2 = adapterStub({ caps: { fileOut: false } })
  const second = makeEngine({ adapter: adapter2, deliveryLog })
  await second.engine.handleInbound('a1', second.dm('/export'))
  await tick()
  assert.match(adapter2.replies.at(-1).text, /ZIP 已写到本机/, '落盘路径交代')
  assert.ok(existsSync(join(second.dir, 'exports')))
})

// —— T2.9 超时迟到补投 ——————————————————————————————————

test('看门狗超时收轮后真 turn/end 到达：一次性补投迟到结果，不重复', async () => {
  const { engine, adapter, sessionApi, dm } = makeEngine({ turnTimeoutMs: 40 })
  const inflight = engine.handleInbound('a1', dm('慢任务'))
  await tick()
  await inflight // 超时即收轮
  assert.match(adapter.replies.at(-1).text, /等待超时/)
  // 迟到：harvest 独立订阅仍在位
  assert.equal(sessionApi.listenerCount(), 1, '收割订阅保持')
  sessionApi.emit(assistantEvent('真结果'))
  sessionApi.emit(turnEnd())
  await tick(20)
  assert.match(adapter.replies.at(-1).text, /迟到的任务结果/)
  const count = adapter.replies.length
  sessionApi.emit(turnEnd())
  await tick(20)
  assert.equal(adapter.replies.length, count, '一次性：不重复投递')
})

// —— T2.8 静音 / 队列 / 目标 ——————————————————————————————————

test('/mute 静音期宿主静默不处理；再切恢复', async () => {
  const { engine, adapter, sessionApi, dm } = makeEngine()
  await engine.handleInbound('a1', dm('/mute'))
  assert.match(adapter.replies.at(-1).text, /已静音/)
  await engine.handleInbound('a1', dm('在吗'))
  assert.equal(sessionApi.prompts.length, 0, '静音期不入队')
  await engine.handleInbound('a1', dm('/mute'))
  assert.match(adapter.replies.at(-1).text, /恢复/)
  const inflight = engine.handleInbound('a1', dm('在吗'))
  await tick()
  assert.equal(sessionApi.prompts.length, 1)
  sessionApi.emit(turnEnd())
  await inflight
})

test('/queue 与 /goal 文案面', async () => {
  const { engine, adapter, dm } = makeEngine()
  await engine.handleInbound('a1', dm('/queue'))
  assert.match(adapter.replies.at(-1).text, /空闲/)
  await engine.handleInbound('a1', dm('/goal 修登录 bug'))
  assert.match(adapter.replies.at(-1).text, /目标已记录/)
  await engine.handleInbound('a1', dm('/goal'))
  assert.match(adapter.replies.at(-1).text, /修登录 bug/)
  await engine.handleInbound('a1', dm('/goal -'))
  assert.match(adapter.replies.at(-1).text, /已清除/)
})

test('T2.8 碎片续写：.. 挂起合并、!! 提交为一个回合；群聊不参与', async () => {
  const { engine, adapter, sessionApi, dm } = makeEngine()
  await engine.handleInbound('a1', dm('第一段..'))
  assert.match(adapter.replies.at(-1).text, /已挂起 1 段/)
  assert.equal(sessionApi.prompts.length, 0)
  await engine.handleInbound('a1', dm('第二段..'))
  assert.match(adapter.replies.at(-1).text, /已挂起 2 段/)
  await engine.handleInbound('a1', dm('!!'))
  await tick()
  assert.equal(sessionApi.prompts.length, 1, '合并后单回合')
  assert.equal(sessionApi.prompts[0].input, '第一段第二段')
  sessionApi.emit(turnEnd())
  await tick()
  // 空提交提示
  await engine.handleInbound('a1', dm('!!'))
  assert.match(adapter.replies.at(-1).text, /没有待提交的碎片/)
  // 群聊走原流程（handled=false 穿透）；不 await——群消息开新回合要收轮才resolve
  const groupMsg = { address: addressOf('telegram', 'group', 'g1'), userId: 'u1', text: '片段..', timestamp: Date.now(), mentionedBot: true }
  void engine.handleInbound('a1', groupMsg)
  await tick()
  assert.equal(sessionApi.prompts.length, 2, '群聊不挂碎片：直接入回合')
  assert.equal(sessionApi.prompts[1].input, '片段..')
  sessionApi.emit(turnEnd())
  await tick()
})

test('主动投递观察：dm 入站在 admitted 前喂 onInboundDm（白名单外也在）', async () => {
  const seen = []
  const { engine, sessionApi, dm } = makeEngine({ onInboundDm: (accountId, message) => seen.push({ accountId, userId: message.userId }) })
  // u1 在白名单；u9 不在——两者都要被观察（syncBack 候选语义）
  void engine.handleInbound('a1', dm('hi'))
  await tick()
  await engine.handleInbound('a1', { ...dm('hi'), userId: 'u9' })
  assert.deepEqual(seen.map((s) => s.userId), ['u1', 'u9'])
  sessionApi.emit(turnEnd())
  await tick()
})
