// T1.7 图片输入公共层 + 渠道图片下载链路 + 网关接线。
import test from 'node:test'
import assert from 'node:assert/strict'
import { visionSupported, prepareImages, toPromptParts, IMAGE_BUDGET } from '../lib/engine/media.js'
import { ImUnionEngine, addressOf } from '../lib/engine/gateway.js'
import { ChatRouter } from '../lib/engine/router.js'
import { TelegramAdapter } from '../lib/channels/telegram.js'
import { DiscordAdapter } from '../lib/channels/discord.js'

const png = (bytes = 1024) => new Uint8Array(bytes).fill(0x89)

const capsWith = (llm) => ({ llm })

test('visionSupported：元数据三态（支持/明确不支持/未知）', async () => {
  assert.equal(await visionSupported(capsWith({ resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }), { provider: 'p', model: 'm' }), true)
  assert.equal(await visionSupported(capsWith({ resolveModelInfo: async () => ({ inputModalities: ['text'] }) }), { provider: 'p', model: 'm' }), false)
  assert.equal(await visionSupported(capsWith({ resolveModelInfo: async () => ({}) }), { provider: 'p', model: 'm' }), undefined, '无元数据=未知，不替宿主否定')
  assert.equal(await visionSupported(capsWith({ resolveModelInfo: async () => { throw new Error('boom') } }), { provider: 'p', model: 'm' }), undefined, '查询失败=未知')
  assert.equal(await visionSupported(capsWith({}), { provider: 'p', model: 'm' }), undefined, '无 llm 面=未知')
  assert.equal(await visionSupported(capsWith({ resolveModelInfo: async () => ({ inputModalities: ['image'] }) }), undefined), undefined, '无选择=未知')
})

test('prepareImages：数量/单图/总量/格式四类预算丢弃各有说明', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ name: `i${i}`, data: png(100), mimeType: 'image/png' }))
  const r1 = prepareImages(many, true)
  assert.equal(r1.parts.length, IMAGE_BUDGET.maxCount)
  assert.match(r1.notes.join(), /上限 4 张/)

  const big = prepareImages([{ name: 'big', data: png(IMAGE_BUDGET.perImageMaxBytes + 1), mimeType: 'image/png' }], true)
  assert.equal(big.parts.length, 0)
  assert.match(big.notes.join(), /2 MiB/)

  const weird = prepareImages([{ name: 'x', data: png(10), mimeType: 'image/tiff' }], true)
  assert.equal(weird.parts.length, 0)
  assert.match(weird.notes.join(), /不支持的图片格式/)

  const nearMax = IMAGE_BUDGET.perImageMaxBytes - 1
  const total = [
    { name: 'a', data: png(nearMax), mimeType: 'image/png' },
    { name: 'b', data: png(nearMax), mimeType: 'image/png' },
    { name: 'c', data: png(nearMax), mimeType: 'image/png' },
    { name: 'd', data: png(nearMax), mimeType: 'image/png' },
  ]
  const r2 = prepareImages(total, true)
  assert.equal(r2.parts.length, 3)
  assert.match(r2.notes.join(), /总量/)
})

test('prepareImages：不支持视觉全丢弃；未知视觉放行；base64 正确', () => {
  const off = prepareImages([{ name: 'a', data: png(4), mimeType: 'image/png' }], false)
  assert.equal(off.parts.length, 0)
  assert.match(off.notes.join(), /不支持图片输入/)
  const unknown = prepareImages([{ name: 'a', data: new Uint8Array([1, 2, 3, 4]), mimeType: 'image/png' }], undefined)
  assert.equal(unknown.parts[0].data, Buffer.from([1, 2, 3, 4]).toString('base64'))
  assert.equal(unknown.parts[0].type, 'image')
  assert.equal(unknown.parts[0].mediaType, 'image/png')
})

test('toPromptParts：文本在前图依序；notes 不混入 prompt', () => {
  const prepared = prepareImages([{ name: 'a', data: png(8), mimeType: 'image/png' }], true)
  const parts = toPromptParts('看这张图', prepared)
  assert.equal(parts[0].type, 'text')
  assert.equal(parts[0].text, '看这张图')
  assert.equal(parts[1].type, 'image')
  const empty = toPromptParts('', { parts: [], notes: ['忽略说明'] })
  assert.equal(empty[0].text, '', '无内容时保底 text part（宿主面要求非空 content）')
})

// —— 网关接线 ——————————————————————————————————————————

const fakeLogger = () => ({ debug() {}, info() {}, warn() {}, error() {} })

test('runTurn：图片走 parts 形态 prompt，vision 元数据不支持时 notes 回渠道用户', async () => {
  const prompts = []
  const adapter = {
    id: 'telegram',
    label: 't',
    caps: { maxMessageLength: 4096 },
    connected: true,
    async connect() {},
    async disconnect() {},
    onMessage() { return () => {} },
    replies: [],
    async reply(address, text) { this.replies.push(text); return { uncertain: false } },
    authorize: () => undefined,
  }
  const sessionApi = {
    backend: 'native',
    async createSession() { return { id: 's-img' } },
    async prompt(sessionId, input) { prompts.push({ sessionId, input }) },
    follow() { return () => {} },
    async cancel() {},
    async listSessions() { return [] },
    async selectModel() {},
  }
  const ctx = { logger: fakeLogger, get: () => undefined }
  const caps = {
    settingsGeneration: 'gen3',
    sessionBackend: 'native',
    llm: { resolveModelInfo: async (provider, model) => ({ inputModalities: provider === 'prov' && model === 'm-text' ? ['text'] : ['text', 'image'] }) },
  }
  const engine = new ImUnionEngine({ ctx, caps, sessionApi, router: new ChatRouter(), turnTimeoutMs: 30 })
  engine.registerAccount(adapter, 'a1', { dmAllowlist: new Set(['u1']) })
  // /model prov/m-text（纯文本模型）→ selections 记 chatKey
  await engine.handleInbound('a1', { address: addressOf('telegram', 'dm', 'c1'), userId: 'u1', text: '/model prov/m-text', mentionedBot: false })
  await engine.handleInbound('a1', {
    address: addressOf('telegram', 'dm', 'c1'),
    userId: 'u1',
    text: '看看这个截图',
    mentionedBot: false,
    images: [{ name: 'shot.png', data: png(64), mimeType: 'image/png' }],
  })
  assert.equal(prompts.length, 1)
  assert.equal(typeof prompts[0].input, 'object', '图片走 content parts 而非裸字符串')
  assert.equal(prompts[0].input[0].type, 'text')
  assert.ok(!JSON.stringify(prompts[0].input).includes('不支持图片输入'), '忽略说明不进模型 prompt')
  assert.ok(adapter.replies.some((r) => /不支持图片输入/.test(r)), '说明回给了渠道用户')
})

// —— 渠道下载 ——————————————————————————————————————————

const tresp = (status, body, buffer) => ({
  ok: status >= 200 && status < 399,
  status,
  json: async () => body,
  arrayBuffer: async () => buffer ?? new ArrayBuffer(0),
})

test('telegram：photo 走 getFile→下载→images，失败降级纯文本', async () => {
  let downloadFails = false
  const calls = []
  const impl = async (url, init) => {
    const method = url.split('/').pop()
    calls.push(method)
    if (method === 'getMe') return tresp(200, { ok: true, result: { username: 'demo_bot' } })
    if (method === 'getUpdates') {
      if (calls.filter((c) => c === 'getUpdates').length > 1) {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('a'), { name: 'AbortError' })), { once: true })
        })
      }
      return tresp(200, {
        ok: true,
        result: [{ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 5, type: 'private' }, from: { id: 9 }, text: '看图', photo: [{ file_id: 's', file_size: 100 }, { file_id: 'l', file_size: 900 }] } }],
      })
    }
    if (method === 'getFile') return tresp(200, { ok: true, result: { file_path: 'photos/l.jpg' } })
    if (method === 'l.jpg') {
      if (downloadFails) throw new Error('cdn down')
      return tresp(200, { ok: true }, new Uint8Array([1, 2, 3]).buffer)
    }
    throw new Error('unexpected ' + method)
  }
  const adapter = new TelegramAdapter({ token: 'TOK', fetchImpl: impl, apiBase: 'https://api.test' })
  const got = []
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  await new Promise((resolve) => setTimeout(resolve, 40))
  await adapter.disconnect()
  assert.equal(got.length, 1)
  assert.equal(got[0].images.length, 1)
  assert.equal(got[0].images[0].mimeType, 'image/jpeg')
  assert.deepEqual([...got[0].images[0].data], [1, 2, 3])
  assert.ok(calls.includes('getFile'), 'file_id 走了 getFile')
})

const dresp = (status, body, buffer) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  arrayBuffer: async () => buffer ?? new ArrayBuffer(0),
})

test('discord：attachments 图下载进 images，非图跳过，失败不丢消息', async () => {
  const urls = []
  const impl = async (url) => {
    urls.push(url)
    if (url.endsWith('/users/@me')) return dresp(200, { id: '42', username: 'unibot' })
    if (url.endsWith('/gateway')) return dresp(200, { url: 'wss://gateway.test' })
    if (url.includes('cdn.test/cat.png')) return dresp(200, {}, new Uint8Array([7, 7, 7]).buffer)
    if (url.includes('cdn.test/doc.pdf')) return dresp(200, {})
    return dresp(404, {})
  }
  const made = []
  const wsFactory = () => {
    const listeners = {}
    const ws = {
      sent: [],
      readyState: 1,
      close() {},
      send(d) { ws.sent.push(JSON.parse(d)) },
      addEventListener(t, cb) { listeners[t] = cb },
      emit(frame) { listeners.message?.({ data: JSON.stringify(frame) }) },
    }
    made.push(ws)
    return ws
  }
  const adapter = new DiscordAdapter({ token: 'DT', fetchImpl: impl, WebSocketImpl: wsFactory, apiBase: 'https://api.test' })
  await adapter.connect()
  const socket = made[0]
  socket.emit({ op: 10, d: { heartbeat_interval: 45000 } })
  socket.emit({ op: 0, t: 'READY', s: 1, d: {} })
  const got = []
  adapter.onMessage((m) => got.push(m))
  socket.emit({
    op: 0,
    t: 'MESSAGE_CREATE',
    s: 2,
    d: {
      channel_id: '202',
      author: { id: '7', username: 'bob' },
      content: '附件',
      attachments: [
        { id: 'a1', filename: 'cat.png', content_type: 'image/png', url: 'https://cdn.test/cat.png' },
        { id: 'a2', filename: 'doc.pdf', content_type: 'application/pdf', url: 'https://cdn.test/doc.pdf' },
      ],
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(got.length, 1)
  assert.equal(got[0].images.length, 1)
  assert.equal(got[0].images[0].mimeType, 'image/png')
  assert.equal(got[0].images[0].name, 'cat.png')
  await adapter.disconnect()
})
