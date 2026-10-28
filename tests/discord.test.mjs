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
    calls.push({ url, method: init?.method ?? 'GET', body, headers: init?.headers, raw: init?.body })
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

async function connectedAdapter(restRoute = GATEWAY_ROUTES, extra = {}) {
  const rest = fakeRest(restRoute)
  const ws = fakeWS()
  const logs = []
  const adapter = new DiscordAdapter({
    token: 'DTOK',
    fetchImpl: rest.impl,
    WebSocketImpl: ws.factory,
    apiBase: 'https://api.test',
    // 重连退避压到毫秒级且抖定为 0：否则用例会真等 1s+ 且等待时长不可断言。
    reconnectBaseMs: 5,
    random: () => 0,
    logger: (m) => logs.push(m),
    ...extra,
  })
  await adapter.connect()
  ws.made[0].emit({ op: 10, d: { heartbeat_interval: 45000 } })
  ws.made[0].emit({ op: 0, t: 'READY', s: 1, d: { user: { id: '42' } } })
  return { adapter, rest, ws, socket: ws.made[0], logs }
}

/** 已拿到 session 的连接：READY 带 session_id + resume_gateway_url，后续断开应走 RESUME。 */
async function resumableAdapter(extra = {}) {
  const rest = fakeRest(GATEWAY_ROUTES)
  const ws = fakeWS()
  const logs = []
  const adapter = new DiscordAdapter({
    token: 'DTOK',
    fetchImpl: rest.impl,
    WebSocketImpl: ws.factory,
    apiBase: 'https://api.test',
    reconnectBaseMs: 5,
    random: () => 0,
    logger: (m) => logs.push(m),
    ...extra,
  })
  await adapter.connect()
  ws.made[0].emit({ op: 10, d: { heartbeat_interval: 45000 } })
  ws.made[0].emit({ op: 0, t: 'READY', s: 41, d: { user: { id: '42' }, session_id: 'SES-1', resume_gateway_url: 'wss://resume.test' } })
  return { adapter, rest, ws, socket: ws.made[0], logs }
}

const nap = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// —— Gateway 协议 ——————————————————————————————————————————

test('connect：REST 取 gateway → HELLO 后 IDENTIFY（intents 组合）→ READY 置连接', async () => {
  const { adapter, socket } = await connectedAdapter()
  const identify = socket.sent.find((f) => f.op === 2)
  assert.ok(identify, 'HELLO 后必发 IDENTIFY')
  assert.equal(identify.d.token, 'DTOK')
  // intents 逐位按 Discord 官方 list-of-intents 的文档值断言，不得拿实现常量自证：
  // GUILDS=1<<0 · GUILD_MESSAGES=1<<9 · DIRECT_MESSAGES=1<<12 · MESSAGE_CONTENT=1<<15。
  // 本行历史上写的是 (1<<15)|(1<<12)|(1<<24)——把错位的实现值一起钉死了（issue #1）。
  assert.equal(identify.d.intents, (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15))
  assert.ok(identify.d.intents & (1 << 9), '必订 GUILD_MESSAGES：缺它则服务器频道 MESSAGE_CREATE 永不推送')
  assert.ok(identify.d.intents & (1 << 15), '必订 MESSAGE_CONTENT：缺它则正文为空')
  assert.ok(identify.d.intents & (1 << 12), '必订 DIRECT_MESSAGES（私聊）')
  assert.ok(identify.d.intents & (1 << 0), '必订 GUILDS（GUILD_CREATE 上下文）')
  assert.equal(identify.d.intents & (1 << 24), 0, '1<<24 不是任何已定义 intent，请求它只会把真缺的位掩盖掉')
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

test('INVALID_SESSION：op9 不零等待动作，退避到点后同连接重 IDENTIFY', async () => {
  const { adapter, socket, logs } = await connectedAdapter()
  const before = socket.sent.filter((f) => f.op === 2).length
  socket.emit({ op: 9, d: false })
  assert.equal(socket.sent.filter((f) => f.op === 2).length, before, '官方要求 op9 后等 1–5s，不得零等待重发')
  await nap(25)
  assert.equal(socket.sent.filter((f) => f.op === 2).length, before + 1, '退避到点后在同一连接上重 IDENTIFY')
  assert.ok(logs.some((m) => m.includes('op9 d=false')), `需留痕失效档位，实际：${JSON.stringify(logs)}`)
  await adapter.disconnect()
})

test('RECONNECT（op7）：落排程并关连接，close 再触发也不叠加排程', async () => {
  const { adapter, socket, ws, logs } = await connectedAdapter()
  socket.emit({ op: 7 })
  assert.equal(socket.readyState, 3, 'op7 应主动关连接')
  assert.equal(ws.made.length, 1, '退避未到，不得立刻建新连接')
  assert.ok(logs.some((m) => m.includes('不叠加')), 'close 与 op7 同时触发只保留一个排程')
  await nap(25)
  assert.equal(ws.made.length, 2, '退避到点后自动重连')
  await adapter.disconnect()
})

test('断开自动重连：有 session 则走 RESUME 续传，且必打 resume_gateway_url', async () => {
  const { adapter, ws, socket, logs } = await resumableAdapter()
  assert.ok(logs.some((m) => m.includes('session 已建立')), 'READY 应留痕 session 可用')
  socket.emit({ op: 7 })
  await nap(25)
  assert.equal(ws.made.length, 2, '应重建连接')
  const next = ws.made[1]
  assert.equal(next.url, 'wss://resume.test', 'RESUME 必须用 resume_gateway_url，不是初次 /gateway 地址')
  next.emit({ op: 10, d: { heartbeat_interval: 45000 } })
  const resume = next.sent.find((f) => f.op === 6)
  assert.ok(resume, 'HELLO 后应发 RESUME')
  assert.equal(next.sent.find((f) => f.op === 2), undefined, '可续传时不该退到 IDENTIFY（会丢断口事件）')
  assert.equal(resume.d.session_id, 'SES-1')
  assert.equal(resume.d.seq, 41, 'RESUME 必带最后收到的 seq，否则断口期间事件会丢/重放')
  assert.equal(resume.d.token, 'DTOK')
  assert.equal(adapter.connected, false, 'RESUME 发出但未确认前不算已连')
  next.emit({ op: 0, t: 'RESUMED', s: 42, d: {} })
  assert.equal(adapter.connected, true, 'RESUMED 帧才置连接')
  assert.ok(logs.some((m) => m.includes('RESUME 成功')), '重连成功需留痕')
  await adapter.disconnect()
})

test('无 session 可续：重连回退 IDENTIFY 并用初次 gateway 地址', async () => {
  const { adapter, ws, socket } = await connectedAdapter()
  socket.emit({ op: 7 })
  await nap(25)
  const next = ws.made[1]
  assert.equal(next.url, 'wss://gateway.test/?v=10&encoding=json', '没有 resume_gateway_url 时用初次取定的 gateway 地址（含版本/编码补全）')
  next.emit({ op: 10, d: { heartbeat_interval: 45000 } })
  assert.ok(next.sent.some((f) => f.op === 2), '回退完整 IDENTIFY')
  assert.equal(next.sent.find((f) => f.op === 6), undefined, '无 session 不得发 RESUME')
  await adapter.disconnect()
})

test('心跳无 ACK = 僵尸连接：主动断开并自动重连（不等服务端踢）', async () => {
  const rest = fakeRest(GATEWAY_ROUTES)
  const ws = fakeWS()
  const logs = []
  const adapter = new DiscordAdapter({
    token: 'DTOK',
    fetchImpl: rest.impl,
    WebSocketImpl: ws.factory,
    apiBase: 'https://api.test',
    reconnectBaseMs: 5,
    random: () => 0,
    logger: (m) => logs.push(m),
  })
  await adapter.connect()
  const socket = ws.made[0]
  // 20ms 心跳间隔且不回 ACK：第二拍即应判定僵尸。
  socket.emit({ op: 10, d: { heartbeat_interval: 20 } })
  await nap(70)
  assert.ok(socket.sent.some((f) => f.op === 1), '第一拍正常发心跳')
  assert.equal(socket.readyState, 3, '无 ACK 的第二拍→判定僵尸并断开')
  assert.ok(logs.some((m) => m.includes('僵尸连接')), `需留痕判定原因，实际：${JSON.stringify(logs)}`)
  await nap(25)
  assert.equal(ws.made.length, 2, '僵尸断开后自动重连')
  await adapter.disconnect()
})

test('ACK 正常时不误判僵尸：每拍收到 HEARTBEAT_ACK 即清位', async () => {
  const { adapter, ws, socket, logs } = await connectedAdapter()
  // 重新发 HELLO 以拿到短心跳间隔（上一拍 HELLO 用的是 45s）。
  const origSend = socket.send
  socket.send = (data) => {
    const frame = JSON.parse(data)
    if (frame.op === 1) socket.emit({ op: 11 }) // 立即回 ACK
    origSend(data)
  }
  socket.emit({ op: 10, d: { heartbeat_interval: 20 } })
  await nap(90)
  const beats = socket.sent.filter((f) => f.op === 1)
  assert.ok(beats.length >= 2, `多拍心跳应持续，实际 ${beats.length} 拍`)
  assert.equal(ws.made.length, 1, '有 ACK 就不得误判僵尸而重建连接')
  assert.ok(!logs.some((m) => m.includes('僵尸连接')), '无误判留痕')
  assert.equal(socket.readyState, 1, '连接保持')
  await adapter.disconnect()
})

test('退避递增并封顶：不放弃重试，只把等待封顶在 reconnectMaxMs', async () => {
  const rest = fakeRest(GATEWAY_ROUTES)
  const ws = fakeWS()
  const logs = []
  const adapter = new DiscordAdapter({
    token: 'DTOK',
    fetchImpl: rest.impl,
    WebSocketImpl: ws.factory,
    apiBase: 'https://api.test',
    reconnectBaseMs: 10,
    reconnectMaxMs: 30,
    random: () => 0,
    logger: (m) => logs.push(m),
  })
  await adapter.connect()
  const socket = ws.made[0]
  socket.emit({ op: 10, d: { heartbeat_interval: 45000 } })
  socket.emit({ op: 0, t: 'READY', s: 1, d: { user: { id: '42' } } })
  for (let i = 0; i < 5; i++) {
    socket.emit({ op: 9, d: false })
    await nap(45)
  }
  const waits = logs
    .filter((m) => m.includes('次尝试'))
    .map((m) => Number(/(\d+)ms 后第/.exec(m)?.[1]))
  assert.deepEqual(waits, [10, 20, 30, 30, 30], `10/20/30 递增后封顶且不断重试，实际：${JSON.stringify(waits)}`)
  await adapter.disconnect()
})

test('disconnect 后不得自动重连（主动拆线与意外断开分流）', async () => {
  const { adapter, ws, socket } = await connectedAdapter()
  await adapter.disconnect()
  // 拆线后再推一个 close（模拟服务端迟到帧）与手动 close：都不得起新连接。
  socket.emit({ op: 7 })
  await nap(25)
  assert.equal(ws.made.length, 1, 'disconnect 后的任何断开信号都不应触发重连')
  assert.equal(adapter.connected, false)
})

test('重连排程在途时上层再 connect：接管而非叠出第二条 Gateway 连接', async () => {
  const { adapter, ws, socket } = await connectedAdapter()
  socket.emit({ op: 7 }) // 落一个尚未到点的重连排程
  assert.equal(ws.made.length, 1)
  await adapter.connect() // `AccountManager.ensureConnected` 的调用路径
  assert.equal(ws.made.length, 2, '只应新建一条，被接管的排程不得再补一条')
  assert.equal(socket.readyState, 3, '旧连接应被主动拆掉')
  await nap(25)
  assert.equal(ws.made.length, 2, '等待期内仍只有一条：双 Gateway 连接会让入站只投此一个 session')
  await adapter.disconnect()
})

test('被替换的旧 socket：迟到帧与 close 一律忽略，不改状态也不投递', async () => {
  const { adapter, ws, socket } = await connectedAdapter()
  await adapter.connect() // 换成第二条连接
  const next = ws.made[1]
  assert.equal(ws.made.length, 2)
  const got = []
  adapter.onMessage((m) => got.push(m))
  // 旧 socket 补发断开信号与一条入站：两者都必须被丢。
  socket.emit({ op: 7 })
  socket.emit({ op: 0, t: 'MESSAGE_CREATE', s: 99, d: { channel_id: 'stale', author: { id: '9' }, content: 'stale' } })
  await nap(25)
  assert.equal(ws.made.length, 2, '旧 socket 事件不得触发新排程')
  assert.equal(next.readyState, 1, '旧 socket 不得把当前连接误判为已断开')
  assert.equal(got.length, 0, `旧 socket 的迟到入站不得投递给上层，实际：${JSON.stringify(got.map((m) => m.address))}`)
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

test('createDiscordAdapter：logger 透传到适配器（issue #1 顺带：断开日志不得静默）', () => {
  const logs = []
  const wired = createDiscordAdapter({
    accountId: 'a',
    config: {},
    secrets: { botToken: 'DTOK' },
    logger: (m) => logs.push(m),
  })
  // `log` 是编译期 private（存的是函数字段），运行时可直接触发，验证“工厂→适配器”这一跳。
  wired.log('gateway 断开')
  assert.deepEqual(logs, ['gateway 断开'], 'factory 必须把 logger 接到适配器，否则全量生命周期日志落空')
  const silent = createDiscordAdapter({ accountId: 'a', config: {}, secrets: { botToken: 'DTOK' } })
  assert.doesNotThrow(() => silent.log('dropped'), '不传 logger 时缺省 no-op，不得抛')
})

// —— 文件输入/输出面（T2.4 渠道侧）——————————————————————————————————————

const binResp = (status, body, bytes) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  arrayBuffer: async () => Uint8Array.from(bytes ?? []).buffer,
})

test('声明一致性：fileIn/fileOut=true 且 sendFile 为函数', async () => {
  const { adapter } = await connectedAdapter()
  assert.equal(adapter.caps.fileIn, true)
  assert.equal(adapter.caps.fileOut, true)
  assert.equal(typeof adapter.sendFile, 'function')
  await adapter.disconnect()
})

test('sendFile：multipart payload_json + files[0]（走注入 fetch 面，不发真实请求）', async () => {
  const { adapter, rest } = await connectedAdapter((url, method) => {
    if (method === 'POST' && url.endsWith('/messages')) return resp(200, { id: 'att-1' })
    return GATEWAY_ROUTES(url)
  })
  const receipt = await adapter.sendFile(
    { channel: 'discord', kind: 'dm', chatId: '202' },
    { name: 'report.pdf', data: Uint8Array.from([1, 2, 3]), mimeType: 'application/pdf' },
  )
  assert.equal(receipt.platformMessageId, 'att-1')
  assert.equal(receipt.uncertain, false)
  const call = rest.calls.at(-1)
  assert.equal(call.url, 'https://api.test/channels/202/messages')
  assert.equal(call.method, 'POST')
  assert.equal(call.headers.authorization, 'Bot DTOK')
  assert.match(call.headers['content-type'], /^multipart\/form-data; boundary=/)
  const raw = Buffer.from(call.raw).toString('latin1')
  assert.ok(raw.includes('name="payload_json"'), 'payload_json 字段')
  assert.ok(raw.includes('name="files[0]"'), '文件字段名固定 files[0]')
  assert.ok(raw.includes('filename="report.pdf"'), '文件名透传')
  assert.ok(raw.includes('Content-Type: application/pdf'))
  assert.ok(raw.includes('allowed_mentions'), 'payload_json 携消息体')
  await adapter.disconnect()
})

test('sendFile：403 确定性抛（非 uncertain）', async () => {
  const { adapter } = await connectedAdapter((url, method) => {
    if (method === 'POST' && url.endsWith('/messages')) return resp(403, { message: 'Missing Permissions' })
    return GATEWAY_ROUTES(url)
  })
  await assert.rejects(
    adapter.sendFile({ channel: 'discord', kind: 'dm', chatId: '1' }, { name: 'a', data: Uint8Array.from([0]) }),
    (e) => e.constructor.name === 'DiscordApiError' && /Missing Permissions/.test(e.message),
  )
  await adapter.disconnect()
})

test('sendFile：网络错/5xx/回包不可解析 = uncertain', async () => {
  const net = await connectedAdapter((url, method) => {
    if (method === 'POST' && url.endsWith('/messages')) throw new TypeError('socket hang up')
    return GATEWAY_ROUTES(url)
  })
  await assert.rejects(
    net.adapter.sendFile({ channel: 'discord', kind: 'dm', chatId: '1' }, { name: 'a', data: Uint8Array.from([0]) }),
    (e) => e.constructor.name.includes('Uncertain'),
  )
  await net.adapter.disconnect()

  const srv = await connectedAdapter((url, method) => {
    if (method === 'POST' && url.endsWith('/messages')) return resp(503, {})
    return GATEWAY_ROUTES(url)
  })
  await assert.rejects(
    srv.adapter.sendFile({ channel: 'discord', kind: 'dm', chatId: '1' }, { name: 'a', data: Uint8Array.from([0]) }),
    (e) => e.constructor.name.includes('Uncertain'),
  )
  await srv.adapter.disconnect()

  const broken = await connectedAdapter((url, method) => {
    if (method === 'POST' && url.endsWith('/messages')) return { ok: true, status: 200, json: async () => { throw new Error('bad json') } }
    return GATEWAY_ROUTES(url)
  })
  await assert.rejects(
    broken.adapter.sendFile({ channel: 'discord', kind: 'dm', chatId: '1' }, { name: 'a', data: Uint8Array.from([0]) }),
    (e) => e.constructor.name.includes('Uncertain'),
  )
  await broken.adapter.disconnect()
})

test('入站 attachments：图进 images、非图进 files；单件失败不丢整条', async () => {
  const { adapter, socket } = await connectedAdapter((url) => {
    if (url.includes('cdn.test/cat.png')) return binResp(200, {}, [7, 7, 7])
    if (url.includes('cdn.test/doc.pdf')) return binResp(200, {}, [9, 9])
    if (url.includes('cdn.test/broken.bin')) throw new Error('cdn down')
    return GATEWAY_ROUTES(url)
  })
  const got = []
  adapter.onMessage((m) => got.push(m))
  socket.emit({
    op: 0,
    t: 'MESSAGE_CREATE',
    s: 9,
    d: {
      channel_id: '202',
      author: { id: '7', username: 'bob' },
      content: '多个附件',
      attachments: [
        { id: 'a1', filename: 'cat.png', content_type: 'image/png', url: 'https://cdn.test/cat.png' },
        { id: 'a2', filename: 'doc.pdf', content_type: 'application/pdf', url: 'https://cdn.test/doc.pdf', size: 2 },
        { id: 'a3', filename: 'broken.bin', content_type: 'application/octet-stream', url: 'https://cdn.test/broken.bin' },
      ],
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(got.length, 1)
  assert.equal(got[0].images.length, 1)
  assert.equal(got[0].files.length, 1, '非图附件入 files')
  assert.equal(got[0].files[0].name, 'doc.pdf')
  assert.deepEqual([...got[0].files[0].data], [9, 9])
  assert.equal(got[0].text, '多个附件', '下载失败件不影响正文投递')
  await adapter.disconnect()
})

test('入站文件超 20 MiB 声明体积：不下载（不自设更大限额）', async () => {
  const { adapter, socket, rest } = await connectedAdapter((url) => {
    if (url.includes('cdn.test/big.zip')) return binResp(200, {}, [1])
    return GATEWAY_ROUTES(url)
  })
  const got = []
  adapter.onMessage((m) => got.push(m))
  socket.emit({
    op: 0,
    t: 'MESSAGE_CREATE',
    s: 10,
    d: {
      channel_id: '202',
      author: { id: '7' },
      content: '大包',
      attachments: [
        { id: 'b1', filename: 'big.zip', content_type: 'application/zip', url: 'https://cdn.test/big.zip', size: 21 * 1024 * 1024 },
      ],
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(got.length, 1)
  assert.equal(got[0].files, undefined)
  assert.ok(!rest.calls.some((c) => String(c.url).includes('cdn.test/big.zip')), '超限件不发下载请求')
  await adapter.disconnect()
})

test('diagnose：文件面未实证 = unverified', async () => {
  const { adapter } = await connectedAdapter()
  const checks = await adapter.diagnose()
  const file = checks.find((c) => c.name === 'file-surface')
  assert.equal(file.status, 'unverified')
  await adapter.disconnect()
})

// —— 引用原文回取（T3.6 上下文增强）——————————————————————————

/** 被引用消息原文（公开面 GET /channels/{cid}/messages/{mid} 的回包形）。 */
const quotedMessage = (over = {}) => ({
  id: '555',
  channel_id: '101',
  author: { id: '8', username: 'alice', global_name: 'Alice' },
  content: '被引用的原文',
  ...over,
})

const replyFrame = (messageReference, over = {}) => ({
  op: 0,
  t: 'MESSAGE_CREATE',
  s: 20,
  d: {
    channel_id: '101',
    guild_id: '900',
    author: { id: '7', username: 'bob', global_name: 'Bob' },
    content: '总结这条',
    mentions: [{ id: '42' }],
    message_reference: messageReference,
    ...over,
  },
})

async function emitAndWait(ctx, frame) {
  const got = []
  ctx.adapter.onMessage((m) => got.push(m))
  ctx.socket.emit(frame)
  await new Promise((resolve) => setTimeout(resolve, 20))
  return got
}

test('引用：message_reference 在位且无内联正文 → 走公开面 GET 回取原文并拼「引用#msgId」', async () => {
  const ctx = await connectedAdapter((url) => {
    if (url.endsWith('/channels/101/messages/555')) return resp(200, quotedMessage())
    return GATEWAY_ROUTES(url)
  })
  const got = await emitAndWait(ctx, replyFrame({ message_id: '555', channel_id: '101' }))
  await ctx.adapter.disconnect()
  assert.equal(got.length, 1, '回取成功不影响投递')
  assert.equal(got[0].quoteId, '555', 'normalize 阶段就登记平台侧引用 id')
  assert.equal(got[0].quoteText, 'Alice: 被引用的原文\n[引用#555]')
  const call = ctx.rest.calls.find((c) => String(c.url).includes('/messages/555'))
  assert.ok(call, '必发一次按 id 取原文')
  assert.equal(call.method, 'GET')
  assert.match(String(call.url), /^https:\/\/api\.test\/channels\/101\/messages\/555$/, 'URL 形态 = 公开面路径')
  assert.equal(call.headers.authorization, 'Bot DTOK')
})

test('引用：channel_id 与当前频道不同 → 用引用自带的频道 id 定位', async () => {
  const ctx = await connectedAdapter((url) => {
    if (url.endsWith('/channels/909/messages/555')) return resp(200, quotedMessage({ content: '跨频道原文' }))
    return GATEWAY_ROUTES(url)
  })
  const got = await emitAndWait(ctx, replyFrame({ message_id: '555', channel_id: '909' }))
  await ctx.adapter.disconnect()
  assert.equal(got[0].quoteText, 'Alice: 跨频道原文\n[引用#555]')
})

test('引用：内联 referenced_message 在位 → 省一次 REST', async () => {
  const ctx = await connectedAdapter()
  const got = await emitAndWait(ctx, replyFrame({ message_id: '555', channel_id: '101' }, { referenced_message: quotedMessage({ content: '内联原文', author: { username: 'carl' } }) }))
  await ctx.adapter.disconnect()
  assert.equal(got[0].quoteText, 'carl: 内联原文\n[引用#555]')
  assert.ok(!ctx.rest.calls.some((c) => String(c.url).includes('/messages/555')), '内联在位时不发回取请求')
})

test('引用：FORWARD 快照（message_snapshot.message）→ 取快照正文', async () => {
  const ctx = await connectedAdapter()
  const got = await emitAndWait(ctx, replyFrame({ type: 1, message_id: '555', channel_id: '101' }, { message_snapshot: { message: quotedMessage({ content: '转发快照正文', author: {} }) } }))
  await ctx.adapter.disconnect()
  assert.equal(got[0].quoteText, '转发快照正文\n[引用#555]', '无作者名时不编造前缀')
})

test('引用：回取 404 → 静默保持现状（不覆盖 quoteText、不丢消息、登记 id）', async () => {
  const ctx = await connectedAdapter((url) => {
    if (url.endsWith('/channels/101/messages/555')) return resp(404, { message: 'Unknown Message' })
    return GATEWAY_ROUTES(url)
  })
  const got = await emitAndWait(ctx, replyFrame({ message_id: '555', channel_id: '101' }))
  await ctx.adapter.disconnect()
  assert.equal(got.length, 1)
  assert.equal(got[0].text, '总结这条')
  assert.equal(got[0].quoteId, '555')
  assert.equal(got[0].quoteText, undefined, '取不到原文即不写引用块')
})

test('引用：网络异常（uncertain）→ 同样静默降级，不向上抛', async () => {
  const ctx = await connectedAdapter((url) => {
    if (url.endsWith('/channels/101/messages/555')) return resp(500, {})
    return GATEWAY_ROUTES(url)
  })
  const got = await emitAndWait(ctx, replyFrame({ message_id: '555', channel_id: '101' }))
  await ctx.adapter.disconnect()
  assert.equal(got.length, 1, '5xx 不阻断投递')
  assert.equal(got[0].quoteText, undefined)
})

test('引用：被引用消息无文本（纯附件）→ 不编造占位', async () => {
  const ctx = await connectedAdapter((url) => {
    if (url.endsWith('/channels/101/messages/555')) return resp(200, quotedMessage({ content: '', attachments: [{ id: 'a', filename: 'p.png', content_type: 'image/png' }] }))
    return GATEWAY_ROUTES(url)
  })
  const got = await emitAndWait(ctx, replyFrame({ message_id: '555', channel_id: '101' }))
  await ctx.adapter.disconnect()
  assert.equal(got[0].quoteText, undefined)
})

test('引用：无 message_reference → 不发回取请求，quoteId/quoteText 均缺位', async () => {
  const ctx = await connectedAdapter()
  const got = await emitAndWait(ctx, {
    op: 0,
    t: 'MESSAGE_CREATE',
    s: 21,
    d: { channel_id: '101', guild_id: '900', author: { id: '7', username: 'bob' }, content: '普通消息', mentions: [{ id: '42' }] },
  })
  await ctx.adapter.disconnect()
  assert.equal(got.length, 1)
  assert.equal(got[0].quoteId, undefined)
  assert.equal(got[0].quoteText, undefined)
  assert.ok(!ctx.rest.calls.some((c) => String(c.url).includes('/messages/')))   
})

test('引用：原文超长 → quoteText 截到 800 码点且标记完整', async () => {
  const ctx = await connectedAdapter((url) => {
    if (url.endsWith('/channels/101/messages/555')) return resp(200, quotedMessage({ content: '字'.repeat(1200) }))
    return GATEWAY_ROUTES(url)
  })
  const got = await emitAndWait(ctx, replyFrame({ message_id: '555', channel_id: '101' }))
  await ctx.adapter.disconnect()
  assert.equal(Array.from(got[0].quoteText).length, 800)
  assert.ok(got[0].quoteText.endsWith('\n[引用#555]'))
})
