// QQ（腾讯官方机器人）渠道单测：取凭证 / 网关帧协议 / 入站归一 / 被动回复窗口 / Receipt 三态 / 诊断。
// 网络面全注入（fetchImpl + SocketImpl），零真实请求。
import test from 'node:test'
import assert from 'node:assert/strict'
import { QqAdapter, QQApiError, QQUncertainError, createQqAdapter, fitByteBudget } from '../lib/channels/qq.js'

const APP = 'APPID-1'
const SEC = 'SUPERSECRETV'
const AT = 'AT-1'

const httpResp = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

function restRecorder(route) {
  const calls = []
  const impl = async (url, init) => {
    let parsed
    if (typeof init?.body === 'string') {
      try {
        parsed = JSON.parse(init.body)
      } catch {
        parsed = undefined
      }
    }
    calls.push({ url, method: init?.method ?? 'GET', body: parsed, headers: init?.headers ?? {} })
    return route(url, init?.method ?? 'GET', parsed, init)
  }
  return { impl, calls }
}

function socketRig() {
  const made = []
  const dial = (url) => {
    const handlers = {}
    const sent = []
    const sock = {
      url,
      sent,
      closeCode: undefined,
      readyState: 1,
      close() {
        sock.readyState = 3
        handlers.close?.({ code: sock.closeCode })
      },
      send(data) {
        sent.push(JSON.parse(data))
      },
      addEventListener(type, cb) {
        handlers[type] = cb
      },
      push(frame) {
        handlers.message?.({ data: JSON.stringify(frame) })
      },
    }
    made.push(sock)
    return sock
  }
  return { dial, made }
}

const BASE_ROUTE = (url, method) => {
  if (url.endsWith('/app/getAppAccessToken')) return httpResp(200, { access_token: AT, expires_in: 7200 })
  if (url.endsWith('/gateway')) return httpResp(200, { url: 'wss://qq.test/websocket' })
  if (method === 'POST' && url.endsWith('/messages')) return httpResp(200, { id: 'SENT-1' })
  return httpResp(200, {})
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

async function build(options = {}, route = BASE_ROUTE) {
  const rest = restRecorder(route)
  const rig = socketRig()
  const adapter = new QqAdapter({
    appId: APP,
    appSecret: SEC,
    apiBase: 'https://api.test',
    fetchImpl: rest.impl,
    SocketImpl: rig.dial,
    reconnectDelayMs: 10,
    ...options,
  })
  return { adapter, rest, rig }
}

/** connect + HELLO + READY（协议默认心跳 45s，避免测试期间抖动）。 */
async function ready(options = {}, route = BASE_ROUTE) {
  const built = await build(options, route)
  await built.adapter.connect()
  const sock = built.rig.made[0]
  sock.push({ op: 10, d: { heartbeat_interval: 45_000 } })
  sock.push({
    op: 0,
    t: 'READY',
    s: 1,
    d: { version: 1, session_id: 'SESSION-1', user: { id: 'BOTID', username: '测试机器人', bot: true }, shard: [0, 0] },
  })
  return { ...built, sock }
}

const C2C_FRAME = (over = {}) => ({
  op: 0,
  t: 'C2C_MESSAGE_CREATE',
  s: 9,
  d: {
    id: 'ROBOT1.0_msg1',
    author: { id: 'OPENID-U', user_openid: 'OPENID-U', username: '阿明', bot: false },
    content: '你好，今天有什么推荐',
    message_type: 0,
    timestamp: '2026-10-18T10:00:00+08:00',
    ...over,
  },
})

const GROUP_FRAME = (over = {}) => ({
  op: 0,
  t: 'GROUP_AT_MESSAGE_CREATE',
  s: 10,
  d: {
    id: 'ROBOT1.0_gmsg1',
    author: { id: 'MEMBER-1', member_openid: 'MEMBER-1', member_role: 'member', username: '小红', bot: false },
    content: ' 查下天气 ',
    group_openid: 'GROUP-OPENID',
    message_type: 0,
    timestamp: '2026-10-18T10:05:00+08:00',
    ...over,
  },
})

// —— 凭证面 ——————————————————————————————————————————

test('取凭证：POST {appId,clientSecret} 形态 + 结果缓存复用；后续请求头 QQBot {access_token}', async () => {
  const { adapter, rest } = await ready()
  const tokenCalls = rest.calls.filter((c) => c.url.endsWith('/app/getAppAccessToken'))
  assert.equal(tokenCalls.length, 1, 'connect 期取一次，网关握手与 reply 复用缓存')
  assert.equal(tokenCalls[0].method, 'POST')
  assert.deepEqual(tokenCalls[0].body, { appId: APP, clientSecret: SEC })
  assert.equal(tokenCalls[0].headers.authorization, undefined, '取凭证面本身不带 authorization')

  await adapter.reply({ channel: 'qq', kind: 'dm', chatId: 'OPENID-U' }, 'hi')
  const sent = rest.calls.at(-1)
  assert.equal(sent.headers.authorization, `QQBot ${AT}`)
  assert.equal(rest.calls.filter((c) => c.url.endsWith('/app/getAppAccessToken')).length, 1, 'expires_in 内不重复换取')
  await adapter.disconnect()
})

test('网关取址：GET /gateway 的 url 直接用于 WebSocket 连接', async () => {
  const { adapter, sock, rest } = await ready()
  const gatewayCall = rest.calls.find((c) => c.url.endsWith('/gateway'))
  assert.equal(gatewayCall.method, 'GET')
  assert.equal(sock.url, 'wss://qq.test/websocket')
  await adapter.disconnect()
})

test('HELLO 后 IDENTIFY(op2)：token=QQBot {AT}、intents=1<<25、shard=[0,1]；READY 置连接', async () => {
  const { adapter, sock } = await ready()
  const login = sock.sent.find((f) => f.op === 2)
  assert.ok(login, 'HELLO 后必发 IDENTIFY')
  assert.equal(login.d.token, `QQBot ${AT}`)
  assert.equal(login.d.intents, 1 << 25)
  assert.deepEqual(login.d.shard, [0, 1])
  assert.equal(adapter.connected, true)
  await adapter.disconnect()
  assert.equal(adapter.connected, false, 'disconnect 后置位')
  await adapter.disconnect()
})

// —— 心跳与会话维护 ——————————————————————————————————————————

test('op1 心跳按 HELLO 间隔发送：首连无 seq 传 null，收到事件 s 后携带最新 seq', async () => {
  const { adapter, rest, rig } = await build()
  await adapter.connect()
  const sock = rig.made[0]
  sock.push({ op: 10, d: { heartbeat_interval: 20 } })
  await tick(45)
  const early = sock.sent.filter((f) => f.op === 1)
  assert.ok(early.length >= 1, '心跳已按周期发出')
  assert.equal(early[0].d, null, '无 s 时传 null')
  sock.push(C2C_FRAME())
  await tick(45)
  const last = sock.sent.filter((f) => f.op === 1).at(-1)
  assert.equal(last.d, 9, '心跳携带最后收到的 s')
  await adapter.disconnect()
  assert.equal(rest.calls.length >= 1, true)
})

test('op9 INVALID_SESSION：d=false 重发 IDENTIFY；d=true 改走 RESUME(op6 带 session_id+seq)', async () => {
  const { adapter, sock } = await ready()
  const before = sock.sent.filter((f) => f.op === 2).length
  sock.push({ op: 9, d: false })
  assert.equal(sock.sent.filter((f) => f.op === 2).length, before + 1, 'd=false → 重新 IDENTIFY')
  assert.equal(sock.sent.filter((f) => f.op === 6).length, 0)

  sock.push({ op: 9, d: true })
  const resume = sock.sent.filter((f) => f.op === 6).at(-1)
  assert.ok(resume, 'd=true 且已有 session → RESUME')
  assert.equal(resume.d.session_id, 'SESSION-1')
  assert.equal(resume.d.seq, 1)
  assert.equal(resume.d.token, `QQBot ${AT}`)
  await adapter.disconnect()
})

test('op7 RECONNECT：关闭旧连接并立即重建新 socket', async () => {
  const { adapter, rig, sock } = await ready()
  sock.push({ op: 7 })
  assert.equal(sock.readyState, 3, '旧连接被关闭')
  await tick(10)
  assert.equal(rig.made.length, 2, '新连接已建立')
  assert.notEqual(rig.made[1], sock)
  await adapter.disconnect()
})

test('WebSocket 关闭码分档：4014（intent 无权限）不再重连，普通断开按延迟重连并尝试 RESUME', async () => {
  const fatal = await ready()
  fatal.sock.closeCode = 4014
  fatal.sock.close()
  await tick(40)
  assert.equal(fatal.rig.made.length, 1, '不可重试档不再建连')
  assert.equal(fatal.adapter.connected, false)
  await fatal.adapter.disconnect()

  const retry = await ready()
  retry.sock.closeCode = 1006
  retry.sock.close()
  await tick(30)
  assert.equal(retry.rig.made.length, 2, '普通断开触发重连')
  retry.rig.made[1].push({ op: 10, d: { heartbeat_interval: 45_000 } })
  const resume = retry.rig.made[1].sent.find((f) => f.op === 6)
  assert.ok(resume, '重连后凭 session 走 RESUME')
  assert.equal(resume.d.session_id, 'SESSION-1')
  await retry.adapter.disconnect()
})

// —— 入站归一 ——————————————————————————————————————————

test('C2C_MESSAGE_CREATE → dm：user_openid 作 chatId/userId、昵称、RFC3339 时间戳、mentionedBot=false', async () => {
  const { adapter, sock } = await ready()
  const got = []
  adapter.onMessage((m) => got.push(m))
  sock.push(C2C_FRAME())
  await tick()
  assert.equal(got.length, 1)
  assert.equal(got[0].address.channel, 'qq')
  assert.equal(got[0].address.kind, 'dm')
  assert.equal(got[0].address.chatId, 'OPENID-U')
  assert.equal(got[0].userId, 'OPENID-U')
  assert.equal(got[0].userDisplayName, '阿明')
  assert.equal(got[0].text, '你好，今天有什么推荐')
  assert.equal(got[0].mentionedBot, false, '单聊无 @ 语义')
  assert.equal(got[0].timestamp, Date.parse('2026-10-18T10:00:00+08:00'))
  await adapter.disconnect()
})

test('GROUP_AT_MESSAGE_CREATE → group：group_openid 作 chatId、member_openid 作 userId、mentionedBot=true', async () => {
  const { adapter, sock } = await ready()
  const got = []
  adapter.onMessage((m) => got.push(m))
  sock.push(GROUP_FRAME())
  await tick()
  assert.equal(got.length, 1)
  assert.equal(got[0].address.kind, 'group')
  assert.equal(got[0].address.chatId, 'GROUP-OPENID')
  assert.equal(got[0].userId, 'MEMBER-1')
  assert.equal(got[0].userDisplayName, '小红')
  assert.equal(got[0].mentionedBot, true, '群事件仅 @ 机器人才回调，协议事实即 true')
  assert.equal(got[0].text, ' 查下天气 ', 'content 已由平台去除 @ 前缀，原样保留')
  await adapter.disconnect()
})

test('机器人回声丢弃；相同消息 id 重复推送去重（协议明载需自行去重）', async () => {
  const { adapter, sock } = await ready()
  const got = []
  adapter.onMessage((m) => got.push(m))
  sock.push(C2C_FRAME({ author: { id: 'BOTID', user_openid: 'OPENID-X', bot: true } }))
  sock.push(C2C_FRAME({ id: 'ROBOT1.0_other', author: { id: 'OTHER-BOT', user_openid: 'OPENID-Y', bot: true } }))
  sock.push(C2C_FRAME())
  sock.push(C2C_FRAME({ content: '重复推送的第二次' }))
  await tick()
  assert.equal(got.length, 1, 'bot 自发与重复 id 均不产生入站')
  assert.equal(got[0].text, '你好，今天有什么推荐')
  await adapter.disconnect()
})

test('富文本/图片入站给占位文案不丢事件（caps.imageIn=false 不下载附件）', async () => {
  const { adapter, sock } = await ready()
  const got = []
  adapter.onMessage((m) => got.push(m))
  sock.push(
    GROUP_FRAME({
      content: ' ',
      attachments: [{ content_type: 'image/jpeg', filename: 'photo.jpg', url: 'https://cdn.test/a.jpg', size: 256000 }],
    }),
  )
  sock.push(C2C_FRAME({ content: '', message_type: 3, ark_data: { ark_type: 'miniapp', ark_name: '小程序' } }))
  sock.push(
    C2C_FRAME({
      id: 'ROBOT1.0_voice',
      content: '   ',
      attachments: [{ content_type: 'voice', voice_wav_url: 'https://cdn.test/w.wav' }],
    }),
  )
  await tick()
  assert.equal(got.length, 3, '三类富事件都不丢')
  assert.equal(got[0].text, '[图片]')
  assert.equal(got[1].text, '[卡片消息 小程序]')
  assert.equal(got[2].text, '[语音]')
  assert.equal(got[0].images, undefined)
  await adapter.disconnect()
})

test('message_type=103 引用消息 → quoteText 取被引用正文', async () => {
  const { adapter, sock } = await ready()
  const got = []
  adapter.onMessage((m) => got.push(m))
  sock.push(
    C2C_FRAME({
      id: 'ROBOT1.0_quote',
      message_type: 103,
      content: '这个建议很有帮助',
      msg_elements: [{ msg_idx: 'REFIDX_aaa', content: '每天坚持阅读半小时' }],
    }),
  )
  await tick()
  assert.equal(got[0].text, '这个建议很有帮助')
  assert.equal(got[0].quoteText, '每天坚持阅读半小时')
  await adapter.disconnect()
})

// —— REST 出站与被动窗口 ——————————————————————————————————————————

test('reply：文本 msg_type=0（文档口径，台账写 1 以公开文档为准）+ 窗口内 msg_id/msg_seq 递增', async () => {
  const { adapter, rest, sock } = await ready()
  sock.push(C2C_FRAME())
  await tick()
  const address = { channel: 'qq', kind: 'dm', chatId: 'OPENID-U' }
  const first = await adapter.reply(address, '第一段')
  assert.equal(first.uncertain, false)
  assert.equal(first.platformMessageId, 'SENT-1')
  let body = rest.calls.at(-1).body
  assert.equal(body.msg_type, 0)
  assert.equal(body.content, '第一段')
  assert.equal(body.msg_id, 'ROBOT1.0_msg1')
  assert.equal(body.msg_seq, 1)
  assert.match(rest.calls.at(-1).url, /\/v2\/users\/OPENID-U\/messages$/)

  await adapter.reply(address, '第二段')
  body = rest.calls.at(-1).body
  assert.equal(body.msg_id, 'ROBOT1.0_msg1')
  assert.equal(body.msg_seq, 2, '相同 msg_id+msg_seq 会被判重复，故序号递增')

  await adapter.reply({ channel: 'qq', kind: 'group', chatId: 'GROUP-OPENID' }, '群内容')
  assert.match(rest.calls.at(-1).url, /\/v2\/groups\/GROUP-OPENID\/messages$/)
  await adapter.disconnect()
})

test('窗口次数耗尽后转主动消息：body 不再带 msg_id/msg_seq', async () => {
  const { adapter, rest, sock } = await ready({ passiveMaxUses: 2 })
  sock.push(GROUP_FRAME())
  await tick()
  const address = { channel: 'qq', kind: 'group', chatId: 'GROUP-OPENID' }
  await adapter.reply(address, 'a')
  assert.equal(rest.calls.at(-1).body.msg_id, 'ROBOT1.0_gmsg1')
  await adapter.reply(address, 'b')
  assert.equal(rest.calls.at(-1).body.msg_seq, 2)
  await adapter.reply(address, 'c')
  const third = rest.calls.at(-1).body
  assert.equal(third.msg_id, undefined, '窗口用尽 → 主动消息')
  assert.equal(third.msg_seq, undefined)
  await adapter.disconnect()
})

test('窗口过期后转主动消息（passiveWindowMs 极小）', async () => {
  const { adapter, rest, sock } = await ready({ passiveWindowMs: 10 })
  sock.push(C2C_FRAME())
  await tick(30)
  await adapter.reply({ channel: 'qq', kind: 'dm', chatId: 'OPENID-U' }, '迟到的回复')
  assert.equal(rest.calls.at(-1).body.msg_id, undefined)
  await adapter.disconnect()
})

test('msg_id 过期 errcode 40034005 = 确定性失败并清窗口；后续降级主动消息', async () => {
  const { adapter, rest, sock } = await ready(
    {},
    (url, method) => {
      if (url.endsWith('/app/getAppAccessToken')) return httpResp(200, { access_token: AT, expires_in: 7200 })
      if (url.endsWith('/gateway')) return httpResp(200, { url: 'wss://qq.test/websocket' })
      if (method === 'POST' && url.endsWith('/messages')) {
        return httpResp(200, { err_code: 40034005, message: '回复消息msg_id已过期', trace_id: 't-1' })
      }
      return httpResp(200, {})
    },
  )
  sock.push(C2C_FRAME())
  await tick()
  await assert.rejects(
    adapter.reply({ channel: 'qq', kind: 'dm', chatId: 'OPENID-U' }, 'x'),
    (error) => error instanceof QQApiError && error.errCode === 40034005 && !error.message.includes(AT),
  )
  await assert.rejects(
    adapter.reply({ channel: 'qq', kind: 'dm', chatId: 'OPENID-U' }, 'y'),
    (error) => error instanceof QQApiError,
  )
  assert.equal(rest.calls.at(-1).body.msg_id, undefined, '窗口已清空，第二次为主动消息形态')
  await adapter.disconnect()
})

test('Receipt 分档：网络异常/5xx/429 = uncertain；HTTP200+err_code≠0 与 4xx = 确定性', async () => {
  const net = await ready(
    {},
    (url, method) => {
      if (url.endsWith('/app/getAppAccessToken')) return httpResp(200, { access_token: AT, expires_in: 7200 })
      if (url.endsWith('/gateway')) return httpResp(200, { url: 'wss://qq.test/websocket' })
      if (method === 'POST' && url.endsWith('/messages')) throw new TypeError('socket hang up')
      return httpResp(200, {})
    },
  )
  await assert.rejects(
    net.adapter.reply({ channel: 'qq', kind: 'dm', chatId: 'OPENID-U' }, 'x'),
    (e) => e instanceof QQUncertainError,
  )
  await net.adapter.disconnect()

  for (const status of [500, 429]) {
    const flaky = await ready(
      {},
      (url, method) => {
        if (url.endsWith('/app/getAppAccessToken')) return httpResp(200, { access_token: AT, expires_in: 7200 })
        if (url.endsWith('/gateway')) return httpResp(200, { url: 'wss://qq.test/websocket' })
        if (method === 'POST' && url.endsWith('/messages')) return httpResp(status, { message: 'busy' })
        return httpResp(200, {})
      },
    )
    await assert.rejects(
      flaky.adapter.reply({ channel: 'qq', kind: 'dm', chatId: 'OPENID-U' }, 'x'),
      (e) => e instanceof QQUncertainError,
      `HTTP ${status} 属不确定`,
    )
    await flaky.adapter.disconnect()
  }

  const rejected = await ready(
    {},
    (url, method) => {
      if (url.endsWith('/app/getAppAccessToken')) return httpResp(200, { access_token: AT, expires_in: 7200 })
      if (url.endsWith('/gateway')) return httpResp(200, { url: 'wss://qq.test/websocket' })
      if (method === 'POST' && url.endsWith('/messages')) return httpResp(400, { err_code: 22006, message: '消息类型与内容不匹配' })
      return httpResp(200, {})
    },
  )
  await assert.rejects(
    rejected.adapter.reply({ channel: 'qq', kind: 'dm', chatId: 'OPENID-U' }, 'x'),
    (e) => e instanceof QQApiError && e.errCode === 22006 && e.httpStatus === 400,
  )
  await rejected.adapter.disconnect()

  const body500 = await ready(
    {},
    (url, method) => {
      if (url.endsWith('/app/getAppAccessToken')) return httpResp(200, { access_token: AT, expires_in: 7200 })
      if (url.endsWith('/gateway')) return httpResp(200, { url: 'wss://qq.test/websocket' })
      if (method === 'POST' && url.endsWith('/messages')) return { ok: false, status: 500, json: async () => { throw new Error('boom') } }
      return httpResp(200, {})
    },
  )
  await assert.rejects(
    body500.adapter.reply({ channel: 'qq', kind: 'dm', chatId: 'OPENID-U' }, 'x'),
    (e) => e instanceof QQUncertainError,
  )
  await body500.adapter.disconnect()
})

test('超时/中止（AbortSignal）与网络异常同档 = uncertain，且不误清被动窗口', async () => {
  const controller = new AbortController()
  controller.abort()
  const { adapter, rest, sock } = await ready({}, (url, method, _body, init) => {
    if (url.endsWith('/app/getAppAccessToken')) return httpResp(200, { access_token: AT, expires_in: 7200 })
    if (url.endsWith('/gateway')) return httpResp(200, { url: 'wss://qq.test/websocket' })
    if (method === 'POST' && init?.signal?.aborted === true) {
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    }
    return httpResp(200, { id: 'SENT-OK' })
  })
  sock.push(C2C_FRAME())
  await tick()
  await assert.rejects(
    adapter.reply({ channel: 'qq', kind: 'dm', chatId: 'OPENID-U' }, 'x', controller.signal),
    (error) =>
      error instanceof QQUncertainError &&
      /中止|超时|不确定/.test(error.message) &&
      !error.message.includes(SEC) &&
      !error.message.includes(AT),
  )
  const survived = await adapter.reply({ channel: 'qq', kind: 'dm', chatId: 'OPENID-U' }, 'y')
  assert.equal(survived.uncertain, false)
  assert.equal(survived.platformMessageId, 'SENT-OK')
  const last = rest.calls.at(-1)
  assert.equal(last.body.msg_id, 'ROBOT1.0_msg1', '不确定面不抹窗口，仍可按被动回复继续')
  assert.equal(last.body.msg_seq, 2, '中止那次已消费 seq：相同 msg_id+msg_seq 重发会撞去重')
  await adapter.disconnect()
})

test('凭证失效一档（401/11243）换发 token 后重试一次', async () => {
  let tokenIssued = 0
  let firstShot = true
  const { adapter, rest } = await ready(
    {},
    (url, method) => {
      if (url.endsWith('/app/getAppAccessToken')) {
        tokenIssued += 1
        return httpResp(200, { access_token: `${AT}#${tokenIssued}`, expires_in: 7200 })
      }
      if (url.endsWith('/gateway')) return httpResp(200, { url: 'wss://qq.test/websocket' })
      if (method === 'POST' && url.endsWith('/messages')) {
        if (firstShot) {
          firstShot = false
          return httpResp(200, { err_code: 11243, message: '校验 token 未通过' })
        }
        return httpResp(200, { id: 'SENT-2' })
      }
      return httpResp(200, {})
    },
  )
  const receipt = await adapter.reply({ channel: 'qq', kind: 'dm', chatId: 'OPENID-U' }, 'x')
  assert.equal(receipt.platformMessageId, 'SENT-2')
  assert.equal(tokenIssued, 2, '凭证类错误触发一次换发')
  assert.equal(rest.calls.at(-1).headers.authorization, `QQBot ${AT}#2`)
  await adapter.disconnect()
})

// —— 装饰面与能力声明 ——————————————————————————————————————————

test('setTyping：单聊走 msg_type=6 input_notify 且与回复共用 seq 不重复；群聊无该档静默 no-op', async () => {
  const { adapter, rest, sock } = await ready()
  sock.push(C2C_FRAME())
  await tick()
  await adapter.setTyping({ channel: 'qq', kind: 'dm', chatId: 'OPENID-U' })
  const typing = rest.calls.at(-1)
  assert.equal(typing.body.msg_type, 6)
  assert.deepEqual(typing.body.input_notify, { input_type: 1, input_second: 30 })
  assert.equal(typing.body.msg_id, 'ROBOT1.0_msg1')
  assert.equal(typing.body.msg_seq, 1, '状态通知同样占 seq，避免与后续回复撞去重')

  await adapter.reply({ channel: 'qq', kind: 'dm', chatId: 'OPENID-U' }, '正式回复')
  assert.equal(rest.calls.at(-1).body.msg_seq, 2)
  assert.equal(rest.calls.at(-1).body.msg_type, 0)

  const count = rest.calls.length
  await adapter.setTyping({ channel: 'qq', kind: 'group', chatId: 'GROUP-OPENID' })
  assert.equal(rest.calls.length, count, '群聊无 typing 档：不发请求')
  await adapter.disconnect()
})

test('setTyping 失败一律吞（装饰面不得影响主回复链）', async () => {
  const { adapter } = await ready(
    {},
    (url, method) => {
      if (url.endsWith('/app/getAppAccessToken')) return httpResp(200, { access_token: AT, expires_in: 7200 })
      if (url.endsWith('/gateway')) return httpResp(200, { url: 'wss://qq.test/websocket' })
      if (method === 'POST' && url.endsWith('/messages')) return httpResp(400, { err_code: 340069, message: '消息类型无效' })
      return httpResp(200, {})
    },
  )
  await adapter.setTyping({ channel: 'qq', kind: 'dm', chatId: 'OPENID-U' })
  await adapter.disconnect()
})

test('caps 诚实位 + authorize 恒交网关 + 无 beginStream/sendFile/askChoices 面', async () => {
  const { adapter } = await ready()
  assert.equal(adapter.id, 'qq')
  assert.deepEqual(adapter.caps, {
    editStream: false,
    nativeStream: false,
    nativeChoices: false,
    statusReaction: false,
    typing: true,
    imageIn: false,
    fileIn: false,
    fileOut: false,
    threads: false,
    voice: false,
    maxMessageLength: 1300,
  })
  assert.equal(adapter.authorize(), undefined)
  assert.equal(adapter.beginStream, undefined)
  assert.equal(adapter.sendFile, undefined)
  assert.equal(adapter.askChoices, undefined)
  await adapter.disconnect()
})

test('数字菜单回退前提：nativeChoices=false 时引擎走文本档位，本渠道不实现按钮面', async () => {
  const { adapter } = await ready()
  assert.equal(adapter.caps.nativeChoices, false)
  assert.equal(typeof adapter.askChoices, 'undefined')
  await adapter.disconnect()
})

// —— 诊断三态与零 secret 回显 ——————————————————————————————————————————

test('diagnose：token 面实探 passed，roundtrip/富媒体恒 unverified，hint 零 secret 回显', async () => {
  const { adapter, sock } = await ready()
  const checks = await adapter.diagnose()
  assert.equal(checks[0].name, 'token-endpoint')
  assert.equal(checks[0].status, 'passed')
  assert.ok(!JSON.stringify(checks).includes(SEC), 'hint 不回显 appSecret')
  assert.ok(!JSON.stringify(checks).includes(AT), 'hint 不回显 access_token')
  assert.equal(checks[1].name, 'gateway-session')
  assert.equal(checks[1].status, 'passed', 'READY 后网关位绿')
  assert.equal(checks[2].name, 'send-roundtrip')
  assert.equal(checks[2].status, 'unverified')
  assert.equal(checks[3].name, 'rich-media-capability')
  assert.equal(checks[3].status, 'unverified')
  assert.match(checks[3].hint, /富媒体需平台侧开通/)
  await adapter.disconnect()

  const offline = await build()
  const offlineChecks = await offline.adapter.diagnose()
  assert.equal(offlineChecks[1].status, 'unverified', '未连接时网关位 unverified 而非 failed')
  await offline.adapter.disconnect()
})

test('diagnose：4xx 凭证拒绝 = failed（文案抹掉 secret）；网络异常 = unverified', async () => {
  const bad = await build({}, () => httpResp(401, { err_code: 11243, message: `校验 token 未通过 secret=${SEC}` }))
  const badChecks = await bad.adapter.diagnose()
  assert.equal(badChecks[0].status, 'failed')
  assert.ok(!badChecks[0].hint.includes(SEC), '失败文案同样抹掉 appSecret')
  await bad.adapter.disconnect()

  const blind = await build({}, () => {
    throw new TypeError('getaddrinfo ENOTFOUND api.bot.qq.com')
  })
  const blindChecks = await blind.adapter.diagnose()
  assert.equal(blindChecks[0].status, 'unverified')
  await blind.adapter.disconnect()

  const limited = await build({}, (url) =>
    url.endsWith('/app/getAppAccessToken') ? httpResp(429, { message: 'rate limit' }) : httpResp(200, {}),
  )
  assert.equal((await limited.adapter.diagnose())[0].status, 'unverified', '限流属不确定')
  await limited.adapter.disconnect()
})

// —— 长文与工厂 ——————————————————————————————————————————

test('长文按 UTF-8 字节预算截断且不切裂多字节字符', async () => {
  const { adapter, rest } = await ready()
  const long = '汉'.repeat(3000)
  await adapter.reply({ channel: 'qq', kind: 'dm', chatId: 'OPENID-U' }, long)
  const sent = rest.calls.at(-1).body.content
  assert.ok(new TextEncoder().encode(sent).length <= 4000, '出站体不超字节预算')
  assert.ok(sent.endsWith('…'))
  assert.equal(sent.startsWith('汉'), true)
  const budgeted = fitByteBudget('a'.repeat(10), 20)
  assert.equal(budgeted, 'a'.repeat(10), '预算内原样返回')
  await adapter.disconnect()
})

test('createQqAdapter：appId/appSecret 未入库即抛；config 覆盖 apiBaseUrl/tokenUrl', () => {
  assert.throws(() => createQqAdapter({ accountId: 'a1', config: {}, secrets: {} }), /appId 未入库/)
  assert.throws(() => createQqAdapter({ accountId: 'a1', config: {}, secrets: { appId: 'X' } }), /appSecret 未入库/)
  const made = createQqAdapter({
    accountId: 'a1',
    config: { apiBaseUrl: 'https://sandbox.api.sgroup.qq.com', tokenUrl: 'https://bots.qq.com/app/getAppAccessToken' },
    secrets: { appId: 'X', appSecret: 'Y' },
  })
  assert.ok(made instanceof QqAdapter)
  assert.equal(made.caps.maxMessageLength, 1300)
  assert.throws(
    () => new QqAdapter({ appId: '', appSecret: 'Y' }),
    /appId 缺失/,
  )
})

test('入站缺消息 id / 缺 openid 的畸形帧与越界事件型不产生入站也不抛', async () => {
  const { adapter, sock } = await ready()
  const got = []
  adapter.onMessage((m) => got.push(m))
  sock.push({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 20, d: { author: { user_openid: 'A' } } })
  sock.push({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 21, d: { id: 'g2', author: { member_openid: 'B' } } })
  sock.push({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 22, d: { id: 'c3', author: { bot: false } } })
  sock.push({ op: 0, t: 'AUDIO_FINISH', s: 23, d: { id: 'x' } })
  sock.push({ op: 0, t: 'MESSAGE_CREATE', s: 24, d: { id: 'y' } })
  sock.push({ op: 0, t: 'READY', s: 25, d: { session_id: 'SESSION-2', user: { id: 'BOTID' } } })
  sock.push('not-json')
  await tick()
  assert.equal(got.length, 0, '缺 id/缺 openid 的事件与未订阅事件型均安全丢弃')
  assert.equal(adapter.connected, true, '二次 READY 只刷新会话位')
  await adapter.disconnect()
})
