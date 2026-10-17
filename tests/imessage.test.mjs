// T3.3 iMessage 渠道单测：macOS 平台闸（装载侧硬拒）/ chat.db 只读轮询游标 /
// handle join 归一 / Apple epoch(2001)→ms 换算 / AppleScript argv 传参（注入防护红线）/
// Receipt 三分（0=成功、非 0=确定性、spawn error/超时=uncertain）/ 诊断三态 / 工厂默认路径。
// 真机面全注入：fake sqlite（DatabaseSyncImpl）+ fake execFileImpl + fileExistsImpl/homedirImpl，
// 零 macOS、零网络、零子进程。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ImessageAdapter,
  ImessageApiError,
  ImessageDbError,
  ImessageUncertainError,
  ImessageUnsupportedError,
  createImessageAdapter,
  buildSendInvocation,
  appleNanoToMs,
  normalizeHandle,
  decodeTextCell,
  toReadOnlyUri,
  SEND_SCRIPT_LINES,
  SQL_NEW_MESSAGES,
  SQL_MAX_ROWID,
  IMESSAGE_MAX_MESSAGE,
  APPLE_EPOCH_OFFSET_MS,
} from '../lib/channels/imessage.js'

const DB_PATH = '/Users/tester/Library/Messages/chat.db'
const HOME = '/Users/tester'

const num = (value) => (typeof value === 'bigint' ? Number(value) : value)
/** Unix ms → message.date（Apple epoch 纳秒：自 2001-01-01 起计，故需减去 978307200000 偏移）。 */
const appleNs = (ms) => BigInt(ms - APPLE_EPOCH_OFFSET_MS) * 1_000_000n
const APPLE_2023_NS = appleNs(1_700_000_000_000) // 721692800000000000n

/** 最小 fake sqlite：只实现 message/handle join 轮询所需 prepare().all()/.get()。 */
function fakeSqlite(rows) {
  const opened = []
  class FakeDatabaseSync {
    constructor(path, options) {
      this.path = path
      this.options = options
      this.closed = false
      this.calls = []
      opened.push(this)
    }
    prepare(sql) {
      const db = this
      return {
        all: (...params) => {
          db.calls.push({ sql, params })
          if (sql.includes('ROWID > ?')) {
            const cursor = num(params[0])
            const limit = num(params[1])
            return rows
              .filter((r) => num(r.rowid) > cursor)
              .sort((a, b) => num(a.rowid) - num(b.rowid))
              .slice(0, Number.isFinite(limit) ? limit : rows.length)
          }
          return []
        },
        get: (...params) => {
          db.calls.push({ sql, params })
          if (sql.includes('MAX(ROWID)')) {
            return { max_rowid: rows.reduce((m, r) => Math.max(m, num(r.rowid)), 0) }
          }
          return { ok: 1 }
        },
      }
    }
    close() {
      this.closed = true
    }
  }
  return { Ctor: FakeDatabaseSync, opened }
}

const row = (rowid, text = '在吗', over = {}) => ({
  rowid,
  text,
  is_from_me: 0,
  date: APPLE_2023_NS,
  handle: '+15551234567',
  ...over,
})

/** 全注入 harness：exists=文件在否；exec=osascript fake（可返回码或抛）。 */
function harness({ rows = [], exists = true, exec = undefined, adapterOptions = {} } = {}) {
  const fake = fakeSqlite(rows)
  const osa = []
  const execFileImpl = async (file, args, options) => {
    osa.push({ file, args, options })
    if (exec !== undefined) return await exec(file, args, options)
    return { code: 0, stdout: 'ok', stderr: '' }
  }
  const adapter = new ImessageAdapter({
    chatDbPath: DB_PATH,
    platform: 'darwin',
    DatabaseSyncImpl: fake.Ctor,
    fileExistsImpl: typeof exists === 'function' ? exists : () => exists,
    execFileImpl,
    pollIntervalMs: 0, // 关后台循环，轮询由 pollOnce 手动驱动（确定性）
    ...adapterOptions,
  })
  return { adapter, fake, osa, rows }
}

/** 连接并收集入站消息。 */
async function listen(adapter) {
  const got = []
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  return got
}

// —— 平台闸（装载侧硬拒） ————————————————————————————————

test('平台闸：darwin 构造通过，win32/linux 构造即抛 ImessageUnsupportedError', () => {
  const fake = fakeSqlite([])
  const ok = new ImessageAdapter({ platform: 'darwin', chatDbPath: DB_PATH, DatabaseSyncImpl: fake.Ctor, pollIntervalMs: 0 })
  assert.equal(ok.id, 'imessage')
  assert.equal(ok.label, 'iMessage')
  assert.throws(
    () => new ImessageAdapter({ platform: 'win32', chatDbPath: DB_PATH }),
    (error) => error instanceof ImessageUnsupportedError && error.message === 'iMessage 渠道仅支持 macOS 宿主',
  )
  assert.throws(() => new ImessageAdapter({ platform: 'linux' }), ImessageUnsupportedError)
})

test('平台闸：工厂在非 darwin 同样抛（buildAdapter catch 记 warn = 明确拒载该渠道）', () => {
  assert.throws(
    () => createImessageAdapter({ accountId: 'mac1', config: {}, secrets: {} }, { platform: 'win32' }),
    ImessageUnsupportedError,
  )
  const adapter = createImessageAdapter(
    { accountId: 'mac1', config: {}, secrets: {} },
    { platform: 'darwin', homedirImpl: () => HOME, DatabaseSyncImpl: fakeSqlite([]).Ctor },
  )
  assert.ok(adapter instanceof ImessageAdapter)
})

test('caps：仅文本私聊——流式/按钮/附件/话题/typing/语音全 false，长度保守 4000', () => {
  const { adapter } = harness()
  assert.deepEqual(adapter.caps, {
    editStream: false,
    nativeStream: false,
    nativeChoices: false,
    statusReaction: false,
    statusProgress: false,
    typing: false,
    imageIn: false,
    fileIn: false,
    fileOut: false,
    threads: false,
    voice: false,
    maxMessageLength: IMESSAGE_MAX_MESSAGE,
  })
  assert.equal(IMESSAGE_MAX_MESSAGE, 4000)
  // 能力缺位即不实现可选面（引擎自动退化 reply / 数字菜单）
  assert.equal(adapter.beginStream, undefined)
  assert.equal(adapter.sendFile, undefined)
  assert.equal(adapter.setTyping, undefined)
  assert.equal(adapter.askChoices, undefined)
})

// 文件面声明一致性回归（M2 T2.4）：imessage 渠道只读 chat.db + osascript 发纯文
// 本私聊（Apple 无公开的“给指定 handle 发附件”命令行/REST 面；附件需 Messages.app
// 自身体内 AppleScript UI 脚本，属未实证面）→ 做不到即不声明：
// caps.fileOut/fileIn 恒 false，且 sendFile 不存在（引擎不会误派文件出站）。
test('文件面未实装：caps.fileOut===false 且 typeof sendFile!==function（声明=实装 E1）', () => {
  const { adapter } = harness()
  assert.equal(adapter.caps.fileOut, false)
  assert.equal(adapter.caps.fileIn, false)
  assert.equal(adapter.caps.imageIn, false)
  assert.notEqual(typeof adapter.sendFile, 'function')
  assert.equal(adapter.sendFile, undefined)
})

// —— 收：chat.db 只读轮询 ————————————————————————————————

test('chat.db 缺失：connect 落明确失败态（未找到 chat.db + 完全磁盘访问指引），不静默空轮询', async () => {
  const { adapter, fake } = harness({ exists: false })
  await assert.rejects(adapter.connect(), (error) => {
    assert.ok(error instanceof ImessageDbError)
    assert.match(error.message, /未找到 chat\.db/)
    assert.match(error.message, /完全磁盘访问/)
    return true
  })
  assert.equal(adapter.connected, false)
  assert.equal(fake.opened.length, 0, '文件缺失时不应尝试开库')
  await assert.rejects(adapter.pollOnce(), ImessageDbError)
})

test('开库形态：走注入 Ctor，路径为只读 URI（file:…?mode=ro）且 readOnly=true', async () => {
  const { adapter, fake } = harness({ rows: [row(1)] })
  await adapter.connect()
  assert.equal(fake.opened.length, 1)
  const db = fake.opened[0]
  assert.equal(db.path, toReadOnlyUri(DB_PATH))
  assert.equal(db.path, 'file:/Users/tester/Library/Messages/chat.db?mode=ro')
  assert.equal(db.options.readOnly, true)
  assert.equal(typeof db.options.timeout, 'number')
  await adapter.disconnect()
})

test('轮询游标：首轮立基线不回放历史；新增行只发一次', async () => {
  const rows = [row(1, '旧1'), row(2, '旧2'), row(3, '旧3')]
  const { adapter, fake } = harness({ rows })
  const got = await listen(adapter)
  assert.equal(got.length, 0, '默认 skipHistory：连接前的历史行不回放')
  assert.equal(fake.opened[0].calls[0].sql, SQL_MAX_ROWID)

  rows.push(row(4, '新消息'), row(5, '更新的消息'))
  assert.equal(await adapter.pollOnce(), 2)
  assert.equal(await adapter.pollOnce(), 0, '游标已推进，同一行不重复发')
  assert.deepEqual(got.map((m) => m.text), ['新消息', '更新的消息'])
  const pollCall = fake.opened[0].calls.find((c) => c.sql === SQL_NEW_MESSAGES)
  assert.equal(num(pollCall.params[0]), 3, '首轮基线 = MAX(ROWID)')
  assert.equal(typeof num(pollCall.params[1]), 'number', '批量上限走绑定参数')
  await adapter.disconnect()
})

test('skipHistory=false 时从 0 起读，回声行不发但游标照样推进', async () => {
  const rows = [row(7, '我发出去的', { is_from_me: 1 }), row(8, '对方发来的')]
  const { adapter } = harness({ rows, adapterOptions: { skipHistory: false } })
  const got = await listen(adapter)
  assert.deepEqual(got.map((m) => m.text), ['对方发来的'], 'is_from_me=1 回声丢弃')
  assert.equal(await adapter.pollOnce(), 0, '游标含被跳过的回声行，不重复扫')
  await adapter.disconnect()
})

test('游标谓词与 handle join 用绑定参数，SQL 本体零插值（两个 ? = cursor + limit）', () => {
  assert.equal((SQL_NEW_MESSAGES.match(/\?/g) ?? []).length, 2)
  assert.match(SQL_NEW_MESSAGES, /LEFT JOIN handle h ON h\.HANDLE_ID = m\.handle_id/)
  assert.match(SQL_NEW_MESSAGES, /WHERE m\.ROWID > \? ORDER BY m\.ROWID ASC/)
  assert.match(SQL_NEW_MESSAGES, /m\.is_from_me/, '回声判定依赖 is_from_me 列')
})

test('normalizeRow：回声/无 handle/空正文（附件类）行不产出消息', () => {
  const { adapter } = harness()
  assert.equal(adapter.normalizeRow(row(1, 'x', { is_from_me: 1 })), undefined, 'is_from_me=1 回声')
  assert.equal(adapter.normalizeRow(row(1, 'x', { is_from_me: 1n })), undefined, 'sqlite 大整数形态同样判回声')
  assert.equal(adapter.normalizeRow(row(1, 'x', { handle: null })), undefined, 'join 不上 handle 不定址')
  assert.equal(adapter.normalizeRow(row(1, null)), undefined, '附件消息 text=NULL 不伪造空消息')
  assert.equal(adapter.normalizeRow(row(1, '   ')), undefined, '纯空白正文丢弃')
})

test('normalizeRow：私聊恒 dm + handle 定址 + Apple epoch→ms（bigint 与 number 同值）', () => {
  const { adapter } = harness()
  const m = adapter.normalizeRow(row(9, '你好呀', { handle: ' Alice@Example.COM ' }))
  assert.deepEqual(m.address, { channel: 'imessage', kind: 'dm', chatId: 'alice@example.com' })
  assert.equal(m.userId, 'alice@example.com')
  assert.equal(m.text, '你好呀')
  assert.equal(m.mentionedBot, false)
  assert.equal(m.timestamp, 1_700_000_000_000)
  assert.equal(m.images, undefined)
  assert.equal(m.files, undefined)
  const fromNumber = adapter.normalizeRow(row(10, '你好', { date: 721692800000000000 }))
  assert.equal(fromNumber.timestamp, 1_700_000_000_000)
})

test('appleNanoToMs：978307200000 偏移换算；0/负值/NULL 视为无效', () => {
  assert.equal(APPLE_EPOCH_OFFSET_MS, 978_307_200_000)
  assert.equal(appleNanoToMs(721692800000000000n), 1_700_000_000_000)
  assert.equal(appleNanoToMs(721692800000000000), 1_700_000_000_000)
  assert.equal(appleNanoToMs('721692800000000000'), 1_700_000_000_000)
  assert.equal(appleNanoToMs(0), undefined)
  assert.equal(appleNanoToMs(null), undefined)
  assert.equal(appleNanoToMs(undefined), undefined)
})

test('normalizeHandle：邮箱小写保留域名点，电话去空格/连字符/括号；text BLOB 走 UTF-16LE 兜底', () => {
  assert.equal(normalizeHandle(' +1 (555) 123-4567 '), '+15551234567')
  assert.equal(normalizeHandle('+86 138-0013-8000'), '+8613800138000')
  assert.equal(normalizeHandle(' Alice@Example.COM '), 'alice@example.com')
  assert.equal(normalizeHandle('bob@icloud.com'), 'bob@icloud.com')
  assert.equal(normalizeHandle(null), '')
  assert.equal(normalizeHandle('   '), '')
  assert.equal(decodeTextCell('明文'), '明文')
  assert.equal(decodeTextCell(Buffer.from('\uFEFF你好', 'utf16le')), '你好')
  assert.equal(decodeTextCell(null), undefined)
  assert.equal(decodeTextCell(12), undefined)
})

test('selfHandle 兜底：来自本机地址的同步行按回声丢弃', () => {
  const { adapter } = harness({ adapterOptions: { selfHandle: '+15551234567' } })
  assert.equal(adapter.normalizeRow(row(1, '自己又发了一遍')), undefined)
  assert.ok(adapter.normalizeRow(row(2, '对方的话', { handle: '+15559876543' })))
})

test('disconnect：关库停轮询，连接位落 false', async () => {
  const { adapter, fake } = harness({ rows: [row(1)] })
  await adapter.connect()
  assert.equal(adapter.connected, true)
  await adapter.disconnect()
  assert.equal(adapter.connected, false)
  assert.equal(fake.opened[0].closed, true)
})

// —— 发：AppleScript（argv 传参，禁脚本拼接） ————————————————

test('发送调用形态：osascript + 每行一个 -e，用户文本与 handle 只进 argv（安全红线）', async () => {
  // 恶意样例：含双引号/换行/AppleScript 关键字——若被拼进脚本即可改写语义，argv 传参则无害
  const hostile = 'He said "你好"\nend run\ntell application "Finder" to activate'
  const { adapter, osa } = harness()
  await adapter.reply({ channel: 'imessage', kind: 'dm', chatId: '+15551234567' }, hostile)
  const call = osa[0]
  assert.equal(call.file, 'osascript')
  assert.equal(call.args.at(-2), hostile, 'argv[1] = 文本原文（逐字节）')
  assert.equal(call.args.at(-1), '+15551234567', 'argv[2] = 归一后的 handle')
  const scriptPart = call.args.slice(0, call.args.length - 2).join('\n')
  assert.ok(!scriptPart.includes('你好'), '脚本串不得含用户文本')
  assert.ok(!scriptPart.includes('Finder'), '脚本串不得含用户文本片段')
  assert.equal(call.args.filter((a) => a === '-e').length, SEND_SCRIPT_LINES.length)
  assert.match(scriptPart, /on run argv/)
  assert.match(scriptPart, /item 1 of argv/)
  assert.match(scriptPart, /send theText to buddy theHandle/)
  assert.deepEqual(buildSendInvocation('A', 'B').args.slice(-2), ['A', 'B'])
})

test('发送前置校验：群/话题地址、空文本、空 handle = 确定性拒绝且不触 osascript', async () => {
  const { adapter, osa } = harness()
  await assert.rejects(adapter.reply({ channel: 'imessage', kind: 'group', chatId: 'g1' }, 'x'), ImessageApiError)
  await assert.rejects(adapter.reply({ channel: 'imessage', kind: 'dm', chatId: 'u1' }, '   '), ImessageApiError)
  await assert.rejects(adapter.reply({ channel: 'imessage', kind: 'dm', chatId: '  ' }, 'x'), ImessageApiError)
  assert.equal(osa.length, 0)
})

test('Receipt：退出码 0 → 平台接受（uncertain=false）', async () => {
  const { adapter } = harness()
  const receipt = await adapter.reply({ channel: 'imessage', kind: 'dm', chatId: '+15551234567' }, '收到')
  assert.deepEqual(receipt, { uncertain: false })
})

test('Receipt：非零退出码（stderr 含 Messages 错误）→ ImessageApiError 确定性失败', async () => {
  const { adapter } = harness({
    exec: async () => ({ code: 1, stdout: '', stderr: '38:64: execution error: “Messages”遇到错误：不能获得对象。 (-1728)' }),
  })
  await assert.rejects(
    adapter.reply({ channel: 'imessage', kind: 'dm', chatId: '+15551234567' }, 'x'),
    (error) =>
      error instanceof ImessageApiError &&
      !(error instanceof ImessageUncertainError) &&
      error.code === 1 &&
      /-1728/.test(error.message),
  )
})

test('Receipt：结果无退出码（被信号终止）→ uncertain，禁自动重发', async () => {
  const { adapter } = harness({ exec: async () => ({ code: null, stdout: '', stderr: '' }) })
  await assert.rejects(
    adapter.reply({ channel: 'imessage', kind: 'dm', chatId: '+15551234567' }, 'x'),
    (error) => error instanceof ImessageUncertainError && /禁自动重发/.test(error.message),
  )
})

test('Receipt：spawn 失败（ENOENT）/ 超时被杀 / 非零退出抛错 → 各归其位', async () => {
  const enoent = harness({ exec: async () => { throw Object.assign(new Error('spawn osascript failed'), { code: 'ENOENT' }) } })
  await assert.rejects(enoent.adapter.reply({ channel: 'imessage', kind: 'dm', chatId: '+15551234567' }, 'x'), ImessageUncertainError)

  const killed = harness({ exec: async () => { throw Object.assign(new Error('killed'), { killed: true, code: null }) } })
  await assert.rejects(
    killed.adapter.reply({ channel: 'imessage', kind: 'dm', chatId: '+15551234567' }, 'x'),
    (error) => error instanceof ImessageUncertainError && /超时/.test(error.message),
  )

  // node:child_process 语义：非零退出走 error 分支且 code 为数字 → 确定性
  const exitErr = harness({ exec: async () => { throw Object.assign(new Error('Not authorized to send Apple events'), { code: 1 }) } })
  await assert.rejects(exitErr.adapter.reply({ channel: 'imessage', kind: 'dm', chatId: '+15551234567' }, 'x'), ImessageApiError)

  const transport = harness({ exec: async () => { throw new Error('boom') } })
  await assert.rejects(transport.adapter.reply({ channel: 'imessage', kind: 'dm', chatId: '+15551234567' }, 'x'), ImessageUncertainError)
})

test('发送透传 AbortSignal：外部取消按不确定处理（不伪装确定性失败）', async () => {
  const controller = new AbortController()
  controller.abort()
  const { adapter, osa } = harness({
    exec: async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    },
  })
  await assert.rejects(
    adapter.reply({ channel: 'imessage', kind: 'dm', chatId: '+15551234567' }, 'x', controller.signal),
    ImessageUncertainError,
  )
  assert.equal(osa[0].options.signal, controller.signal)
  assert.equal(typeof osa[0].options.timeoutMs, 'number')
})

// —— 诊断三态 ——————————————————————————————————————————

test('diagnose：chat.db 可读 + osascript 可用 → passed/passed/unverified', async () => {
  const { adapter } = harness({ rows: [row(1)] })
  const checks = await adapter.diagnose()
  assert.deepEqual(checks.map((c) => [c.name, c.status]), [
    ['chat-db', 'passed'],
    ['osascript', 'passed'],
    ['roundtrip', 'unverified'],
  ])
  assert.ok(typeof checks[0].elapsedMs === 'number')
})

test('diagnose：chat.db 缺失 + osascript 不可用 → failed/unverified/unverified（不判死）', async () => {
  const { adapter } = harness({
    exists: false,
    exec: async () => {
      throw Object.assign(new Error('spawn osascript failed'), { code: 'ENOENT' })
    },
  })
  const checks = await adapter.diagnose()
  assert.deepEqual(checks.map((c) => [c.name, c.status]), [
    ['chat-db', 'failed'],
    ['osascript', 'unverified'],
    ['roundtrip', 'unverified'],
  ])
  assert.match(checks[0].hint, /未找到 chat\.db/)
  assert.match(checks[0].hint, /完全磁盘访问/)
  assert.match(checks[2].hint, /真机/)
})

test('diagnose：osascript 非零退出（未授权「自动化」）→ unverified 而非 failed', async () => {
  const { adapter } = harness({
    exec: async () => ({ code: 1, stdout: '', stderr: 'Not authorized to send Apple events to Messages.' }),
  })
  const checks = await adapter.diagnose()
  const osa = checks.find((c) => c.name === 'osascript')
  assert.equal(osa.status, 'unverified')
  assert.match(osa.hint, /自动化/)
})

test('diagnose：开库抛错（权限缺失/库被锁）→ chat-db failed 带原因', async () => {
  const base = fakeSqlite([])
  class Boom extends base.Ctor {
    constructor(path, options) {
      super(path, options)
      throw new Error('SqliteError: unable to open database file')
    }
  }
  const adapter = new ImessageAdapter({
    platform: 'darwin',
    chatDbPath: DB_PATH,
    DatabaseSyncImpl: Boom,
    fileExistsImpl: () => true,
    execFileImpl: async () => ({ code: 0, stdout: '', stderr: '' }),
    pollIntervalMs: 0,
  })
  const checks = await adapter.diagnose()
  assert.equal(checks[0].name, 'chat-db')
  assert.equal(checks[0].status, 'failed')
  assert.match(checks[0].hint, /unable to open database file/)
  await assert.rejects(adapter.connect(), ImessageDbError)
})

// —— 工厂与默认路径 ————————————————————————————————————

test('工厂：默认路径 = ~/Library/Messages/chat.db，config 覆盖 chatDbPath/selfHandle/pollIntervalMs', () => {
  const injection = { platform: 'darwin', homedirImpl: () => HOME, DatabaseSyncImpl: fakeSqlite([]).Ctor, fileExistsImpl: () => true }
  const dflt = createImessageAdapter({ accountId: 'mac1', config: {}, secrets: {} }, injection)
  assert.equal(dflt.chatDbPath.replace(/\\/g, '/'), `${HOME}/Library/Messages/chat.db`)
  assert.equal(dflt.selfHandle, '')
  assert.equal(dflt.accountId, 'mac1')
  assert.equal(dflt.id, 'imessage')

  const overridden = createImessageAdapter(
    { accountId: 'mac2', config: { chatDbPath: '/tmp/copied.db', selfHandle: ' me@icloud.com ', pollIntervalMs: '0' }, secrets: {} },
    injection,
  )
  assert.equal(overridden.chatDbPath, '/tmp/copied.db')
  assert.equal(overridden.selfHandle, 'me@icloud.com')
})

test('工厂：只读 URI 转写（Windows 分隔符归一，POSIX 原样）', () => {
  assert.equal(toReadOnlyUri('/Users/x/chat.db'), 'file:/Users/x/chat.db?mode=ro')
  assert.equal(toReadOnlyUri('C:\\Users\\x\\chat.db'), 'file:/C:/Users/x/chat.db?mode=ro')
})
