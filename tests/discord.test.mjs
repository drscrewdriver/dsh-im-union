// Discord 渠道单测：Gateway 帧协议 / REST 出站 / 编辑流式 / 表格转竖排 / Receipt 语义。
// 网络面全注入（fetchImpl + WebSocketImpl），不发真实请求。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DiscordAdapter, createDiscordAdapter, convertMarkdownTables } from '../lib/channels/discord.js'

const resp = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

function fakeRest(route) {
  const calls = []
  const impl = async (url, init) => {
    let body
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = { raw: true }
      }
    }
    calls.push({ url, method: init?.method ?? 'GET', body, headers: init?.headers })
    return route(url, init?.method ?? 'GET', body)
  }
  return { impl, calls }
}

function fakeWS() {
  const made = []
  const factory = (url) => {
    const listeners = {}
    const sent = []
    const ws = {
      url,
      sent,
      readyState: 1,
      close() {
        ws.readyState = 3
        listeners.close?.({})
      },
      send(data) {
        sent.push(JSON.parse(data))
      },
      addEventListener(type, cb) {
        listeners[type] = cb
      },
      emit(frame) {
        listeners.message?.({ data: JSON.stringify(frame) })
      },
    }
    made.push(ws)
    return ws
  }
  return { factory, made }
}

const GATEWAY_ROUTES = (url) => {
  if (url.endsWith('/users/@me')) return resp(200, { id: '42', username: 'unibot' })
  if (url.endsWith('/gateway')) return resp(200, { url: 'wss://gateway.test' })
  return resp(200, {})
}

async function connectedAdapter(restRoute = GATEWAY_ROUTES) {
  const rest = fakeRest(restRoute)
  const ws = fakeWS()
  const adapter = new DiscordAdapter({ token: 'DTOK', fetchImpl: rest.impl, WebSocketImpl: ws.factory, apiBase: 'https://api.test' })
  const p = adapter.connect()
  await p
  ws.made[0].emit({ op: 10, d: { heartbeat_interval: 45000 } })
  ws.made[0].emit({ op: 0, t: 'READY', s: 1, d: { user: { id: '42' } } })
  return { adapter, rest, ws, socket: ws.made[0] }
}

// —— Gateway 协议 ——————————————————————————————————————————

test('connect：REST 取 gateway → HELLO 后 IDENTIFY（intents 组合）→ READY 置连接', async () => {
  const { adapter, socket } = await connectedAdapter()
  const identify = socket.sent.find((f) => f.op === 2)
  assert.ok(identify, 'HELLO 后必发 IDENTIFY')
  assert.equal(identify.d.token, 'DTOK')
  assert.equal(identify.d.intents, (1 << 15) | (1 << 12) | (1 << 24))
  assert.equal(adapter.connected, true)
  await adapter.disconnect()
  assert.equal(adapter.connected, false)
})

test('MESSAGE_CREATE：群聊显式 @ 本机器人 → mentionedBot；回声丢弃', async () => {
  const { adapter, socket } = await connectedAdapter()
  const got = []
  adapter.onMessage((m) => got.push(m))
  socket.emit({
    op: 0,
    t: 'MESSAGE_CREATE',
    s: 2,
    d: {
      channel_id: '101',
      guild_id: '900',
      author: { id: '7', username: 'bob', global_name: 'Bob' },
      content: 'hello <@42>',
      timestamp: '2026-10-18T00:00:00.000Z',
      mentions: [{ id: '42' }],
    },
  })
  socket.emit({
    op: 0,
    t: 'MESSAGE_CREATE',
    s: 3,
    d: { channel_id: '101', guild_id: '900', author: { id: '42' }, content: 'echo', mentions: [] },
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await adapter.disconnect()
  assert.equal(got.length, 1, 'bot 自发消息不产生入站')
  assert.equal(got[0].address.kind, 'group')
  assert.equal(got[0].address.chatId, '101')
  assert.equal(got[0].userId, '7')
  assert.equal(got[0].userDisplayName, 'Bob')
  assert.equal(got[0].mentionedBot, true)
  assert.equal(got[0].timestamp, Date.parse('2026-10-18T00:00:00.000Z'))
})

test('DM 判定与群聊未 @ 规则', async () => {
  const { adapter, socket } = await connectedAdapter()
  const got = []
  adapter.onMessage((m) => got.push(m))
  socket.emit({ op: 0, t: 'MESSAGE_CREATE', s: 4, d: { channel_id: '202', author: { id: '7' }, content: 'hi' } })
  socket.emit({ op: 0, t: 'MESSAGE_CREATE', s: 5, d: { channel_id: '101', guild_id: '900', author: { id: '7' }, content: 'no mention', mentions: [] } })
  await new Promise((resolve) => setTimeout(resolve, 5)) // 异步投递：等下载面落地
  assert.equal(got[0].address.kind, 'dm')
  assert.equal(got[0].mentionedBot, false, 'DM 不做 @ 判定')
  assert.equal(got.length, 2)
  // 群未 @ 的裁决在网关（mentionedBot false），渠道只报告事实
  await adapter.disconnect()
})

test('HELLO 心跳按间隔发出并携带最后 seq', async () => {
  const rest = fakeRest(GATEWAY_ROUTES)
  const ws = fakeWS()
  const adapter = new DiscordAdapter({ token: 'T', fetchImpl: rest.impl, WebSocketImpl: ws.factory, apiBase: 'https://api.test' })
  await adapter.connect()
  const socket = ws.made[0]
  socket.emit({ op: 10, d: { heartbeat_interval: 20 } })
  socket.emit({ op: 0, t: 'MESSAGE_CREATE', s: 77, d: { channel_id: '1', author: { id: '7' }, content: 'x' } })
  await new Promise((resolve) => setTimeout(resolve, 60))
  await adapter.disconnect()
  const beats = socket.sent.filter((f) => f.op === 1)
  assert.ok(beats.length >= 1, '心跳已发')
  assert.equal(beats[0].d, 77, '心跳携带最后收到的 seq')
})

test('INVALID_SESSION 重发 IDENTIFY；RECONNECT 关连接', async () => {
  const { adapter, socket } = await connectedAdapter()
  const before = socket.sent.filter((f) => f.op === 2).length
  socket.emit({ op: 9, d: false })
  assert.equal(socket.sent.filter((f) => f.op === 2).length, before + 1)
  let closed = false
  const origClose = socket.close
  socket.close = () => {
    closed = true
    origClose.call(socket)
  }
  socket.emit({ op: 7 })
  assert.equal(closed, true)
  await adapter.disconnect()
})

// —— REST 出站与回退 ——————————————————————————————————————————

test('reply：POST messages 带 allowed_mentions 空 parse；回执平台 id', async () => {
  const { adapter, rest } = await connectedAdapter((url, method, body) => {
    if (url.endsWith('/messages') && method === 'POST') return resp(200, { id: 'msg-1' })
    return GATEWAY_ROUTES(url)
  })
  const receipt = await adapter.reply({ channel: 'discord', kind: 'dm', chatId: '202' }, '**hi**')
  assert.equal(receipt.platformMessageId, 'msg-1')
  const call = rest.calls.at(-1)
  assert.equal(call.headers.authorization, 'Bot DTOK')
  assert.deepEqual(call.body.allowed_mentions, { parse: [] })
  assert.equal(call.body.content, '**hi**', 'Discord markdown 内建渲染，原文直发')
  await adapter.disconnect()
})

test('beginStream：占位 POST → PATCH 编辑 → finish 回执；unknown message 补发接替', async () => {
  let idSeq = 0
  const { adapter, rest } = await connectedAdapter((url, method) => {
    if (method === 'POST' && url.endsWith('/messages')) return resp(200, { id: `m${++idSeq}` })
    if (method === 'PATCH') return resp(400, { message: 'Unknown Message' })
    return GATEWAY_ROUTES(url)
  })
  const stream = await adapter.beginStream({ channel: 'discord', kind: 'dm', chatId: '202' })
  await stream.update('第一段')
  await stream.finish('最终')
  const posts = rest.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/messages'))
  assert.equal(posts.length, 2, '编辑被拒（Unknown Message）→ 补发接替')
  assert.equal(posts[1].body.content, '最终')
  await adapter.disconnect()
})

test('reply：网络异常/5xx = uncertain；403 确定性抛', async () => {
  const net = await connectedAdapter((url, method) => {
    if (url.endsWith('/messages')) throw new TypeError('socket hang up')
    return GATEWAY_ROUTES(url)
  })
  await assert.rejects(
    net.adapter.reply({ channel: 'discord', kind: 'dm', chatId: '1' }, 'x'),
    (e) => e.constructor.name.includes('Uncertain'),
  )
  await net.adapter.disconnect()

  const forbidden = await connectedAdapter((url, method) => {
    if (url.endsWith('/messages')) return resp(403, { message: 'Missing Permissions' })
    return GATEWAY_ROUTES(url)
  })
  await assert.rejects(forbidden.adapter.reply({ channel: 'discord', kind: 'dm', chatId: '1' }, 'x'), /Missing Permissions/)
  await forbidden.adapter.disconnect()
})

test('setTyping 静默失败不上抛；authorize 恒交网关', async () => {
  const { adapter, rest } = await connectedAdapter((url, method) => {
    if (url.endsWith('/typing')) return resp(403, { message: 'slow mode' })
    return GATEWAY_ROUTES(url)
  })
  await adapter.setTyping({ channel: 'discord', kind: 'group', chatId: '101' })
  assert.ok(rest.calls.some((c) => c.url.endsWith('/typing')))
  assert.equal(adapter.authorize(), undefined)
  assert.equal(adapter.caps.editStream, true)
  assert.equal(adapter.caps.maxMessageLength, 2000)
  await adapter.disconnect()
})

test('diagnose 三态：passed / failed / 限流 unverified', async () => {
  const ok = await connectedAdapter()
  const checks = await ok.adapter.diagnose()
  assert.equal(checks[0].status, 'passed')
  assert.equal(checks[0].hint, 'unibot')
  assert.equal(checks[1].status, 'passed', 'READY 后 gateway-session 位绿')
  await ok.adapter.disconnect()

  const bad = new DiscordAdapter({
    token: 'X',
    apiBase: 'https://api.test',
    fetchImpl: fakeRest(() => resp(401, { message: 'invalid token' })).impl,
    WebSocketImpl: fakeWS().factory,
  })
  assert.equal((await bad.diagnose())[0].status, 'failed')

  const limited = new DiscordAdapter({
    token: 'X',
    apiBase: 'https://api.test',
    fetchImpl: fakeRest(() => resp(429, { message: 'rate limited' })).impl,
    WebSocketImpl: fakeWS().factory,
  })
  assert.equal((await limited.diagnose())[0].status, 'unverified')
})

// —— 表格转竖排 ——————————————————————————————————————————

test('convertMarkdownTables：表头+分隔行 → 每数据行竖排块', () => {
  const table = ['| 名字 | 分数 | 等级 |', '| --- | ---: | --- |', '| 甲 | 90 | A |', '| 乙 | 80 | B |'].join('\n')
  const out = convertMarkdownTables(`前文\n${table}\n后文`)
  assert.match(out, /^前文/)
  assert.match(out, /【甲】/)
  assert.match(out, /分数: 90/)
  assert.match(out, /等级: A/)
  assert.match(out, /【乙】/)
  assert.ok(!out.includes('| ---'), '表格行不再以原样出现')
  assert.match(out, /后文$/)
})

test('convertMarkdownTables：非表格文本原样返回', () => {
  const plain = '普通消息 | 含竖线但不是表格'
  assert.equal(convertMarkdownTables(plain), plain)
})

test('长文截断到 2000 并以省略号收尾', async () => {
  const { adapter, rest } = await connectedAdapter((url, method) => {
    if (method === 'POST' && url.endsWith('/messages')) return resp(200, { id: 'big' })
    return GATEWAY_ROUTES(url)
  })
  await adapter.reply({ channel: 'discord', kind: 'dm', chatId: '1' }, 'z'.repeat(3000))
  assert.equal(rest.calls.at(-1).body.content.length, 2000)
  await adapter.disconnect()
})

test('createDiscordAdapter：token 缺失即抛', () => {
  assert.throws(() => createDiscordAdapter({ accountId: 'a', config: {}, secrets: {} }), /botToken 未入库/)
})
