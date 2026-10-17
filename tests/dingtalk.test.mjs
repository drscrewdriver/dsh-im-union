// T2.1 钉钉渠道单测：Stream 注册建连握手 / 线帧 ACK（EVENT·CALLBACK·ping·disconnect）/
// 机器人回调归一（dm·group·回声丢弃·排重·非文本占位）/ sessionWebhook 回复形态 /
// AI Card 投放+流式（guid 唯一·isFull·isFinalize）/ 卡片失败回退文本 /
// errcode 确定性 vs 网络 uncertain / 主动推送 / token 刷新 / 诊断三态 / 工厂。
// 网络面全注入 fake fetch + fake WebSocket，不发真实请求。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DingtalkAdapter,
  DingTalkApiError,
  DingTalkUncertainError,
  createDingtalkAdapter,
} from '../lib/channels/dingtalk.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// —— fake WebSocket（与 wecom/telegram 测试同款形态） ————————————

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
        if (sock.closed) return
        sock.closed = true
        sock.readyState = 3
        sock.emit('close', {})
      },
      addEventListener(type, cb) {
        ;(listeners[type] ??= []).push(cb)
      },
      emit(type, event) {
        for (const cb of listeners[type] ?? []) cb(event)
      },
      /** 辅助：投递一帧下行（对象或已序列化字符串）。 */
      push(frame) {
        sock.emit('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) })
      },
    }
    made.push(sock)
    return sock
  }
  return { factory, made }
}

// —— fake fetch：按 URL 片段路由，记录全部调用 ————————————————

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

const GATEWAY_URL = '/v1.0/gateway/connections/open'
const TOKEN_URL = '/v1.0/oauth2/accessToken'
const CARD_CREATE_URL = '/v1.0/card/instances/createAndDeliver'
const CARD_STREAM_URL = '/v1.0/card/streaming'
const DM_SEND_URL = '/v1.0/robot/oToMessages/batchSend'
const GROUP_SEND_URL = '/v1.0/robot/groupMessages/send'
const WEBHOOK_URL = 'https://oapi.dingtalk.com/robot/sendBySession?session=s1'

const defaultRoutes = () => ({
  [GATEWAY_URL]: () => jsonResponse(200, { endpoint: 'wss://wss-open-connection.dingtalk.com:443/connect', ticket: 'TICKET-1' }),
  [TOKEN_URL]: () => jsonResponse(200, { accessToken: 'AT-1', expireIn: 7200 }),
  [CARD_CREATE_URL]: () => jsonResponse(200, { success: true }),
  [CARD_STREAM_URL]: () => jsonResponse(200, { success: true, result: true }),
  [WEBHOOK_URL]: () => jsonResponse(200, { errcode: 0, errmsg: 'ok' }),
  [DM_SEND_URL]: () => jsonResponse(200, { processQueryKey: 'PQ-DM' }),
  [GROUP_SEND_URL]: () => jsonResponse(200, { processQueryKey: 'PQ-GROUP' }),
})

function fakeFetch(overrides = {}) {
  const routes = { ...defaultRoutes(), ...overrides }
  const calls = []
  const fn = async (url, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    const record = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body }
    calls.push(record)
    for (const [key, handler] of Object.entries(routes)) {
      if (key !== '' && url.includes(key)) return handler(record, calls)
    }
    return jsonResponse(404, { code: 'NotFound', message: `fake 未路由：${url}` })
  }
  const of = (needle) => calls.filter((c) => c.url.includes(needle))
  return { fn, calls, of }
}

// —— 构造助手 ——————————————————————————————————————

function makeAdapter(optionPatches = {}, routes = {}) {
  const ws = fakeWS()
  const http = fakeFetch(routes)
  const adapter = new DingtalkAdapter({
    clientId: 'CID',
    clientSecret: 'CS',
    cardTemplateId: 'TPL-1',
    robotCode: 'ROBOT-1',
    WebSocketImpl: ws.factory,
    fetchImpl: http.fn,
    streamThrottleMs: 0,
    requestTimeoutMs: 40,
    ...optionPatches,
  })
  return { adapter, ws, http }
}

/** 完成 Stream 握手后的适配器 + socket。 */
async function connectedAdapter(optionPatches = {}, routes = {}) {
  const { adapter, ws, http } = makeAdapter(optionPatches, routes)
  const inflight = adapter.connect()
  await sleep(5)
  const sock = ws.made[0]
  sock.emit('open', {})
  await inflight
  return { adapter, sock, ws, http }
}

// —— 线帧夹具 ——————————————————————————————————————

const wireFrame = (type, topic, messageId, data) => ({
  specVersion: '1.0',
  type,
  headers: { contentType: 'application/json', messageId, topic },
  data: JSON.stringify(data),
})

const dmPayload = (over = {}) => ({
  conversationId: 'cidDM==',
  conversationType: '1',
  senderId: '$:LWCP_v1:$user',
  senderStaffId: 'staff-001',
  senderNick: '小明',
  chatbotUserId: '$:LWCP_v1:$bot',
  msgId: 'msg-1',
  msgtype: 'text',
  text: { content: ' 你好，钉钉 ' },
  robotCode: 'dingROBOT',
  isInAtList: false,
  sessionWebhook: WEBHOOK_URL,
  sessionWebhookExpiredTime: Date.now() + 60_000,
  createAt: 1690362101894,
  ...over,
})

const groupPayload = (over = {}) =>
  dmPayload({
    conversationId: 'cidGroup==',
    conversationType: '2',
    text: { content: '@小助手 帮我查天气' },
    isInAtList: true,
    conversationTitle: '测试群',
    ...over,
  })

/** 喂一条机器人回调并返回归一后的 SemanticMessage（同时注册回复上下文）。 */
function botFrame(messageId, payload) {
  return wireFrame('CALLBACK', '/v1.0/im/bot/messages/get', messageId, payload)
}

// —— 一、Stream 建连握手 ——————————————————————————————————

test('connect：POST /v1.0/gateway/connections/open 携 clientId/clientSecret+subscriptions，endpoint?ticket= 建连', async () => {
  const { adapter, ws, http } = await connectedAdapter()
  const open = http.of(GATEWAY_URL)[0]
  assert.equal(open.method, 'POST')
  assert.equal(open.body.clientId, 'CID')
  assert.equal(open.body.clientSecret, 'CS')
  assert.deepEqual(open.body.subscriptions, [
    { type: 'EVENT', topic: '*' },
    { type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' },
  ])
  assert.match(open.body.ua, /^[\w.-]+\/\d+\.\d+\.\d+$/, '文档口径 ua=name-sdk-lang/version')
  assert.ok(ws.made[0].url.startsWith('wss://wss-open-connection.dingtalk.com:443/connect?ticket=TICKET-1'))
  assert.equal(adapter.connected, true)
  // ticket 90s 单次有效：建连面不应复用旧 ticket 再发一次注册
  assert.equal(http.of(GATEWAY_URL).length, 1)
  await adapter.disconnect()
})

test('connect：注册未返回 endpoint/ticket → 确定性 DingTalkApiError', async () => {
  const { adapter, ws } = makeAdapter({}, { [GATEWAY_URL]: () => jsonResponse(200, { endpoint: '', ticket: '' }) })
  const rejected = assert.rejects(adapter.connect(), DingTalkApiError)
  await sleep(10)
  await rejected
  assert.equal(ws.made.length, 0, '无 ticket 不应建连')
})

// —— 二、线帧 ACK ——————————————————————————————————————

test('EVENT 帧：回 ACK data 带 status=SUCCESS 且 messageId 原样回传，不派发业务', async () => {
  const { adapter, sock } = await connectedAdapter()
  const seen = []
  adapter.onMessage((m) => seen.push(m))
  sock.push(wireFrame('EVENT', '*', 'EM-1', { eventType: 'user_add_org' }))
  const ack = sock.sent.at(-1)
  assert.equal(ack.code, 200)
  assert.equal(ack.headers.messageId, 'EM-1')
  assert.equal(ack.headers.contentType, 'application/json')
  assert.deepEqual(JSON.parse(ack.data), { status: 'SUCCESS', message: 'success' })
  assert.equal(seen.length, 0)
  await adapter.disconnect()
})

test('机器人 CALLBACK：先回固定 {"response": null} 再派发归一消息', async () => {
  const { adapter, sock } = await connectedAdapter()
  const seen = []
  adapter.onMessage((m) => seen.push(m))
  sock.push(wireFrame('CALLBACK', '/v1.0/im/bot/messages/get', 'CB-1', dmPayload()))
  assert.equal(sock.sent.length, 1, '只回一帧 ACK')
  const ack = sock.sent[0]
  assert.equal(ack.code, 200)
  assert.equal(ack.headers.messageId, 'CB-1')
  assert.equal(ack.data, '{"response":null}')
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].address, { channel: 'dingtalk', kind: 'dm', chatId: 'staff-001' })
  assert.equal(seen[0].text, '你好，钉钉')
  assert.equal(seen[0].userId, 'staff-001')
  assert.equal(seen[0].userDisplayName, '小明')
  assert.equal(seen[0].mentionedBot, false, '单聊不算点名')
  assert.equal(seen[0].timestamp, 1690362101894)
  await adapter.disconnect()
})

test('SYSTEM ping：data 原样回传（opaque）且 messageId 一致 = PONG', async () => {
  const { adapter, sock } = await connectedAdapter()
  sock.push(wireFrame('SYSTEM', 'ping', 'PM-1', { opaque: '123-dsfs' }))
  const pong = sock.sent.at(-1)
  assert.equal(pong.code, 200)
  assert.equal(pong.message, 'OK')
  assert.equal(pong.headers.messageId, 'PM-1')
  assert.equal(pong.data, '{"opaque":"123-dsfs"}', '文档：响应 data 需携带请求 opaque')
  await adapter.disconnect()
})

test('SYSTEM disconnect：不回 ACK，主动关闭走「重新注册取新 ticket」重连路径', async () => {
  const { adapter, sock } = await connectedAdapter()
  const before = sock.sent.length
  sock.push({ specVersion: '1.0', type: 'SYSTEM', headers: { contentType: 'application/json', topic: 'disconnect' }, data: JSON.stringify({ reason: 'connection is expired' }) })
  assert.equal(sock.sent.length, before, 'disconnect 无需响应')
  assert.equal(sock.closed, true)
  assert.equal(adapter.connected, false)
  await adapter.disconnect()
})

test('未知 CALLBACK topic：回 code 404 topic not supported', async () => {
  const { adapter, sock } = await connectedAdapter()
  sock.push(wireFrame('CALLBACK', '/v1.0/unknown/topic', 'UK-1', {}))
  const ack = sock.sent.at(-1)
  assert.equal(ack.code, 404)
  assert.match(ack.message, /topic/)
  await adapter.disconnect()
})

// —— 三、入站归一 ——————————————————————————————————————

test('normalize：群聊→group（chatId=conversationId）+ 剥 @ 前缀 + mentionedBot=true', () => {
  const { adapter } = makeAdapter()
  const m = adapter.normalize(groupPayload())
  assert.equal(m.address.kind, 'group')
  assert.equal(m.address.chatId, 'cidGroup==')
  assert.equal(m.text, '帮我查天气', '协议事实：回调 content 带 @机器人前缀')
  assert.equal(m.mentionedBot, true, '协议事实：群里只有 @ 本机器人才回调')
})

test('normalize：机器人自发回声丢弃', () => {
  const { adapter } = makeAdapter()
  assert.equal(adapter.normalize(dmPayload({ senderId: '$:LWCP_v1:$bot' })), undefined)
})

test('排重：同 msgId 重放只派发一次（事件面可能重放）', async () => {
  const { adapter, sock } = await connectedAdapter()
  const seen = []
  adapter.onMessage((m) => seen.push(m))
  sock.push(wireFrame('CALLBACK', '/v1.0/im/bot/messages/get', 'CB-A', dmPayload({ msgId: 'dup-1' })))
  sock.push(wireFrame('CALLBACK', '/v1.0/im/bot/messages/get', 'CB-B', dmPayload({ msgId: 'dup-1' })))
  assert.equal(seen.length, 1)
  assert.equal(sock.sent.length, 2, '两帧都需 ACK（避免服务端判消费失败重推）')
  await adapter.disconnect()
})

test('normalize：非文本类型给占位文案，不丢事件（与飞书同纪律）', () => {
  const { adapter } = makeAdapter()
  assert.match(adapter.normalize(dmPayload({ msgtype: 'picture', text: undefined })).text, /图片输入首档未启用/)
  assert.match(adapter.normalize(dmPayload({ msgtype: 'audio', text: undefined })).text, /语音输入未启用/)
  assert.match(adapter.normalize(dmPayload({ msgtype: 'file', text: undefined })).text, /文件输入未启用/)
  assert.match(adapter.normalize(dmPayload({ msgtype: 'sticker', text: undefined })).text, /暂不支持的消息类型：sticker/)
  const rich = adapter.normalize(
    dmPayload({ msgtype: 'richText', text: undefined, content: { richText: [{ text: '前段' }, { type: 'picture', downloadCode: 'DC' }, { text: '后段' }] } }),
  )
  assert.equal(rich.text, '前段 [图片] 后段')
})

// —— 四、出站：sessionWebhook ——————————————————————————

test('reply：回调上下文内走 sessionWebhook，markdown 优先且无需 token 头', async () => {
  const { adapter, sock, http } = await connectedAdapter()
  sock.push(wireFrame('CALLBACK', '/v1.0/im/bot/messages/get', 'CB-1', dmPayload()))
  const receipt = await adapter.reply({ channel: 'dingtalk', kind: 'dm', chatId: 'staff-001' }, '**粗体** 回复')
  const hook = http.of(WEBHOOK_URL).at(-1)
  assert.equal(hook.url, WEBHOOK_URL)
  assert.equal(hook.method, 'POST')
  assert.equal(hook.body.msgtype, 'markdown')
  assert.equal(hook.body.markdown.text, '**粗体** 回复')
  assert.equal(hook.body.markdown.title, '粗体 回复', 'title 取首行去标记')
  assert.equal(hook.headers['x-acs-dingtalk-access-token'], undefined, 'webhook 面不需要 access_token')
  assert.deepEqual(receipt, { uncertain: false })
  await adapter.disconnect()
})

test('reply：超 caps.maxMessageLength 裁剪到 1000（保留最新尾窗）', async () => {
  const { adapter, sock, http } = await connectedAdapter()
  sock.push(botFrame('CB-1', dmPayload()))
  await adapter.reply({ channel: 'dingtalk', kind: 'dm', chatId: 'staff-001' }, 'x'.repeat(1500))
  const sent = http.of(WEBHOOK_URL).at(-1).body.markdown.text
  assert.equal(sent.length, 1000)
  assert.ok(sent.startsWith('…'), '截断前缀省略号提示')
  assert.ok(sent.endsWith('x'))
  await adapter.disconnect()
})

test('markdown 被格式类拒绝（errcode）→ 回退纯文本重发', async () => {
  let hookCalls = 0
  const { adapter, sock, http } = await connectedAdapter({}, {
    [WEBHOOK_URL]: () => {
      hookCalls += 1
      return hookCalls === 1
        ? jsonResponse(200, { errcode: 400005, errmsg: 'invalid markdown format' })
        : jsonResponse(200, { errcode: 0, errmsg: 'ok' })
    },
  })
  sock.push(wireFrame('CALLBACK', '/v1.0/im/bot/messages/get', 'CB-1', dmPayload()))
  const receipt = await adapter.reply({ channel: 'dingtalk', kind: 'dm', chatId: 'staff-001' }, '回退链测试')
  const bodies = http.of(WEBHOOK_URL).map((c) => c.body)
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0].msgtype, 'markdown')
  assert.deepEqual(bodies[1], { msgtype: 'text', text: { content: '回退链测试' } })
  assert.equal(receipt.uncertain, false)
  await adapter.disconnect()
})

test('errcode=-1（系统繁忙）→ DingTalkUncertainError，不伪装确定性失败', async () => {
  const { adapter, sock } = await connectedAdapter({}, { [WEBHOOK_URL]: () => jsonResponse(200, { errcode: -1, errmsg: '系统繁忙' }) })
  sock.push(wireFrame('CALLBACK', '/v1.0/im/bot/messages/get', 'CB-1', dmPayload()))
  await assert.rejects(
    adapter.reply({ channel: 'dingtalk', kind: 'dm', chatId: 'staff-001' }, 'x'),
    (error) => error instanceof DingTalkUncertainError,
  )
  await adapter.disconnect()
})

test('errcode 明确拒绝 → DingTalkApiError（确定性），且不自动重发', async () => {
  const { adapter, sock, http } = await connectedAdapter({}, { [WEBHOOK_URL]: () => jsonResponse(200, { errcode: 130101, errmsg: 'token is not exist' }) })
  sock.push(wireFrame('CALLBACK', '/v1.0/im/bot/messages/get', 'CB-1', dmPayload()))
  await assert.rejects(
    adapter.reply({ channel: 'dingtalk', kind: 'dm', chatId: 'staff-001' }, 'x'),
    (error) => error instanceof DingTalkApiError && error.code === '130101',
  )
  assert.equal(http.of(WEBHOOK_URL).length, 1, 'D7：明确拒绝不重发')
  await adapter.disconnect()
})

test('传输失败/超时 → DingTalkUncertainError（webhook 只发一次）', async () => {
  const { adapter, sock, http } = await connectedAdapter({}, {
    [WEBHOOK_URL]: () => {
      throw new TypeError('fetch failed')
    },
  })
  sock.push(wireFrame('CALLBACK', '/v1.0/im/bot/messages/get', 'CB-1', dmPayload()))
  await assert.rejects(adapter.reply({ channel: 'dingtalk', kind: 'dm', chatId: 'staff-001' }, 'x'), DingTalkUncertainError)
  assert.equal(http.of(WEBHOOK_URL).length, 1)

  const hang = await connectedAdapter({ requestTimeoutMs: 20 }, {
    [WEBHOOK_URL]: () => new Promise(() => {}),
  })
  hang.sock.push(wireFrame('CALLBACK', '/v1.0/im/bot/messages/get', 'CB-2', dmPayload()))
  await assert.rejects(hang.adapter.reply({ channel: 'dingtalk', kind: 'dm', chatId: 'staff-001' }, 'x'), DingTalkUncertainError)
  await hang.adapter.disconnect()
  await adapter.disconnect()
})

// —— 五、出站：机器人主动推送 ——————————————————————————

test('无回调上下文：单聊 batchSend / 群聊 groupMessages.send，msgParam 为 json 字符串并回 platformMessageId', async () => {
  const { adapter, http } = await connectedAdapter()
  const dm = await adapter.reply({ channel: 'dingtalk', kind: 'dm', chatId: 'staff-999' }, '主动单聊')
  const dmCall = http.of(DM_SEND_URL).at(-1)
  assert.equal(dmCall.body.robotCode, 'ROBOT-1')
  assert.deepEqual(dmCall.body.userIds, ['staff-999'])
  assert.equal(dmCall.body.msgKey, 'sampleMarkdown')
  assert.deepEqual(JSON.parse(dmCall.body.msgParam), { title: '主动单聊', text: '主动单聊' })
  assert.equal(dmCall.headers['x-acs-dingtalk-access-token'], 'AT-1', 'v1.0 接口鉴权头')
  assert.deepEqual(dm, { platformMessageId: 'PQ-DM', uncertain: false })

  const group = await adapter.reply({ channel: 'dingtalk', kind: 'group', chatId: 'cidGroup==' }, '主动群聊')
  const groupCall = http.of(GROUP_SEND_URL).at(-1)
  assert.equal(groupCall.body.openConversationId, 'cidGroup==')
  assert.equal(groupCall.body.msgKey, 'sampleMarkdown')
  assert.deepEqual(group, { platformMessageId: 'PQ-GROUP', uncertain: false })
  await adapter.disconnect()
})

test('既无 sessionWebhook 又无 robotCode → 确定性 DingTalkApiError（no-context）', async () => {
  const { adapter } = await connectedAdapter({ robotCode: '' })
  await assert.rejects(
    adapter.reply({ channel: 'dingtalk', kind: 'dm', chatId: 'staff-001' }, 'x'),
    (error) => error instanceof DingTalkApiError && error.code === 'no-context',
  )
  await adapter.disconnect()
})

test('token 失效（401 InvalidAuthentication）→ 刷新后重试一次', async () => {
  let tokens = 0
  let sends = 0
  const { adapter, http } = await connectedAdapter(
    {},
    {
      [TOKEN_URL]: () => jsonResponse(200, { accessToken: `AT-${++tokens}`, expireIn: 7200 }),
      [DM_SEND_URL]: () => (++sends === 1 ? jsonResponse(401, { code: 'InvalidAuthentication', message: 'access token invalid' }) : jsonResponse(200, { processQueryKey: 'PQ-OK' })),
    },
  )
  const receipt = await adapter.reply({ channel: 'dingtalk', kind: 'dm', chatId: 'staff-001' }, '重试')
  assert.equal(sends, 2)
  assert.equal(http.of(DM_SEND_URL).at(-1).headers['x-acs-dingtalk-access-token'], 'AT-2')
  assert.equal(receipt.platformMessageId, 'PQ-OK')
  await adapter.disconnect()
})

// —— 六、AI Card 流式 ——————————————————————————————————

test('beginStream：createAndDeliver 单聊形态（outTrackId/callbackType=STREAM/openSpaceId=IM_ROBOT）', async () => {
  const { adapter, http } = await connectedAdapter()
  const stream = await adapter.beginStream({ channel: 'dingtalk', kind: 'dm', chatId: 'staff-001' })
  const create = http.of(CARD_CREATE_URL).at(-1)
  assert.equal(create.body.cardTemplateId, 'TPL-1')
  assert.match(create.body.outTrackId, /^imu_/)
  assert.equal(create.body.callbackType, 'STREAM')
  assert.equal(create.body.openSpaceId, 'dtv1.card//IM_ROBOT.staff-001')
  assert.deepEqual(create.body.imRobotOpenSpaceModel, { supportForward: true })
  assert.deepEqual(create.body.imRobotOpenDeliverModel, { spaceType: 'IM_ROBOT' })
  assert.deepEqual(create.body.cardData, { cardParamMap: { content: '' } })
  await stream.abort()
  await adapter.disconnect()
})

test('beginStream：群卡片 openSpaceId=IM_GROUP.<conversationId> + imGroupOpenDeliverModel 带 robotCode', async () => {
  const { adapter, sock, http } = await connectedAdapter()
  sock.push(wireFrame('CALLBACK', '/v1.0/im/bot/messages/get', 'CB-G', groupPayload()))
  const stream = await adapter.beginStream({ channel: 'dingtalk', kind: 'group', chatId: 'cidGroup==' })
  const create = http.of(CARD_CREATE_URL).at(-1)
  assert.equal(create.body.openSpaceId, 'dtv1.card//IM_GROUP.cidGroup==')
  assert.deepEqual(create.body.imGroupOpenDeliverModel, { robotCode: 'ROBOT-1', spaceType: 'IM_GROUP' })
  assert.deepEqual(create.body.cardData, { cardParamMap: { content: '' } })
  await stream.abort()
  await adapter.disconnect()
})

test('卡片流式：PUT /v1.0/card/streaming，guid 每帧唯一，isFull=true，收轮 isFinalize=true', async () => {
  const { adapter, http } = await connectedAdapter()
  const address = { channel: 'dingtalk', kind: 'dm', chatId: 'staff-001' }
  const stream = await adapter.beginStream(address)
  await stream.update('第一段')
  await stream.update('第一段 第二段')
  const receipt = await stream.finish('第一段 第二段 终')
  const frames = http.of(CARD_STREAM_URL)
  assert.equal(frames.length, 2 + 1)
  assert.equal(frames[0].method, 'PUT', '文档口径：流式更新为 PUT')
  for (const frame of frames) {
    assert.equal(frame.body.isFull, true, 'markdown 变量必须全量覆盖')
    assert.equal(frame.body.key, 'content')
    assert.match(frame.body.guid, /^[\w-]{36}$/, 'guid 需为唯一幂等标志')
  }
  assert.equal(new Set(frames.map((f) => f.body.guid)).size, frames.length, 'guid 不得重复')
  assert.equal(new Set(frames.map((f) => f.body.outTrackId)).size, 1, '同一张卡共用 outTrackId')
  assert.equal(frames.at(-2).body.isFinalize, false)
  assert.equal(frames.at(-1).body.isFinalize, true, '收轮帧切「完成」态')
  assert.equal(frames.at(-1).body.content, '第一段 第二段 终')
  assert.equal(receipt.uncertain, false)
  assert.match(receipt.platformMessageId, /^imu_/)
  await adapter.disconnect()
})

test('卡片流式：单帧超 1K 保留最新尾窗（打字机可见尾部）', async () => {
  const { adapter, http } = await connectedAdapter()
  const stream = await adapter.beginStream({ channel: 'dingtalk', kind: 'dm', chatId: 'staff-001' })
  await stream.update('h'.repeat(1500))
  const content = http.of(CARD_STREAM_URL).at(-1).body.content
  assert.equal(content.length, 1000)
  assert.ok(content.startsWith('…'))
  await stream.abort()
  await adapter.disconnect()
})

test('卡片面确定性被拒（权限）→ 退化文本档：caps 关闭 + finish 走 sessionWebhook 文本', async () => {
  const { adapter, sock, http } = await connectedAdapter(
    {},
    { [CARD_CREATE_URL]: () => jsonResponse(403, { code: 'Forbidden', message: 'no permission Card.Instance.Write' }) },
  )
  sock.push(wireFrame('CALLBACK', '/v1.0/im/bot/messages/get', 'CB-1', dmPayload()))
  assert.equal(adapter.caps.nativeStream, true)
  const stream = await adapter.beginStream({ channel: 'dingtalk', kind: 'dm', chatId: 'staff-001' })
  assert.equal(adapter.cardDisabled, true)
  assert.equal(adapter.caps.nativeStream, false, '声明=真实现：卡片面关闭即撤销原生流式声明')
  assert.equal(adapter.caps.statusProgress, false)
  await stream.update('中间快照不发帧')
  assert.equal(http.of(CARD_STREAM_URL).length, 0)
  assert.equal(http.of(WEBHOOK_URL).length, 0)
  const receipt = await stream.finish('文本回退终稿')
  assert.equal(http.of(WEBHOOK_URL).at(-1).body.markdown.text, '文本回退终稿')
  assert.equal(receipt.uncertain, false)
  await adapter.disconnect()
})

test('卡片面 uncertain（网络错）→ 上抛不改判、不关卡片档（D7）', async () => {
  const { adapter } = await connectedAdapter({}, {
    [CARD_CREATE_URL]: () => {
      throw new TypeError('socket hang up')
    },
  })
  await assert.rejects(
    adapter.beginStream({ channel: 'dingtalk', kind: 'dm', chatId: 'staff-001' }),
    DingTalkUncertainError,
  )
  assert.equal(adapter.cardDisabled, false)
  assert.equal(adapter.caps.nativeStream, true)
  await adapter.disconnect()
})

test('文本档：未配 cardTemplateId / cardMode=text → beginStream 抛错交引擎退化 reply', async () => {
  const noTpl = makeAdapter({ cardTemplateId: '' })
  assert.equal(noTpl.adapter.caps.nativeStream, false)
  assert.equal(noTpl.adapter.caps.statusProgress, false)
  await assert.rejects(noTpl.adapter.beginStream({ channel: 'dingtalk', kind: 'dm', chatId: 'u' }), /cardTemplateId/)

  const textMode = makeAdapter({ cardMode: 'text' })
  await assert.rejects(textMode.adapter.beginStream({ channel: 'dingtalk', kind: 'dm', chatId: 'u' }), /文本档/)
})

// —— 七、caps / 准入 ——————————————————————————————————

test('caps 诚实：卡片档只声明 nativeStream+statusProgress，其余未实现一律 false', () => {
  const { adapter } = makeAdapter()
  assert.deepEqual(adapter.caps, {
    editStream: false,
    nativeStream: true,
    nativeChoices: false,
    statusReaction: false,
    statusProgress: true,
    typing: false,
    imageIn: false,
    fileIn: false,
    fileOut: false,
    threads: false,
    voice: false,
    maxMessageLength: 1000,
  })
  assert.equal(adapter.id, 'dingtalk')
  assert.equal(adapter.label, '钉钉')
})

test('authorize 恒返回 undefined（白名单裁决在网关，红线 D6）', () => {
  const { adapter } = makeAdapter()
  const message = adapter.normalize(dmPayload())
  assert.equal(adapter.authorize(message), undefined)
})

// —— 八、诊断三态 ——————————————————————————————————————

test('diagnose：credentials 实探 passed / stream passed / card+roundtrip unverified / hint 零 secret 回显', async () => {
  const { adapter, http } = await connectedAdapter()
  const before = http.of(TOKEN_URL).length
  const checks = await adapter.diagnose()
  assert.deepEqual(checks.map((c) => [c.name, c.status]), [
    ['credentials', 'passed'],
    ['stream-connection', 'passed'],
    ['card-streaming', 'unverified'],
    ['roundtrip', 'unverified'],
  ])
  assert.ok(http.of(TOKEN_URL).length > before, 'credentials 面实探：不复用缓存 token')
  const hints = checks.map((c) => c.hint ?? '').join('|')
  assert.ok(!hints.includes('CS'), 'hint 零 secret 回显')
  assert.ok(!hints.includes('AT-1'), 'hint 不回显 token')
  await adapter.disconnect()
})

test('diagnose：凭据被 4xx 拒绝 → failed（确定性）', async () => {
  const { adapter } = await connectedAdapter({}, {
    [TOKEN_URL]: () => jsonResponse(400, { code: 'invalidClientIdSecret', message: 'appKey or appSecret is invalid' }),
  })
  const checks = await adapter.diagnose()
  assert.equal(checks[0].name, 'credentials')
  assert.equal(checks[0].status, 'failed')
  assert.ok(!checks[0].hint.includes('CS'))
  await adapter.disconnect()
})

test('diagnose：网络抖动 → credentials unverified（不谎报失败）', async () => {
  const { adapter } = await connectedAdapter({}, {
    [TOKEN_URL]: () => {
      throw new TypeError('network unreachable')
    },
  })
  const checks = await adapter.diagnose()
  assert.equal(checks[0].status, 'unverified')
  assert.equal(checks.at(-1).name, 'roundtrip')
  assert.equal(checks.at(-1).status, 'unverified')
  await adapter.disconnect()
})

// —— 九、工厂 ——————————————————————————————————————

test('工厂：secrets 取 clientId/clientSecret，缺位即抛（不静默降级）', () => {
  assert.throws(() => createDingtalkAdapter({ accountId: 'a1', config: {}, secrets: {} }), /clientId\/clientSecret 未入库/)
  assert.throws(() => createDingtalkAdapter({ accountId: 'a1', config: {}, secrets: { clientId: 'C' } }), /clientId\/clientSecret 未入库/)
  const adapter = createDingtalkAdapter({ accountId: 'a1', config: {}, secrets: { clientId: 'C', clientSecret: 'S' } })
  assert.equal(adapter.id, 'dingtalk')
  assert.equal(adapter.caps.nativeStream, false, '未配 cardTemplateId → 文本档，诚实关闭声明')
  const carded = createDingtalkAdapter({ accountId: 'a2', config: { cardTemplateId: 'TPL-9' }, secrets: { clientId: 'C', clientSecret: 'S' } })
  assert.equal(carded.caps.nativeStream, true)
  assert.equal(carded.caps.statusProgress, true)
  const text = createDingtalkAdapter({ accountId: 'a3', config: { cardTemplateId: 'TPL-9', cardMode: 'text' }, secrets: { clientId: 'C', clientSecret: 'S' } })
  assert.equal(text.caps.nativeStream, false)
})

test('apiBase 覆盖：专有云/代理场景所有 REST 面走自定义基址', async () => {
  const { adapter, sock, http } = await connectedAdapter({ apiBase: 'https://api.custom.example.com/' })
  assert.ok(http.of('https://api.custom.example.com/v1.0/gateway/connections/open').length === 1)
  await adapter.reply({ channel: 'dingtalk', kind: 'dm', chatId: 'staff-001' }, 'x')
  assert.ok(http.of('https://api.custom.example.com/v1.0/robot/oToMessages/batchSend').length === 1)
  sock.push(wireFrame('CALLBACK', '/v1.0/im/bot/messages/get', 'CB-1', dmPayload({ sessionWebhook: WEBHOOK_URL })))
  await adapter.reply({ channel: 'dingtalk', kind: 'dm', chatId: 'staff-001' }, 'x')
  assert.equal(http.of(WEBHOOK_URL).at(-1).url, WEBHOOK_URL, 'sessionWebhook 用回调原样 URL，不改写基址')
  await adapter.disconnect()
})
