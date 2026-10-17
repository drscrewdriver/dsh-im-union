// T1.2 微信 iLink 渠道单测：头形态 / 归一 / 游标滚动 / -14 停轮 /
// context_token 回传 / ret 判型 / AES 往返 / CDN 上传链路 / typing / 诊断。
// 网络面全注入 fetchImpl，不发真实请求。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  WeixinAdapter,
  WeixinApiError,
  WeixinUncertainError,
  createWeixinAdapter,
  randomWechatUin,
  encodeClientVersion,
  aesEncrypt,
  aesDecrypt,
  WEIXIN_MAX_MESSAGE,
} from '../lib/channels/weixin.js'
import { implementedChannels } from '../lib/channels/registry.js'

const okJson = (body, extra = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  headers: { get: () => extra['x-encrypted-param'] ?? null },
  arrayBuffer: async () => new Uint8Array(0).buffer,
})

function fakeFetch(route) {
  const calls = []
  const impl = async (url, init) => {
    let body
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = { raw: true }
      }
    } else if (init?.body instanceof Uint8Array) {
      body = { binary: init.body }
    }
    calls.push({ url, method: init?.method ?? 'GET', body, headers: init?.headers, signal: init?.signal })
    // 长轮询仿真：getupdates 至少 hold 10ms——否则测试里轮询循环会打成
    // 同步紧循环（真服务端会 hold 秒级，calls 数组不会爆增长）。
    if (url.endsWith('/getupdates')) await new Promise((resolve) => setTimeout(resolve, 10))
    return route(url, body, init)
  }
  return { impl, calls }
}

function makeAdapter(route, opts = {}) {
  const fetch = fakeFetch(route)
  const adapter = new WeixinAdapter({ botToken: 'TOK@im.bot:06', fetchImpl: fetch.impl, ...opts })
  return { adapter, fetch }
}

const dm = { channel: 'weixin', kind: 'dm', chatId: 'u1@im.wechat' }

// —— 头与编码形态 ——————————————————————————————

test('X-WECHAT-UIN：随机 uint32 十进制字符串 base64（协议防重放形态）', () => {
  const b64 = randomWechatUin()
  const decoded = Buffer.from(b64, 'base64').toString('utf8')
  assert.match(decoded, /^\d+$/)
  const n = Number(decoded)
  assert.ok(n >= 0 && n <= 0xffffffff)
})

test('iLink-App-ClientVersion：x.y.z → 0x00MMNNPP 十进制', () => {
  assert.equal(encodeClientVersion('2.4.4'), 132100)
  assert.equal(encodeClientVersion('0.0.1'), 1)
})

test('AES-128-ECB 往返：三形态密钥（hex32 / base64(16B) / base64(hex串)）', () => {
  const plain = new Uint8Array(100).fill(0x41)
  const { cipher, keyHex } = aesEncrypt(plain)
  assert.equal(cipher.length, Math.ceil((plain.length + 1) / 16) * 16, 'filesize 口径=PKCS7 密文长')
  assert.deepEqual([...aesDecrypt(cipher, keyHex)], [...plain])
  assert.deepEqual([...aesDecrypt(cipher, Buffer.from(keyHex.slice(0, 32), 'hex').toString('base64'))].length, 100)
  const rawKey = Buffer.from(keyHex, 'hex')
  assert.deepEqual([...aesDecrypt(cipher, rawKey.toString('base64'))], [...plain])
})

// —— 入站归一 ——————————————————————————————————

test('fillMedia：text 归一 + context_token 记账 + bot 回声丢弃', async () => {
  const { adapter } = makeAdapter(() => okJson({ ret: 0, msgs: [] }))
  const m = await adapter.fillMedia({
    message_type: 1,
    from_user_id: 'u1@im.wechat',
    context_token: 'CTX1',
    create_time_ms: 1730000000000,
    item_list: [{ type: 1, text_item: { text: '你好' } }],
  })
  assert.equal(m.address.kind, 'dm')
  assert.equal(m.address.chatId, 'u1@im.wechat')
  assert.equal(m.text, '你好')
  assert.equal(m.timestamp, 1730000000000)
  const echo = await adapter.fillMedia({ message_type: 2, from_user_id: 'x', item_list: [] })
  assert.equal(echo, undefined)
})

test('fillMedia：语音转写文本消费；视频给占位不丢消息', async () => {
  const { adapter } = makeAdapter(() => okJson({ ret: 0 }))
  const v = await adapter.fillMedia({ message_type: 1, from_user_id: 'u', item_list: [{ type: 3, voice_item: { text: '帮我订机票' } }] })
  assert.equal(v.text, '[语音] 帮我订机票')
  const vid = await adapter.fillMedia({ message_type: 1, from_user_id: 'u', item_list: [{ type: 5, video_item: {} }] })
  assert.match(vid.text, /视频消息暂不支持/)
})

test('fillMedia：入站图片 CDN 下载 + hex 密钥优先解密', async () => {
  const plain = new Uint8Array([0xff, 0xd8, 0xff, 0x01, 0x02, 0x03])
  const { cipher, keyHex } = aesEncrypt(plain)
  const { adapter, fetch } = makeAdapter((url) => {
    if (url.includes('/download')) {
      return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => cipher.buffer.slice(cipher.byteOffset, cipher.byteOffset + cipher.byteLength) }
    }
    return okJson({ ret: 0 })
  })
  const m = await adapter.fillMedia({
    message_type: 1,
    from_user_id: 'u',
    item_list: [{ type: 2, msg_id: 7, image_item: { aeskey: keyHex, media: { encrypt_query_param: 'EQP' } } }],
  })
  assert.equal(m.images.length, 1)
  assert.deepEqual([...m.images[0].data], [...plain])
  const dl = fetch.calls.find((c) => c.url.includes('/download'))
  assert.ok(dl.url.includes('encrypted_query_param=EQP'), '按协议构造下载地址')
})

// —— 轮询循环 ——————————————————————————————————

test('getupdates：游标非空滚动、空响应保持；请求带鉴权头与 base_info', async () => {
  let polls = 0
  const { adapter, fetch } = makeAdapter((url) => {
    if (!url.endsWith('/getupdates')) return okJson({ ret: 0 }) // notifystart 等不吃轮询脚本
    polls += 1
    if (polls === 1) return okJson({ ret: 0, msgs: [], get_updates_buf: 'BUF1' })
    if (polls === 2) return okJson({ ret: 0, msgs: [], get_updates_buf: '' })
    if (polls === 3) return okJson({ ret: 0, msgs: [{ message_type: 1, from_user_id: 'u', item_list: [{ type: 1, text_item: { text: 'hi' } }] }], get_updates_buf: 'BUF2' })
    return okJson({ ret: 0, msgs: [] })
  })
  const got = []
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  await new Promise((r) => setTimeout(r, 120))
  await adapter.disconnect()
  assert.equal(got.length, 1)
  const first = fetch.calls.find((c) => c.url.endsWith('/getupdates'))
  assert.equal(first.headers.Authorization, 'Bearer TOK@im.bot:06')
  assert.equal(first.headers.AuthorizationType, 'ilink_bot_token')
  assert.ok(first.headers['X-WECHAT-UIN'], '防重放头必须存在')
  assert.equal(first.body.base_info.bot_agent, 'dsh-im-union')
  const bufs = fetch.calls.filter((c) => c.url.endsWith('/getupdates')).map((c) => c.body.get_updates_buf)
  assert.deepEqual(bufs.slice(0, 3), ['', 'BUF1', 'BUF1'], '空游标响应不滚动（重复收防护）')
})

test('errcode=-14：authExpired 置位并停止轮询（fail-closed 不盲重试）', async () => {
  let polls = 0
  const { adapter, fetch } = makeAdapter((url) => {
    if (!url.endsWith('/getupdates')) return okJson({ ret: 0 })
    polls += 1
    return okJson({ ret: 0, msgs: [] , ...(polls >= 2 ? { errcode: -14, errmsg: 'session expired' } : {}) })
  })
  await adapter.connect()
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(adapter.authExpired, true)
  const before = fetch.calls.filter((c) => c.url.endsWith('/getupdates')).length
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(fetch.calls.filter((c) => c.url.endsWith('/getupdates')).length, before, '-14 后不得继续轮询')
  await adapter.disconnect()
})

// —— 出站 ——————————————————————————————————————

test('reply：sendmessage 回传 context_token；message_type=2 state=2；ret=0 成功', async () => {
  const { adapter, fetch } = makeAdapter((url, body) => {
    if (url.endsWith('/getupdates')) return okJson({ ret: 0, msgs: [] })
    return okJson({ ret: 0, errmsg: '' })
  })
  await adapter.connect()
  await adapter.fillMedia({ message_type: 1, from_user_id: dm.chatId, context_token: 'CTX9', item_list: [] })
  const receipt = await adapter.reply(dm, '回复内容')
  assert.equal(receipt.uncertain, false)
  const send = fetch.calls.find((c) => c.url.endsWith('/sendmessage'))
  assert.equal(send.body.msg.context_token, 'CTX9', '协议事实：回复必须回传会话令牌')
  assert.equal(send.body.msg.message_type, 2)
  assert.equal(send.body.msg.message_state, 2)
  assert.equal(send.body.msg.item_list[0].text_item.text, '回复内容')
  assert.ok(send.body.msg.client_id, 'client_id 去重必带')
  await adapter.disconnect()
})

test('reply：非零 ret = 确定性 WeixinApiError；网络断 = Uncertain', async () => {
  const { adapter } = makeAdapter((url) => (url.endsWith('/sendmessage') ? okJson({ ret: 4200, errmsg: 'context expired' }) : okJson({ ret: 0, msgs: [] })))
  await adapter.connect()
  await assert.rejects(adapter.reply(dm, 'x'), WeixinApiError)
  await adapter.disconnect()
  const { adapter: a2 } = makeAdapter(() => {
    throw new Error('socket hang up')
  })
  await a2.connect()
  await assert.rejects(a2.reply(dm, 'x'), WeixinUncertainError)
  await a2.disconnect()
})

test('sendFile：getuploadurl 参数形态 + CDN POST 密文 + x-encrypted-param → image_item 键 base64(hex)', async () => {
  const png = new Uint8Array(50).fill(0x89)
  const { adapter, fetch } = makeAdapter((url, body) => {
    if (url.endsWith('/getupdates')) return okJson({ ret: 0, msgs: [] })
    if (url.endsWith('/getuploadurl')) return okJson({ upload_param: 'UP1' })
    if (url.includes('/c2c/upload')) return { ok: true, status: 200, json: async () => ({}), headers: { get: (n) => (n === 'x-encrypted-param' ? 'XEP1' : null) } }
    return okJson({ ret: 0 })
  })
  await adapter.connect()
  await adapter.sendFile(dm, { name: 'p.png', data: png, mimeType: 'image/png' })
  const up = fetch.calls.find((c) => c.url.endsWith('/getuploadurl'))
  assert.equal(up.body.media_type, 1)
  assert.equal(up.body.rawsize, png.length)
  assert.equal(up.body.rawfilemd5, createHash('md5').update(png).digest('hex'))
  assert.equal(up.body.filesize, Math.ceil((png.length + 1) / 16) * 16)
  assert.equal(up.body.no_need_thumb, true)
  assert.match(up.body.aeskey, /^[0-9a-f]{32}$/)
  const cdn = fetch.calls.find((c) => c.url.includes('/c2c/upload'))
  assert.equal(cdn.headers['content-type'], 'application/octet-stream')
  assert.ok(cdn.url.includes('encrypted_query_param=UP1'))
  const send = fetch.calls.find((c) => c.url.endsWith('/sendmessage'))
  assert.equal(send.body.msg.item_list[0].type, 2)
  assert.equal(send.body.msg.item_list[0].image_item.media.encrypt_query_param, 'XEP1')
  assert.equal(Buffer.from(send.body.msg.item_list[0].image_item.media.aes_key, 'base64').toString('utf8'), up.body.aeskey, 'aes_key=base64(hex串)（官方发送器口径）')
  await adapter.disconnect()
})

test('sendFile 非图片走 file_item（media_type 3，len 明文十进制串）', async () => {
  const data = new Uint8Array(20).fill(7)
  const { adapter, fetch } = makeAdapter((url) => {
    if (url.endsWith('/getupdates')) return okJson({ ret: 0, msgs: [] })
    if (url.endsWith('/getuploadurl')) return okJson({ upload_full_url: 'https://cdn.test/up' })
    if (url.includes('cdn.test/up')) return { ok: true, status: 200, json: async () => ({}), headers: { get: () => 'XEP2' } }
    return okJson({ ret: 0 })
  })
  await adapter.connect()
  await adapter.sendFile(dm, { name: 'a.txt', data, mimeType: 'text/plain' })
  assert.equal(fetch.calls.find((c) => c.url.endsWith('/getuploadurl')).body.media_type, 3)
  assert.ok(fetch.calls.some((c) => c.url === 'https://cdn.test/up'), 'upload_full_url 优先（协议口径）')
  const send = fetch.calls.find((c) => c.url.endsWith('/sendmessage'))
  assert.equal(send.body.msg.item_list[0].type, 4)
  assert.equal(send.body.msg.item_list[0].file_item.file_name, 'a.txt')
  assert.equal(send.body.msg.item_list[0].file_item.len, '20')
  await adapter.disconnect()
})

// —— typing ————————————————————————————————————

test('setTyping：getConfig 取 ticket → sendtyping status=1；二次调用走缓存', async () => {
  const { adapter, fetch } = makeAdapter((url) => {
    if (url.endsWith('/getupdates')) return okJson({ ret: 0, msgs: [] })
    if (url.endsWith('/getconfig')) return okJson({ ret: 0, typing_ticket: 'TK1' })
    return okJson({ ret: 0 })
  })
  await adapter.connect()
  await adapter.setTyping(dm)
  await adapter.setTyping(dm)
  const configs = fetch.calls.filter((c) => c.url.endsWith('/getconfig'))
  assert.equal(configs.length, 1, 'ticket 按用户缓存')
  const typings = fetch.calls.filter((c) => c.url.endsWith('/sendtyping'))
  assert.ok(typings.length >= 2)
  assert.equal(typings[0].body.typing_ticket, 'TK1')
  assert.equal(typings[0].body.status, 1)
  await adapter.disconnect()
})

// —— 诊断与工厂 ——————————————————————————————————

test('diagnose：token 在位 + getupdates 探活 passed；-14 failed；roundtrip 恒 unverified', async () => {
  const { adapter } = makeAdapter((url) => (url.endsWith('/getupdates') ? okJson({ ret: 0, msgs: [] }) : okJson({ ret: 0 })))
  const checks = await adapter.diagnose()
  assert.equal(checks[0].name, 'credentials')
  assert.equal(checks[0].status, 'passed')
  assert.equal(checks[1].name, 'session')
  assert.equal(checks[1].status, 'passed')
  assert.equal(checks.at(-1).status, 'unverified')
  const { adapter: dead } = makeAdapter(() => okJson({ ret: 0, msgs: [], errcode: -14, errmsg: 'expired' }))
  const deadChecks = await dead.diagnose()
  assert.equal(deadChecks[1].status, 'failed')
})

test('工厂与注册表：weixin 已实现；缺 token 构造期抛；分段上限 1800', () => {
  assert.ok(implementedChannels().includes('weixin'))
  assert.throws(() => createWeixinAdapter({ accountId: 'a1', config: {}, secrets: {} }), /botToken 缺失/)
  const { adapter } = makeAdapter(() => okJson({ ret: 0 }))
  assert.equal(adapter.caps.maxMessageLength, WEIXIN_MAX_MESSAGE)
  assert.equal(adapter.caps.editStream, false, '协议无编辑能力：诚实声明，引擎收轮分段')
  assert.equal(adapter.caps.typing, true)
})
