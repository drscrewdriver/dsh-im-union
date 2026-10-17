// Telegram 渠道单测：协议解析 / 富文本回退链 / 编辑流式 / Receipt 语义 / 诊断三态。
// 网络面全部走注入的 fake fetch，不发真实请求。
import test from 'node:test'
import assert from 'node:assert/strict'
import { TelegramAdapter, createTelegramAdapter } from '../lib/channels/telegram.js'

const resp = (status, body) => ({
  ok: status >= 200 && status < 399,
  status,
  json: async () => body,
})
const success = (result) => resp(200, { ok: true, result })
const apiErr = (description, status = 400) => resp(status, { ok: false, description, error_code: status })
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })
/** 下载面响应（带 arrayBuffer）。 */
const binResp = (bytes, status = 200) => ({
  ok: status >= 200 && status < 399,
  status,
  json: async () => ({}),
  arrayBuffer: async () => Uint8Array.from(bytes).buffer,
})

/** 通用 fake：route(method, body, init) → 响应或 Promise。calls 记录请求。 */
function fakeFetch(route) {
  const calls = []
  const impl = async (url, init) => {
    const method = url.split('/').pop()
    let body = {}
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = { raw: true }
      }
    }
    calls.push({ url, method, body, init })
    return route(method, body, init)
  }
  impl.calls = calls
  return impl
}

/** 连接型 fake：getMe 固定成功；首个 getUpdates 返回 updates，其余挂到 abort。 */
function connectFetch(updates = [], extraRoute) {
  let first = true
  return fakeFetch((method, body, init) => {
    if (method === 'getMe') return success({ username: 'demo_bot' })
    if (method === 'getUpdates') {
      if (first) {
        first = false
        return success(updates)
      }
      return new Promise((_, reject) => {
        const signal = init?.signal
        if (signal !== undefined) {
          if (signal.aborted) return reject(abortError())
          signal.addEventListener('abort', () => reject(abortError()), { once: true })
        }
      })
    }
    if (extraRoute !== undefined) return extraRoute(method, body)
    return success({})
  })
}

const newAdapter = (fetchImpl) => new TelegramAdapter({ token: 'TOK', fetchImpl, apiBase: 'https://api.test' })

const privateMsg = (over = {}) => ({
  message_id: 1,
  date: 1700000000,
  chat: { id: 111, type: 'private' },
  from: { id: 42, first_name: 'Alice', username: 'al' },
  text: 'hi',
  ...over,
})

async function withConnected(adapter) {
  await adapter.connect()
  return adapter
}

const waitUntil = async (fn, ms = 2000) => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('waitUntil 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// —— 入站协议解析 ——————————————————————————————————————————

test('normalize：私聊 → dm，字段齐备', async () => {
  const adapter = newAdapter(connectFetch())
  await withConnected(adapter)
  const m = adapter.normalize(privateMsg({ text: 'hi @demo_bot 在吗' }))
  adapter.disconnect()
  assert.equal(m.address.channel, 'telegram')
  assert.equal(m.address.kind, 'dm')
  assert.equal(m.address.chatId, '111')
  assert.equal(m.userId, '42')
  assert.equal(m.userDisplayName, 'Alice al')
  assert.equal(m.mentionedBot, true, '@用户名即算显式点名')
  assert.equal(m.timestamp, 1700000000000)
})

test('normalize：/cmd@bot 命令形式识别为点名', async () => {
  const adapter = newAdapter(connectFetch())
  await withConnected(adapter)
  assert.equal(adapter.normalize(privateMsg({ text: '/start@DEMO_BOT' })).mentionedBot, true)
  assert.equal(adapter.normalize(privateMsg({ text: '/start other' })).mentionedBot, false)
  adapter.disconnect()
})

test('normalize：群聊 → group，channel 频道丢弃', async () => {
  const adapter = newAdapter(connectFetch())
  await withConnected(adapter)
  const g = adapter.normalize(privateMsg({ chat: { id: -100, type: 'supergroup' } }))
  assert.equal(g.address.kind, 'group')
  assert.equal(adapter.normalize(privateMsg({ chat: { id: -1, type: 'channel' } })), undefined)
  assert.equal(adapter.normalize(undefined), undefined)
  adapter.disconnect()
})

test('normalize：话题群 threadId 进地址', async () => {
  const adapter = newAdapter(connectFetch())
  await withConnected(adapter)
  const m = adapter.normalize(
    privateMsg({ chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 7 }),
  )
  assert.equal(m.address.threadId, '7')
  adapter.disconnect()
})

test('normalize：引用文本截断 200；caption 兜底', async () => {
  const adapter = newAdapter(connectFetch())
  await withConnected(adapter)
  const long = 'x'.repeat(300)
  assert.equal(adapter.normalize(privateMsg({ reply_to_message: { text: long } })).quoteText.length, 200)
  assert.equal(adapter.normalize(privateMsg({ text: undefined, caption: '图说' })).text, '图说')
  adapter.disconnect()
})

test('长轮询投递：首帧 update 触达监听器且 offset 前移', async () => {
  const received = []
  const adapter = newAdapter(
    connectFetch([{ update_id: 5, message: privateMsg({ text: 'ping' }) }]),
  )
  adapter.onMessage((m) => received.push(m))
  await withConnected(adapter)
  await waitUntil(() => received.length > 0)
  adapter.disconnect()
  assert.equal(received[0].text, 'ping')
  assert.equal(received[0].address.kind, 'dm')
})

// —— 出站与回退链 ——————————————————————————————————————————

test('reply：Markdown 首发；回执带平台消息 id', async () => {
  const fetchImpl = connectFetch([], (method) =>
    method === 'sendMessage' ? success({ message_id: 9 }) : success({}),
  )
  const adapter = new TelegramAdapter({ token: 'TOK', fetchImpl, apiBase: 'https://api.test' })
  const receipt = await adapter.reply({ channel: 'telegram', kind: 'dm', chatId: '111' }, '**hi**')
  assert.equal(receipt.platformMessageId, '9')
  assert.equal(receipt.uncertain, false)
  assert.equal(fetchImpl.calls.at(-1).body.parse_mode, 'Markdown')
})

test('reply：格式被 400 拒 → 纯文本重发（富文本回退链）', async () => {
  let sends = 0
  const fetchImpl = connectFetch([], (method, body) => {
    if (method !== 'sendMessage') return success({})
    sends += 1
    return sends === 1 && body.parse_mode !== undefined
      ? apiErr("can't parse entities from entity")
      : success({ message_id: 10 })
  })
  const adapter = new TelegramAdapter({ token: 'TOK', fetchImpl, apiBase: 'https://api.test' })
  const receipt = await adapter.reply({ channel: 'telegram', kind: 'dm', chatId: '111' }, '**bad markdown**')
  assert.equal(sends, 2)
  assert.equal(receipt.platformMessageId, '10')
  assert.equal(fetchImpl.calls.at(-1).body.parse_mode, undefined)
})

test('reply：网络异常 = uncertain（结果不明禁重发）', async () => {
  const fetchImpl = connectFetch([], () => {
    throw new TypeError('socket hang up')
  })
  const adapter = new TelegramAdapter({ token: 'TOK', fetchImpl, apiBase: 'https://api.test' })
  await assert.rejects(
    adapter.reply({ channel: 'telegram', kind: 'dm', chatId: '111' }, 'x'),
    (error) => error.constructor.name.includes('Uncertain'),
  )
})

test('reply：5xx = uncertain；4xx 确定性失败直接抛', async () => {
  const net = connectFetch([], () => resp(502, { ok: false }))
  const adapter5 = new TelegramAdapter({ token: 'TOK', fetchImpl: net, apiBase: 'https://api.test' })
  await assert.rejects(
    adapter5.reply({ channel: 'telegram', kind: 'dm', chatId: '1' }, 'x'),
    (error) => error.constructor.name.includes('Uncertain'),
  )
  const blocked = connectFetch([], () => apiErr('bot was blocked by the user', 403))
  const adapter4 = new TelegramAdapter({ token: 'TOK', fetchImpl: blocked, apiBase: 'https://api.test' })
  await assert.rejects(
    adapter4.reply({ channel: 'telegram', kind: 'dm', chatId: '1' }, 'x'),
    (error) => !error.constructor.name.includes('Uncertain') && /blocked/.test(error.message),
  )
})

test('reply：超 4096 截断加省略号', async () => {
  const fetchImpl = connectFetch([], () => success({ message_id: 1 }))
  const adapter = new TelegramAdapter({ token: 'TOK', fetchImpl, apiBase: 'https://api.test' })
  await adapter.reply({ channel: 'telegram', kind: 'dm', chatId: '1' }, 'y'.repeat(5000))
  const sent = fetchImpl.calls.at(-1).body.text
  assert.equal(sent.length, 4096)
  assert.ok(sent.endsWith('…'))
})

// —— 编辑流式 ——————————————————————————————————————————

test('beginStream：首更占位发送，后续 editMessageText，finish 带回执', async () => {
  const fetchImpl = connectFetch([], (method, body) => {
    if (method === 'sendMessage') return success({ message_id: 20 })
    if (method === 'editMessageText') return success({ message_id: 20, text: body.text })
    return success({})
  })
  const adapter = new TelegramAdapter({ token: 'TOK', fetchImpl, apiBase: 'https://api.test' })
  const stream = await adapter.beginStream({ channel: 'telegram', kind: 'dm', chatId: '111' })
  await stream.update('第一段')
  await stream.update('第二段更长')
  const receipt = await stream.finish('最终答复')
  const sends = fetchImpl.calls.filter((c) => c.method === 'sendMessage')
  const edits = fetchImpl.calls.filter((c) => c.method === 'editMessageText')
  assert.equal(sends.length, 1, '只有第一次是发送占位')
  assert.equal(edits.length, 2)
  assert.equal(edits.at(-1).body.message_id, 20)
  assert.equal(receipt.platformMessageId, '20')
})

test('beginStream：not modified 幂等吞掉；消息被删则补发接替', async () => {
  let editMode = 'notmodified'
  const fetchImpl = connectFetch([], (method, body) => {
    if (method === 'sendMessage') return success({ message_id: body.text === 'S2' ? 21 : 20 })
    if (method === 'editMessageText') {
      return editMode === 'notmodified'
        ? apiErr('message is not modified')
        : apiErr('message to edit not found')
    }
    return success({})
  })
  const adapter = new TelegramAdapter({ token: 'TOK', fetchImpl, apiBase: 'https://api.test' })
  const stream = await adapter.beginStream({ channel: 'telegram', kind: 'dm', chatId: '111' })
  await stream.update('S')
  await stream.update('S') // not modified → 不抛不补发
  assert.equal(fetchImpl.calls.filter((c) => c.method === 'sendMessage').length, 1)
  editMode = 'deleted'
  await stream.update('S2') // 编辑被拒 → 补发新消息
  const sends = fetchImpl.calls.filter((c) => c.method === 'sendMessage')
  assert.equal(sends.length, 2)
  assert.equal(sends.at(-1).body.text, 'S2')
})

test('beginStream：abort 后不再产生新请求', async () => {
  const fetchImpl = connectFetch([], (method) => (method === 'sendMessage' ? success({ message_id: 30 }) : success({})))
  const adapter = new TelegramAdapter({ token: 'TOK', fetchImpl, apiBase: 'https://api.test' })
  const stream = await adapter.beginStream({ channel: 'telegram', kind: 'dm', chatId: '111' })
  await stream.update('a')
  stream.abort()
  const before = fetchImpl.calls.length
  await stream.update('b')
  assert.equal(fetchImpl.calls.length, before)
})

// —— 能力位 / 准入 / 诊断 ——————————————————————————————————————————

test('caps 与 authorize：编辑流式开启，准入恒交网关', () => {
  const adapter = new TelegramAdapter({ token: 'TOK', fetchImpl: connectFetch(), apiBase: 'https://api.test' })
  assert.equal(adapter.caps.editStream, true)
  assert.equal(adapter.caps.nativeStream, false)
  assert.equal(adapter.caps.maxMessageLength, 4096)
  assert.equal(adapter.caps.voice, false)
  assert.equal(adapter.authorize(), undefined)
})

test('diagnose 三态：有效 passed / 4xx failed / 网络 unverified', async () => {
  const ok = new TelegramAdapter({ token: 'TOK', fetchImpl: connectFetch(), apiBase: 'https://api.test' })
  const checks = await ok.diagnose()
  assert.equal(checks[0].status, 'passed')
  assert.equal(checks[0].hint, 'demo_bot', '诊断回包只出用户名不泄 token')
  assert.equal(checks[1].status, 'unverified', '未连接时长轮询位不谎报')

  const bad = new TelegramAdapter({
    token: 'TOK',
    fetchImpl: fakeFetch((method) => (method === 'getMe' ? apiErr('Unauthorized', 401) : success({}))),
    apiBase: 'https://api.test',
  })
  assert.equal((await bad.diagnose())[0].status, 'failed')

  const net = new TelegramAdapter({
    token: 'TOK',
    fetchImpl: fakeFetch(() => {
      throw new TypeError('down')
    }),
    apiBase: 'https://api.test',
  })
  assert.equal((await net.diagnose())[0].status, 'unverified')
})

// —— 工厂与凭据 ——————————————————————————————————————————

test('createTelegramAdapter：token 缺失即抛；apiBaseUrl 覆写生效', async () => {
  assert.throws(
    () => createTelegramAdapter({ accountId: 'a1', config: {}, secrets: {} }),
    /botToken 未入库/,
  )
  const fetchImpl = connectFetch([], () => success({ message_id: 1 }))
  const prevFetch = globalThis.fetch
  globalThis.fetch = fetchImpl // 工厂不注入 fetch，走生产路径（全局 fetch 桩）
  try {
    const adapter = createTelegramAdapter({
      accountId: 'a1',
      config: { apiBaseUrl: 'https://mirror.example' },
      secrets: { botToken: 'X' },
    })
    await adapter.reply({ channel: 'telegram', kind: 'dm', chatId: '1' }, 'x')
    assert.ok(fetchImpl.calls.at(-1).url.startsWith('https://mirror.example/botX/sendMessage'))
  } finally {
    globalThis.fetch = prevFetch
  }
})

// —— 文件输入/输出面（T2.4 渠道侧）——————————————————————————————————————

test('声明一致性：fileIn/fileOut=true 且 sendFile 为函数', () => {
  const adapter = newAdapter(connectFetch())
  assert.equal(adapter.caps.fileIn, true)
  assert.equal(adapter.caps.fileOut, true)
  assert.equal(typeof adapter.sendFile, 'function')
})

test('sendFile：sendDocument multipart 形（url/method/content-type/字段名）+ 回执', async () => {
  const fetchImpl = fakeFetch((method) => (method === 'sendDocument' ? success({ message_id: 55 }) : success({})))
  const adapter = newAdapter(fetchImpl)
  const receipt = await adapter.sendFile(
    { channel: 'telegram', kind: 'dm', chatId: '111' },
    { name: 'report.txt', data: Uint8Array.from([1, 2, 3]), mimeType: 'text/plain' },
  )
  assert.equal(receipt.platformMessageId, '55')
  assert.equal(receipt.uncertain, false)
  const call = fetchImpl.calls.at(-1)
  assert.equal(call.url, 'https://api.test/botTOK/sendDocument')
  assert.equal(call.method, 'sendDocument')
  assert.equal(call.init.method, 'POST')
  const headers = call.init.headers
  assert.ok(headers['content-type'].startsWith('multipart/form-data; boundary='), '内容型声明 boundary')
  const raw = Buffer.from(call.init.body).toString('latin1')
  assert.ok(raw.includes('name="chat_id"'), '同页表单必须带 chat_id')
  assert.ok(raw.includes('111'), 'chat_id 值入页')
  assert.ok(raw.includes('name="document"'), '文件字段名固定 document')
  assert.ok(raw.includes('filename="report.txt"'), '文件名透传')
  assert.ok(raw.includes('Content-Type: text/plain'), 'mime 优先使用调用方声明')
})

test('sendFile：4xx = 确定性失败抛（非 uncertain，不重发）', async () => {
  const fetchImpl = fakeFetch((method) =>
    method === 'sendDocument' ? apiErr('file too big', 400) : success({}),
  )
  const adapter = newAdapter(fetchImpl)
  await assert.rejects(
    adapter.sendFile({ channel: 'telegram', kind: 'dm', chatId: '1' }, { name: 'a.bin', data: Uint8Array.from([0]) }),
    (error) => !error.constructor.name.includes('Uncertain') && /too big/.test(error.message),
  )
})

test('sendFile：网络错/5xx/回包不可解析 = uncertain', async () => {
  const net = newAdapter(fakeFetch(() => {
    throw new TypeError('socket hang up')
  }))
  await assert.rejects(
    net.sendFile({ channel: 'telegram', kind: 'dm', chatId: '1' }, { name: 'a', data: Uint8Array.from([0]) }),
    (error) => error.constructor.name.includes('Uncertain'),
  )
  const srv = newAdapter(fakeFetch(() => resp(502, {})))
  await assert.rejects(
    srv.sendFile({ channel: 'telegram', kind: 'dm', chatId: '1' }, { name: 'a', data: Uint8Array.from([0]) }),
    (error) => error.constructor.name.includes('Uncertain'),
  )
  const broken = newAdapter(
    fakeFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('unterminated json')
      },
    })),
  )
  await assert.rejects(
    broken.sendFile({ channel: 'telegram', kind: 'dm', chatId: '1' }, { name: 'a', data: Uint8Array.from([0]) }),
    (error) => error.constructor.name.includes('Uncertain'),
  )
})

test('入站 document：getFile → 下载面填 files（名称取 file_name）', async () => {
  const received = []
  const adapter = newAdapter(
    connectFetch(
      [
        {
          update_id: 3,
          message: privateMsg({
            text: undefined,
            caption: '看下报告',
            document: { file_id: 'DOC1', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 3 },
          }),
        },
      ],
      (method) => {
        if (method === 'getFile') return success({ file_id: 'DOC1', file_path: 'documents/report.pdf' })
        if (method === 'report.pdf') return binResp([7, 7, 7])
        return success({})
      },
    ),
  )
  adapter.onMessage((m) => received.push(m))
  await withConnected(adapter)
  await waitUntil(() => received.length > 0)
  adapter.disconnect()
  const m = received[0]
  assert.equal(m.text, '看下报告')
  assert.equal(m.files.length, 1)
  assert.equal(m.files[0].name, 'report.pdf')
  assert.deepEqual(Array.from(m.files[0].data), [7, 7, 7])
})

test('入站 document：无 file_name 时合成名；下载失败不丢整条消息', async () => {
  const received = []
  const adapter = newAdapter(
    connectFetch(
      [{ update_id: 4, message: privateMsg({ text: undefined, caption: undefined, document: { file_id: 'DOCX' } }) }],
      (method) => {
        if (method === 'getFile') return apiErr('file id is invalid', 400)
        return success({})
      },
    ),
  )
  adapter.onMessage((m) => received.push(m))
  await withConnected(adapter)
  await waitUntil(() => received.length > 0)
  adapter.disconnect()
  assert.equal(received[0].text, '')
  assert.equal(received[0].files, undefined, '下载失败降级为无附件，消息照常投递')
})

test('diagnose：文件面未实证 = unverified（不谎报）', async () => {
  const adapter = newAdapter(connectFetch())
  const checks = await adapter.diagnose()
  const file = checks.find((c) => c.name === 'file-surface')
  assert.equal(file.status, 'unverified')
})
