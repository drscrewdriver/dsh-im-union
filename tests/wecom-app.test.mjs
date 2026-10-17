// T3.4 企微自建应用渠道单测：回调 URL 验证 / XML 消息回调往返 / AES 包结构
// 向量 / 出站 send body / token 缓存与 40014 重试 / 确定性 vs uncertain 分档 /
// 诊断三态 / 工厂校验 / 队列模型。网络面全注入 fake fetch，不发真实请求。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createDecipheriv, randomBytes } from 'node:crypto'
import {
  WecomAppAdapter,
  WeComAppApiError,
  WeComAppUncertainError,
  createWecomAppAdapter,
  buildMsgSignature,
  encryptMessage,
  decryptMessage,
  extractXmlField,
  WECOM_APP_MAX_MESSAGE,
} from '../lib/channels/wecom-app.js'

const CORP_ID = 'ww1234567890abcdef'
const CORP_SECRET = 'CORP-SECRET-TOPSECRET123'
const CALLBACK_TOKEN = 'cb-token-XYZ'
// 43 位 EncodingAESKey：32 字节密钥的 base64（44 位含尾部 '='）去掉 '='
const AES_KEY = Buffer.from(randomBytes(32)).toString('base64').slice(0, 43)
const AGENT_ID = '1000002'

function makeQuery(token, timestamp, nonce, encrypt) {
  return {
    timestamp,
    nonce,
    msg_signature: buildMsgSignature([token, timestamp, nonce, encrypt]),
  }
}

function baseAdapter(options = {}) {
  return new WecomAppAdapter({
    corpId: CORP_ID,
    corpSecret: CORP_SECRET,
    callbackToken: CALLBACK_TOKEN,
    encodingAesKey: AES_KEY,
    agentId: AGENT_ID,
    ...options,
  })
}

/** 按 URL 路由的 fake fetch；calls 记录 {url, init}。 */
function fakeFetch(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    for (const route of routes) {
      if (url.includes(route.match)) {
        const result = typeof route.reply === 'function' ? route.reply(calls.filter((c) => c.url.includes(route.match)).length) : route.reply
        if (result instanceof Error) throw result
        return {
          ok: (result.status ?? 200) >= 200 && (result.status ?? 200) < 300,
          status: result.status ?? 200,
          json: async () => result.json,
        }
      }
    }
    throw new Error(`fake fetch: 未预期请求 ${url}`)
  }
  return { fetchImpl, calls }
}

// —— verifyUrl ————————————————————————————————

test('verifyUrl 正例：验签通过并返回解密后的 echostr 明文', () => {
  const adapter = baseAdapter()
  const echo = 'echo-1234567890abcdef'
  const cipher = encryptMessage(AES_KEY, echo, CORP_ID)
  const query = { ...makeQuery(CALLBACK_TOKEN, '1713424427', '415670741', cipher), echostr: cipher }
  assert.equal(adapter.verifyUrl(query), echo)
})

test('verifyUrl 签名错配 → null（不解密不回显）', () => {
  const adapter = baseAdapter()
  const cipher = encryptMessage(AES_KEY, 'echo-x', CORP_ID)
  const query = { timestamp: '1713424427', nonce: '415670741', msg_signature: 'deadbeef'.repeat(5), echostr: cipher }
  assert.equal(adapter.verifyUrl(query), null)
})

test('verifyUrl receiveid 非本企业 → null（fail-closed）', () => {
  const adapter = baseAdapter()
  const cipher = encryptMessage(AES_KEY, 'echo-x', 'wwOTHERCORP')
  const query = { ...makeQuery(CALLBACK_TOKEN, '171', '415', cipher), echostr: cipher }
  assert.equal(adapter.verifyUrl(query), null)
})

// —— handleXmlCallback ————————————————————————————————

function xmlCallbackFixture(innerXml, token = CALLBACK_TOKEN) {
  const adapter = baseAdapter()
  const encrypt = encryptMessage(AES_KEY, innerXml, CORP_ID)
  const body = `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><Encrypt><![CDATA[${encrypt}]]></Encrypt><AgentID><![CDATA[${AGENT_ID}]]></AgentID></xml>`
  return { adapter, query: makeQuery(token, '1713424427', '415670741', encrypt), body }
}

test('handleXmlCallback 单聊完整往返：解出 SemanticMessage 并入队 emit', () => {
  const inner = `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><FromUserName><![CDATA[zhangsan]]></FromUserName><CreateTime>1713424427</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好，应用]]></Content><MsgId>4561237891234</MsgId><AgentID>1000002</AgentID></xml>`
  const { adapter, query, body } = xmlCallbackFixture(inner)
  const got = []
  adapter.onMessage((m) => got.push(m))
  const result = adapter.handleXmlCallback(query, body)
  assert.equal(result.ok, true)
  assert.ok(result.message)
  assert.deepEqual(result.message.address, { channel: 'wecom-app', kind: 'dm', chatId: 'zhangsan' })
  assert.equal(result.message.userId, 'zhangsan')
  assert.equal(result.message.text, '你好，应用')
  assert.equal(result.message.mentionedBot, false)
  assert.equal(result.message.timestamp, 1713424427 * 1000)
  assert.equal(got.length, 1)
  assert.deepEqual(adapter.drain().map((m) => m.text), ['你好，应用']) // 内部队列已入
})

test('handleXmlCallback 群聊字段：ChatId→group 地址、@前缀剥离、恒被点名', () => {
  const inner = `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><FromUserName><![CDATA[lisi]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[@小助手 帮我查个东西]]></Content><ChatId><![CDATA[wrChat001]]></ChatId><MsgId>789</MsgId><AgentID>1000002</AgentID></xml>`
  const { adapter, query, body } = xmlCallbackFixture(inner)
  const result = adapter.handleXmlCallback(query, body)
  assert.equal(result.ok, true)
  assert.ok(result.message)
  assert.deepEqual(result.message.address, { channel: 'wecom-app', kind: 'group', chatId: 'wrChat001' })
  assert.equal(result.message.text, '帮我查个东西')
  assert.equal(result.message.mentionedBot, true)
})

test('handleXmlCallback 验签失败 → ok:false，不解析不 emit', () => {
  const inner = `<xml><FromUserName><![CDATA[zhangsan]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hi]]></Content></xml>`
  const encrypt = encryptMessage(AES_KEY, inner, CORP_ID)
  const body = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`
  const adapter = baseAdapter()
  let emitted = 0
  adapter.onMessage(() => (emitted += 1))
  const result = adapter.handleXmlCallback(
    { timestamp: '171', nonce: '415', msg_signature: 'ffffffffffffffffffffffffffffffffffffffff', echostr: undefined },
    body,
  )
  assert.deepEqual(result, { ok: false })
  assert.equal(emitted, 0)
})

test('handleXmlCallback MsgId 重放排重：第二次不再 emit', () => {
  const inner = `<xml><FromUserName><![CDATA[zhangsan]]></FromUserName><CreateTime>1</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hi]]></Content><MsgId>dup-1</MsgId></xml>`
  const { adapter, query, body } = xmlCallbackFixture(inner)
  let emitted = 0
  adapter.onMessage(() => (emitted += 1))
  assert.equal(adapter.handleXmlCallback(query, body).ok, true)
  assert.equal(adapter.handleXmlCallback(query, body).ok, true)
  assert.equal(emitted, 1)
})

test('handleXmlCallback 图片消息：占位文案不丢消息（imageIn=false 口径）', () => {
  const inner = `<xml><FromUserName><![CDATA[zhangsan]]></FromUserName><CreateTime>1</CreateTime><MsgType><![CDATA[image]]></MsgType><PicUrl><![CDATA[http://x]]></PicUrl><MediaId><![CDATA[MEDIA1]]></MediaId><MsgId>img-1</MsgId></xml>`
  const { adapter, query, body } = xmlCallbackFixture(inner)
  const result = adapter.handleXmlCallback(query, body)
  assert.equal(result.ok, true)
  assert.ok(result.message)
  assert.match(result.message.text, /图片输入首版未接/)
})

test('handleXmlCallback 事件回调首版不消费：ok:true 无 message', () => {
  const inner = `<xml><FromUserName><![CDATA[zhangsan]]></FromUserName><CreateTime>1</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[click]]></Event></xml>`
  const { adapter, query, body } = xmlCallbackFixture(inner)
  assert.deepEqual(adapter.handleXmlCallback(query, body), { ok: true })
})

// —— AES 包结构向量（random+len+msg+receiveid 逐字节断言） ————————————

test('encryptMessage/decryptMessage 往返 + 密文包结构逐字节核对', () => {
  const message = '<xml>消息体 XML 载荷</xml>'
  const cipherB64 = encryptMessage(AES_KEY, message, CORP_ID)
  assert.deepEqual(decryptMessage(AES_KEY, cipherB64), { message, receiveId: CORP_ID })
  // 手工按协议结构解密，逐字节断言 random(16)+msg_len(4B 网络序)+msg+receiveid
  const key = Buffer.from(`${AES_KEY}=`, 'base64')
  assert.equal(key.length, 32)
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)
  const plain = Buffer.concat([decipher.update(Buffer.from(cipherB64, 'base64')), decipher.final()])
  assert.equal(plain.length % 32, 0) // PKCS#7 K=32 对齐
  const pad = plain[plain.length - 1]
  assert.ok(pad >= 1 && pad <= 32)
  assert.ok(plain.subarray(plain.length - pad).every((b) => b === pad)) // 填充字节等值
  const content = plain.subarray(16, plain.length - pad)
  const msgLen = content.readUInt32BE(0) // 网络字节序
  assert.equal(msgLen, Buffer.byteLength(message, 'utf8'))
  assert.equal(content.subarray(4, 4 + msgLen).toString('utf8'), message)
  assert.equal(content.subarray(4 + msgLen).toString('utf8'), CORP_ID)
  // random(16) 每次不同 → 同明文两次加密的密文不同
  assert.notEqual(encryptMessage(AES_KEY, message, CORP_ID), cipherB64)
})

test('验签向量：字典序拼接 SHA1 与官方算例同法（sort+join+sha1）', () => {
  const parts = ['AAAAA', '1714112445', '415670741', 'bbbb']
  const expected = createHash('sha1').update([...parts].sort().join(''), 'utf8').digest('hex')
  assert.equal(buildMsgSignature(parts), expected)
})

// —— 出站 ————————————————————————————————

test('reply 单聊：gettoken→message/send，body 含 touser/msgtype/text/agentid/safe', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { match: 'gettoken', reply: { json: { errcode: 0, errmsg: 'ok', access_token: 'T-1', expires_in: 7200 } } },
    { match: 'message/send', reply: { json: { errcode: 0, errmsg: 'ok', msgid: 'M-1' } } },
  ])
  const adapter = baseAdapter({ fetchImpl })
  const receipt = await adapter.reply({ channel: 'wecom-app', kind: 'dm', chatId: 'zhangsan' }, '回复内容')
  assert.equal(receipt.uncertain, false)
  assert.equal(receipt.platformMessageId, 'M-1')
  assert.ok(calls[0].url.startsWith('https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid='))
  assert.ok(calls[1].url.endsWith('/cgi-bin/message/send?access_token=T-1'))
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    touser: 'zhangsan',
    msgtype: 'text',
    text: { content: '回复内容' },
    agentid: 1000002,
    safe: 0,
  })
})

test('reply 群聊：走 appchat/send 带 chatid（message/send 无群投参数）', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { match: 'gettoken', reply: { json: { errcode: 0, access_token: 'T-1', expires_in: 7200 } } },
    { match: 'appchat/send', reply: { json: { errcode: 0, errmsg: 'ok' } } },
  ])
  const adapter = baseAdapter({ fetchImpl })
  await adapter.reply({ channel: 'wecom-app', kind: 'group', chatId: 'wrChat001' }, '群里回复')
  assert.match(calls[1].url, /\/cgi-bin\/appchat\/send/)
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    chatid: 'wrChat001',
    msgtype: 'text',
    text: { content: '群里回复' },
    safe: 0,
  })
})

test('token 缓存：两次 reply 只 gettoken 一次（7200s 提前刷新窗口内）', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { match: 'gettoken', reply: { json: { errcode: 0, access_token: 'T-c', expires_in: 7200 } } },
    { match: 'message/send', reply: { json: { errcode: 0 } } },
  ])
  const adapter = baseAdapter({ fetchImpl })
  await adapter.reply({ channel: 'wecom-app', kind: 'dm', chatId: 'u1' }, 'a')
  await adapter.reply({ channel: 'wecom-app', kind: 'dm', chatId: 'u1' }, 'b')
  assert.equal(calls.filter((c) => c.url.includes('gettoken')).length, 1)
  assert.equal(calls.filter((c) => c.url.includes('message/send')).length, 2)
})

test('40014 → 清缓存重取 token 重试一次即成功（gettoken 共 2 次，send 共 2 次）', async () => {
  let tokens = 0
  let sends = 0
  const fetchImpl = async (url) => {
    if (url.includes('gettoken')) {
      tokens += 1
      return { ok: true, status: 200, json: async () => ({ errcode: 0, access_token: `T-${tokens}`, expires_in: 7200 }) }
    }
    sends += 1
    return { ok: true, status: 200, json: async () => (sends === 1 ? { errcode: 40014, errmsg: 'invalid access_token' } : { errcode: 0 }) }
  }
  const adapter = baseAdapter({ fetchImpl })
  const receipt = await adapter.reply({ channel: 'wecom-app', kind: 'dm', chatId: 'u1' }, 'x')
  assert.equal(receipt.uncertain, false)
  assert.equal(tokens, 2) // 初次 + 40014 后缓存被清重取
  assert.equal(sends, 2)
})

test('40014 连续两次 → 只重试一次，仍 40014 抛确定性错误', async () => {
  let sends = 0
  const { fetchImpl } = fakeFetch([
    { match: 'gettoken', reply: { json: { errcode: 0, access_token: 'T-1', expires_in: 7200 } } },
    {
      match: 'message/send',
      reply: () => {
        sends += 1
        return { json: { errcode: 40014, errmsg: 'invalid access_token' } }
      },
    },
  ])
  const adapter = baseAdapter({ fetchImpl })
  await assert.rejects(
    () => adapter.reply({ channel: 'wecom-app', kind: 'dm', chatId: 'u1' }, 'x'),
    (error) => error instanceof WeComAppApiError && error.errcode === 40014,
  )
  assert.equal(sends, 2) // 恰好一次重试
})

test('errcode≠0（非 token 类）→ WeComAppApiError 确定性，不重试', async () => {
  let sends = 0
  const { fetchImpl } = fakeFetch([
    { match: 'gettoken', reply: { json: { errcode: 0, access_token: 'T-1', expires_in: 7200 } } },
    {
      match: 'message/send',
      reply: () => {
        sends += 1
        return { json: { errcode: 60011, errmsg: 'no privilege' } }
      },
    },
  ])
  const adapter = baseAdapter({ fetchImpl })
  await assert.rejects(
    () => adapter.reply({ channel: 'wecom-app', kind: 'dm', chatId: 'u1' }, 'x'),
    (error) => error instanceof WeComAppApiError && error.errcode === 60011,
  )
  assert.equal(sends, 1)
})

test('网络失败 → WeComAppUncertainError（D7），错误文本零 secret 回显', async () => {
  const { fetchImpl } = fakeFetch([{ match: 'message/send', reply: () => new Error('socket hang up') }])
  const adapter = baseAdapter({ fetchImpl })
  adapter.tokenCache = { value: 'T-1', expiresAt: Date.now() + 60_000 }
  await assert.rejects(
    () => adapter.reply({ channel: 'wecom-app', kind: 'dm', chatId: 'u1' }, 'x'),
    (error) => error instanceof WeComAppUncertainError && !error.message.includes(CORP_SECRET) && !error.message.includes('T-1'),
  )
})

test('gettoken 业务失败 → 确定性 ApiError，hint 不带 corpSecret', async () => {
  const { fetchImpl } = fakeFetch([
    { match: 'gettoken', reply: { json: { errcode: 40013, errmsg: 'invalid corpsecret' } } },
  ])
  const adapter = baseAdapter({ fetchImpl })
  await assert.rejects(
    () => adapter.getAccessToken(),
    (error) =>
      error instanceof WeComAppApiError &&
      error.errcode === 40013 &&
      !error.message.includes(CORP_SECRET) &&
      !error.message.includes(AES_KEY),
  )
})

test('防御上限：超 2048 字节的 text 直接确定性拒绝，不出网', async () => {
  const { fetchImpl, calls } = fakeFetch([{ match: 'message/send', reply: { json: { errcode: 0 } } }])
  const adapter = baseAdapter({ fetchImpl })
  await assert.rejects(
    () => adapter.reply({ channel: 'wecom-app', kind: 'dm', chatId: 'u1' }, '啊'.repeat(700)),
    /超协议上限/,
  )
  assert.equal(calls.length, 0)
})

// —— caps / 队列模型 / 工厂 / 诊断 ————————————————————————————————

test('caps：应用消息无编辑流式、入站文件面未接/出站文件面已接、maxMessageLength=600', () => {
  const adapter = baseAdapter()
  const caps = adapter.caps
  assert.equal(caps.editStream, false)
  assert.equal(caps.nativeStream, false)
  assert.equal(caps.nativeChoices, false)
  assert.equal(caps.typing, false)
  assert.equal(caps.imageIn, false)
  // 入站 media_id 下载面（/cgi-bin/media/get）未接 → fileIn=false 且无入站 files 填充
  assert.equal(caps.fileIn, false)
  // E1 声明=实装：media/upload + msgtype=file 已接 → fileOut=true 且 sendFile 为函数
  assert.equal(caps.fileOut, true)
  assert.equal(typeof adapter.sendFile, 'function')
  assert.equal(caps.threads, false)
  assert.equal(caps.voice, false)
  assert.equal(caps.statusReaction, false)
  assert.equal(caps.maxMessageLength, 600)
  assert.equal(WECOM_APP_MAX_MESSAGE, 600)
})

test('connect 即准备态；disconnect 清队列与 token 缓存', async () => {
  const adapter = baseAdapter()
  assert.equal(adapter.connected, false)
  await adapter.connect()
  assert.equal(adapter.connected, true)
  const inner = `<xml><FromUserName><![CDATA[u]]></FromUserName><CreateTime>1</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[q]]></Content><MsgId>q-1</MsgId></xml>`
  const { query, body } = xmlCallbackFixture(inner)
  adapter.handleXmlCallback(query, body)
  assert.equal(adapter.drain().length, 1)
  adapter.handleXmlCallback(query, body) // MsgId 重复 → 重放排重不再入队
  const fx2 = xmlCallbackFixture(inner.replace('q-1', 'q-2')) // 新 MsgId → 入队
  adapter.handleXmlCallback(fx2.query, fx2.body)
  assert.equal(adapter.drain().length, 1)
  await adapter.disconnect()
  assert.equal(adapter.connected, false)
  assert.deepEqual(adapter.drain(), [])
})

test('工厂校验：corpId/corpSecret/aesKey/callbackToken 缺一即抛；agentId 属 config', () => {
  const base = { accountId: 'acc-1', config: { callbackToken: CALLBACK_TOKEN, agentId: AGENT_ID }, secrets: { corpId: CORP_ID, corpSecret: CORP_SECRET, encodingAesKey: AES_KEY } }
  assert.ok(createWecomAppAdapter(base) instanceof WecomAppAdapter)
  assert.throws(() => createWecomAppAdapter({ ...base, secrets: { ...base.secrets, corpId: '' } }), /corpId/)
  assert.throws(() => createWecomAppAdapter({ ...base, secrets: { ...base.secrets, corpSecret: undefined } }), /corpSecret/)
  assert.throws(() => createWecomAppAdapter({ ...base, secrets: { ...base.secrets, encodingAesKey: '' } }), /encodingAesKey/)
  assert.throws(() => createWecomAppAdapter({ ...base, config: { agentId: AGENT_ID } }), /callbackToken/)
  // 抛错文本零 secret 回显
  try {
    createWecomAppAdapter({ ...base, secrets: { ...base.secrets, corpSecret: '' } })
  } catch (error) {
    assert.ok(!String(error).includes(AES_KEY))
  }
})

test('诊断三态：凭据在位 passed + gettoken 实探 passed + 回调/插件/roundtrip unverified', async () => {
  const { fetchImpl } = fakeFetch([
    { match: 'gettoken', reply: { json: { errcode: 0, access_token: 'T-d', expires_in: 7200 } } },
  ])
  const adapter = baseAdapter({ fetchImpl })
  const checks = await adapter.diagnose()
  const byName = Object.fromEntries(checks.map((c) => [c.name, c.status]))
  assert.equal(byName.credentials, 'passed')
  assert.equal(byName.gettoken, 'passed')
  assert.equal(byName.callback, 'unverified')
  assert.equal(byName['wechat-plugin-reach'], 'unverified')
  assert.equal(byName.roundtrip, 'unverified')
  // 零 secret 回显：任何 check 字段不得含凭据值
  const dump = JSON.stringify(checks)
  assert.ok(!dump.includes(CORP_SECRET) && !dump.includes(AES_KEY) && !dump.includes('T-d'))
})

test('诊断 gettoken 实探 failed：errcode 透出，hint 零 secret', async () => {
  const { fetchImpl } = fakeFetch([{ match: 'gettoken', reply: { json: { errcode: 40001, errmsg: 'invalid credential' } } }])
  const adapter = baseAdapter({ fetchImpl })
  const checks = await adapter.diagnose()
  const gt = checks.find((c) => c.name === 'gettoken')
  assert.equal(gt.status, 'failed')
  assert.match(gt.hint ?? '', /40001/)
  assert.ok(!JSON.stringify(checks).includes(CORP_SECRET))
})

test('extractXmlField 最小子集：CDATA/纯文本/缺标签', () => {
  const xml = '<xml><A><![CDATA[值 1]]></A><B>plain</B></xml>'
  assert.equal(extractXmlField(xml, 'A'), '值 1')
  assert.equal(extractXmlField(xml, 'B'), 'plain')
  assert.equal(extractXmlField(xml, 'Missing'), undefined)
})

// —— 文件面（M2 T2.4）————————————————————————————————
// 协议依据：上传临时素材 /cgi-bin/media/upload?access_token=…&type=file（multipart 字段名
// 固定 media，≤20MB、三天有效）+ 发送应用消息 msgtype=file（file.media_id）。
// 帧形断言：只断 url/method/header/字段名，不解析 multipart 正文语义。

const TOKEN_OK = { match: 'gettoken', reply: { json: { errcode: 0, access_token: 'T-f', expires_in: 7200 } } }
const UPLOAD_OK = { match: 'media/upload', reply: { json: { errcode: 0, media_id: 'MEDIA-1', type: 'file', created_at: '1700000000' } } }
const SEND_OK = { match: 'message/send', reply: { json: { errcode: 0, msgid: 'MSG-9' } } }

const DM = { channel: 'wecom-app', kind: 'dm', chatId: 'u1' }
const GROUP = { channel: 'wecom-app', kind: 'group', chatId: 'chat-77' }

test('sendFile 单聊两步帧形：media/upload multipart（字段名 media）→ message/send msgtype=file', async () => {
  const { fetchImpl, calls } = fakeFetch([TOKEN_OK, UPLOAD_OK, SEND_OK])
  const adapter = baseAdapter({ fetchImpl })
  const receipt = await adapter.sendFile(DM, { name: 'report.pdf', data: new Uint8Array([1, 2, 3, 4]) })
  assert.deepEqual(receipt, { platformMessageId: 'MSG-9', uncertain: false })

  const upload = calls.find((c) => c.url.includes('/cgi-bin/media/upload'))
  assert.equal(upload.init.method, 'POST')
  assert.match(upload.url, /\/cgi-bin\/media\/upload\?access_token=T-f&type=file$/)
  assert.match(upload.init.headers['content-type'], /^multipart\/form-data; boundary=----dshImUnion[0-9a-f]{24}$/)
  const raw = Buffer.from(upload.init.body).toString('latin1')
  assert.match(raw, /Content-Disposition: form-data; name="media"; filename="report\.pdf"/)
  assert.match(raw, /Content-Type: application\/octet-stream/)
  const boundary = upload.init.headers['content-type'].split('boundary=')[1]
  assert.ok(raw.endsWith(`--${boundary}--\r\n`), 'multipart 尾分隔符闭合')
  assert.ok(raw.includes('\r\n\r\n'), '头部与字节体以空行分隔（正文不参与语义断言）')

  const send = calls.find((c) => c.url.includes('/cgi-bin/message/send'))
  assert.deepEqual(JSON.parse(send.init.body), {
    touser: 'u1',
    msgtype: 'file',
    file: { media_id: 'MEDIA-1' },
    agentid: Number(AGENT_ID),
    safe: 0,
  })
  assert.equal(send.init.headers['Content-Type'], 'application/json')
})

test('sendFile 群聊：走 appchat/send 带 chatid + msgtype=file（body 无 agentid）', async () => {
  const { fetchImpl, calls } = fakeFetch([
    TOKEN_OK,
    UPLOAD_OK,
    { match: 'appchat/send', reply: { json: { errcode: 0 } } },
  ])
  const adapter = baseAdapter({ fetchImpl })
  const receipt = await adapter.sendFile(GROUP, { name: 'a.bin', data: new Uint8Array([9]) })
  assert.equal(receipt.uncertain, false)
  const send = calls.find((c) => c.url.includes('/cgi-bin/appchat/send'))
  assert.deepEqual(JSON.parse(send.init.body), { chatid: 'chat-77', msgtype: 'file', file: { media_id: 'MEDIA-1' }, safe: 0 })
  assert.equal(calls.some((c) => c.url.includes('/cgi-bin/message/send')), false)
})

test('sendFile 上传确定性失败（errcode≠0）→ WeComAppApiError，且不进入发送步', async () => {
  const { fetchImpl, calls } = fakeFetch([
    TOKEN_OK,
    { match: 'media/upload', reply: { json: { errcode: 41005, errmsg: 'media file not exist' } } },
    SEND_OK,
  ])
  const adapter = baseAdapter({ fetchImpl })
  await assert.rejects(
    () => adapter.sendFile(DM, { name: 'a.bin', data: new Uint8Array([1]) }),
    (error) => error instanceof WeComAppApiError && error.errcode === 41005,
  )
  assert.equal(calls.filter((c) => c.url.includes('media/upload')).length, 1)
  assert.equal(calls.some((c) => c.url.includes('message/send')), false, '上传未被接受 → 不发引用未素材的消息')
})

test('sendFile 上传传输失败 → WeComAppUncertainError（D7）：不重传不发送、零 token 回显', async () => {
  const { fetchImpl, calls } = fakeFetch([
    TOKEN_OK,
    { match: 'media/upload', reply: () => new Error('socket hang up') },
    SEND_OK,
  ])
  const adapter = baseAdapter({ fetchImpl })
  await assert.rejects(
    () => adapter.sendFile(DM, { name: 'a.bin', data: new Uint8Array([1]) }),
    (error) => error instanceof WeComAppUncertainError && !error.message.includes('T-f') && !error.message.includes(CORP_SECRET),
  )
  assert.equal(calls.filter((c) => c.url.includes('media/upload')).length, 1, '结果不明也不自动重发')
  assert.equal(calls.some((c) => c.url.includes('message/send')), false)
})

test('sendFile 上传成功体无 media_id → 确定性 ApiError（不发空引用）', async () => {
  const { fetchImpl, calls } = fakeFetch([
    TOKEN_OK,
    { match: 'media/upload', reply: { json: { errcode: 0, type: 'file' } } },
    SEND_OK,
  ])
  const adapter = baseAdapter({ fetchImpl })
  await assert.rejects(
    () => adapter.sendFile(DM, { name: 'a.bin', data: new Uint8Array([1]) }),
    /无 media_id/,
  )
  assert.equal(calls.some((c) => c.url.includes('message/send')), false)
})

test('sendFile 预检拒绝不出网：空文件 / 超临时素材 20MB / 缺 agentId', async () => {
  const { fetchImpl, calls } = fakeFetch([TOKEN_OK, UPLOAD_OK, SEND_OK])
  const adapter = baseAdapter({ fetchImpl })
  await assert.rejects(
    () => adapter.sendFile(DM, { name: 'empty.bin', data: new Uint8Array(0) }),
    (error) => error instanceof WeComAppApiError,
  )
  await assert.rejects(
    () => adapter.sendFile(DM, { name: 'huge.bin', data: new Uint8Array(20 * 1024 * 1024 + 1) }),
    (error) => error instanceof WeComAppApiError && /20971520/.test(error.message),
  )
  const noAgent = baseAdapter({ fetchImpl, agentId: undefined })
  await assert.rejects(() => noAgent.sendFile(DM, { name: 'a.bin', data: new Uint8Array([1]) }), /agentId/)
  assert.equal(calls.length, 0)
})

test('sendFile 不超引擎裁额：20MiB 整值放行（与 FILE_BUDGET 口径一致）', async () => {
  const { fetchImpl, calls } = fakeFetch([TOKEN_OK, UPLOAD_OK, SEND_OK])
  const adapter = baseAdapter({ fetchImpl })
  const receipt = await adapter.sendFile(DM, { name: 'edge.bin', data: new Uint8Array(20 * 1024 * 1024) })
  assert.equal(receipt.uncertain, false)
  assert.equal(calls.filter((c) => c.url.includes('media/upload')).length, 1)
})

test('诊断 file-surface：未实证 = unverified，hint 如实区分出站已接/入站未接', async () => {
  const { fetchImpl } = fakeFetch([TOKEN_OK])
  const adapter = baseAdapter({ fetchImpl })
  const checks = await adapter.diagnose()
  const fs = checks.find((c) => c.name === 'file-surface')
  assert.equal(fs.status, 'unverified')
  assert.match(fs.hint, /media\/upload/)
  assert.match(fs.hint, /caps\.fileIn=false/)
  assert.ok(!JSON.stringify(checks).includes(CORP_SECRET))
})

