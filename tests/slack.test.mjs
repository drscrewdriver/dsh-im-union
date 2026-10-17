// T2.3 Slack 渠道单测：Socket Mode 握手 / events_api 帧归一与 envelope ACK /
// chat.postMessage·chat.update body 形态与 ok:false 判型 / 编辑流式（节流·
// not_found 补发接替·rate_limited 确定性）/ mrkdwn 转换 / disconnect·canary 重连 /
// 诊断三态 / 工厂双 token。网络面全注入 fake fetch·WebSocket，零真实请求。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SlackAdapter,
  SlackApiError,
  SlackUncertainError,
  createSlackAdapter,
  toSlackMrkdwn,
} from '../lib/channels/slack.js'

const BOT = 'xoxb-bot'
const APP = 'xapp-bot'

const resp = (status, body) => ({
  ok: status >= 200 && status < 399,
  status,
  json: async () => body,
})

const authOk = () =>
  resp(200, { ok: true, url: 'https://acme.slack.com/api/', team: 'Acme', team_id: 'T111', user: 'imbot', user_id: 'U_BOT', bot_id: 'B222' })
const openOk = (ticket = 't-1') => resp(200, { ok: true, url: `wss://wss.slack.com/link/?ticket=${ticket}` })
const posted = (ts) => resp(200, { ok: true, channel: 'C1', ts, message: { ts } })

/** 默认路由：全部成功；postMessage 依次返回递增 ts。 */
function defaultRoute() {
  let seq = 0
  return (method) => {
    switch (method) {
      case 'auth.test':
        return authOk()
      case 'apps.connections.open':
        return openOk()
      case 'chat.postMessage':
        seq += 1
        return posted(`1700.00000${seq}`)
      case 'chat.update':
        return resp(200, { ok: true, channel: 'C1', ts: '1700.000001' })
      default:
        return resp(200, { ok: true })
    }
  }
}

function fakeFetch(route) {
  const calls = []
  const impl = async (url, init) => {
    const method = url.slice(url.lastIndexOf('/') + 1)
    const parsed = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ url, method, init, body: parsed })
    return route(method, calls[calls.length - 1], calls)
  }
  const byMethod = (name) => calls.filter((c) => c.method === name)
  return { impl, calls, byMethod }
}

function fakeWS() {
  const made = []
  const factory = (url) => {
    const listeners = {}
    const sock = {
      url,
      sent: [],
      readyState: 1,
      closed: false,
      send(data) {
        if (sock.closed) throw new Error('send on closed socket')
        sock.sent.push(JSON.parse(data))
      },
      close() {
        sock.closed = true
        sock.emit('close', {})
      },
      addEventListener(type, cb) {
        ;(listeners[type] ??= []).push(cb)
      },
      emit(type, event) {
        for (const cb of listeners[type] ?? []) cb(event)
      },
      frame(obj) {
        sock.emit('message', { data: JSON.stringify(obj) })
      },
    }
    made.push(sock)
    return sock
  }
  return { factory, made }
}

const helloFrame = (approximateConnectionTime = 3600) => ({
  type: 'hello',
  connection_info: { app_id: 'A1' },
  num_connections: 1,
  debug_info: { host: 'wss://wss.slack.com', build_number: 54, approximate_connection_time: approximateConnectionTime },
})

const eventsFrame = (envelopeId, event) => ({
  type: 'events_api',
  envelope_id: envelopeId,
  accepts_response_payload: false,
  payload: {
    token: 'v',
    team_id: 'T111',
    api_app_id: 'A1',
    event,
    event_id: `Ev-${envelopeId}`,
    event_time: 1700,
    type: 'event_callback',
  },
})

const imEvent = (over = {}) => ({
  type: 'message',
  channel: 'D9',
  channel_type: 'im',
  user: 'U7',
  text: 'hi',
  ts: '1700.000001',
  ...over,
})
const channelEvent = (over = {}) => ({
  type: 'message',
  channel: 'C1',
  channel_type: 'channel',
  user: 'U7',
  text: 'hello',
  ts: '1700.000001',
  ...over,
})

/** 握手完成后的适配器 + socket（可选注入 fetch 路由覆盖）。 */
async function connectedAdapter(route, options = {}) {
  const ws = fakeWS()
  const fetch = fakeFetch(route ?? defaultRoute())
  const adapter = new SlackAdapter({
    botToken: BOT,
    appToken: APP,
    fetchImpl: fetch.impl,
    WebSocketImpl: ws.factory,
    editThrottleMs: 5,
    reconnectBaseMs: 5,
    ...options,
  })
  const collected = []
  adapter.onMessage((m) => collected.push(m))
  const inflight = adapter.connect()
  await new Promise((r) => setTimeout(r, 0))
  const sock = ws.made[0]
  sock.emit('open', {})
  sock.frame(helloFrame())
  await inflight
  return { adapter, sock, ws, fetch, collected }
}

/** 逐例自带路由的握手套件（复用 fakeFetch 记录面）。 */
async function connectedAdapterWith(fetch) {
  return connectedAdapter(undefined, { fetchImpl: fetch.impl })
}

async function waitUntil(fn, timeout = 1500) {
  const started = Date.now()
  while (!fn()) {
    if (Date.now() - started > timeout) throw new Error('waitUntil 超时')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const dm = { channel: 'slack', kind: 'dm', chatId: 'D9' }
const group = { channel: 'slack', kind: 'group', chatId: 'C1' }

// —— 握手 ——————————————————————————————————————————

test('connect：先 auth.test（bot token）再 apps.connections.open（app token），hello 帧后才算连接', async () => {
  const { adapter, ws, fetch, sock } = await connectedAdapter()
  assert.equal(adapter.connected, true)
  assert.deepEqual(
    fetch.calls.map((c) => c.method),
    ['auth.test', 'apps.connections.open'],
  )
  assert.equal(fetch.calls[0].init.headers.authorization, `Bearer ${BOT}`)
  assert.equal(fetch.calls[1].init.headers.authorization, `Bearer ${APP}`)
  assert.equal(ws.made.length, 1)
  assert.equal(sock.url, 'wss://wss.slack.com/link/?ticket=t-1')
  await adapter.disconnect()
  assert.equal(adapter.connected, false)
})

test('apps.connections.open：token 只走 Authorization 头，不进 POST body（文档明确参数形会被拒）', async () => {
  const { fetch } = await connectedAdapter()
  const open = fetch.byMethod('apps.connections.open')[0]
  assert.equal(open.body.token, undefined)
  assert.deepEqual(open.body, {})
  assert.equal(open.init.method, 'POST')
})

test('connect：握手期 WS error/close → SlackUncertainError（不伪装确定性失败）', async () => {
  const ws = fakeWS()
  const adapter = new SlackAdapter({
    botToken: BOT,
    appToken: APP,
    fetchImpl: fakeFetch(defaultRoute()).impl,
    WebSocketImpl: ws.factory,
    reconnectBaseMs: 5,
  })
  const inflight = adapter.connect()
  await new Promise((r) => setTimeout(r, 0))
  ws.made[0].emit('error', {})
  await assert.rejects(inflight, SlackUncertainError)
  assert.equal(adapter.connected, false)
})

test('connect：auth.test 明确拒绝（invalid_auth）确定性抛 SlackApiError', async () => {
  const route = (method) => (method === 'auth.test' ? resp(200, { ok: false, error: 'invalid_auth' }) : defaultRoute()(method))
  const adapter = new SlackAdapter({
    botToken: BOT,
    appToken: APP,
    fetchImpl: fakeFetch(route).impl,
    WebSocketImpl: fakeWS().factory,
  })
  await assert.rejects(adapter.connect(), (error) => error instanceof SlackApiError && error.error === 'invalid_auth')
})

// —— 入站帧归一 ——————————————————————————————————————————

test('events_api：im 事件 → dm 会话，且回 envelope ACK 帧', async () => {
  const { sock, collected } = await connectedAdapter()
  sock.frame(eventsFrame('En-1', imEvent({ text: '你好' })))
  assert.equal(collected.length, 1)
  const msg = collected[0]
  assert.deepEqual(msg.address, { channel: 'slack', kind: 'dm', chatId: 'D9' })
  assert.equal(msg.userId, 'U7')
  assert.equal(msg.text, '你好')
  assert.equal(msg.mentionedBot, false)
  assert.equal(msg.timestamp, 1700000)
  assert.deepEqual(sock.sent.at(-1), { envelope_id: 'En-1', payload: {} })
})

test('events_api：频道消息默认也回调 → 只有正文含 <@BOT user id> 才算被 @', async () => {
  const { sock, collected } = await connectedAdapter()
  sock.frame(eventsFrame('En-1', channelEvent({ text: 'plain talk' })))
  sock.frame(eventsFrame('En-2', channelEvent({ text: 'hey <@U_BOT> look' })))
  sock.frame(eventsFrame('En-3', channelEvent({ text: 'alt <@U_BOT|imbot> hi' })))
  assert.equal(collected.length, 3)
  assert.equal(collected[0].mentionedBot, false)
  assert.equal(collected[0].address.kind, 'group')
  assert.equal(collected[1].mentionedBot, true)
  assert.equal(collected[2].mentionedBot, true)
})

test('events_api：app_mention 事件恒算被 @；私聊恒 false', async () => {
  const { sock, collected } = await connectedAdapter()
  sock.frame(eventsFrame('En-1', { type: 'app_mention', channel: 'C1', channel_type: 'channel', user: 'U7', text: '<@U_BOT>', ts: '1700.2' }))
  sock.frame(eventsFrame('En-2', { type: 'app_mention', channel: 'D9', channel_type: 'im', user: 'U7', text: '<@U_BOT>', ts: '1700.3' }))
  assert.equal(collected[0].mentionedBot, true)
  assert.equal(collected[1].mentionedBot, false)
  assert.equal(collected[1].address.kind, 'dm')
})

test('events_api：thread 内消息（thread_ts ≠ ts）→ ChatAddress.threadId；顶层消息不设 threadId', async () => {
  const { sock, collected } = await connectedAdapter()
  sock.frame(eventsFrame('En-1', channelEvent({ text: 'root', ts: '1700.100' })))
  sock.frame(eventsFrame('En-2', channelEvent({ text: 'reply', ts: '1700.200', thread_ts: '1700.100' })))
  sock.frame(eventsFrame('En-3', channelEvent({ text: 'self', ts: '1700.300', thread_ts: '1700.300' })))
  assert.equal(collected[0].address.threadId, undefined)
  assert.equal(collected[1].address.threadId, '1700.100')
  assert.equal(collected[1].address.chatId, 'C1')
  assert.equal(collected[2].address.threadId, undefined)
})

test('events_api：机器人回声（bot_id 非空）、subtype 事件、非消息类型一律丢弃', async () => {
  const { sock, collected } = await connectedAdapter()
  sock.frame(eventsFrame('En-1', channelEvent({ bot_id: 'B222', text: 'self echo' })))
  sock.frame(eventsFrame('En-2', channelEvent({ subtype: 'channel_join', text: 'joined' })))
  sock.frame(eventsFrame('En-3', { type: 'reaction_added', user: 'U7', item: {} }))
  sock.frame(eventsFrame('En-4', { type: 'message', user: 'U7', text: 'no channel' }))
  assert.equal(collected.length, 1)
  assert.equal(collected[0].address.chatId, 'U7')
  assert.equal(collected[0].address.kind, 'group')
})

test('events_api：同 envelope_id 重投排重（Socket Mode 未 ACK 会重投），但每帧都回 ACK', async () => {
  const { sock, collected } = await connectedAdapter()
  sock.frame(eventsFrame('En-1', imEvent()))
  sock.frame(eventsFrame('En-1', imEvent()))
  assert.equal(collected.length, 1)
  assert.equal(sock.sent.filter((f) => f.envelope_id === 'En-1').length, 2)
})

test('events_api：容忍 payload.events 数组形', async () => {
  const { sock, collected } = await connectedAdapter()
  sock.frame({
    type: 'events_api',
    envelope_id: 'En-9',
    payload: { events: [imEvent({ text: 'a' }), imEvent({ text: 'b', ts: '1700.000002' })] },
  })
  assert.equal(collected.length, 2)
  assert.deepEqual(sock.sent.at(-1), { envelope_id: 'En-9', payload: {} })
})

test('interactive / slash_commands 首版不消费业务，但仍回 ACK 防重投', async () => {
  const { sock, collected } = await connectedAdapter()
  sock.frame({ type: 'interactive', envelope_id: 'En-i', payload: { type: 'block_actions' } })
  sock.frame({ type: 'slash_commands', envelope_id: 'En-s', payload: { command: '/go' } })
  assert.equal(collected.length, 0)
  assert.deepEqual(sock.sent.map((f) => f.envelope_id), ['En-i', 'En-s'])
})

const binResp = (status, bytes) => ({
  ok: status >= 200 && status < 399,
  status,
  json: async () => undefined,
  arrayBuffer: async () => new Uint8Array(bytes).buffer,
})

test('附件事件：非图走 url_private 异步 fill 进 files；图不下载（imageIn=false）', async () => {
  const route = (method, call, all) => {
    if (method === 'a.pdf') return binResp(200, [1, 2, 3])
    return defaultRoute()(method, call, all)
  }
  const { sock, collected, fetch } = await connectedAdapter(route)
  sock.frame(eventsFrame('En-1', imEvent({ text: '', files: [{ name: 'shot.png', mimetype: 'image/png', url_private: 'https://files.slack.com/shot.png' }] })))
  sock.frame(eventsFrame('En-2', imEvent({ text: 'see this', ts: '1700.000002', files: [{ name: 'a.pdf', url_private: 'https://files.slack.com/a.pdf' }, { name: 'b.pdf' }] })))
  await waitUntil(() => collected.length === 2)
  assert.equal(collected[0].text, '[shot.png]', '图事件仍不丢（占位文案）')
  assert.equal(collected[0].files, undefined, '图引用不下载')
  assert.equal(collected[1].text, 'see this\n[附件 2：a.pdf 等]')
  assert.deepEqual([...collected[1].files[0].data], [1, 2, 3], '非图字节归一到 files')
  assert.equal(collected[1].files[0].name, 'a.pdf')
  assert.equal(collected[1].files.length, 1, '无 url_private 的引用不下载')
  const dl = fetch.calls.find((c) => c.method === 'a.pdf')
  assert.equal(dl.init.headers.authorization, `Bearer ${BOT}`, 'url_private 下载带 bot token')
  assert.equal(fetch.calls.find((c) => c.method === 'shot.png'), undefined, '图 URL 不发起下载')
})

test('入站文件下载失败 → 降级为无附件，不丢整条消息', async () => {
  const route = (method, call, all) => {
    if (method === 'a.pdf') return resp(403, {})
    return defaultRoute()(method, call, all)
  }
  const { sock, collected } = await connectedAdapter(route)
  sock.frame(eventsFrame('En-1', imEvent({ text: '请看附件', ts: '1700.000003', files: [{ name: 'a.pdf', url_private: 'https://files.slack.com/a.pdf' }] })))
  await waitUntil(() => collected.length === 1)
  assert.equal(collected[0].files, undefined)
  assert.match(collected[0].text, /请看附件/)
})

test('入站文件超 20 MiB → 不下载（引擎 FILE_BUDGET 限额，渠道不自设更大）', async () => {
  const route = (method, call, all) => {
    if (method === 'big.bin') throw new Error('不应发起下载')
    return defaultRoute()(method, call, all)
  }
  const { sock, collected } = await connectedAdapter(route)
  sock.frame(
    eventsFrame(
      'En-1',
      imEvent({
        text: '大文件',
        ts: '1700.000004',
        files: [{ name: 'big.bin', url_private: 'https://files.slack.com/big.bin', size: 21 * 1024 * 1024 }],
      }),
    ),
  )
  await waitUntil(() => collected.length === 1)
  assert.equal(collected[0].files, undefined)
})

// —— 出站与判型 ——————————————————————————————————————————

test('reply：chat.postMessage body 形态（channel/text），返回 platformMessageId', async () => {
  const { adapter, fetch } = await connectedAdapter()
  const receipt = await adapter.reply(dm, 'hello **world**')
  assert.deepEqual(receipt, { platformMessageId: '1700.000001', uncertain: false })
  const call = fetch.byMethod('chat.postMessage')[0]
  assert.deepEqual(call.body, { channel: 'D9', text: 'hello *world*' })
  assert.equal(call.init.headers.authorization, `Bearer ${BOT}`)
})

test('reply：thread 地址 → thread_ts 挂父消息 ts', async () => {
  const { adapter, fetch } = await connectedAdapter()
  await adapter.reply({ channel: 'slack', kind: 'group', chatId: 'C1', threadId: '1700.100' }, 'in thread')
  assert.deepEqual(fetch.byMethod('chat.postMessage')[0].body, {
    channel: 'C1',
    text: 'in thread',
    thread_ts: '1700.100',
  })
})

test('判型：HTTP 200 但 body.ok=false → 确定性 SlackApiError（不看 HTTP 状态）', async () => {
  const route = (method) => (method === 'chat.postMessage' ? resp(200, { ok: false, error: 'channel_not_found' }) : defaultRoute()(method))
  const { adapter } = await connectedAdapter(route)
  await assert.rejects(adapter.reply(group, 'x'), (error) => error instanceof SlackApiError && error.error === 'channel_not_found')
})

test('判型：rate_limited（HTTP 429 + Retry-After）是明确拒绝 → 确定性可告知，非 uncertain', async () => {
  const route = (method) => (method === 'chat.postMessage' ? resp(429, { ok: false, error: 'rate_limited' }) : defaultRoute()(method))
  const { adapter } = await connectedAdapter(route)
  await assert.rejects(adapter.reply(group, 'x'), (error) => error instanceof SlackApiError && error.error === 'rate_limited' && !(error instanceof SlackUncertainError))
})

test('判型：网络异常 / 5xx 无错误码 / 响应体不可解析 → SlackUncertainError', async () => {
  const net = await connectedAdapter((method, call, calls) => {
    if (method === 'chat.postMessage') throw new Error('socket hang up')
    return defaultRoute()(method, call, calls)
  })
  await assert.rejects(net.adapter.reply(group, 'x'), SlackUncertainError)

  const gw = await connectedAdapter((method) => (method === 'chat.postMessage' ? resp(503, '<html>bad gateway</html>') : defaultRoute()(method)))
  await assert.rejects(gw.adapter.reply(group, 'x'), SlackUncertainError)

  const broken = await connectedAdapter((method) => (method === 'chat.postMessage' ? resp(200, undefined) : defaultRoute()(method)))
  await assert.rejects(broken.adapter.reply(group, 'x'), SlackUncertainError)
})

test('reply：uncertain 只上抛不返回 Receipt，且适配器不自行重发（D7 宁可漏发不双发）', async () => {
  const { adapter, fetch } = await connectedAdapter((method) => {
    if (method === 'chat.postMessage') throw new Error('socket hang up')
    return defaultRoute()(method)
  })
  await assert.rejects(adapter.reply(group, 'x'), SlackUncertainError)
  assert.equal(fetch.byMethod('chat.postMessage').length, 1)
})

test('出站长度：超上限按 caps.maxMessageLength 截断（Slack >40000 会被服务端截断）', async () => {
  const { adapter, fetch } = await connectedAdapter()
  await adapter.reply(group, 'x'.repeat(45000))
  const text = fetch.byMethod('chat.postMessage')[0].body.text
  assert.equal(text.length, 40000)
  assert.ok(text.endsWith('…'))
})

// —— 编辑流式 ——————————————————————————————————————————

test('beginStream：首次占位 postMessage，后续 chat.update 同一条消息并节流', async () => {
  const stamps = []
  const base = defaultRoute()
  const route = (method, call, calls) => {
    if (method === 'chat.update') stamps.push(Date.now())
    return base(method, call, calls)
  }
  const { adapter, fetch } = await connectedAdapter(route, { editThrottleMs: 40 })
  const stream = await adapter.beginStream(group)
  await stream.update('a')
  await stream.update('ab')
  const receipt = await stream.finish('abc')
  assert.equal(receipt.uncertain, false)
  assert.equal(receipt.platformMessageId, '1700.000001')
  assert.equal(fetch.byMethod('chat.postMessage').length, 1)
  const updates = fetch.byMethod('chat.update')
  assert.equal(updates.length, 2)
  assert.deepEqual(updates[0].body, { channel: 'C1', ts: '1700.000001', text: 'ab' })
  assert.deepEqual(updates.at(-1).body, { channel: 'C1', ts: '1700.000001', text: 'abc' })
  assert.ok(stamps.length === 2 && stamps[1] - stamps[0] >= 30, `节流间隔不足：${stamps}`)
})

test('beginStream：thread 内流式同样成立（postMessage 带 thread_ts，chat.update 同频道）', async () => {
  const { adapter, fetch } = await connectedAdapter()
  const stream = await adapter.beginStream({ channel: 'slack', kind: 'group', chatId: 'C1', threadId: '1700.100' })
  await stream.update('one')
  await stream.update('two')
  assert.equal(fetch.byMethod('chat.postMessage')[0].body.thread_ts, '1700.100')
  assert.equal(fetch.byMethod('chat.update')[0].body.channel, 'C1')
  assert.equal(fetch.byMethod('chat.update')[0].body.ts, '1700.000001')
})

test('beginStream：编辑遇 message_not_found（消息被删）→ 补发接替，不算失败', async () => {
  const base = defaultRoute()
  const route = (method, call, calls) =>
    method === 'chat.update' ? resp(200, { ok: false, error: 'message_not_found' }) : base(method, call, calls)
  const { adapter, fetch } = await connectedAdapter(route)
  const stream = await adapter.beginStream(group)
  await stream.update('a')
  await stream.update('b')
  const receipt = await stream.finish('c')
  assert.equal(receipt.uncertain, false)
  assert.equal(fetch.byMethod('chat.postMessage').length, 3)
  assert.equal(fetch.byMethod('chat.update').length, 2)
  // 接替后的下一次编辑指向接替那条消息的 ts
  assert.equal(fetch.byMethod('chat.update').at(-1).body.ts, '1700.000002')
  assert.equal(receipt.platformMessageId, '1700.000003')
})

test('beginStream：编辑被明确拒绝（rate_limited）原样上抛，不静默补发加重限流', async () => {
  const route = (method) => {
    if (method === 'chat.update') return resp(429, { ok: false, error: 'rate_limited' })
    return defaultRoute()(method)
  }
  const { adapter, fetch } = await connectedAdapter(route)
  const stream = await adapter.beginStream(group)
  await stream.update('a')
  await assert.rejects(stream.update('b'), (error) => error instanceof SlackApiError && error.error === 'rate_limited')
  assert.equal(fetch.byMethod('chat.postMessage').length, 1)
})

test('beginStream：编辑结果不明（uncertain）上抛且不接替', async () => {
  const route = (method) => {
    if (method === 'chat.update') throw new Error('socket hang up')
    return defaultRoute()(method)
  }
  const { adapter, fetch } = await connectedAdapter(route)
  const stream = await adapter.beginStream(group)
  await stream.update('a')
  await assert.rejects(stream.update('b'), SlackUncertainError)
  assert.equal(fetch.byMethod('chat.postMessage').length, 1)
})

test('beginStream：abort 后停止编辑', async () => {
  const { adapter, fetch } = await connectedAdapter()
  const stream = await adapter.beginStream(group)
  await stream.update('a')
  stream.abort()
  await stream.update('b')
  assert.equal(fetch.byMethod('chat.update').length, 0)
  assert.equal(fetch.byMethod('chat.postMessage').length, 1)
})

// —— mrkdwn 转换 ——————————————————————————————————————————

test('mrkdwn：粗体 **x** → *x*，斜体 *x* / __x__ → _x_，删除线 ~~x~~ → ~x~', () => {
  assert.equal(toSlackMrkdwn('**b** and __i__ and *s*'), '*b* and _i_ and _s_')
  assert.equal(toSlackMrkdwn('~~gone~~'), '~gone~')
  assert.equal(toSlackMrkdwn('**Note:** value'), '*Note:* value')
})

test('mrkdwn：[text](url) → <url|text>，图片降级为链接面', () => {
  assert.equal(toSlackMrkdwn('see [docs](https://api.slack.com/docs)'), 'see <https://api.slack.com/docs|docs>')
  assert.equal(toSlackMrkdwn('![](https://x.example/a.png)'), '<https://x.example/a.png>')
  assert.equal(toSlackMrkdwn('![cat](https://x.example/a.png)'), '<https://x.example/a.png|cat>')
})

test('mrkdwn：行内代码与围栏代码块原样保留（内部强调标记不转换）', () => {
  assert.equal(toSlackMrkdwn('use `a*b_c` now'), 'use `a*b_c` now')
  assert.equal(toSlackMrkdwn('```js\n**not bold** [x](y)\n```'), '```js\n**not bold** [x](y)\n```')
})

test('mrkdwn：标题行降级为加粗行（Slack 无标题语法）', () => {
  assert.equal(toSlackMrkdwn('# Title'), '*Title*')
  assert.equal(toSlackMrkdwn('### Deep **Sub**'), '*Deep Sub*')
})

test('mrkdwn：表格转竖排（Slack 不渲染 markdown 表格）', () => {
  const table = ['| Name | Value |', '| --- | --- |', '| a | 1 |', '| b | 2 |'].join('\n')
  assert.equal(
    toSlackMrkdwn(table).trim(),
    ['*Name*: a', '*Value*: 1', '', '*Name*: b', '*Value*: 2'].join('\n'),
  )
})

test('mrkdwn：普通段落与非表格行不受影响', () => {
  const src = '- item one\n- item two\n\nplain | not a table | row\n'
  assert.equal(toSlackMrkdwn(src), src)
})

// —— 服务端回收指令 ——————————————————————————————————————————

test('disconnect 帧（refresh_requested）→ 关旧连接并换 ticket 重开', async () => {
  let opens = 0
  const base = defaultRoute()
  const route = (method, call, calls) => {
    if (method === 'apps.connections.open') {
      opens += 1
      return openOk(`t-${opens}`)
    }
    return base(method, call, calls)
  }
  const { adapter, sock, ws } = await connectedAdapter(route)
  sock.frame({ type: 'disconnect', reason: 'refresh_requested', debug_info: {} })
  await waitUntil(() => ws.made.length === 2)
  assert.equal(sock.closed, true)
  const next = ws.made[1]
  assert.equal(next.url, 'wss://wss.slack.com/link/?ticket=t-2')
  assert.equal(opens, 2)
  next.emit('open', {})
  next.frame(helloFrame())
  await waitUntil(() => adapter.connected)
  await adapter.disconnect()
})

test('canary 帧（reason_code）→ 同类重连指令，按服务端回收处理', async () => {
  const { adapter, sock, ws } = await connectedAdapter()
  sock.frame({ type: 'canary', reason_code: 'reconnect_requested' })
  await waitUntil(() => ws.made.length === 2)
  assert.equal(sock.closed, true)
  const next = ws.made[1]
  next.emit('open', {})
  next.frame(helloFrame())
  await waitUntil(() => adapter.connected)
  assert.equal(ws.made.length, 2)
  await adapter.disconnect()
})

test('连接期 close → 自动重连（退避），恢复后 connected 重新置位', async () => {
  const { adapter, sock, ws } = await connectedAdapter()
  sock.emit('close', {})
  await waitUntil(() => ws.made.length === 2)
  const next = ws.made[1]
  assert.equal(adapter.connected, false)
  next.emit('open', {})
  next.frame(helloFrame())
  await waitUntil(() => adapter.connected)
  await adapter.disconnect()
  assert.equal(adapter.connected, false)
  // 主动拆除后不再有新的 socket（禁重连）
  const count = ws.made.length
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(ws.made.length, count)
})

// —— 能力位 / 准入 / 诊断 ——————————————————————————————————————————

test('caps：声明=真实现（editStream/threads 开，其余首版关，上限 40000）', async () => {
  const { adapter } = await connectedAdapter()
  assert.deepEqual(adapter.caps, {
    editStream: true,
    nativeStream: false,
    nativeChoices: false,
    statusReaction: false,
    typing: false,
    imageIn: false,
    fileIn: true,
    fileOut: true,
    threads: true,
    voice: false,
    maxMessageLength: 40000,
  })
  assert.equal(adapter.id, 'slack')
  assert.equal(typeof adapter.beginStream, 'function')
  assert.equal(typeof adapter.sendFile, 'function', 'fileOut=true 已实装（声明=实装）')
  assert.equal(adapter.askChoices, undefined)
  assert.equal(adapter.setTyping, undefined)
})

test('authorize：恒 undefined（准入白名单归网关）', async () => {
  const { adapter } = await connectedAdapter()
  assert.equal(adapter.authorize?.({ address: dm, userId: 'U7', text: 'x', mentionedBot: false }), undefined)
})

test('诊断：两 token 实探通过 + roundtrip 恒 unverified，hint 零 token 回显', async () => {
  const { adapter, fetch } = await connectedAdapter()
  const checks = await adapter.diagnose()
  assert.deepEqual(
    checks.map((c) => c.name),
    ['bot-token', 'app-token-socket', 'roundtrip', 'file-surface'],
  )
  assert.deepEqual(
    checks.map((c) => c.status),
    ['passed', 'passed', 'unverified', 'unverified'],
  )
  assert.match(checks[0].hint, /imbot/)
  assert.match(checks[1].hint, /Socket Mode 长连接已建立/)
  const blob = JSON.stringify(checks)
  assert.ok(!blob.includes(BOT) && !blob.includes(APP), 'hint 不得回显 token')
  assert.equal(fetch.byMethod('apps.connections.open').length, 1) // 已连通 → 诊断不再消耗 Tier 3 配额
})

test('诊断：bot token 被拒 → failed；未连接时 app token 走 apps.connections.open 实探', async () => {
  const route = (method) => {
    if (method === 'auth.test') return resp(200, { ok: false, error: 'not_authed' })
    if (method === 'apps.connections.open') return resp(200, { ok: false, error: 'invalid_auth' })
    return defaultRoute()(method)
  }
  const adapter = new SlackAdapter({ botToken: BOT, appToken: APP, fetchImpl: fakeFetch(route).impl, WebSocketImpl: fakeWS().factory })
  const checks = await adapter.diagnose()
  assert.equal(checks[0].status, 'failed')
  assert.match(checks[0].hint, /not_authed/)
  assert.equal(checks[1].status, 'failed')
  assert.match(checks[1].hint, /connections:read/)
  assert.equal(checks[2].status, 'unverified')
})

test('诊断：网络不明 → 四项 unverified（不把不确定说成失败）', async () => {
  const route = () => {
    throw new Error('socket hang up')
  }
  const adapter = new SlackAdapter({ botToken: BOT, appToken: APP, fetchImpl: fakeFetch(route).impl, WebSocketImpl: fakeWS().factory })
  const checks = await adapter.diagnose()
  assert.deepEqual(
    checks.map((c) => c.status),
    ['unverified', 'unverified', 'unverified', 'unverified'],
  )
})

// —— 工厂 ——————————————————————————————————————————

test('工厂：Socket Mode 双 token 缺一即构造抛错', () => {
  const base = { accountId: 'acc-1', config: {}, secrets: {} }
  assert.throws(() => createSlackAdapter({ ...base, secrets: { botToken: BOT } }), /acc-1: appToken 未入库/)
  assert.throws(() => createSlackAdapter({ ...base, secrets: { appToken: APP } }), /acc-1: botToken 未入库/)
  assert.throws(() => createSlackAdapter({ ...base, secrets: { botToken: '  ', appToken: APP } }), /botToken 未入库/)
  const adapter = createSlackAdapter({ ...base, secrets: { botToken: BOT, appToken: APP } })
  assert.ok(adapter instanceof SlackAdapter)
})

test('适配器构造：双 token 校验与工厂同口径（不降级为「单边可用」）', () => {
  assert.throws(() => new SlackAdapter({ botToken: '', appToken: APP }), /botToken 缺失/)
  assert.throws(() => new SlackAdapter({ botToken: BOT, appToken: '' }), /appToken 缺失/)
})

// —— 文件面出站（T2.4）——————————————————————————————————

/** 上传链路由：getUploadURLExternal → upload_url 直传 → completeUploadExternal。 */
function uploadRoute(over = {}) {
  const base = defaultRoute()
  return (method, call, all) => {
    switch (method) {
      case 'files.getUploadURLExternal':
        return over.ticket ?? resp(200, { ok: true, file_id: 'F1', upload_url: 'https://upload.slack.com/upload-req-1' })
      case 'upload-req-1':
        return over.raw ?? resp(200, 'OK')
      case 'files.completeUploadExternal':
        return over.complete ?? resp(200, { ok: true, files: [{ id: 'F1' }] })
      default:
        return base(method, call, all)
    }
  }
}

test('sendFile：三步链帧形（filename/length → 原始字节直传 → channel_id + files）', async () => {
  const fetch = fakeFetch(uploadRoute())
  const { adapter } = await connectedAdapterWith(fetch)
  const data = new Uint8Array([1, 2, 3, 4, 5])
  const receipt = await adapter.sendFile(dm, { name: 'report.pdf', data, mimeType: 'application/pdf' })
  assert.deepEqual(
    fetch.calls.map((c) => c.method).slice(2),
    ['files.getUploadURLExternal', 'upload-req-1', 'files.completeUploadExternal'],
  )
  const ticket = fetch.byMethod('files.getUploadURLExternal')[0]
  assert.deepEqual(ticket.body, { filename: 'report.pdf', length: 5 })
  assert.equal(ticket.init.headers.authorization, `Bearer ${BOT}`)
  const raw = fetch.byMethod('upload-req-1')[0]
  assert.equal(raw.url, 'https://upload.slack.com/upload-req-1', '直传走 upload_url 原域名')
  assert.equal(raw.init.method, 'POST')
  assert.equal(raw.init.headers['content-type'], 'application/pdf')
  assert.ok(raw.init.body instanceof Uint8Array, '原始字节直传（不包 multipart）')
  assert.equal(raw.init.headers.authorization, undefined, 'upload_url 不携 token 头')
  const done = fetch.byMethod('files.completeUploadExternal')[0]
  assert.deepEqual(done.body, { files: JSON.stringify([{ id: 'F1', title: 'report.pdf' }]), channel_id: 'D9' })
  assert.deepEqual(receipt, { platformMessageId: 'F1', uncertain: false })
  await adapter.disconnect()
})

test('sendFile：thread 地址→ completeUploadExternal 挂 thread_ts', async () => {
  const fetch = fakeFetch(uploadRoute())
  const { adapter } = await connectedAdapterWith(fetch)
  await adapter.sendFile({ channel: 'slack', kind: 'group', chatId: 'C1', threadId: '1700.100' }, { name: 'a.txt', data: new Uint8Array([1]) })
  const done = fetch.byMethod('files.completeUploadExternal')[0]
  assert.deepEqual(done.body, {
    files: JSON.stringify([{ id: 'F1', title: 'a.txt' }]),
    channel_id: 'C1',
    thread_ts: '1700.100',
  })
  await adapter.disconnect()
})

test('sendFile：mimeType 缺省 → application/octet-stream', async () => {
  const fetch = fakeFetch(uploadRoute())
  const { adapter } = await connectedAdapterWith(fetch)
  await adapter.sendFile(dm, { name: 'blob.bin', data: new Uint8Array([7]) })
  assert.equal(fetch.byMethod('upload-req-1')[0].init.headers['content-type'], 'application/octet-stream')
  await adapter.disconnect()
})

test('sendFile：ok:false 带错误码 → SlackApiError（确定性，不自作重发）', async () => {
  const fetch = fakeFetch(uploadRoute({ complete: resp(200, { ok: false, error: 'channels_not_found' }) }))
  const { adapter } = await connectedAdapterWith(fetch)
  await assert.rejects(adapter.sendFile(dm, { name: 'a.txt', data: new Uint8Array([1]) }), SlackApiError)
  assert.equal(fetch.byMethod('upload-req-1').length, 1, '失败后链路不重跑')
  assert.equal(fetch.byMethod('files.getUploadURLExternal').length, 1)
  await adapter.disconnect()
})

test('sendFile：票据缺 file_id/upload_url → 确定性 SlackApiError', async () => {
  const fetch = fakeFetch(uploadRoute({ ticket: resp(200, { ok: true }) }))
  const { adapter } = await connectedAdapterWith(fetch)
  await assert.rejects(adapter.sendFile(dm, { name: 'a.txt', data: new Uint8Array([1]) }), SlackApiError)
  assert.equal(fetch.byMethod('files.completeUploadExternal').length, 0)
  await adapter.disconnect()
})

test('sendFile：直传 5xx / 传输错 → uncertain（D7 禁自动重发）', async () => {
  const five = fakeFetch(uploadRoute({ raw: resp(503, {}) }))
  const { adapter: a1 } = await connectedAdapterWith(five)
  await assert.rejects(a1.sendFile(dm, { name: 'a.txt', data: new Uint8Array([1]) }), SlackUncertainError)
  assert.equal(five.byMethod('files.completeUploadExternal').length, 0, '结果不明即停在直传位')
  await a1.disconnect()
  const boom = fakeFetch((method, call, all) => {
    if (method === 'files.getUploadURLExternal') return resp(200, { ok: true, file_id: 'F1', upload_url: 'https://upload.slack.com/upload-req-1' })
    if (method === 'upload-req-1') throw new Error('socket hang up')
    return defaultRoute()(method, call, all)
  })
  const { adapter: a2 } = await connectedAdapterWith(boom)
  await assert.rejects(a2.sendFile(dm, { name: 'a.txt', data: new Uint8Array([1]) }), SlackUncertainError)
  await a2.disconnect()
})

test('sendFile：直传 4xx → SlackApiError（确定性拒投）', async () => {
  const fetch = fakeFetch(uploadRoute({ raw: resp(400, {}) }))
  const { adapter } = await connectedAdapterWith(fetch)
  await assert.rejects(adapter.sendFile(dm, { name: 'a.txt', data: new Uint8Array([1]) }), SlackApiError)
  await adapter.disconnect()
})
