// T1.3 飞书渠道单测：事件归一 / REST 出站参数 / 权限码转译 / 诊断三态 / SDK 注入面。
import test from 'node:test'
import assert from 'node:assert/strict'
import { FeishuAdapter, normalizeFeishuMessage, createFeishuAdapter } from '../lib/channels/feishu.js'
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
  const created = { messageCalls: [], requestCalls: [], started: false, handlers: undefined }
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
      }
      this.request = async (o) => {
        created.requestCalls.push(o)
        if (opts.requestThrows !== undefined) throw opts.requestThrows
        return opts.requestResult ?? { code: 0, data: { bot: { open_id: 'ou_bot' } } }
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

test('diagnose 三态：凭据 passed/failed + ws 位 + 权限位 unverified 明示', async () => {
  const ok = makeAdapter()
  await ok.adapter.connect()
  const checks = await ok.adapter.diagnose()
  assert.equal(checks[0].status, 'passed')
  assert.equal(checks[1].status, 'passed', 'ws 已连')
  assert.equal(checks[2].status, 'unverified')
  assert.ok(checks[2].hint.includes('权限'), '权限位给引导不谎报')

  const bad = makeAdapter({ requestThrows: new Error('401') })
  await bad.adapter.connect()
  const checksB = await bad.adapter.diagnose()
  assert.equal(checksB[0].status, 'failed')

  const never = makeAdapter()
  const checksC = await never.adapter.diagnose()
  assert.equal(checksC[0].status, 'failed')
  assert.equal(checksC[1].status, 'unverified')
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
