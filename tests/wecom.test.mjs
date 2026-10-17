// T1.6 企微机器人渠道单测：订阅握手 / 心跳 / 回调归一 / req_id 透传 /
// stream 流式 / send_msg 主动推送回退 / Receipt 语义 / 排重 / 被踢禁重连。
// 网络面全注入 fake WebSocket，不发真实请求。
import test from 'node:test'
import assert from 'node:assert/strict'
import { WecomAdapter, WecomApiError, WecomUncertainError, createWecomAdapter } from '../lib/channels/wecom.js'
import { implementedChannels } from '../lib/channels/registry.js'

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
        if (sock.closed) throw new Error('send on closed')
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
    }
    made.push(sock)
    return sock
  }
  return { factory, made }
}

/** 完成握手后的适配器 + socket。 */
async function connectedAdapter(options = {}) {
  const ws = fakeWS()
  const adapter = new WecomAdapter({
    botId: 'BOT',
    secret: 'SEC',
    WebSocketImpl: ws.factory,
    heartbeatMs: 60_000,
    requestTimeoutMs: 50,
    ...options,
  })
  const inflight = adapter.connect()
  await new Promise((r) => setTimeout(r, 0))
  const sock = ws.made[0]
  sock.emit('open', {})
  const sub = sock.sent.at(-1)
  sock.emit('message', { data: JSON.stringify({ headers: { req_id: sub.headers.req_id }, errcode: 0, errmsg: 'ok' }) })
  await inflight
  // 辅助：对某个待响应请求按 errcode 回帧
  sock.respondTo = (frame, errcode = 0, errmsg = 'ok') => {
    sock.emit('message', { data: JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode, errmsg }) })
  }
  return { adapter, sock }
}

const msgCallback = (reqId, body) => ({
  data: JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: reqId }, body }),
})

// —— 握手与心跳 ——————————————————————————————————

test('connect：aibot_subscribe 携 bot_id/secret，errcode=0 后置连接', async () => {
  const { adapter, sock } = await connectedAdapter()
  const sub = sock.sent[0]
  assert.equal(sub.cmd, 'aibot_subscribe')
  assert.deepEqual(sub.body, { bot_id: 'BOT', secret: 'SEC' })
  assert.equal(adapter.connected, true)
  await adapter.disconnect()
})

test('订阅被拒（errcode≠0）：connect 确定性抛 WecomApiError', async () => {
  const ws = fakeWS()
  const adapter = new WecomAdapter({ botId: 'B', secret: 'S', WebSocketImpl: ws.factory, requestTimeoutMs: 50 })
  const inflight = adapter.connect()
  await new Promise((r) => setTimeout(r, 0))
  const sock = ws.made[0]
  sock.emit('open', {})
  const sub = sock.sent.at(-1)
  sock.emit('message', { data: JSON.stringify({ headers: { req_id: sub.headers.req_id }, errcode: 40013, errmsg: 'invalid secret' }) })
  await assert.rejects(inflight, WecomApiError)
  assert.equal(adapter.connected, false)
})

test('心跳：按间隔发 cmd=ping 帧', async () => {
  const { adapter, sock } = await connectedAdapter({ heartbeatMs: 20 })
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(sock.sent.some((f) => f.cmd === 'ping'), '应出现 ping 心跳帧')
  await adapter.disconnect()
})

// —— 入站归一 ————————————————————————————————————

test('normalize：单聊→dm 原样文本；群聊剥 @ 前缀且 mentionedBot=true', () => {
  const adapter = new WecomAdapter({ botId: 'B', secret: 'S', WebSocketImpl: () => { throw new Error('unused') } })
  const single = adapter.normalize({ chattype: 'single', from: { userid: 'u1' }, msgtype: 'text', text: { content: '你好' } })
  assert.equal(single.address.kind, 'dm')
  assert.equal(single.address.chatId, 'u1')
  assert.equal(single.text, '你好')
  assert.equal(single.mentionedBot, false)
  const group = adapter.normalize({ chattype: 'group', chatid: 'g9', from: { userid: 'u2' }, msgtype: 'text', text: { content: '@RobotA 帮我查天气' } })
  assert.equal(group.address.kind, 'group')
  assert.equal(group.address.chatId, 'g9')
  assert.equal(group.text, '帮我查天气', '群回调 content 带 @机器人前缀需剥离')
  assert.equal(group.mentionedBot, true, '协议事实：群回调即 @触发')
})

test('normalize：图片消息给占位文案不丢事件（首档 imageIn=false）', () => {
  const adapter = new WecomAdapter({ botId: 'B', secret: 'S', WebSocketImpl: () => { throw new Error('unused') } })
  const m = adapter.normalize({ chattype: 'single', from: { userid: 'u1' }, msgtype: 'image', image: { url: 'https://x', aeskey: 'K' } })
  assert.match(m.text, /图片输入首档未启用/)
})

test('回调入站：listener 收到归一消息且 msgid 重放被排重', async () => {
  const { adapter, sock } = await connectedAdapter()
  const got = []
  adapter.onMessage((m) => got.push(m))
  const body = { msgid: 'M1', chattype: 'single', from: { userid: 'u1' }, msgtype: 'text', text: { content: 'hi' } }
  sock.emit('message', msgCallback('REQ1', body))
  sock.emit('message', msgCallback('REQ1', body)) // 重放
  assert.equal(got.length, 1)
  assert.equal(got[0].text, 'hi')
  await adapter.disconnect()
})

// —— 出站 ————————————————————————————————————————

test('reply：有回调上下文走 aibot_respond_msg 且透传原 req_id', async () => {
  const { adapter, sock } = await connectedAdapter()
  adapter.onMessage(() => {})
  sock.emit('message', msgCallback('REQ_CTX', { msgid: 'M2', chattype: 'group', chatid: 'g1', from: { userid: 'u' }, msgtype: 'text', text: { content: '@Bot 干活' } }))
  const p = adapter.reply({ channel: 'wecom', kind: 'group', chatId: 'g1' }, '完成')
  const frame = sock.sent.at(-1)
  assert.equal(frame.cmd, 'aibot_respond_msg')
  assert.equal(frame.headers.req_id, 'REQ_CTX', 'respond 必须透传回调 req_id（协议事实）')
  assert.equal(frame.body.msgtype, 'markdown')
  sock.respondTo(frame)
  const receipt = await p
  assert.equal(receipt.uncertain, false)
  await adapter.disconnect()
})

test('reply：无回调上下文回退 aibot_send_msg（chat_type 1/2）', async () => {
  const { adapter, sock } = await connectedAdapter()
  const p = adapter.reply({ channel: 'wecom', kind: 'dm', chatId: 'u9' }, '推送')
  const frame = sock.sent.at(-1)
  assert.equal(frame.cmd, 'aibot_send_msg')
  assert.equal(frame.body.chat_type, 1)
  assert.equal(frame.body.chatid, 'u9')
  sock.respondTo(frame)
  await p
  const p2 = adapter.reply({ channel: 'wecom', kind: 'group', chatId: 'g5' }, '推送')
  const frame2 = sock.sent.at(-1)
  assert.equal(frame2.body.chat_type, 2)
  sock.respondTo(frame2)
  await p2
  await adapter.disconnect()
})

test('beginStream：同 stream.id 逐步刷新，finish=true 收轮；全程共用回调 req_id', async () => {
  const { adapter, sock } = await connectedAdapter()
  sock.emit('message', msgCallback('REQ_ST', { msgid: 'M3', chattype: 'single', from: { userid: 'u1' }, msgtype: 'text', text: { content: '跑个长活' } }))
  const stream = await adapter.beginStream({ channel: 'wecom', kind: 'dm', chatId: 'u1' })
  const tick = () => new Promise((r) => setTimeout(r, 0)) // 队列帧经微任务落地
  const p1 = stream.update('前半')
  await tick()
  const f1 = sock.sent.at(-1)
  assert.equal(f1.cmd, 'aibot_respond_msg')
  assert.equal(f1.headers.req_id, 'REQ_ST')
  assert.equal(f1.body.msgtype, 'stream')
  assert.equal(f1.body.stream.finish, false)
  const sid = f1.body.stream.id
  sock.respondTo(f1)
  await p1
  const p2 = stream.finish('前半+后半')
  await tick()
  const f2 = sock.sent.at(-1)
  assert.equal(f2.body.stream.id, sid, '刷新必须复用同一 stream.id')
  assert.equal(f2.body.stream.finish, true)
  sock.respondTo(f2)
  const receipt = await p2
  assert.equal(receipt.platformMessageId, sid)
  await adapter.disconnect()
})

test('服务端拒绝（errcode≠0）→ WecomApiError 确定性失败', async () => {
  const { adapter, sock } = await connectedAdapter()
  const p = adapter.reply({ channel: 'wecom', kind: 'dm', chatId: 'u1' }, 'x')
  sock.respondTo(sock.sent.at(-1), 93000, 'invalid chatid')
  await assert.rejects(p, WecomApiError)
  await adapter.disconnect()
})

test('响应超时 → WecomUncertainError（D7 禁重发）', async () => {
  const { adapter } = await connectedAdapter()
  await assert.rejects(
    adapter.reply({ channel: 'wecom', kind: 'dm', chatId: 'u1' }, 'x'),
    WecomUncertainError,
  )
  await adapter.disconnect()
})

test('断连后发送 → uncertain（不伪装确定性失败）', async () => {
  const { adapter } = await connectedAdapter()
  await adapter.disconnect()
  await assert.rejects(
    adapter.reply({ channel: 'wecom', kind: 'dm', chatId: 'u1' }, 'x'),
    (error) => error instanceof WecomUncertainError || error instanceof WecomApiError,
  )
})

test('disconnected_event（被新连接踢掉）→ kicked 置位', async () => {
  const { adapter, sock } = await connectedAdapter()
  sock.emit('message', {
    data: JSON.stringify({ cmd: 'aibot_event_callback', headers: { req_id: 'E1' }, body: { msgtype: 'event', event: { eventtype: 'disconnected_event' } } }),
  })
  assert.equal(adapter.kicked, true)
  await adapter.disconnect()
})

// —— 诊断与工厂 ————————————————————————————————————

test('diagnose 三态：凭据 passed / 连接状态 / roundtrip 恒 unverified', async () => {
  const { adapter } = await connectedAdapter()
  const checks = await adapter.diagnose()
  assert.deepEqual(checks.map((c) => [c.name, c.status]), [
    ['credentials', 'passed'],
    ['connection', 'passed'],
    ['roundtrip', 'unverified'],
  ])
  await adapter.disconnect()
})

test('工厂：secrets 缺位即构造期抛（不静默降级）', async () => {
  assert.throws(() => createWecomAdapter({ accountId: 'a1', config: {}, secrets: {} }), /botId 缺失/)
  assert.throws(() => createWecomAdapter({ accountId: 'a1', config: {}, secrets: { botId: 'B' } }), /secret 缺失/)
  assert.ok(implementedChannels().includes('wecom'))
})
