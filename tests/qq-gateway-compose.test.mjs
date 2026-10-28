// F1 招牌主张的**组合级**证据：模型输出 ```svg 围栏 → gateway 净化抽取 → sharp 渲染 PNG →
// **真实 QqAdapter.sendFile** 上传换 file_info → msg_type=7 投递。
// 此前只分两段证过（gateway 用假适配器 / QQ 适配器独立桩跑），二者串联从未被证明；本文件补上。
// 零真实网络：fetchImpl 注入协议形桩（WS 不参与——出站链路只需 REST，引擎不触发 connect）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { ImUnionEngine, addressOf } from '../lib/engine/gateway.js'
import { ChatRouter } from '../lib/engine/router.js'
import { QqAdapter } from '../lib/channels/qq.js'

const tick = (ms = 8) => new Promise((resolve) => setTimeout(resolve, ms))
const jsonResp = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload })
const parseJson = (t) => {
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 0 160 80">' +
  '<rect width="160" height="80" fill="#ffffff"/><text x="10" y="46" font-size="24">chart</text></svg>'

function stubHttp() {
  const state = { sends: [], uploads: [], fiSeq: 0, sendSeq: 0 }
  const impl = async (url, init) => {
    const method = String(init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? parseJson(init?.body) : init?.body
    if (url.endsWith('/app/getAppAccessToken')) return jsonResp(200, { access_token: 'STUB-AT', expires_in: 7200 })
    if (method === 'POST' && /\/v2\/(users|groups)\/[^/]+\/files$/.test(url)) {
      state.uploads.push({ url, body, raw: init?.body })
      return jsonResp(200, { file_info: 'FI-' + (++state.fiSeq), url: 'https://qq.test/fi', ttl: 3600 })
    }
    if (method === 'POST' && /\/v2\/(users|groups)\/[^/]+\/messages$/.test(url)) {
      state.sends.push(body)
      return jsonResp(200, { id: 'S-' + (++state.sendSeq) })
    }
    return jsonResp(200, {})
  }
  return { impl, state }
}

function liveSession() {
  const state = { listener: undefined, prompted: [] }
  return {
    backend: 'native',
    async createSession() {
      return { id: 'x' }
    },
    async prompt(sessionId, input) {
      state.prompted.push({ sessionId, input })
    },
    follow(_sid, onEvent) {
      state.listener = onEvent
      return () => {
        state.listener = undefined
      }
    },
    async cancel() {},
    async listSessions() {
      return []
    },
    async selectModel() {},
    emit(event) {
      state.listener?.(event)
    },
    state,
  }
}

const assistantEvent = (text) => ({
  type: 'assistant/message',
  data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } },
})
const turnEnd = () => ({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

const waitUntil = async (fn, ms = 8000) => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('waitUntil 超时')
    await tick(10)
  }
}

test('组合链：模型出 svg 围栏 → gateway 抽图 → sharp 渲染 → 真实 QqAdapter.sendFile 走 msg_type=7', async () => {
  const http = stubHttp()
  const adapter = new QqAdapter({
    appId: 'STUB-APPID',
    appSecret: 'STUB-SECRET',
    apiBase: 'https://stub.test',
    tokenUrl: 'https://bots.stub.test/app/getAppAccessToken',
    fetchImpl: http.impl,
  })
  // 前置：本用例成立的条件是「真适配器自声明出站图片能力」，否则 gateway 闸门会走降级分支。
  assert.equal(adapter.caps.fileOut, true)
  assert.equal(typeof adapter.sendFile, 'function')

  const session = liveSession()
  const engine = new ImUnionEngine({
    ctx: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }), get: () => undefined },
    caps: { settingsGeneration: 'gen3', sessionBackend: 'native', credentials: undefined },
    sessionApi: session,
    router: new ChatRouter(),
  })
  engine.registerAccount(adapter, 'acct-qq', { dmAllowlist: new Set(['u1']) })

  const address = addressOf('qq', 'dm', 'OPENID-DM')
  const inflight = engine.handleInbound('acct-qq', { address, userId: 'u1', text: '画个图', mentionedBot: false })
  await waitUntil(() => session.state.prompted.length === 1)
  session.emit(assistantEvent('这是图表：\n\n```svg\n' + SVG + '\n```'))
  session.emit(turnEnd())
  await inflight
  await tick(40)

  // ① 出图链真的产出了图片上传（官方 SDK 小文件形态：JSON + base64 PNG），而非降级纯文字。
  assert.ok(http.state.uploads.length >= 1, '应有 /files 上传（若 sharp 缺位则此处为 0，即降级）')
  const upload = http.state.uploads[0]
  assert.match(upload.url, /\/v2\/users\/OPENID-DM\/files$/)
  assert.equal(upload.body.file_type, 1, '图片档 file_type=1')
  assert.equal(upload.body.srv_send_msg, false, '不得让平台代发消息')
  const png = Buffer.from(String(upload.body.file_data), 'base64')
  assert.ok(png.length > 0, 'base64 解出的 PNG 非空')
  assert.deepEqual([...png.subarray(1, 4)], ['P', 'N', 'G'].map((ch) => ch.charCodeAt(0)), '确为 sharp 渲染出的 PNG 魔数')

  // ② 富媒体消息：msg_type=7 携带上一步换来的 file_info（官方体形 media 包裹）。
  const rich = http.state.sends.find((b) => b.msg_type === 7)
  assert.ok(rich, '应发出 msg_type=7 图片消息')
  assert.equal(rich.media.file_info, 'FI-1')
  // ③ 正文仍在（附图不吞正文），且图片消息在正文之后投递。
  const textFirst = http.state.sends.findIndex((b) => b.msg_type === 0 || b.msg_type === 2)
  assert.ok(textFirst >= 0 && http.state.sends.indexOf(rich) > textFirst, '先正文后附图')
  await adapter.disconnect()
})
