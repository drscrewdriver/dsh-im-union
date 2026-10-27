// T1.3 飞书渠道单测：事件归一 / REST 出站参数 / 权限码转译 / 诊断三态 / SDK 注入面。
import test from 'node:test'
import assert from 'node:assert/strict'
import { FeishuAdapter, normalizeFeishuMessage, createFeishuAdapter, FEISHU_PERMISSION_TEMPLATE } from '../lib/channels/feishu.js'
import { implementedChannels } from '../lib/channels/registry.js'

const textEvent = (over = {}) => ({
  sender: { sender_id: { user_id: 'ou_sender' } },
  message: {
    message_id: 'om_1',
    chat_id: 'oc_chat',
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text: '你好' }),
    ...over,
  },
})

// —— 归一 ——————————————————————————————————————————

test('normalize：p2p → dm，text 解包', () => {
  const m = normalizeFeishuMessage(textEvent())
  assert.equal(m.address.channel, 'feishu')
  assert.equal(m.address.kind, 'dm')
  assert.equal(m.address.chatId, 'oc_chat')
  assert.equal(m.userId, 'ou_sender')
  assert.equal(m.text, '你好')
  assert.equal(m.mentionedBot, false)
})

test('normalize：群聊 mention 占位符剥离并置 mentionedBot', () => {
  const m = normalizeFeishuMessage(
    textEvent({
      chat_type: 'group',
      content: JSON.stringify({ text: '@_user_1 帮我看看', mentions: [{ key: '@_user_1', name: 'bot' }] }),
    }),
  )
  assert.equal(m.address.kind, 'group')
  assert.equal(m.mentionedBot, true)
  assert.equal(m.text, '帮我看看')
})

test('normalize：非文本消息给占位文案（不丢事件）；缺字段返回 undefined', () => {
  const m = normalizeFeishuMessage(textEvent({ message_type: 'image', content: JSON.stringify({ image_key: 'img' }) }))
  assert.match(m.text, /非文本消息：image/)
  assert.equal(normalizeFeishuMessage({}), undefined)
  assert.equal(normalizeFeishuMessage({ sender: { sender_id: {} }, message: { chat_id: 'c' } }), undefined)
})

// —— SDK 注入面 ——————————————————————————————————————————

function fakeLark(opts = {}) {
  const created = { messageCalls: [], requestCalls: [], fileCalls: [], resourceCalls: [], started: false, handlers: undefined }
  const lark = {
    WSClient: function () {
      this.start = async () => {
        created.started = true
      }
    },
    EventDispatcher: function () {
      this.register = function (handlers) {
        created.handlers = handlers
        return this
      }
    },
    Client: function () {
      this.im = {
        message: {
          create: async (payload) => {
            created.messageCalls.push(payload)
            if (opts.createThrows !== undefined) throw opts.createThrows
            return opts.createResult ?? { message_id: 'om_new' }
          },
        },
        file: opts.noFileFace === true ? undefined : {
          create: async (payload) => {
            created.fileCalls.push(payload)
            if (opts.fileThrows !== undefined) throw opts.fileThrows
            if (opts.fileResult !== undefined) return opts.fileResult
            return { file_key: 'file_new' }
          },
        },
        messageResource: opts.noResourceFace === true ? undefined : {
          get: async (payload) => {
            created.resourceCalls.push(payload)
            // 语音档位需要按 type 分输（file 无字节→ media 双试路径）。
            if (typeof opts.resourceRoute === 'function') {
              const out = opts.resourceRoute(payload)
              if (out instanceof Error) throw out
              if (out === undefined) return { headers: {} }
              return {
                getReadableStream: () => (async function* () {
                  yield Uint8Array.from(out)
                })(),
              }
            }
            if (opts.resourceThrows !== undefined) throw opts.resourceThrows
            if (opts.resourceNoStream === true) return { headers: {} }
            return {
              getReadableStream: () => (async function* () {
                yield Uint8Array.from(opts.resourceBytes ?? [4, 5, 6])
              })(),
            }
          },
        },
      }
      this.request = async (o) => {
        created.requestCalls.push(o)
        if (typeof opts.requestRoute === 'function') {
          const out = opts.requestRoute(o)
          if (out instanceof Error) throw out
          return out
        }
        if (opts.requestThrows !== undefined) throw opts.requestThrows
        return opts.requestResult ?? { code: 0, tenant_access_token: 't-fake', data: { bot: { open_id: 'ou_bot' } } }
      }
    },
  }
  return { lark, created }
}

const makeAdapter = (opts = {}) => {
  const { lark, created } = fakeLark(opts)
  const adapter = new FeishuAdapter({ appId: 'cli_x', appSecret: 'sec', lark })
  return { adapter, created }
}

test('connect：WSClient start + 事件注册；receive 驱动 listener', async () => {
  const { adapter, created } = makeAdapter()
  const got = []
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  assert.equal(created.started, true)
  assert.ok(created.handlers?.['im.message.receive_v1'], 'receive_v1 已注册')
  assert.equal(adapter.connected, true)
  await adapter.injectEvent('im.message.receive_v1', textEvent())
  assert.equal(got.length, 1)
  assert.equal(got[0].text, '你好')
  await assert.rejects(adapter.injectEvent('nope', {}), /未注册事件/)
  await adapter.disconnect()
  assert.equal(adapter.connected, false)
})

test('reply：create 参数形态（receive_id_type/chat_id/text content JSON）与回执', async () => {
  const { adapter, created } = makeAdapter()
  await adapter.connect()
  const receipt = await adapter.reply({ channel: 'feishu', kind: 'dm', chatId: 'oc_chat' }, '回你')
  assert.equal(receipt.platformMessageId, 'om_new')
  const call = created.messageCalls[0]
  assert.deepEqual(call.params, { receive_id_type: 'chat_id' })
  assert.equal(call.data.receive_id, 'oc_chat')
  assert.equal(call.data.msg_type, 'text')
  assert.deepEqual(JSON.parse(call.data.content), { text: '回你' })
})

test('权限错误码 → 开发者后台引导文案（不透传内部错误体）', async () => {
  const { adapter } = makeAdapter({ createResult: { code: 99991672, msg: 'App tenant access token has no api access for scope: im:message' } })
  await adapter.connect()
  await assert.rejects(
    adapter.reply({ channel: 'feishu', kind: 'dm', chatId: 'c' }, 'x'),
    (e) => /im:message/.test(e.message) && /开发者后台/.test(e.message) && !/tenant access token/.test(e.message),
  )
})

test('网络类错误 → Uncertain（D7 禁重发）；其他平台拒绝确定性抛', async () => {
  const a = makeAdapter({ createThrows: new Error('request to open.feishu.cn timeout') })
  await a.adapter.connect()
  await assert.rejects(a.adapter.reply({ channel: 'feishu', kind: 'dm', chatId: 'c' }, 'x'), (e) => e.constructor.name.includes('Uncertain'))

  const b = makeAdapter({ createResult: { code: 230001, msg: 'invalid param' } })
  await b.adapter.connect()
  await assert.rejects(b.adapter.reply({ channel: 'feishu', kind: 'dm', chatId: 'c' }, 'x'), /code 230001/)
})

test('未 connect 就发消息 → 明确抛（不静默）', async () => {
  const { adapter } = makeAdapter()
  await assert.rejects(adapter.reply({ channel: 'feishu', kind: 'dm', chatId: 'c' }, 'x'), /未初始化/)
})

test('diagnose 三态：凭据 passed/failed + ws 位 + 机器人能力位 + 权限位 unverified 明示', async () => {
  const ok = makeAdapter()
  await ok.adapter.connect()
  const checks = await ok.adapter.diagnose()
  const byName = (n) => checks.find((c) => c.name === n)
  assert.equal(byName('credentials-valid').status, 'passed')
  assert.equal(byName('ws-long-connection').status, 'passed', 'ws 已连')
  assert.equal(byName('bot-ability').status, 'passed', '默认 fake 回 code 0')
  assert.equal(byName('permission-im-message').status, 'unverified')
  assert.ok(byName('permission-im-message').hint.includes('权限'), '权限位给引导不谎报')
  // 凭据探测走 token 端点（bot/v2/info 不存在，探它必假失败）
  assert.equal(ok.created.requestCalls[0].url, '/open-apis/auth/v3/tenant_access_token/internal', '凭据位探 token 端点')
  assert.equal(ok.created.requestCalls[0].data.app_id, 'cli_x', '带 appId 但 diagnose 不回显 secret')

  const bad = makeAdapter({ requestThrows: new Error('401') })
  await bad.adapter.connect()
  const checksB = await bad.adapter.diagnose()
  assert.equal(checksB[0].status, 'failed')

  const never = makeAdapter()
  const checksC = await never.adapter.diagnose()
  assert.equal(checksC[0].status, 'failed')
  assert.equal(checksC[1].status, 'unverified')
})

test('diagnose：appSecret 错（10014）→ 凭据位 failed；机器人能力未开通（11205）→ bot 位 failed 且两者不混谈', async () => {
  const wrongSecret = makeAdapter({ requestRoute: (o) => (o.url.includes('tenant_access_token') ? { code: 10014, msg: 'app secret invalid' } : { code: 0 }) })
  await wrongSecret.adapter.connect()
  const checksA = await wrongSecret.adapter.diagnose()
  assert.equal(checksA.find((c) => c.name === 'credentials-valid').status, 'failed')
  assert.match(checksA.find((c) => c.name === 'credentials-valid').hint, /appId\/appSecret 无效/)
  assert.equal(checksA.find((c) => c.name === 'bot-ability').status, 'passed', '错 secret 不改 bot 位结论（bot 面不校验凭据）')

  const noBot = makeAdapter({ requestRoute: (o) => (o.url.includes('bot/v3/info') ? { code: 11205, msg: 'app do not have bot' } : { code: 0, tenant_access_token: 't-fake' }) })
  await noBot.adapter.connect()
  const checksB = await noBot.adapter.diagnose()
  assert.equal(checksB.find((c) => c.name === 'credentials-valid').status, 'passed', '凭据有效：不再假报失败')
  const bot = checksB.find((c) => c.name === 'bot-ability')
  assert.equal(bot.status, 'failed')
  assert.match(bot.hint, /机器人/)
  assert.match(checksB.find((c) => c.name === 'ws-long-connection').hint, /不能据此推定/, '长连接通过不等于能收发')
})

test('caps 首版档位：逐步消息模式（editStream false），maxMessageLength 4000', () => {
  const { adapter } = makeAdapter()
  assert.equal(adapter.caps.editStream, false)
  assert.equal(adapter.caps.imageIn, false)
  assert.equal(adapter.caps.maxMessageLength, 4000)
  assert.equal(adapter.authorize(), undefined)
})

test('工厂凭据校验 + registry 实现度登记 feishu', async () => {
  await assert.rejects(
    createFeishuAdapter({ accountId: 'a', config: {}, secrets: {} }),
    /appId\/appSecret 未入库/,
  )
  assert.ok(implementedChannels().includes('feishu'))
})

// —— 文件输入/输出面（T2.4 渠道侧）——————————————————————————————————————

test('声明一致性：fileIn/fileOut=true 且 sendFile 为函数（imageIn 仍 false）', () => {
  const { adapter } = makeAdapter()
  assert.equal(adapter.caps.fileIn, true)
  assert.equal(adapter.caps.fileOut, true)
  assert.equal(typeof adapter.sendFile, 'function')
  assert.equal(adapter.caps.imageIn, false)
})

test('sendFile：im.file.create(stream) → message.create(msg_type=file, file_key)', async () => {
  const { adapter, created } = makeAdapter()
  await adapter.connect()
  const receipt = await adapter.sendFile(
    { channel: 'feishu', kind: 'dm', chatId: 'oc_chat' },
    { name: 'spec.pdf', data: Uint8Array.from([1, 2, 3]), mimeType: 'application/pdf' },
  )
  assert.equal(receipt.platformMessageId, 'om_new')
  const upload = created.fileCalls[0]
  assert.equal(upload.data.file_type, 'stream')
  assert.equal(upload.data.file_name, 'spec.pdf')
  assert.ok(upload.data.file instanceof Uint8Array, '字节直接交给 SDK 上传面')
  const sent = created.messageCalls.at(-1)
  assert.deepEqual(sent.params, { receive_id_type: 'chat_id' })
  assert.equal(sent.data.msg_type, 'file')
  assert.deepEqual(JSON.parse(sent.data.content), { file_key: 'file_new' })
})

test('sendFile：空文件确定性抛（平台不允许空文件，不发请求）', async () => {
  const { adapter, created } = makeAdapter()
  await adapter.connect()
  await assert.rejects(
    adapter.sendFile({ channel: 'feishu', kind: 'dm', chatId: 'c' }, { name: 'empty.bin', data: new Uint8Array(0) }),
    /空文件/,
  )
  assert.equal(created.fileCalls.length, 0)
})

test('sendFile：网络类抛 = Uncertain；无 file_key = 确定性抛', async () => {
  const net = makeAdapter({ fileThrows: new Error('connect timeout') })
  await net.adapter.connect()
  await assert.rejects(
    net.adapter.sendFile({ channel: 'feishu', kind: 'dm', chatId: 'c' }, { name: 'a', data: Uint8Array.from([1]) }),
    (e) => e.constructor.name.includes('Uncertain'),
  )

  const noKey = makeAdapter({ fileResult: {} })
  await noKey.adapter.connect()
  await assert.rejects(
    noKey.adapter.sendFile({ channel: 'feishu', kind: 'dm', chatId: 'c' }, { name: 'a', data: Uint8Array.from([1]) }),
    /file_key/,
  )

  const badCode = makeAdapter({ fileThrows: Object.assign(new Error('upload rejected'), { code: 234001 }) })
  await badCode.adapter.connect()
  await assert.rejects(
    badCode.adapter.sendFile({ channel: 'feishu', kind: 'dm', chatId: 'c' }, { name: 'a', data: Uint8Array.from([1]) }),
    /code 234001/,
  )
})

test('sendFile：SDK 缺上传面时明确抛（不静默降级）', async () => {
  const { adapter } = makeAdapter({ noFileFace: true })
  await adapter.connect()
  await assert.rejects(
    adapter.sendFile({ channel: 'feishu', kind: 'dm', chatId: 'c' }, { name: 'a', data: Uint8Array.from([1]) }),
    /im.file.create/,
  )
})

test('入站 file 事件：归一为文件名占位正文＋message_resource 下载填 files', async () => {
  const { adapter, created } = makeAdapter({ resourceBytes: [9, 8, 7] })
  const got = []
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  await adapter.injectEvent('im.message.receive_v1', {
    sender: { sender_id: { user_id: 'ou_sender' } },
    message: {
      message_id: 'om_file1',
      chat_id: 'oc_chat',
      chat_type: 'p2p',
      message_type: 'file',
      content: JSON.stringify({ file_key: 'file_in', file_name: '报告.docx' }),
    },
  })
  assert.equal(got.length, 1)
  assert.match(got[0].text, /\[文件：报告\.docx\]/)
  assert.equal(got[0].files.length, 1)
  assert.equal(got[0].files[0].name, '报告.docx')
  assert.deepEqual([...got[0].files[0].data], [9, 8, 7])
  assert.deepEqual(created.resourceCalls[0], {
    params: { type: 'file' },
    path: { message_id: 'om_file1', file_key: 'file_in' },
  })
  await adapter.disconnect()
})

test('入站 file 下载失败/无流面：降级为无附件但不丢整条', async () => {
  const a = makeAdapter({ resourceThrows: new Error('403 permission denied') })
  const got = []
  a.adapter.onMessage((m) => got.push(m))
  await a.adapter.connect()
  await a.adapter.injectEvent('im.message.receive_v1', {
    sender: { sender_id: { user_id: 'ou_sender' } },
    message: {
      message_id: 'om_file2',
      chat_id: 'oc_chat',
      chat_type: 'p2p',
      message_type: 'file',
      content: JSON.stringify({ file_key: 'file_x', file_name: 'a.bin' }),
    },
  })
  assert.equal(got.length, 1)
  assert.equal(got[0].files, undefined)
  await a.adapter.disconnect()

  const b = makeAdapter({ noResourceFace: true })
  const gotB = []
  b.adapter.onMessage((m) => gotB.push(m))
  await b.adapter.connect()
  await b.adapter.injectEvent('im.message.receive_v1', {
    sender: { sender_id: { user_id: 'ou_sender' } },
    message: {
      message_id: 'om_file3',
      chat_id: 'oc_chat',
      chat_type: 'p2p',
      message_type: 'file',
      content: JSON.stringify({ file_key: 'file_y' }),
    },
  })
  assert.equal(gotB.length, 1)
  assert.equal(gotB[0].files, undefined, '无下载面时不伪填附件')
  assert.match(gotB[0].text, /\[文件：未命名文件\]/)
  await b.adapter.disconnect()
})

test('diagnose：文件权限位未实证 = unverified', async () => {
  const { adapter } = makeAdapter()
  await adapter.connect()
  const checks = await adapter.diagnose()
  const file = checks.find((c) => c.name === 'permission-file')
  assert.equal(file.status, 'unverified')
  assert.match(file.hint, /im:resource/)
})

// —— 流式卡片档（T1.3 尾巴）——————————————————

function cardFetch(routes) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers })
    return routes(url, init)
  }
  return { impl, calls }
}
const feishuResp = (body, ok = true, status = 200) => ({ ok, status, json: async () => ({ code: 0, ...body }) })

async function cardAdapter(routeExtra = {}) {
  const { lark, created } = fakeLark(routeExtra.larkOpts)
  const fetch = cardFetch((url) => {
    if (url.includes('/auth/v3/tenant_access_token')) return feishuResp({ tenant_access_token: 't-abc', expire: 3600 })
    if (url.includes('/cardkit/v1/cards') && !url.includes('/elements') && !url.includes('/settings')) return feishuResp({ data: { card_id: 'card-1' } })
    return feishuResp({})
  })
  const adapter = new FeishuAdapter({ appId: 'cli', appSecret: 'sec', lark, fetchImpl: fetch.impl, ...routeExtra.adapterOpts })
  await adapter.connect()
  return { adapter, created, fetch }
}

test('卡片档：caps.nativeStream=true；beginStream 建实体→interactive 引用 card_id', async () => {
  const { adapter, created, fetch } = await cardAdapter()
  assert.equal(adapter.caps.nativeStream, true)
  const stream = await adapter.beginStream({ channel: 'feishu', kind: 'dm', chatId: 'oc_1' })
  assert.ok(fetch.calls.some((c) => c.url.includes('/auth/v3/tenant_access_token')), '先取 tenant token')
  const createCard = fetch.calls.find((c) => c.url.includes('/cardkit/v1/cards') && c.method === 'POST')
  assert.equal(createCard.body.type, 'card_json')
  assert.match(createCard.body.data, /"streaming_mode":true/)
  const sent = created.messageCalls.at(-1)
  assert.equal(sent.data.msg_type, 'interactive')
  assert.equal(JSON.parse(sent.data.content).card_id, 'card-1', '消息体引用卡片实体 id')
  assert.ok(stream)
})

test('卡片档：update 全量推送元素内容；finish 落定+关 streaming_mode', async () => {
  const { adapter, fetch } = await cardAdapter()
  const stream = await adapter.beginStream({ channel: 'feishu', kind: 'dm', chatId: 'oc_1' })
  await stream.update('前半')
  const put = fetch.calls.filter((c) => c.method === 'PUT')
  assert.equal(put.length, 1)
  assert.ok(put[0].url.includes('/cards/card-1/elements/imu_stream/content'))
  assert.equal(put[0].body.content, '前半')
  const receipt = await stream.finish('前半+后半')
  assert.equal(receipt.uncertain, false)
  assert.equal(receipt.platformMessageId, 'om_new')
  assert.equal(fetch.calls.filter((c) => c.method === 'PUT').at(-1).body.content, '前半+后半', '全量口径')
  const settings = fetch.calls.find((c) => c.method === 'PATCH')
  assert.ok(settings.url.includes('/cards/card-1/settings'))
  assert.equal(settings.body.config.streaming_mode, false)
})

test('卡片档：权限错误码转译为批量导入模板引导', async () => {
  const { lark } = fakeLark()
  const fetch = cardFetch((url) => {
    if (url.includes('/auth/v3/tenant_access_token')) return feishuResp({ tenant_access_token: 't', expire: 3600 })
    return { ok: true, status: 200, json: async () => ({ code: 99991672, msg: 'no permission' }) }
  })
  const adapter = new FeishuAdapter({ appId: 'cli', appSecret: 'sec', lark, fetchImpl: fetch.impl })
  await adapter.connect()
  await assert.rejects(
    adapter.beginStream({ channel: 'feishu', kind: 'dm', chatId: 'oc_1' }),
    (error) => /cardkit:card:write/.test(error.message) && error.message.includes('im:message'),
  )
})

test('text 档：caps 全 false 且不消费 card REST（引擎分段 reply 退化）', async () => {
  const { adapter, fetch } = await cardAdapter({ adapterOpts: { cardMode: 'text' } })
  assert.equal(adapter.caps.nativeStream, false)
  await assert.rejects(adapter.beginStream({ channel: 'feishu', kind: 'dm', chatId: 'oc_1' }), /逐步消息档/)
  await adapter.reply({ channel: 'feishu', kind: 'dm', chatId: 'oc_1' }, '文本')
  assert.ok(!fetch.calls.some((c) => c.url.includes('/cardkit/')))
})

test('typing 档（飞书无 typing API）：入站消息贴 OnIt 表情，reply 落地即回收', async () => {
  const fetch = cardFetch((url) => {
    if (url.includes('/auth/v3/tenant_access_token')) return feishuResp({ tenant_access_token: 't-abc', expire: 3600 })
    if (url.includes('/reactions')) return feishuResp({ data: { reaction_id: 'r-1' } })
    return feishuResp({})
  })
  const { lark } = fakeLark()
  const adapter = new FeishuAdapter({ appId: 'cli', appSecret: 'sec', lark, fetchImpl: fetch.impl })
  await adapter.connect()
  assert.equal(adapter.caps.typing, true, 'typing 位声明')
  assert.equal(adapter.caps.statusReaction, true, '状态表情同源声明')

  await adapter.injectEvent('im.message.receive_v1', textEvent()) // 记住入站 message_id=om_1
  const address = { channel: 'feishu', kind: 'dm', chatId: 'oc_chat' }
  await adapter.setTyping(address)
  const added = fetch.calls.find((c) => c.method === 'POST' && c.url.includes('/im/v1/messages/om_1/reactions'))
  assert.ok(added, '挂在用户本条消息上')
  assert.equal(added.body.reaction_type.emoji_type, 'OnIt')

  await adapter.reply(address, '答复')
  const removed = fetch.calls.find((c) => c.method === 'DELETE' && c.url.includes('/im/v1/messages/om_1/reactions/r-1'))
  assert.ok(removed, '回复落地即回收状态位')
})

test('typing 档：无入站 message_id / 表情接口失败：静默不抛（不阻断回合）', async () => {
  const fetch = cardFetch((url) => {
    if (url.includes('/auth/v3/tenant_access_token')) return feishuResp({ tenant_access_token: 't-abc', expire: 3600 })
    if (url.includes('/reactions')) return { ok: true, status: 200, json: async () => ({ code: 230002, msg: 'bot is not in chat' }) }
    return feishuResp({})
  })
  const { lark } = fakeLark()
  const adapter = new FeishuAdapter({ appId: 'cli', appSecret: 'sec', lark, fetchImpl: fetch.impl })
  await adapter.connect()
  // 没有入站记录 → 直接返回，不发请求
  await adapter.setTyping({ channel: 'feishu', kind: 'dm', chatId: 'oc_none' })
  assert.equal(fetch.calls.filter((c) => c.url.includes('/reactions')).length, 0)
  // 有入站记录但平台拒（无权限/限频）→ 静默
  await adapter.injectEvent('im.message.receive_v1', textEvent())
  await adapter.setTyping({ channel: 'feishu', kind: 'dm', chatId: 'oc_chat' })
  assert.ok(fetch.calls.some((c) => c.url.includes('/reactions')))
})

test('审批卡片：1.0 形态出卡（action/button）→ card.action.trigger 回传定夺；非发起者不改判', async () => {
  const { lark, created } = fakeLark({ createResult: { message_id: 'om_card' } })
  const adapter = new FeishuAdapter({ appId: 'cli', appSecret: 'sec', lark })
  await adapter.connect()
  assert.equal(adapter.caps.nativeChoices, true, '按钮位声明')

  const address = { channel: 'feishu', kind: 'dm', chatId: 'oc_1' }
  let settled = null
  const pending = adapter
    .askChoices(address, '需要审批：工具 Bash', ['允许一次', '拒绝'], false, undefined, { ownerUserId: 'ou_owner' })
    .then((r) => { settled = r })
  const sent = created.messageCalls.at(-1)
  assert.equal(sent.data.msg_type, 'interactive')
  const card = JSON.parse(sent.data.content)
  assert.equal(card.schema, undefined, '1.0 形态：不带 schema（2.0 的 body.elements 不支持 action 标签）')
  assert.equal(card.elements[1].tag, 'action')
  assert.deepEqual(card.elements[1].actions.map((b) => b.text.content), ['允许一次', '拒绝'])
  assert.deepEqual(card.elements[1].actions[0].value, { imu: 'choice', label: '允许一次' })

  const rawAction = (openId, label) => ({
    schema: '2.0',
    header: { event_type: 'card.action.trigger' },
    event: {
      context: { open_message_id: 'om_card', open_chat_id: 'oc_1' },
      operator: { open_id: openId },
      action: { tag: 'button', value: { imu: 'choice', label } },
    },
  })

  // 出卡是异步的（create 回包后才登记 pending）：先让一个微任务落定
  await new Promise((r) => setTimeout(r, 0))

  // 他人点按：不改判（D5），回 toast 说明，promise 仍未决
  const other = await adapter.injectEvent('card.action.trigger', rawAction('ou_other', '允许一次'))
  assert.ok(other !== undefined, 'pending 已登记：他人点按应回 toast')
  assert.match(JSON.stringify(other), /只接受发起者/)
  assert.equal(settled, null, '他人点按不得定夺')

  // 发起者点按：定夺 + toast 回执
  const mine = await adapter.injectEvent('card.action.trigger', rawAction('ou_owner', '拒绝'))
  await pending
  assert.deepEqual(settled, { answer: '拒绝', uncertain: false })
  assert.match(JSON.stringify(mine), /已记录/)

  // 卡还在但 pending 已清：迟到的重复点按不再影响任何事
  const late = await adapter.injectEvent('card.action.trigger', rawAction('ou_owner', '允许一次'))
  assert.equal(late, undefined)
})

test('审批卡片：multi=true 拒接（无卡片多选原语，交回 broker 走文本）', async () => {
  const { lark } = fakeLark()
  const adapter = new FeishuAdapter({ appId: 'cli', appSecret: 'sec', lark })
  await adapter.connect()
  await assert.rejects(
    adapter.askChoices({ channel: 'feishu', kind: 'dm', chatId: 'oc_1' }, '选哪些', ['a', 'b'], true),
    /多选无卡片原语/,
  )
})

test('diagnose 附送权限模板与 cardkit 档位提示；工厂 config.cardMode', async () => {
  const { adapter } = await cardAdapter()
  const checks = await adapter.diagnose()
  const cardkit = checks.find((c) => c.name === 'permission-cardkit')
  assert.equal(cardkit.status, 'unverified')
  assert.ok(checks.some((c) => String(c.hint).includes('im:message')))
  assert.ok(FEISHU_PERMISSION_TEMPLATE.includes('cardkit:card:write'))
  const textAdapter = await createFeishuAdapter({ accountId: 'a', config: { cardMode: 'text' }, secrets: { appId: 'x', appSecret: 'y' } })
  assert.equal(textAdapter.caps.nativeStream, false)
})

// —— 语音档位（T3.5：ffmpeg + DashScope，全注入零真机）——————————————————

const audioEvent = (over = {}) => ({
  sender: { sender_id: { user_id: 'ou_sender' } },
  message: {
    message_id: 'om_voice1',
    chat_id: 'oc_chat',
    chat_type: 'p2p',
    message_type: 'audio',
    content: JSON.stringify({ file_key: 'file_voice', duration: 2000 }),
    ...over,
  },
})

/** ffmpeg 注入替身：pipe 流式产出 out 字节（默认合法 wav 头 1s）。 */
function ffmpegFake(scenario = {}) {
  const calls = []
  const mkStream = () => {
    const handlers = {}
    return {
      on: (event, cb) => {
        ;(handlers[event] ??= []).push(cb)
        return this
      },
      emit(chunk) {
        for (const cb of handlers.data ?? []) cb(chunk)
      },
      handlers,
    }
  }
  const impl = (command, args) => {
    const record = { command, args, input: [], handlers: {} }
    calls.push(record)
    const stdout = mkStream()
    const stderr = mkStream()
    const child = {
      stdin: { write: (chunk) => record.input.push(chunk), end: () => {} },
      stdout,
      stderr,
      on: (event, cb) => {
        ;(record.handlers[event] ??= []).push(cb)
        return child
      },
      kill: () => true,
    }
    setImmediate(() => {
      if (scenario.enoent === true) {
        for (const cb of record.handlers.error ?? []) cb(Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }))
        return
      }
      for (const chunk of scenario.out ?? [makeWav(32000, 32000)]) stdout.emit(chunk)
      for (const cb of record.handlers.close ?? []) cb(scenario.code ?? 0)
    })
    return child
  }
  return { impl, calls }
}

/** 16k/16bit 单声道 RIFF/WAVE 头（data 段长度按声明计）。 */
function makeWav(dataBytes, byteRate) {
  const head = new Uint8Array(44)
  const view = new DataView(head.buffer)
  const ascii = (at, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, Math.round(byteRate / 2), true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  return head
}

/** DashScope 注入替身（与 cardkit 的 fetchImpl 互不污染）。 */
function voiceFetch(route) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    return route(url, init)
  }
  return { impl, calls }
}
const dsOk = (body) => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => new Uint8Array([9, 9, 9, 9]).buffer })
const dsErr = (status, body) => ({ ok: false, status, json: async () => body ?? { code: 'Denied' }, arrayBuffer: async () => new Uint8Array(0).buffer })
const asrOk = (text) => dsOk({ output: { choices: [{ message: { content: [{ text }] } }] }, usage: { seconds: 2 } })

const makeVoiceAdapter = (opts = {}) => {
  const { lark, created } = fakeLark(opts.larkOpts ?? {})
  const ffmpeg = opts.ffmpeg ?? ffmpegFake()
  const ds = opts.ds ?? voiceFetch(() => asrOk('你好'))
  const adapter = new FeishuAdapter({
    appId: 'cli_x',
    appSecret: 'sec',
    lark,
    voiceEnabled: opts.voiceEnabled !== false,
    voice: { apiKey: opts.apiKey ?? 'ds-key', spawnImpl: ffmpeg.impl, fetchImpl: ds.impl, ...(opts.voiceExtra ?? {}) },
  })
  return { adapter, created, ffmpeg, ds }
}

test('normalize：audio 帧→「[语音消息]」占位（未开档位时即终值，不丢事件）', () => {
  const m = normalizeFeishuMessage(audioEvent())
  assert.equal(m.text, '[语音消息]')
  assert.equal(m.mentionedBot, true)
})

test('语音关闭：audio 事件零下载/零转码/零网络（默认关不偷跑）', async () => {
  const ffmpeg = ffmpegFake()
  const ds = voiceFetch(() => asrOk('不该被调'))
  const { adapter, created } = makeAdapter({ resourceBytes: [1, 2, 3] })
  const got = []
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  await adapter.injectEvent('im.message.receive_v1', audioEvent())
  assert.equal(got.length, 1, '事件照常派发')
  assert.equal(got[0].text, '[语音消息]')
  assert.equal(created.resourceCalls.length, 0)
  assert.equal(ffmpeg.calls.length, 0)
  assert.equal(ds.calls.length, 0)
  assert.equal(adapter.caps.voice, false)
})

test('audio 全链：下载→ffmpeg 转 wav/16k→ASR→正文带 🎤（不丢事件）', async () => {
  const { adapter, created, ffmpeg, ds } = makeVoiceAdapter()
  const got = []
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  await adapter.injectEvent('im.message.receive_v1', audioEvent())
  assert.equal(got.length, 1)
  assert.equal(got[0].text, '🎤 你好')
  assert.deepEqual(created.resourceCalls[0], { params: { type: 'file' }, path: { message_id: 'om_voice1', file_key: 'file_voice' } })
  assert.deepEqual(ffmpeg.calls[0].args, ['-hide_banner', '-loglevel', 'error', '-f', 'ogg', '-i', 'pipe:0', '-y', '-f', 'wav', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', 'pipe:1'])
  assert.ok(ffmpeg.calls[0].args.includes('pcm_s16le'), '转 wav/16k 单声道')
  const asrCall = ds.calls[0]
  assert.equal(asrCall.method, 'POST')
  assert.ok(asrCall.url.endsWith('/services/aigc/multimodal-generation/generation'), asrCall.url)
  assert.equal(asrCall.headers.authorization, 'Bearer ds-key')
  assert.equal(asrCall.body.model, 'qwen3-asr-flash')
  assert.match(asrCall.body.input.messages[0].content[0].audio, /^data:audio\/wav;base64,/)
  assert.ok(!JSON.stringify(got[0]).includes('ds-key'), '转写后的消息零密钥')
})

test('audio 资源 type 双试：file 无字节时改取 media（不硬编单侧结论）', async () => {
  const larkOpts = { resourceRoute: (payload) => (payload.params.type === 'file' ? undefined : [7, 7, 7]) }
  const { adapter, created } = makeVoiceAdapter({ larkOpts })
  const got = []
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  await adapter.injectEvent('im.message.receive_v1', audioEvent())
  assert.deepEqual(created.resourceCalls.map((c) => c.params.type), ['file', 'media'])
  assert.equal(got[0].text, '🎤 你好', 'media 侧取到字节即能转写')
})

test('audio 失败占位：缺 file_key / 无资源字节 / 缺 ffmpeg / ASR 401 均不丢事件', async () => {
  const noKey = makeVoiceAdapter({ apiKey: 'ds-key' })
  const got1 = []
  noKey.adapter.onMessage((m) => got1.push(m))
  await noKey.adapter.connect()
  await noKey.adapter.injectEvent('im.message.receive_v1', audioEvent({ content: JSON.stringify({ duration: 1000 }) }))
  assert.equal(got1.length, 1)
  assert.equal(got1[0].text, '[语音转写失败：音频为空]')
  assert.equal(noKey.created.resourceCalls.length, 0, '无资源标识即不尝试下载')

  const noBytes = makeVoiceAdapter({ larkOpts: { resourceRoute: () => undefined } })
  const got2 = []
  noBytes.adapter.onMessage((m) => got2.push(m))
  await noBytes.adapter.connect()
  await noBytes.adapter.injectEvent('im.message.receive_v1', audioEvent())
  assert.equal(got2[0].text, '[语音转写失败：语音资源下载失败]')
  assert.deepEqual(noBytes.created.resourceCalls.map((c) => c.params.type), ['file', 'media'])

  const noFfmpeg = makeVoiceAdapter({ ffmpeg: ffmpegFake({ enoent: true }) })
  const got3 = []
  noFfmpeg.adapter.onMessage((m) => got3.push(m))
  await noFfmpeg.adapter.connect()
  await noFfmpeg.adapter.injectEvent('im.message.receive_v1', audioEvent())
  assert.equal(got3[0].text, '[语音转写失败：本机缺 ffmpeg]')
  assert.equal(noFfmpeg.ds.calls.length, 0, '转码缺位即不触网')

  const rejected = makeVoiceAdapter({ ds: voiceFetch(() => dsErr(401, { code: 'InvalidApiKey', message: 'api key invalid' })) })
  const got4 = []
  rejected.adapter.onMessage((m) => got4.push(m))
  await rejected.adapter.connect()
  await rejected.adapter.injectEvent('im.message.receive_v1', audioEvent())
  assert.equal(got4[0].text, '[语音转写失败：平台拒绝]')
  assert.equal(got4.length, 1)
})

test('audio 开了档位但未入库密钥：回「未配置语音密钥」且零下载', async () => {
  const { adapter, created, ffmpeg, ds } = makeVoiceAdapter({ apiKey: '' })
  const got = []
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  await adapter.injectEvent('im.message.receive_v1', audioEvent())
  assert.equal(got[0].text, '[语音转写失败：未配置语音密钥]')
  assert.equal(created.resourceCalls.length, 0)
  assert.equal(ffmpeg.calls.length, 0)
  assert.equal(ds.calls.length, 0)
})

test('speak：TTS→转 opus→file.create(opus,duration)→msg_type=audio', async () => {
  const ds = voiceFetch((url) => {
    if (url.includes('SpeechSynthesizer')) return dsOk({ output: { audio: { url: 'https://dashscope-result.example/a.wav' }, format: 'wav' } })
    return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => makeWav(32000, 32000).buffer }
  })
  const ffmpeg = ffmpegFake({ out: [Uint8Array.from([1, 2, 3, 4])] })
  const { adapter, created } = makeVoiceAdapter({ ds, ffmpeg })
  await adapter.connect()
  const receipt = await adapter.speak({ channel: 'feishu', kind: 'dm', chatId: 'oc_chat' }, '你好')
  assert.equal(receipt.platformMessageId, 'om_new')
  const post = ds.calls[0]
  assert.equal(post.url.endsWith('/services/audio/tts/SpeechSynthesizer'), true)
  assert.equal(post.body.input.voice, 'longanyang')
  assert.ok(ffmpeg.calls[0].args.includes('libopus'), '飞书语音条口径 opus')
  const upload = created.fileCalls[0]
  assert.equal(upload.data.file_type, 'opus')
  assert.equal(upload.data.duration, 1000, 'duration 毫秒随上传')
  assert.ok(upload.data.file instanceof Uint8Array)
  const sent = created.messageCalls.at(-1)
  assert.equal(sent.data.msg_type, 'audio')
  assert.deepEqual(JSON.parse(sent.data.content), { file_key: 'file_new', duration: 1000 })
})

test('speak 未启用：明确抛（默认不可达）；TTS 拒绝=确定性、网络错=Uncertain', async () => {
  const off = makeAdapter()
  await off.adapter.connect()
  await assert.rejects(off.adapter.speak({ channel: 'feishu', kind: 'dm', chatId: 'c' }, 'x'), /语音档位未启用/)
  assert.equal(off.adapter.caps.voice, false, '档位声明不造假')

  const denied = makeVoiceAdapter({ ds: voiceFetch(() => dsErr(400, { code: 'InvalidParameter' })) })
  await denied.adapter.connect()
  await assert.rejects(denied.adapter.speak({ channel: 'feishu', kind: 'dm', chatId: 'c' }, 'x'), /\[语音合成失败：平台拒绝\]/)
  assert.equal(denied.ffmpeg.calls.length, 0, '合成未成即不转码')

  const net = makeVoiceAdapter({ ds: voiceFetch(() => { throw new Error('socket hang up') }) })
  await net.adapter.connect()
  await assert.rejects(net.adapter.speak({ channel: 'feishu', kind: 'dm', chatId: 'c' }, 'x'), (e) => e.constructor.name.includes('Uncertain'))
})

test('diagnose voice 三态：未启用=unverified / 配置但探测失败=failed / 探测通过=passed', async () => {
  const off = makeAdapter()
  await off.adapter.connect()
  const checksOff = await off.adapter.diagnose()
  const voiceOff = checksOff.find((c) => c.name === 'voice-pipeline')
  assert.equal(voiceOff.status, 'unverified')
  assert.match(voiceOff.hint, /voiceEnabled/)

  const broken = makeVoiceAdapter({ ffmpeg: ffmpegFake({ enoent: true }) })
  await broken.adapter.connect()
  const checksBroken = await broken.adapter.diagnose()
  const voiceBroken = checksBroken.find((c) => c.name === 'voice-pipeline')
  assert.equal(voiceBroken.status, 'failed')
  assert.match(voiceBroken.hint, /\[语音转写失败：本机缺 ffmpeg\]/)

  const good = makeVoiceAdapter({ ffmpeg: ffmpegFake({ out: [new TextEncoder().encode('ffmpeg version 7.1')] }) })
  await good.adapter.connect()
  const checksGood = await good.adapter.diagnose()
  const voiceGood = checksGood.find((c) => c.name === 'voice-pipeline')
  assert.equal(voiceGood.status, 'passed')
  assert.match(voiceGood.hint, /ffmpeg 到位/)

  const noKey = makeVoiceAdapter({ apiKey: '' })
  await noKey.adapter.connect()
  const checksNoKey = await noKey.adapter.diagnose()
  assert.equal(checksNoKey.find((c) => c.name === 'voice-pipeline').status, 'failed')
  assert.ok(!JSON.stringify(checksNoKey).includes('ds-key'), '诊断不回显密钥')
})

test('工厂：voiceEnabled=\'true\' 才接线；密钥只从 secrets 取（零明文）', async () => {
  const base = { accountId: 'a', secrets: { appId: 'x', appSecret: 'y', dashScopeKey: 'ds-from-vault' } }
  const offAdapter = await createFeishuAdapter({ ...base, config: {} })
  assert.equal(offAdapter.caps.voice, false)
  await assert.rejects(offAdapter.reply({ channel: 'feishu', kind: 'dm', chatId: 'c' }, 'x'), /未初始化/)
  const on = await createFeishuAdapter({
    ...base,
    config: { voiceEnabled: 'true', dashscopeModel: 'qwen3-asr-flash-2025-05-19', dashscopeTtsModel: 'cosyvoice-v2', dashscopeVoice: 'longxiaochun' },
  })
  assert.equal(on.caps.voice, false, '开了档位也不抹能力位（无真机实证）')
  assert.equal(typeof on.speak, 'function')
  const noVault = await createFeishuAdapter({ accountId: 'a', config: { voiceEnabled: 'true' }, secrets: { appId: 'x', appSecret: 'y' } })
  const checks = await noVault.diagnose()
  const voice = checks.find((c) => c.name === 'voice-pipeline')
  assert.equal(voice.status, 'failed')
  assert.match(voice.hint, /dashScopeKey/)
})
