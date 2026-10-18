// Matrix olm E2EE 入站解密 A 档单测（Megolm 解密，出站不加密）。
// 覆盖面：device_id 派生稳定性 / canonicalJson 签名序列化 / MatrixE2eeCrypto 单元
// （fake olm 断言调用序列 + 密钥上报 payload 形 + to_device room_key 存取 + 解密链）/
// 真包 @matrix-org/olm@3.2.15 WASM 往返（可加载则实解密）/ 适配器接线三档：
// disabled 零漂移、optional 解密+维持现状占位、required 不拒连+密钥未达占位、
// olm 加载失败退旧兜底（required 拒连 / optional 占位）、诊断如实三态。
// 网络面全 fake（注入 fetchImpl），olm 面注入工厂；零真实请求。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MatrixAdapter,
  MatrixApiError,
  createMatrixAdapter,
  ENCRYPTED_PLACEHOLDER,
  ENCRYPTED_KEY_MISSING_PLACEHOLDER,
} from '../lib/channels/matrix.js'
import {
  MatrixE2eeCrypto,
  deriveDeviceId,
  canonicalJson,
  loadRealOlm,
  MEGOLM_ALGORITHM,
  ONETIME_KEY_FLOOR,
} from '../lib/channels/matrix-e2ee.js'

const BASE = 'https://matrix.example.org'
const TOKEN = 'syt_imu_matrix_fake_token'
const BOT = '@bot:example.org'
const ALICE = '@alice:example.org'
const ROOM = '!room1:example.org'
const SESSION_KEY = 'MEGOLM_SESSION_KEY_1'
/** fake 绑定形态：InboundGroupSession.create 返回 'SID@'+session_key（session_id 一致性面）。 */
const SID = `SID@${SESSION_KEY}`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(fn, ms = 2500) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('waitUntil 超时')
    await sleep(5)
  }
}

function res(status, body, headers = {}) {
  const lowered = {}
  for (const [name, value] of Object.entries(headers)) lowered[name.toLowerCase()] = value
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (name) => lowered[String(name).toLowerCase()] ?? null },
  }
}

let evSeq = 0
function msgEvent(over = {}) {
  const { content, ...rest } = over
  evSeq += 1
  return {
    type: 'm.room.message',
    event_id: `E${evSeq}`,
    sender: ALICE,
    origin_server_ts: 1700000000000,
    content: { msgtype: 'm.text', body: '你好' },
    ...rest,
    ...(content === undefined ? {} : { content: { msgtype: 'm.text', body: '你好', ...content } }),
  }
}
/** Megolm 加密事件（A 档入站形：algorithm/sender_key/session_id/ciphertext）。 */
const encEvent = (over = {}) =>
  msgEvent({
    type: 'm.room.encrypted',
    content: { algorithm: MEGOLM_ALGORITHM, sender_key: 'CURVE_SENDER_A', session_id: SID, ciphertext: 'CT1' },
    ...over,
  })
const roomKeyEvent = (over = {}) => ({
  type: 'm.room_key',
  sender: ALICE,
  content: { algorithm: MEGOLM_ALGORITHM, room_id: ROOM, session_id: SID, session_key: SESSION_KEY },
  ...over,
})
const roomFace = (events) => ({ timeline: { events } })
/** sync 体：rooms 与 to_device 两半独立可给。 */
const syncBody = (rooms, next_batch, extra = {}) => res(200, { next_batch, ...(rooms === undefined ? {} : { rooms }), ...extra })

/**
 * fake olm 工厂：记录调用序列（trace），解密/签名返回可预期常量。
 * options.fail='load' → import 面抛；options.fail='account' → Account.create 抛。
 */
function makeFakeOlm(options = {}) {
  const trace = []
  class Account {
    create() {
      trace.push('account.create')
      if (options.fail === 'account') throw new Error('OLM.UNKNOWN: account 初始化炸')
    }
    identity_keys() {
      trace.push('account.identity_keys')
      return JSON.stringify({ curve25519: 'FAKE_CURVE_PUB', ed25519: 'FAKE_ED_PUB' })
    }
    sign(message) {
      trace.push('account.sign')
      return `SIG(${message.length})`
    }
    one_time_keys() {
      trace.push('account.one_time_keys')
      return JSON.stringify(options.emptyOtkPool === true ? {} : { curve25519: { AAAAAA: 'OTK_A', AAAAAB: 'OTK_B' } })
    }
    generate_one_time_keys(count) {
      trace.push(`account.gen_otk(${count})`)
    }
    mark_keys_as_published() {
      trace.push('account.mark')
    }
    max_number_of_one_time_keys() {
      return 10
    }
    free() {
      trace.push('account.free')
    }
  }
  class InboundGroupSession {
    create(sessionKey) {
      trace.push(`igs.create(${sessionKey})`)
      this.key = sessionKey
      return `SID@${this.key}`
    }
    decrypt(ciphertext) {
      trace.push(`igs.decrypt(${ciphertext})`)
      if (ciphertext === 'BAD') throw new Error('OLM.BAD_MESSAGE')
      return { message_index: 0, plaintext: JSON.stringify({ type: 'm.room.message', content: { msgtype: 'm.text', body: `解开的密文:${ciphertext}` } }) }
    }
    free() {
      trace.push('igs.free')
    }
  }
  const namespace = {
    Account,
    InboundGroupSession,
    init: async () => {
      trace.push('olm.init')
    },
  }
  const factory = async () => {
    trace.push('olmFactory()')
    if (options.fail === 'load') throw new Error('olm WASM 加载失败（fake）')
    return namespace
  }
  return { factory, trace, namespace }
}

/** 路由：whoami/成员/加密探测/send/keys.upload；upload 响应可接管。 */
function makeRoute(over = {}) {
  return (entry) => {
    const p = entry.path
    if (p === '/_matrix/client/v3/account/whoami') return res(200, { user_id: BOT, device_id: 'WHOADEV' })
    if (p === '/_matrix/client/v3/keys/upload') {
      return over.keyUpload === undefined ? res(200, { one_time_key_counts: { curve25519: 50 } }) : over.keyUpload(entry)
    }
    if (p.endsWith('/members')) return over.members ?? res(200, { chunk: [] })
    if (p.endsWith('/state/m.room.encryption')) {
      return over.encryption ?? res(404, { errcode: 'M_NOT_FOUND', error: 'There is no encryption event' })
    }
    if (p.includes('/send/m.room.message/')) return over.send ?? res(200, { event_id: 'EV1' })
    return res(200, {})
  }
}

/** fake fetch：sync 脚本队列 + 记录 calls（keys/upload 单独可查）。 */
function fakeFetch(route, syncScript = []) {
  const queue = [...syncScript]
  const calls = []
  const syncs = []
  const impl = async (url, init) => {
    const u = new URL(url)
    const entry = {
      url,
      method: init?.method ?? 'GET',
      path: u.pathname,
      query: u.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: init?.headers ?? {},
      signal: init?.signal,
    }
    calls.push(entry)
    if (u.pathname === '/_matrix/client/v3/sync') {
      syncs.push(entry)
      const next = queue.shift()
      await sleep(5) // 长轮询仿真：防紧循环
      return next !== undefined ? (typeof next === 'function' ? next(syncs.length, entry) : next) : res(200, { next_batch: 'sx' })
    }
    return route(entry, calls)
  }
  const matching = (needle) => calls.filter((c) => c.path.includes(needle))
  return { impl, calls, syncs, matching, keyUploads: () => matching('/keys/upload') }
}

const syncProcessed = (fetch, n) => fetch.syncs.length > n

function newE2eeAdapter(encryption, fake, extra = {}) {
  const lines = []
  const adapter = new MatrixAdapter({
    accessToken: TOKEN,
    homeserverBaseUrl: BASE,
    fetchImpl: fake.impl,
    logger: (m) => lines.push(m),
    ...(encryption === undefined ? {} : { encryption }),
    ...(fake.factory === undefined ? {} : { olmFactory: fake.factory }),
    ...extra,
  })
  return { adapter, lines }
}

// —— device_id 派生（无状态文件依赖：accessToken 哈希）————————————————

test('deriveDeviceId：同 token+user 稳定；user/token 任一变更即换；形为大写 hex 12 位', () => {
  const a = deriveDeviceId(TOKEN, BOT)
  assert.match(a, /^[0-9A-F]{12}$/)
  assert.equal(deriveDeviceId(TOKEN, BOT), a, '重复调用必须稳定（同设备身份）')
  assert.notEqual(deriveDeviceId(TOKEN + 'x', BOT), a, 'token 轮换 → 新设备身份（A 档边界：旧设备 room_key 不跟来）')
  assert.notEqual(deriveDeviceId(TOKEN, '@other:example.org'), a, 'user 参与派生盐')
  assert.notEqual(deriveDeviceId(TOKEN), a, 'userId 缺省位与显式位不同形')
})

// —— canonicalJson（/#canonical-v1 签名序列化）———————————————————

test('canonicalJson：键字典序 + 无空白 + ~0/~1 转义 + 数组保序', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: null, c: 'x/y~z' }] }), '{"a":[2,{"c":"x~1y~0z","d":null}],"b":1}')
  assert.equal(canonicalJson('a/b~c'), '"a~1b~0c"')
  assert.equal(canonicalJson(true), 'true')
})

// —— MatrixE2eeCrypto 单元（fake olm 断言调用序列）————————————————

test('Crypto.init：olm 加载失败 → ready=false + lastError 如实；幂等成功', async () => {
  const bad = makeFakeOlm({ fail: 'load' })
  const cryptoBad = new MatrixE2eeCrypto({ olmFactory: bad.factory })
  assert.equal(await cryptoBad.init(), false)
  assert.equal(cryptoBad.ready, false)
  assert.match(cryptoBad.lastError, /olm WASM 加载失败/)
  assert.deepEqual(bad.trace, ['olmFactory()'], '工厂抛在 new Account 之前')

  const good = makeFakeOlm()
  const cryptoGood = new MatrixE2eeCrypto({ olmFactory: good.factory })
  assert.equal(await cryptoGood.init(), true)
  assert.equal(await cryptoGood.init(), true, '二次 init 不重跑工厂（幂等）')
  assert.equal(good.trace.filter((t) => t === 'olmFactory()').length, 1)
  assert.equal(cryptoGood.identityKeys().ed25519, 'FAKE_ED_PUB', '3.2.15 绑定 identity_keys 为 JSON string 形态')
})

test('deviceKeysPayload：规范 /keys/upload 形——keys/signatures/one_time_keys + 调用序列', async () => {
  const fake = makeFakeOlm()
  const crypto = new MatrixE2eeCrypto({ olmFactory: fake.factory })
  await crypto.init()
  const deviceId = deriveDeviceId(TOKEN, BOT)
  const payload = crypto.deviceKeysPayload(BOT, deviceId)
  assert.deepEqual(payload.device_keys.user_id, BOT)
  assert.deepEqual(payload.device_keys.device_id, deviceId)
  assert.deepEqual(payload.device_keys.algorithms, [MEGOLM_ALGORITHM])
  assert.deepEqual(payload.device_keys.keys, {
    [`curve25519:${deviceId}`]: 'FAKE_CURVE_PUB',
    [`ed25519:${deviceId}`]: 'FAKE_ED_PUB',
  })
  assert.deepEqual(Object.keys(payload.device_keys.signatures), [BOT])
  assert.match(payload.device_keys.signatures[BOT][`ed25519:${deviceId}`], /^SIG\(/, 'ed25519 对剔除 signatures 的 canonical JSON 签名')
  assert.deepEqual(Object.keys(payload.one_time_keys).sort(), ['signed_curve25519:AAAAAA', 'signed_curve25519:AAAAAB'])
  const signedKey = payload.one_time_keys['signed_curve25519:AAAAAA']
  assert.equal(signedKey.key, 'OTK_A')
  assert.match(signedKey.signatures[BOT][`ed25519:${deviceId}`], /^SIG\(/)
  const seq = fake.trace
  const idx = (t) => seq.indexOf(t)
  assert.ok(idx('account.create') < idx('account.sign'), '身份密钥签名在 one-time keys 收集前')
  assert.ok(idx('account.sign') < idx('account.one_time_keys'))
  assert.ok(idx('account.one_time_keys') < idx('account.mark'), '上传后必须 mark 已发布（规范防重复发布）')
  assert.equal(idx('account.gen_otk(10)'), -1, '池非空不生成（最小实现只取未发布存量）')
})

test('handleRoomKey/decryptToEventFields：存取消序列 + 形检/算法/session_id 一致性/sender 绑定', async () => {
  const fake = makeFakeOlm()
  const crypto = new MatrixE2eeCrypto({ olmFactory: fake.factory })
  await crypto.init()
  assert.equal(crypto.handleRoomKey({ algorithm: 'm.olm.v1.curve25519-aes-sha2', room_id: ROOM, session_id: SID, session_key: SESSION_KEY }), false, '非 Megolm 算法拒存')
  assert.equal(crypto.handleRoomKey({ algorithm: MEGOLM_ALGORITHM, room_id: ROOM, session_id: SID }), false, '缺 session_key 拒存')
  assert.equal(crypto.handleRoomKey({ algorithm: MEGOLM_ALGORITHM, room_id: ROOM, session_id: 'WRONG_SID', session_key: SESSION_KEY }), false, 'session_id 与密钥派生不符拒存')
  assert.ok(fake.trace.includes('igs.free'), '不符会话释放 WASM 对象')
  assert.equal(crypto.handleRoomKey(roomKeyEvent().content, ALICE), true)
  assert.equal(crypto.hasSession(ROOM, SID), true)
  assert.equal(crypto.sessionCount(), 1)

  assert.equal(crypto.decryptToEventFields(ROOM, encEvent({ content: { algorithm: 'olm', session_id: SID, ciphertext: 'CT1' } })), undefined, '非 Megolm algorithm 不解')
  assert.equal(crypto.decryptToEventFields('!other:example.org', encEvent()), undefined, '会话按 room_id+session_id 记账')
  assert.equal(crypto.decryptToEventFields(ROOM, encEvent({ sender: '@evil:example.org' })), undefined, '加密事件 sender 与 room_key 来源不一致按失败处理（A 档可用最强设备绑定）')
  const fields = crypto.decryptToEventFields(ROOM, encEvent())
  assert.equal(fields.type, 'm.room.message')
  assert.equal(fields.content.body, '解开的密文:CT1')
  assert.ok(fake.trace.includes('igs.create(MEGOLM_SESSION_KEY_1)') && fake.trace.includes('igs.decrypt(CT1)'), '调用序列：先建会话后解密')
  assert.equal(crypto.decryptToEventFields(ROOM, encEvent({ content: { algorithm: MEGOLM_ALGORITHM, session_id: SID, ciphertext: 'BAD' } })), undefined, 'olm 抛错=解密失败，不伪称成功')
  assert.match(crypto.lastError, /OLM\.BAD_MESSAGE/)
  assert.equal(fake.namespace.InboundGroupSession === undefined, false)
  crypto.freeSessions()
  assert.equal(crypto.sessionCount(), 0)
})

test('topUpOneTimeKeys：水位补充面只带 one_time_keys（同一 /keys/upload 端点）', async () => {
  const fake = makeFakeOlm({ emptyOtkPool: true })
  const crypto = new MatrixE2eeCrypto({ olmFactory: fake.factory, oneTimeKeyTarget: 6 })
  await crypto.init()
  const payload = crypto.topUpOneTimeKeys('DEV1', BOT)
  // 空池 → generate(6) 再取（fake 二次仍空 → 无钥可报，返回 undefined 如实）
  assert.ok(fake.trace.includes('account.gen_otk(6)'), '空池先生成（≤ 上限）')
  assert.equal(payload, undefined, '生成后仍无钥 → 不给伪载荷')
})

// —— 真包往返（@matrix-org/olm@3.2.15 WASM 实解密；加载失败即如实跳过）————————

test('真包往返：OutboundGroupSession 加密 → Crypto 入站解密得原事件 JSON', async () => {
  let olm
  try {
    olm = await loadRealOlm()
  } catch (error) {
    console.log(`（真 olm 包不可加载，跳过：${error.message}）`)
    return
  }
  const { OutboundGroupSession } = olm
  assert.equal(typeof OutboundGroupSession, 'function', '3.2.15 绑定自带出站会话（仅测试造密文用，A 档出站不加密）')
  const out = new OutboundGroupSession()
  out.create()
  const crypto = new MatrixE2eeCrypto({ olmFactory: async () => olm })
  assert.equal(await crypto.init(), true)
  assert.equal(
    crypto.handleRoomKey(
      { algorithm: MEGOLM_ALGORITHM, room_id: ROOM, session_id: out.session_id(), session_key: out.session_key() },
      ALICE,
    ),
    true,
    '真绑定 create 返回 session_id，与声明一致',
  )
  const plaintext = JSON.stringify({ type: 'm.room.message', content: { msgtype: 'm.text', body: '真包往返 ✔ 含非 ASCII' } })
  const ciphertext = out.encrypt(plaintext)
  const fields = crypto.decryptToEventFields(ROOM, {
    type: 'm.room.encrypted',
    sender: ALICE,
    content: { algorithm: MEGOLM_ALGORITHM, sender_key: 'REAL_SENDER_KEY', session_id: out.session_id(), ciphertext },
  })
  assert.ok(fields !== undefined, '真包解密必须成功（单参 decrypt 形）')
  assert.equal(fields.type, 'm.room.message')
  assert.equal(fields.content.body, '真包往返 ✔ 含非 ASCII')
  assert.equal(crypto.decryptToEventFields(ROOM, { type: 'm.room.encrypted', sender: ALICE, content: { algorithm: MEGOLM_ALGORITHM, session_id: out.session_id(), ciphertext: 'not-base64!' } }), undefined, '坏密文如实失败')
  crypto.freeSessions()
})

test('真包适配器接线往返：to_device room_key → m.room.encrypted 解出正文（createMatrixAdapter 显式注入）', async () => {
  let factory
  try {
    factory = loadRealOlm
    await factory()
  } catch (error) {
    console.log(`（真 olm 包不可加载，跳过：${error.message}）`)
    return
  }
  const { OutboundGroupSession } = await loadRealOlm()
  const out = new OutboundGroupSession()
  out.create()
  // Megolm 实测语义：session_key() 导出的是「当前消息版本」的密钥，encrypt 推进版本后再取
  // 会得到更高起始 index 的密钥，旧密文解密抛 OLM.UNKNOWN_MESSAGE_INDEX；生产流程里
  // room_key 本就先于首条密文分发，故先锁 session_key/session_id 再造密文。
  const sessionId = out.session_id()
  const sessionKey = out.session_key()
  const plain = JSON.stringify({ type: 'm.room.message', content: { msgtype: 'm.text', body: '真包端到端解开' } })
  const ciphertext = out.encrypt(plain)
  const fake = fakeFetch(makeRoute(), [
    () => syncBody({ join: { [ROOM]: roomFace([]) } }, 's1'),
    () =>
      syncBody(
        { join: { [ROOM]: roomFace([encEvent({ event_id: 'R1', content: { algorithm: MEGOLM_ALGORITHM, sender_key: 'K', session_id: sessionId, ciphertext } })]) } },
        's2',
        {
          to_device: { events: [roomKeyEvent({ content: { algorithm: MEGOLM_ALGORITHM, room_id: ROOM, session_id: sessionId, session_key: sessionKey } })] },
        },
      ),
  ])
  // 工厂面不收 fetchImpl 注入参：测试期临时替换 globalThis.fetch（构造期即捕获 fake，与 matrix.test.mjs 工厂用例同法）
  const prevFetch = globalThis.fetch
  globalThis.fetch = fake.impl
  const adapter = createMatrixAdapter({
    accountId: 'dev',
    config: { homeserverBaseUrl: BASE, encryption: 'optional', dmRoomList: ROOM },
    secrets: { accessToken: TOKEN },
    olmFactory: factory,
  })
  globalThis.fetch = prevFetch
  const got = []
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  assert.equal(fake.keyUploads().length, 1, '真包引导即发布设备密钥')
  await waitUntil(() => syncProcessed(fake, 2))
  assert.deepEqual(got.map((m) => m.text), ['真包端到端解开'])
  assert.equal(got[0].address.kind, 'dm')
  await adapter.disconnect()
})

// —— 适配器接线：三档行为 ————————————————————————————

test('disabled（默认/显式）+注入工厂：零漂移——olm 不加载、/keys/upload 不发、占位照旧、to_device 不消费', async () => {
  const fake = fakeFetch(makeRoute(), [
    () => syncBody({ join: { [ROOM]: roomFace([]) } }, 's1'),
    () => syncBody({ join: { [ROOM]: roomFace([encEvent({ event_id: 'D1' })]) } }, 's2', { to_device: { events: [roomKeyEvent()] } }),
  ])
  const { factory, trace } = makeFakeOlm()
  const { adapter } = newE2eeAdapter(undefined, { ...fake, factory }, { dmRoomList: [ROOM] })
  const got = []
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  await waitUntil(() => syncProcessed(fake, 2))
  assert.deepEqual(got.map((m) => m.text), [ENCRYPTED_PLACEHOLDER], '默认档加密事件仍占位不丢（与历史逐字一致）')
  assert.equal(fake.keyUploads().length, 0)
  assert.equal(factory !== undefined && trace.length, 0, 'disabled 不碰 olm 工厂')
  const checks = await adapter.diagnose()
  const e2ee = checks.find((c) => c.name === 'e2ee')
  assert.equal(e2ee.status, 'unverified')
  assert.match(e2ee.hint, /optional 模式：olm 解密面未接/, '零漂移：默认档诊断文案与旧 optional 逐字一致')
  await adapter.disconnect()
})

test('optional + 解密面：to_device room_key 存取 → 增量 sync 解密投递；密钥未达维持现状占位', async () => {
  const fake = fakeFetch(makeRoute(), [
    () => syncBody({ join: { [ROOM]: roomFace([]) } }, 's1'),
    () => syncBody({ join: {} }, 's2', { to_device: { events: [roomKeyEvent()] }, device_one_time_keys_count: { curve25519: 20 } }),
    () =>
      syncBody(
        {
          join: {
            [ROOM]: roomFace([
              encEvent({ event_id: 'O1' }),
              encEvent({ event_id: 'O2', content: { algorithm: MEGOLM_ALGORITHM, sender_key: 'CURVE_SENDER_A', session_id: 'SID@UNKNOWN_KEY', ciphertext: 'CT2' } }),
              msgEvent({ event_id: 'O3', content: { body: '明文照常' } }),
            ]),
          },
        },
        's3',
      ),
  ])
  const { factory, trace } = makeFakeOlm()
  const { adapter } = newE2eeAdapter('optional', { ...fake, factory }, { dmRoomList: [ROOM] })
  const got = []
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  assert.equal(fake.keyUploads().length, 1, 'enabled 档 connect 期发布设备密钥')
  const upload = fake.keyUploads()[0]
  assert.equal(upload.method, 'POST')
  assert.equal(upload.headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(upload.body.device_keys.device_id, deriveDeviceId(TOKEN, BOT), 'device_id=accessToken 哈希派生')
  await waitUntil(() => syncProcessed(fake, 3))
  assert.deepEqual(
    got.map((m) => m.text),
    ['解开的密文:CT1', ENCRYPTED_PLACEHOLDER, '明文照常'],
    '密钥已达→解密投递；密钥未达→optional 维持现状占位（不丢事件）',
  )
  assert.equal(got[0].userId, ALICE)
  assert.equal(got[1].address.kind, 'dm')
  assert.ok(trace.includes('igs.create(MEGOLM_SESSION_KEY_1)'), 'room_key 已建会话')
  assert.ok(trace.includes('igs.decrypt(CT1)'))
  assert.equal(fake.matching('/state/m.room.encryption').length, 0, 'optional 从不加密探测（旧行为保持）')
  await adapter.disconnect()
})

test('required + 解密面：不拒连加密房间；密钥未达给占位而非拒连；密钥到达后解密；出站本地拒发明文', async () => {
  const fake = fakeFetch(makeRoute(), [
    () => syncBody({ join: { [ROOM]: roomFace([encEvent({ event_id: 'R-NOKEY' })]) } }, 's1'),
    () =>
      syncBody(
        { join: { [ROOM]: roomFace([encEvent({ event_id: 'R-OK' })]) } },
        's2',
        { to_device: { events: [roomKeyEvent()] } },
      ),
  ])
  const lines = []
  const { factory } = makeFakeOlm()
  const adapter = new MatrixAdapter({
    accessToken: TOKEN,
    homeserverBaseUrl: BASE,
    encryption: 'required',
    olmFactory: factory,
    fetchImpl: fake.impl,
    logger: (m) => lines.push(m),
    deliverInitialHistory: true,
    dmRoomList: [ROOM],
  })
  const got = []
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  await waitUntil(() => syncProcessed(fake, 2))
  assert.deepEqual(got.map((m) => m.text), [ENCRYPTED_KEY_MISSING_PLACEHOLDER, '解开的密文:CT1'], '密钥未达占位不丢事件；同 session 密钥到达后即可解')
  assert.deepEqual(adapter.refusedRoomIds, [], 'required + 解密面在位：不再拒连')
  assert.equal(fake.matching('/state/m.room.encryption').length, 0, '解密面在位不再花探测请求')
  assert.ok(lines.some((l) => l.includes('设备密钥已发布') && l.includes('跨设备分享不完整')), 'A 档边界进日志')
  await assert.rejects(
    adapter.reply({ channel: 'matrix', kind: 'dm', chatId: ROOM }, '明文回话'),
    (error) => error instanceof MatrixApiError && error.errcode === 'IMU_E2EE_REFUSED',
    'A 档出站不加密；观测到 m.room.encrypted 即实锤房间加密——规范禁明文进加密房间，本地拒发',
  )
  const checks = await adapter.diagnose()
  const e2ee = checks.find((c) => c.name === 'e2ee')
  assert.equal(e2ee.status, 'passed')
  assert.match(e2ee.hint, /A 档解密面已就位/)
  assert.match(e2ee.hint, /仅覆盖会话内已分发 room_key 的解密，跨设备分享不完整/)
  assert.ok(!`${e2ee.hint}`.includes(TOKEN), 'hint 零 token 回显（device_id 哈希派生不外泄原值）')
  await adapter.disconnect()
})

test('one-time keys 水位低于 ${ONETIME_KEY_FLOOR} → 最小补充面再发 /keys/upload', async () => {
  const fake = fakeFetch(makeRoute(), [
    () => syncBody({}, 's1', { device_one_time_keys_count: { curve25519: 2 } }),
  ])
  const { factory } = makeFakeOlm()
  const { adapter } = newE2eeAdapter('optional', { ...fake, factory })
  await adapter.connect()
  await waitUntil(() => syncProcessed(fake, 1))
  const uploads = fake.keyUploads()
  assert.equal(uploads.length, 2, '引导 1 次 + 水位补充 1 次')
  assert.equal(uploads[1].body.device_keys, undefined, '补充包只带 one_time_keys')
  assert.ok(uploads[1].body.one_time_keys['signed_curve25519:AAAAAA'] !== undefined)
  await adapter.disconnect()
})

test('olm 加载失败退旧兜底：required 仍拒连加密房间（诊断 failed）；optional 维持占位（unverified）', async () => {
  const fakeR = fakeFetch(makeRoute({ encryption: res(200, { algorithm: MEGOLM_ALGORITHM }) }), [
    () => syncBody({ join: { [ROOM]: roomFace([msgEvent()]) } }, 's1'),
    () => syncBody({ join: { [ROOM]: roomFace([msgEvent({ event_id: 'AFTER' })]) } }, 's2'),
  ])
  const { factory } = makeFakeOlm({ fail: 'load' })
  const req = newE2eeAdapter('required', { ...fakeR, factory })
  const gotR = []
  req.adapter.onMessage((m) => gotR.push(m))
  await req.adapter.connect()
  await waitUntil(() => syncProcessed(fakeR, 2))
  assert.deepEqual(req.adapter.refusedRoomIds, [ROOM], 'olm 不可用 = 无解密面 → 旧拒连兜底')
  assert.deepEqual(gotR.map((m) => m.text), [], '拒连房间事件一律不消费')
  const checksR = await req.adapter.diagnose()
  const e2eeR = checksR.find((c) => c.name === 'e2ee')
  assert.equal(e2eeR.status, 'failed')
  assert.match(e2eeR.hint, /required 模式已拒连 1 个加密房间/)
  assert.match(e2eeR.hint, /加载失败/, 'failed 原因如实带上 olm 错误')
  await req.adapter.disconnect()

  const fakeO = fakeFetch(makeRoute(), [
    () => syncBody({ join: { [ROOM]: roomFace([]) } }, 's1'),
    () => syncBody({ join: { [ROOM]: roomFace([encEvent({ event_id: 'OF1' })]) } }, 's2'),
  ])
  const { factory: factoryO } = makeFakeOlm({ fail: 'load' })
  const opt = newE2eeAdapter('optional', { ...fakeO, factory: factoryO }, { dmRoomList: [ROOM] })
  const gotO = []
  opt.adapter.onMessage((m) => gotO.push(m))
  await opt.adapter.connect()
  await waitUntil(() => syncProcessed(fakeO, 2))
  assert.deepEqual(gotO.map((m) => m.text), [ENCRYPTED_PLACEHOLDER], 'optional：olm 挂了也维持现状占位不丢事件')
  const checksO = await opt.adapter.diagnose()
  const e2eeO = checksO.find((c) => c.name === 'e2ee')
  assert.equal(e2eeO.status, 'unverified')
  assert.match(e2eeO.hint, /olm 解密面加载失败/)
  await opt.adapter.disconnect()
})

test('设备密钥发布失败（/keys/upload 5xx）：解密面仍就位，诊断 unverified 不谎报 passed', async () => {
  const fake = fakeFetch(makeRoute({ keyUpload: () => res(500, { error: 'boom' }) }), [() => syncBody({}, 's1')])
  const { factory } = makeFakeOlm()
  const lines = []
  const adapter = new MatrixAdapter({
    accessToken: TOKEN,
    homeserverBaseUrl: BASE,
    encryption: 'optional',
    olmFactory: factory,
    fetchImpl: fake.impl,
    logger: (m) => lines.push(m),
  })
  await adapter.connect()
  const checks = await adapter.diagnose()
  const e2ee = checks.find((c) => c.name === 'e2ee')
  assert.equal(e2ee.status, 'unverified')
  assert.match(e2ee.hint, /设备密钥未发布成功/)
  assert.ok(lines.some((l) => l.includes('/keys/upload 失败')))
  await adapter.disconnect()
})
