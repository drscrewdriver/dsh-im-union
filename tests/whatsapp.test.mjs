// WhatsApp 渠道单测（T3.1）：QR 配对状态机 / auth 目录复用 / messages.upsert 归一 /
// 编辑流式（同 key 复用） / Receipt uncertain 语义 / 诊断三态 / 工厂 authDir 缺省。
// 协议面全走注入的 fake makeSocket，零真实 Baileys、零网络、零 creds 文件读写。
// 风格仿 tests/telegram.test.mjs（node:test + assert/strict，导入编译产物 lib/）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { WhatsappAdapter, WhatsAppApiError, WhatsAppUncertainError, createWhatsappAdapter } from '../lib/channels/whatsapp.js'

/** fake Baileys socket：ev.on/off + emit 触发事件；sendMessage 记录并回 key；可注入失败。 */
function makeFakeSocket() {
  const handlers = {}
  const socket = {
    ev: {
      on(evt, cb) {
        ;(handlers[evt] ||= []).push(cb)
      },
      off(evt, cb) {
        handlers[evt] = (handlers[evt] || []).filter((f) => f !== cb)
      },
      removeAllListeners() {
        for (const k of Object.keys(handlers)) handlers[k] = []
      },
    },
    sent: [],
    presences: [],
    failNext: null, // { output:{statusCode} } 或 Error：下一条 sendMessage 抛它
    async sendMessage(jid, payload) {
      socket.sent.push({ jid, payload })
      if (socket.failNext !== null) {
        const f = socket.failNext
        socket.failNext = null
        throw f
      }
      // 编辑：Baileys 复用被编辑消息的 key（remoteJid/fromMe/id 不变）。
      if (payload && payload.edit) return { key: payload.edit }
      return { key: { remoteJid: jid, fromMe: true, id: 'ID' + socket.sent.length } }
    },
    async sendPresenceUpdate(type, jid) {
      socket.presences.push([type, jid])
    },
    end() {
      socket.ended = true
    },
    emit(evt, payload) {
      for (const cb of handlers[evt] || []) cb(payload)
    },
  }
  return socket
}

/** makeSocket 注入工厂：记录调用 ctx（含 stateDir），返回 {socket,hasCreds}。 */
function fakeFactory(socket, hasCreds) {
  const factory = (ctx) => {
    factory.ctxCalls.push(ctx)
    return hasCreds === undefined ? { socket } : { socket, hasCreds }
  }
  factory.ctxCalls = []
  return factory
}

const openBot = (socket, id = 'bot9@s.whatsapp.net') => socket.emit('connection.update', { connection: 'open', me: { id } })

async function connectedAdapter(hasCreds) {
  const socket = makeFakeSocket()
  const adapter = new WhatsappAdapter({ accountId: 'acct', makeSocket: fakeFactory(socket, hasCreds) })
  await adapter.connect()
  openBot(socket)
  return { socket, adapter }
}

const DM_ADDR = { channel: 'whatsapp', kind: 'dm', chatId: '42@s.whatsapp.net' }

// —— QR 配对状态机 ——————————————————————————————————————————

test('QR 配对：connection.update.qr 上抛，open 后清 qr 并 connected', async () => {
  const socket = makeFakeSocket()
  const qrSeen = []
  const adapter = new WhatsappAdapter({ accountId: 'a', makeSocket: fakeFactory(socket, false), onQr: (q) => qrSeen.push(q) })
  await adapter.connect()
  socket.emit('connection.update', { qr: 'QR-STRING-1' })
  assert.equal(adapter.getPairingQr(), 'QR-STRING-1')
  assert.deepEqual(qrSeen, ['QR-STRING-1'], 'qr 经 onQr 回调上抛给设置页')
  assert.equal(adapter.connected, false, 'qr 态尚未在线')
  socket.emit('connection.update', { connection: 'close' })
  socket.emit('connection.update', { connection: 'open', me: { id: 'bot9@s.whatsapp.net' } })
  assert.equal(adapter.connected, true)
  assert.equal(adapter.getPairingQr(), undefined, 'open 后 qr 清空')
  await adapter.disconnect()
})

// —— auth 目录复用 ——————————————————————————————————————————

test('auth 目录：缺省落 accountId 子目录，重连复用同一 stateDir', async () => {
  const socket = makeFakeSocket()
  const factory = fakeFactory(socket)
  const adapter = new WhatsappAdapter({ accountId: 'acct7', makeSocket: factory })
  assert.ok(adapter.getStateDir().includes('acct7'), '缺省 authDir 用 accountId 子目录')
  await adapter.connect()
  const dir1 = factory.ctxCalls[0].stateDir
  assert.ok(dir1.includes('acct7'))
  await adapter.disconnect()
  await adapter.connect()
  assert.equal(factory.ctxCalls.length, 2)
  assert.equal(factory.ctxCalls[1].stateDir, dir1, '重连恢复同一 creds 目录')
  await adapter.disconnect()
})

test('auth 目录：config.authDir 覆写生效', () => {
  const adapter = createWhatsappAdapter({ accountId: 'x', config: { authDir: '/custom/wa-creds' }, secrets: {} })
  assert.equal(adapter.getStateDir(), '/custom/wa-creds')
})

// —— messages.upsert 归一 ——————————————————————————————————————————

test('normalize：dm 归一，字段齐备，fromMe 回声丢弃', async () => {
  const { adapter } = await connectedAdapter()
  const m = adapter.normalize({
    key: { remoteJid: '42@s.whatsapp.net', fromMe: false, id: 'M1' },
    message: { conversation: 'hello' },
    pushName: 'Bob',
    messageTimestamp: 1700000000,
  })
  assert.equal(m.address.channel, 'whatsapp')
  assert.equal(m.address.kind, 'dm')
  assert.equal(m.address.chatId, '42@s.whatsapp.net')
  assert.equal(m.userId, '42@s.whatsapp.net')
  assert.equal(m.userDisplayName, 'Bob')
  assert.equal(m.text, 'hello')
  assert.equal(m.mentionedBot, false)
  assert.equal(m.timestamp, 1700000000000)
  assert.equal(adapter.normalize({ key: { remoteJid: '42@s.whatsapp.net', fromMe: true, id: 'M2' }, message: { conversation: 'me' } }), undefined, '自发回声丢弃')
  assert.equal(adapter.normalize({ key: {}, message: { conversation: 'x' } }), undefined, '无 remoteJid 丢弃')
  assert.equal(adapter.normalize(undefined), undefined)
})

test('normalize：group 用 participant 作发送者，mentionedJid 判 @', async () => {
  const { adapter } = await connectedAdapter()
  const g = adapter.normalize({
    key: { remoteJid: 'grp1@g.us', fromMe: false, participant: '77@s.whatsapp.net', id: 'M3' },
    message: { extendedTextMessage: { text: 'hey', contextInfo: { mentionedJid: ['bot9@s.whatsapp.net'] } } },
  })
  assert.equal(g.address.kind, 'group')
  assert.equal(g.address.chatId, 'grp1@g.us')
  assert.equal(g.userId, '77@s.whatsapp.net', '群内发送者取 participant')
  assert.equal(g.mentionedBot, true, 'mentionedJid 含本机 jid → 点名')
  const quiet = adapter.normalize({
    key: { remoteJid: 'grp1@g.us', fromMe: false, participant: '77@s.whatsapp.net', id: 'M4' },
    message: { conversation: 'quiet' },
  })
  assert.equal(quiet.mentionedBot, false)
})

test('normalize：非文本消息给占位文案不丢事件', async () => {
  const { adapter } = await connectedAdapter()
  const img = adapter.normalize({ key: { remoteJid: '42@s.whatsapp.net', fromMe: false, id: 'M5' }, message: { imageMessage: {} } })
  assert.equal(img.text, '[图片]')
  const audio = adapter.normalize({ key: { remoteJid: '42@s.whatsapp.net', fromMe: false, id: 'M6' }, message: { audioMessage: {} } })
  assert.equal(audio.text, '[语音]')
  const cap = adapter.normalize({ key: { remoteJid: '42@s.whatsapp.net', fromMe: false, id: 'M7' }, message: { imageMessage: { caption: '看这张' } } })
  assert.equal(cap.text, '看这张', '图片带 caption 时取 caption')
})

test('messages.upsert 事件触达监听器', async () => {
  const socket = makeFakeSocket()
  const adapter = new WhatsappAdapter({ accountId: 'a', makeSocket: fakeFactory(socket) })
  await adapter.connect()
  openBot(socket)
  const received = []
  adapter.onMessage((m) => received.push(m))
  socket.emit('messages.upsert', {
    messages: [
      { key: { remoteJid: '42@s.whatsapp.net', fromMe: false, id: 'U1' }, message: { conversation: 'ping' } },
      { key: { remoteJid: '42@s.whatsapp.net', fromMe: true, id: 'U2' }, message: { conversation: 'echo' } },
    ],
  })
  assert.equal(received.length, 1, 'fromMe 回声不入监听')
  assert.equal(received[0].text, 'ping')
})

// —— 编辑流式 ——————————————————————————————————————————

test('beginStream：首更占位发送，后续 edit 复用同 key，finish 带回执', async () => {
  const { socket, adapter } = await connectedAdapter()
  const stream = await adapter.beginStream(DM_ADDR)
  await stream.update('第一段')
  await stream.update('第二段更长')
  const rc = await stream.finish('最终答复')
  const sends = socket.sent.filter((s) => s.payload.text !== undefined && !s.payload.edit)
  const edits = socket.sent.filter((s) => s.payload.edit)
  assert.equal(sends.length, 1, '只有第一次是发送占位')
  assert.equal(edits.length, 2, '后续全走 edit')
  assert.equal(edits[0].payload.edit.id, 'ID1', 'edit 引用占位 key')
  assert.equal(edits[1].payload.edit.id, 'ID1', '连续 edit 同一 key')
  assert.equal(rc.platformMessageId, 'ID1')
  assert.equal(rc.uncertain, false)
})

test('beginStream：abort 后不再产生新调用', async () => {
  const { socket, adapter } = await connectedAdapter()
  const stream = await adapter.beginStream(DM_ADDR)
  await stream.update('a')
  stream.abort()
  const before = socket.sent.length
  await stream.update('b')
  assert.equal(socket.sent.length, before)
})

// —— Receipt / 错误分类 ——————————————————————————————————————————

test('reply：ACK 落定成功，带平台消息 id', async () => {
  const { adapter } = await connectedAdapter()
  const r = await adapter.reply(DM_ADDR, 'hi')
  assert.equal(r.platformMessageId, 'ID1')
  assert.equal(r.uncertain, false)
})

test('reply：超 4000 截断加省略号', async () => {
  const { socket, adapter } = await connectedAdapter()
  await adapter.reply(DM_ADDR, 'y'.repeat(5000))
  const sent = socket.sent.at(-1).payload.text
  assert.equal(sent.length, 4000)
  assert.ok(sent.endsWith('…'))
})

test('reply：WS 断连/超时（无状态码）= uncertain', async () => {
  const { socket, adapter } = await connectedAdapter()
  socket.failNext = new Error('socket hang up')
  await assert.rejects(adapter.reply(DM_ADDR, 'x'), (e) => e instanceof WhatsAppUncertainError && /Uncertain/.test(e.constructor.name))
})

test('reply：5xx = uncertain；4xx 明确 error 节点 = 确定性 WhatsAppApiError', async () => {
  const { socket, adapter } = await connectedAdapter()
  socket.failNext = { output: { statusCode: 503 } }
  await assert.rejects(adapter.reply(DM_ADDR, 'x'), (e) => e instanceof WhatsAppUncertainError)
  socket.failNext = { output: { statusCode: 400 } }
  await assert.rejects(
    adapter.reply(DM_ADDR, 'x'),
    (e) => e instanceof WhatsAppApiError && e.statusCode === 400,
  )
})

test('reply：未 connect 即发 = uncertain（会话未建立）', async () => {
  const socket = makeFakeSocket()
  const adapter = new WhatsappAdapter({ accountId: 'a', makeSocket: fakeFactory(socket) })
  await assert.rejects(adapter.reply(DM_ADDR, 'x'), (e) => e instanceof WhatsAppUncertainError)
})

// —— typing presence ——————————————————————————————————————————

test('setTyping：sendPresenceUpdate composing', async () => {
  const { socket, adapter } = await connectedAdapter()
  await adapter.setTyping(DM_ADDR)
  assert.deepEqual(socket.presences.at(-1), ['composing', '42@s.whatsapp.net'])
})

// —— 诊断三态 ——————————————————————————————————————————

test('diagnose：creds 在位 passed / 连接未 open unverified / roundtrip unverified', async () => {
  const socket = makeFakeSocket()
  const adapter = new WhatsappAdapter({ accountId: 'a', makeSocket: fakeFactory(socket, true) })
  await adapter.connect()
  const checks = await adapter.diagnose()
  assert.equal(checks[0].name, 'auth-creds')
  assert.equal(checks[0].status, 'passed')
  assert.equal(checks[1].name, 'connection')
  assert.equal(checks[1].status, 'unverified', '未 open 前不谎报在线')
  assert.equal(checks[2].name, 'roundtrip')
  assert.equal(checks[2].status, 'unverified')
  openBot(socket)
  assert.equal((await adapter.diagnose())[1].status, 'passed')
})

test('diagnose：未配对 creds failed，且不回显任何凭据值', async () => {
  const socket = makeFakeSocket()
  const adapter = new WhatsappAdapter({ accountId: 'a', makeSocket: fakeFactory(socket, false) })
  await adapter.connect()
  const checks = await adapter.diagnose()
  assert.equal(checks[0].status, 'failed')
  const dump = JSON.stringify(checks)
  assert.ok(!/s.whatsapp.net|@g.us|ID\d|creds_/.test(dump), '诊断零凭据回显')
  // creds.update 事件把 creds 位翻正
  socket.emit('creds.update', {})
  assert.equal(adapter.hasCreds(), true)
})

// —— caps / authorize / 工厂 ——————————————————————————————————————————

test('caps 诚实 + authorize 恒 undefined', async () => {
  const socket = makeFakeSocket()
  const adapter = new WhatsappAdapter({ accountId: 'a', makeSocket: fakeFactory(socket) })
  assert.equal(adapter.caps.editStream, true)
  assert.equal(adapter.caps.nativeStream, false)
  assert.equal(adapter.caps.nativeChoices, false)
  assert.equal(adapter.caps.typing, true)
  assert.equal(adapter.caps.imageIn, false)
  assert.equal(adapter.caps.fileIn, false)
  assert.equal(adapter.caps.fileOut, false)
  assert.equal(adapter.caps.threads, false)
  assert.equal(adapter.caps.voice, false)
  assert.equal(adapter.caps.maxMessageLength, 4000)
  assert.equal(adapter.authorize(), undefined)
})

test('createWhatsappAdapter：QR 配对渠道 secrets 可空，缺 authDir 不抛', () => {
  assert.doesNotThrow(() => createWhatsappAdapter({ accountId: 'z', config: {}, secrets: {} }))
  const adapter = createWhatsappAdapter({ accountId: 'acct99', config: {}, secrets: {} })
  assert.ok(adapter.getStateDir().includes('acct99'))
})
