// QQ 渠道「桩级端到端」冒烟（计划 task_21 的「或桩」口径）：用一个协议形桩服务器 + 桩网关，
// 驱动**真实 QqAdapter** 跑通六面全链路，验证跨面一致性——这是逐调用注入 fetchImpl 的单测覆盖不到的层面：
//   ① intents 协商（1<<25 与 keyboard 的 1<<26 是否同帧上报）
//   ② 入站图 rkey 即时下载 + 串行派发保序
//   ③ 文本/Markdown/富媒体三种出站体形态
//   ④ 被动窗口 seq 在 reply→sendFile→askChoices 混合发送下是否严格单调（撞去重的根因面）
//   ⑤ 媒体图 3 步链（prepare→COS 直传→complete）产出的 url 能进 msg_type=2
//   ⑥ keyboard 发送体与 INTERACTION_CREATE 回传结算能否自洽（token/idx 从已发体反取）
//   ⑦ 群管理四端点路径/体形与官方口径一致
// 零真实网络：fetchImpl + SocketImpl 全注入。
import test from 'node:test'
import assert from 'node:assert/strict'
import { QqAdapter } from '../lib/channels/qq.js'

const APP = 'STUB-APPID'
const SEC = 'STUB-SECRET'
const AT = 'STUB-AT'
const DM = { channel: 'qq', kind: 'dm', chatId: 'OPENID-DM' }
const GROUP = { channel: 'qq', kind: 'group', chatId: 'GROUP-OPENID' }

const tick = (ms = 8) => new Promise((resolve) => setTimeout(resolve, ms))
const jsonResp = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
})
const parseJson = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
const isMessages = (url) => /\/v2\/(users|groups)\/[^/]+\/messages$/.test(url)

function stubServer() {
  const state = {
    calls: [], sends: [], uploads: [], prepares: [], puts: [], completes: [],
    approvals: [], mutes: [], recalls: [], mdImages: [],
    fiSeq: 0, sendSeq: 0,
  }
  const impl = async (url, init) => {
    const method = String(init?.method ?? 'GET').toUpperCase()
    const raw = init?.body
    const body = typeof raw === 'string' ? parseJson(raw) : raw
    state.calls.push({ url, method, body, headers: init?.headers ?? {} })

    if (url.endsWith('/app/getAppAccessToken')) return jsonResp(200, { access_token: AT, expires_in: 7200 })
    if (url.endsWith('/gateway')) return jsonResp(200, { url: 'wss://stub.test/websocket' })

    // 媒体图 3 步链
    if (method === 'GET' && url.endsWith('/v2/media-images')) return jsonResp(200, { images: state.mdImages })
    if (method === 'POST' && url.endsWith('/v2/media-images/prepare')) {
      state.prepares.push(body)
      return jsonResp(200, { upload_id: 'UP-' + (state.prepares.length), presigned_url: 'https://stub-cos.example/put?sig=' + state.prepares.length })
    }
    if (method === 'PUT' && url.startsWith('https://stub-cos.example')) {
      state.puts.push({ url, headers: init?.headers ?? {}, bytes: raw })
      return jsonResp(200, {})
    }
    if (method === 'POST' && url.endsWith('/v2/media-images/complete')) {
      state.completes.push(body)
      return jsonResp(200, { image_id: 'IMG-' + state.completes.length, url: `qqbot-media://image/v1/T${state.completes.length}`, ttl: 3600 })
    }

    // 富媒体上传（msg_type=7 前置）
    if (method === 'POST' && /\/v2\/(users|groups)\/[^/]+\/files$/.test(url)) {
      state.uploads.push({ url, form: raw, body })
      return jsonResp(200, { file_info: 'FI-' + (++state.fiSeq), url: 'https://qq.test/fi', ttl: 3600 })
    }

    // 群管理端点
    if (method === 'GET' && url.includes('/join_request_list')) {
      return jsonResp(200, { join_requests: [{ member_openid: 'M1', join_request_id: 'J1', username: '新人' }] })
    }
    if (method === 'POST' && url.includes('/approval_join_request/')) {
      state.approvals.push({ url, body })
      return jsonResp(200, {})
    }
    if (method === 'GET' && url.includes('/restrict_chat_setting')) return jsonResp(200, { members: [] })
    if (method === 'POST' && url.includes('/restrict_chat_setting')) {
      state.mutes.push({ url, body })
      return jsonResp(200, {})
    }
    if (method === 'DELETE' && /\/v2\/groups\/[^/]+\/messages\/[^/]+$/.test(url)) {
      state.recalls.push(url)
      return jsonResp(200, {})
    }

    // 消息发送（所有出站形态在此收口，便于跨面断言）
    if (method === 'POST' && isMessages(url)) {
      state.sends.push(body)
      return jsonResp(200, { id: 'S-' + (++state.sendSeq) })
    }

    // 入站附件下载（rkey 时效面）
    if (url.startsWith('https://multimedia.stub')) {
      return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new Uint8Array([9, 8, 7, 6]).buffer }
    }
    return jsonResp(200, {})
  }
  return { impl, state }
}

function stubGateway() {
  const made = []
  const dial = (url) => {
    const handlers = {}
    const sent = []
    const sock = {
      url,
      sent,
      readyState: 1,
      close() {
        sock.readyState = 3
        handlers.close?.({ code: undefined })
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

const C2C = (over = {}) => ({
  op: 0,
  t: 'C2C_MESSAGE_CREATE',
  s: 5,
  d: {
    id: 'STUB-msg-1',
    author: { id: 'OPENID-DM', user_openid: 'OPENID-DM', username: '阿明', bot: false },
    content: '你好',
    message_type: 0,
    timestamp: '2026-10-28T10:00:00+08:00',
    ...over,
  },
})

async function boot(options = {}) {
  const http = stubServer()
  const rig = stubGateway()
  const adapter = new QqAdapter({
    appId: APP,
    appSecret: SEC,
    apiBase: 'https://stub.test',
    tokenUrl: 'https://bots.stub.test/app/getAppAccessToken',
    fetchImpl: http.impl,
    SocketImpl: rig.dial,
    reconnectDelayMs: 10,
    ...options,
  })
  const got = []
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  const sock = rig.made[0]
  sock.push({ op: 10, d: { heartbeat_interval: 45_000 } })
  sock.push({ op: 0, t: 'READY', s: 1, d: { session_id: 'SID', user: { id: 'BOTID', bot: true } } })
  await tick()
  return { adapter, http, rig, sock, got }
}

test('桩端到端①：IDENTIFY 同帧上报 1<<25 与 keyboard 的 1<<26', async () => {
  const { adapter, sock } = await boot({ enableKeyboard: true })
  const identify = sock.sent.find((f) => f.op === 2)
  assert.ok(identify, '应发出 IDENTIFY')
  assert.equal(identify.d.intents & (1 << 25), 1 << 25)
  assert.equal(identify.d.intents & (1 << 26), 1 << 26)
  await adapter.disconnect()
})

test('桩端到端②③④：入站图下载→文本/Markdown/富媒体出站→被动窗口 seq 跨面单调', async () => {
  const { adapter, http, sock, got } = await boot()
  // 入站带图：rkey 即时下载填 images[]
  sock.push(C2C({ id: 'STUB-msg-img', content: '', attachments: [{ content_type: 'image/png', filename: 'p.png', url: 'https://multimedia.stub/download?p=1&rkey=EXP' }] }))
  await tick(30)
  assert.equal(got.length, 1, '入站消息经串行链派发')
  assert.equal(got[0].images?.length, 1, '桩侧附件被下载')
  assert.deepEqual(Array.from(got[0].images[0].data), [9, 8, 7, 6])

  // 出站三形态
  await adapter.reply(DM, '纯文本')
  await adapter.reply(DM, '看图 ![c](https://cdn.test/x.png)')
  await adapter.sendFile(DM, { name: 'chart.png', data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' })

  const sends = http.state.sends
  assert.equal(sends.length, 3, '三次出站')
  assert.equal(sends[0].msg_type, 0)
  assert.equal(sends[1].msg_type, 2, '含图内嵌走 markdown')
  assert.equal(sends[2].msg_type, 7, 'sendFile 走富媒体')
  assert.equal(sends[2].media.file_info, 'FI-1', '官方体形 media:{file_info}')
  assert.equal(http.state.uploads.length, 1)
  assert.match(http.state.uploads[0].url, /\/v2\/users\/OPENID-DM\/files$/, '单聊上传端点')
  assert.equal(http.state.uploads[0].body.file_type, 1, '官方 SDK 小文件形态：JSON + file_type=1')
  assert.equal(http.state.uploads[0].body.srv_send_msg, false)

  // 窗口单调：三次发送同 msg_id 且 seq 严格递增（撞去重根因面）
  const seqs = sends.map((b) => b.msg_seq)
  assert.deepEqual(new Set(seqs).size, 3, 'seq 不重复')
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'seq 递增')
  assert.equal(new Set(sends.map((b) => b.msg_id)).size, 1, '同一被动窗口 msg_id')
  await adapter.disconnect()
})

test('桩端到端⑤：媒体图 3 步链产出的 url 可进 markdown 正文', async () => {
  const { adapter, http } = await boot()
  const r = await adapter.uploadMarkdownImage({ name: 'chart.png', data: new Uint8Array([1, 2, 3, 4]), mimeType: 'image/png' })
  assert.equal(r.ok, true)
  assert.match(r.data.url, /^qqbot-media:\/\/image\/v1\/T/)
  assert.equal(http.state.prepares.length, 1)
  assert.match(http.state.prepares[0].file_name, /^chart_[0-9a-f]{12}\.png$/)
  assert.equal(http.state.prepares[0].content_type, 'image/png')
  assert.equal(http.state.puts.length, 1, 'COS 直传发生')
  assert.equal(http.state.puts[0].headers['content-type'], 'image/png', '直传 content-type 与 prepare 一致')
  assert.equal(http.state.puts[0].headers.authorization, undefined, '直传不带 QQBot 鉴权头')
  assert.equal(http.state.completes.length, 1)
  assert.ok(http.state.sends.length === 0, '媒体图链不应顺带发消息')

  await adapter.reply(DM, `正文 ![x](${r.data.url})`)
  const last = http.state.sends.at(-1)
  assert.equal(last.msg_type, 2)
  assert.ok(last.markdown.content.includes('qqbot-media://'), 'url 进 msg_type=2 正文')
  await adapter.disconnect()
})

test('桩端到端⑥：keyboard 发送体与 INTERACTION_CREATE 回传自洽（D5 拒他人/认本人）', async () => {
  const { adapter, http, sock } = await boot({ enableKeyboard: true })
  const p = adapter.askChoices(DM, '需要审批', ['允许一次', '拒绝'], false, undefined, { ownerUserId: 'OPENID-DM' })
  await tick()
  const kbSend = http.state.sends.at(-1)
  assert.equal(kbSend.msg_type, 2)
  assert.ok(kbSend.keyboard?.content?.rows?.length === 2, '两行按钮（keyboard.content.rows 官方包装）')
  const dataAllow = kbSend.keyboard.content.rows[0].buttons[0].action.data
  const dataDeny = kbSend.keyboard.content.rows[1].buttons[0].action.data
  assert.equal(JSON.parse(dataAllow).idx, 0)
  assert.equal(kbSend.keyboard.content.rows[0].buttons[0].action.permission.type, 0, '指定用户可操作')

  sock.push({ op: 0, t: 'INTERACTION_CREATE', s: 20, d: { id: 'INT-A', data: dataAllow, user: { user_openid: 'OTHER' } } })
  await tick()
  sock.push({ op: 0, t: 'INTERACTION_CREATE', s: 21, d: { id: 'INT-B', data: dataDeny, user: { user_openid: 'OPENID-DM' } } })
  const res = await p
  assert.equal(res.answer, '拒绝', '他人点按不改判，本人点按结算')
  assert.equal(res.uncertain, false)
  // 官方交互确认：两次回传均需 PUT /interactions/{id} {code:0}
  await tick()
  const acks = http.state.calls.filter((c) => c.method === 'PUT' && c.url.includes('/interactions/'))
  assert.equal(acks.length, 2, '已上交互确认')
  await adapter.disconnect()
})

test('桩端到端⑦：群管理四端点路径与体形符合官方口径', async () => {
  const { adapter, http } = await boot()
  const list = await adapter.qqGroupListJoinRequests('GROUP-OPENID')
  assert.equal(list.ok, true)
  assert.equal(list.data[0].member_openid, 'M1')

  const ap = await adapter.qqGroupApproveJoin('GROUP-OPENID', 'M1', 'approve', { joinRequestId: 'J1' })
  assert.equal(ap.ok, true)
  assert.match(http.state.approvals[0].url, /\/v2\/groups\/GROUP-OPENID\/approval_join_request\/M1$/)
  assert.equal(http.state.approvals[0].body.op, 'approve')

  const mute = await adapter.qqGroupSetMute('GROUP-OPENID', ['M1'], 600)
  assert.equal(mute.ok, true)
  assert.equal(http.state.mutes[0].body.members[0].op, 'add')
  assert.match(String(http.state.mutes[0].body.members[0].mute_expire_at), /^\d{4}-\d{2}-\d{2}T/)

  const un = await adapter.qqGroupSetMute('GROUP-OPENID', ['M1', 'M2'], 0)
  assert.equal(un.ok, true)
  assert.equal(http.state.mutes.at(-1).body.members.length, 2, '解除支持批量 del')

  const rc = await adapter.qqGroupRecall('GROUP-OPENID', 'MSG-9', 'group')
  assert.equal(rc.ok, true)
  assert.match(http.state.recalls[0], /\/v2\/groups\/GROUP-OPENID\/messages\/MSG-9$/)
  await adapter.disconnect()
})

test('桩端到端⑧：群/单聊上传端点不互通（走各自路径）', async () => {
  const { adapter, http } = await boot()
  await adapter.sendFile(GROUP, { name: 'a.jpg', data: new Uint8Array([1]), mimeType: 'image/jpeg' })
  assert.match(http.state.uploads[0].url, /\/v2\/groups\/GROUP-OPENID\/files$/)
  assert.match(http.state.sends[0].msg_type === 7 ? 'ok' : 'bad', /^ok$/)
  await adapter.disconnect()
})
