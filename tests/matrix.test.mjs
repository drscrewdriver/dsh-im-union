// T3.2 Matrix CS API 渠道单测：whoami 握手 / sync 长轮询游标滚动与 410 重建 /
// m.text 归一（dm-group 判定·非文本占位·自身回声·重投排重·回复回退剥离）/
// PUT send txnId 形态 / 429 retry_after_ms 同 txnId 重传 / 编辑流式 m.replace /
// typing / m.room.encrypted 两模式（optional 占位不丢·required 拒连）/
// 诊断三态 / 工厂校验。网络面全注入 fake fetchImpl（工厂面临时替换 globalThis.fetch），
// 零真实请求。已知缺陷按当前实际行为断言并注释「已知缺陷登记」。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MatrixAdapter,
  MatrixApiError,
  MatrixUncertainError,
  createMatrixAdapter,
  stripReplyFallback,
  ENCRYPTED_PLACEHOLDER,
  MATRIX_MAX_MESSAGE,
} from '../lib/channels/matrix.js'

const BASE = 'https://matrix.example.org'
const TOKEN = 'syt_imu_matrix_fake_token'
const BOT = '@bot:example.org'
const ALICE = '@alice:example.org'
const ROOM = '!room1:example.org'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })

async function waitUntil(fn, ms = 2500) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('waitUntil 超时')
    await sleep(5)
  }
}

/** 响应形态：只实现 matrix.ts 用到的能力（ok/status/json/headers.get）。 */
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
/** 时间线消息事件（content 浅合并，其余字段整体覆盖）。 */
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
const encEvent = (over = {}) =>
  msgEvent({ type: 'm.room.encrypted', content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'AAAA' }, ...over })
const memberEvent = (userId, membership = 'join', displayname = undefined) => ({
  type: 'm.room.member',
  state_key: userId,
  sender: userId,
  content: { membership, ...(displayname === undefined ? {} : { displayname }) },
})
/** 已加入房间面（timeline + 可选 state）。 */
const roomFace = (events, stateEvents = undefined) => ({
  timeline: { events, ...(stateEvents === undefined ? {} : { state: { events: stateEvents } }) },
})
const syncBody = (rooms, next_batch) => res(200, { next_batch, rooms })

const roomOf = (entry) => decodeURIComponent(entry.path.split('/')[5])
const txnOf = (entry) => decodeURIComponent(entry.path.split('/')[8])

/** 路由项支持常量或 (entry, n) → 响应；返回 undefined 时走默认。 */
const pick = (specValue, entry, n, fallback) => {
  const value = typeof specValue === 'function' ? specValue(entry, n) : specValue
  return value === undefined ? fallback(entry, n) : value
}

/**
 * 默认路由：whoami 成功、成员面空（0 join → dm）、房间未启用加密（404）、
 * 出站 send 返回递增 event_id、join/typing 空成功。逐项可覆盖。
 */
function makeRoute(over = {}) {
  let whoamiN = 0
  let membersN = 0
  let encN = 0
  let sendN = 0
  let joinN = 0
  let typingN = 0
  return (entry) => {
    const p = entry.path
    if (p === '/_matrix/client/v3/account/whoami') {
      whoamiN += 1
      return pick(over.whoami, entry, whoamiN, () => res(200, { user_id: BOT, device_id: 'DEV1' }))
    }
    if (p.endsWith('/members')) {
      membersN += 1
      return pick(over.members, entry, membersN, () => res(200, { chunk: [] }))
    }
    if (p.endsWith('/state/m.room.encryption')) {
      encN += 1
      return pick(over.encryption, entry, encN, () => res(404, { errcode: 'M_NOT_FOUND', error: 'There is no encryption event' }))
    }
    if (p.includes('/send/m.room.message/')) {
      sendN += 1
      return pick(over.send, entry, sendN, () => res(200, { event_id: `EV${sendN}` }))
    }
    if (p.startsWith('/_matrix/client/v3/join/')) {
      joinN += 1
      return pick(over.join, entry, joinN, () => res(200, { room_id: roomOf(entry) }))
    }
    if (p.endsWith('/typing')) {
      typingN += 1
      return pick(over.typing, entry, typingN, () => res(200, {}))
    }
    return res(200, {})
  }
}

/**
 * fake fetch：记录 calls/syncs，sync 走脚本队列。
 * 长轮询仿真——每个 sync 至少 hold 10ms（可置 0 以观测紧循环），脚本耗尽后挂到 abort
 * 才返回，否则 pollLoop 在测试里会打成同步紧循环（真服务端 hold 秒级，请求数不会爆）。
 */
function fakeFetch(route, syncScript = [], options = {}) {
  const holdMs = options.holdMs ?? 10
  const queue = [...syncScript]
  const calls = []
  const syncs = []
  let parked = 0
  let lastSpec
  const impl = async (url, init) => {
    const u = new URL(url)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const entry = {
      url,
      method: init?.method ?? 'GET',
      path: u.pathname,
      query: u.searchParams,
      body,
      raw: init?.body,
      headers: init?.headers ?? {},
      signal: init?.signal,
      at: Date.now(),
    }
    calls.push(entry)
    if (u.pathname === '/_matrix/client/v3/sync') {
      syncs.push(entry)
      const next = queue.shift()
      const spec = next !== undefined ? next : options.loopLast === true ? lastSpec : undefined
      if (spec !== undefined) {
        lastSpec = spec
        // 长轮询仿真：hold 至少一个事件循环 tick（真服务端 hold 秒级）
        await sleep(holdMs > 0 ? holdMs : 0)
        return typeof spec === 'function' ? spec(syncs.length, entry) : spec
      }
      parked += 1
      return new Promise((resolve, reject) => {
        const signal = init?.signal
        if (signal === undefined) {
          reject(new Error(`测试 sync 脚本耗尽且无 abort 信号（第 ${syncs.length} 次 sync）`))
          return
        }
        if (signal.aborted) {
          reject(abortError())
          return
        }
        signal.addEventListener('abort', () => reject(abortError()), { once: true })
      })
    }
    return route(entry, calls)
  }
  const matching = (needle) => calls.filter((c) => c.path.includes(needle))
  return { impl, calls, syncs, matching, get parkedCount() { return parked }, sends: () => matching('/send/m.room.message/') }
}

/** sync 请求是否已推进到第 n 次（第 n+1 次已发出 ⇒ 第 n 次响应已被完整消费）。 */
const syncProcessed = (fetch, n) => fetch.syncs.length > n

function newAdapter(extra = {}) {
  const fetch = extra.fetch ?? fakeFetch(makeRoute())
  const lines = []
  const adapter = new MatrixAdapter({
    accessToken: TOKEN,
    homeserverBaseUrl: BASE,
    fetchImpl: fetch.impl,
    logger: (m) => lines.push(m),
    ...extra.options,
  })
  return { adapter, fetch, lines }
}

async function withGlobalFetch(impl, body) {
  const real = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await body()
  } finally {
    globalThis.fetch = real
  }
}

const dmAddr = { channel: 'matrix', kind: 'dm', chatId: ROOM }
const groupAddr = { channel: 'matrix', kind: 'group', chatId: ROOM }

// —— 握手 ——————————————————————————————————————————

test('connect：whoami 取自身 id（Bearer 头而非查询参数）→ 首轮 sync 建游标', async () => {
  const fetch = fakeFetch(makeRoute(), [() => syncBody({}, 's1')])
  const adapter = new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: BASE, fetchImpl: fetch.impl })
  assert.equal(adapter.id, 'matrix')
  assert.equal(adapter.label, 'Matrix')
  assert.equal(adapter.connected, false)
  assert.equal(adapter.hasSyncCursor, false)
  await adapter.connect()
  assert.equal(adapter.connected, true)
  assert.equal(fetch.calls[0].method, 'GET')
  assert.equal(fetch.calls[0].url, `${BASE}/_matrix/client/v3/account/whoami`)
  assert.equal(fetch.calls[0].headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(fetch.calls[0].headers['content-type'], 'application/json')
  assert.ok(!fetch.calls[0].url.includes('access_token'), 'v1.11 起 access token 只走请求头')
  const sync = fetch.syncs[0]
  assert.equal(sync.query.get('since'), null, '首轮为全量同步')
  assert.equal(sync.query.get('timeout'), '30000')
  assert.deepEqual(JSON.parse(sync.query.get('filter')), {
    room: {
      timeline: { limit: 20, types: ['m.room.message', 'm.room.encrypted', 'm.room.member'] },
      state: { lazy_load_members: true },
    },
  })
  assert.equal(adapter.hasSyncCursor, true)
  await adapter.disconnect()
  assert.equal(adapter.connected, false)
  assert.equal(fetch.matching('/logout').length, 0, '软停轮询：绝不 POST /logout 吊销外部预置 token')
})

test('connect：whoami 无 user_id → 明确抛错且不进轮询（非规范实现不消费事件）', async () => {
  const fetch = fakeFetch(makeRoute({ whoami: res(200, { device_id: 'DEV1' }) }))
  const adapter = new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: BASE, fetchImpl: fetch.impl })
  await assert.rejects(adapter.connect(), /whoami 响应缺少 user_id/)
  assert.equal(adapter.connected, false)
  assert.equal(fetch.syncs.length, 0)
})

// —— sync 游标面 ——————————————————————————————————————

test('sync 游标：next_batch 非空才滚动，下一轮作为 since 带上', async () => {
  const fetch = fakeFetch(makeRoute(), [
    () => syncBody({}, 's1'),
    () => syncBody({}, ''),
    () => syncBody({}, 's2'),
  ])
  const adapter = new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: BASE, fetchImpl: fetch.impl })
  await adapter.connect() // 消费 #1
  await waitUntil(() => syncProcessed(fetch, 3))
  assert.deepEqual(
    fetch.syncs.slice(0, 4).map((c) => c.query.get('since')),
    [null, 's1', 's1', 's2'],
    '空 next_batch 保持旧游标（重复收防护）')
  assert.equal(adapter.hasSyncCursor, true)
  await adapter.disconnect()
})

test('sync 410 Gone：弃游标重做全量同步（下一轮不带 since）', async () => {
  const fetch = fakeFetch(makeRoute(), [
    () => syncBody({}, 's1'),
    () => res(410, { errcode: 'M_UNKNOWN_TOKEN', error: 'since token expired' }),
    () => syncBody({}, 's2'),
  ])
  const lines = []
  const adapter = new MatrixAdapter({
    accessToken: TOKEN,
    homeserverBaseUrl: BASE,
    fetchImpl: fetch.impl,
    logger: (m) => lines.push(m),
  })
  await adapter.connect()
  await waitUntil(() => syncProcessed(fetch, 3))
  assert.deepEqual(
    fetch.syncs.slice(0, 4).map((c) => c.query.get('since')),
    [null, 's1', null, 's2'],
    '410 后必须弃游标')
  assert.ok(lines.some((l) => l.includes('游标过期（410）')), '弃游标要留日志')
  await adapter.disconnect()
})

test('sync 成功路径有最小间隔：服务端不 hold 也不成热循环（主会话修复回归）', async () => {
  // 缺陷已修：pollLoop 成功路径插 POLL_MIN_INTERVAL_MS(200ms)；构造面 timeout=0 仍透传
  // 但不再构成热循环（工厂配置面 '0' 另由 positiveIntOr 拒收，见工厂用例）。
  const fetch = fakeFetch(makeRoute(), [() => syncBody({}, 's1')], { holdMs: 0, loopLast: true })
  const adapter = new MatrixAdapter({
    accessToken: TOKEN,
    homeserverBaseUrl: BASE,
    fetchImpl: fetch.impl,
    syncTimeoutMs: 0,
  })
  await adapter.connect()
  await sleep(60)
  const hot = fetch.syncs.length
  await adapter.disconnect()
  const gaps = fetch.syncs.slice(1).map((c, i) => c.at - fetch.syncs[i].at)
  const minGap = gaps.length > 0 ? Math.min(...gaps) : Number.POSITIVE_INFINITY
  assert.equal(fetch.syncs[0].query.get('timeout'), '0', '构造面透传 0（工厂面另论）')
  assert.ok(minGap >= 150, `成功轮间隔必须 ≥ 最小间隔（实测最小 ${minGap}ms，60ms 窗口内仅 ${hot} 轮）`)
  assert.ok(hot <= 3, `60ms 窗口内不得堆叠超过 3 轮（实发 ${hot}）`)
})

// —— 入站归一 ——————————————————————————————————————

test('入站：m.text 归一 / 非文本 msgtype 占位 / 自身回声丢弃 / 非消息事件与缺 sender 丢弃 / 重投排重', async () => {
  const members = res(200, { chunk: [memberEvent(BOT, 'join', 'IM Bot'), memberEvent(ALICE, 'join', 'Alice')] })
  const fetch = fakeFetch(makeRoute({ members }), [
    () => syncBody({ join: { [ROOM]: roomFace([msgEvent({ event_id: 'HIST' })]) } }, 's1'),
    () =>
      syncBody(
        {
          join: {
            [ROOM]: roomFace([
              msgEvent({ event_id: 'E1', content: { body: '你好' } }),
              msgEvent({ event_id: 'E2', sender: BOT, content: { body: '我自己发的' } }),
              msgEvent({ event_id: 'E3', content: { msgtype: 'm.image', body: 'img.png' } }),
              msgEvent({ event_id: 'E4', content: { msgtype: 'm.sticker' } }),
              msgEvent({ event_id: 'E5', type: 'm.room.member', state_key: ALICE, content: { membership: 'join' } }),
              msgEvent({ event_id: 'E6', sender: undefined, content: { body: '无 sender' } }),
              msgEvent({ event_id: 'E1' }),
              msgEvent({ event_id: 'E8', content: { msgtype: 'm.notice', body: '通知体' }, origin_server_ts: 1700000009000 }),
            ]),
          },
        },
        's2',
      ),
    () => syncBody({ join: { [ROOM]: roomFace([msgEvent({ event_id: 'E1' }), msgEvent({ event_id: 'E3' })]) } }, 's3'),
  ])
  const got = []
  const adapter = new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: BASE, fetchImpl: fetch.impl })
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  assert.deepEqual(got, [], '全量首 sync 默认不回放历史时间线（防旧消息触发回合）')
  await waitUntil(() => syncProcessed(fetch, 3))
  assert.deepEqual(
    got.map((m) => m.text),
    ['你好', '[图片消息：媒体下载面未接]', '[暂不支持的消息类型: m.sticker]', '通知体'],
    '回声/成员事件/无 sender/重投均丢弃，非文本给占位不丢消息')
  assert.deepEqual(got[0].address, { channel: 'matrix', kind: 'dm', chatId: ROOM })
  assert.equal(got[0].userId, ALICE)
  assert.equal(got[0].userDisplayName, 'Alice', '成员面 displayname 缓存优先')
  assert.equal(got[0].timestamp, 1700000000000)
  assert.equal(got[0].mentionedBot, false, 'dm 不依赖点名位')
  assert.equal(got[3].timestamp, 1700000009000)
  assert.equal(got[1].timestamp, 1700000000000)
  await adapter.disconnect()
})

test('deliverInitialHistory=true：显式开历史面时全量首 sync 也投递', async () => {
  const fetch = fakeFetch(makeRoute(), [
    () => syncBody({ join: { [ROOM]: roomFace([msgEvent({ content: { body: '历史' } })]) } }, 's1'),
  ])
  const got = []
  const adapter = new MatrixAdapter({
    accessToken: TOKEN,
    homeserverBaseUrl: BASE,
    fetchImpl: fetch.impl,
    deliverInitialHistory: true,
    dmRoomList: [ROOM],
  })
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  await waitUntil(() => syncProcessed(fetch, 1))
  assert.deepEqual(got.map((m) => m.text), ['历史'])
  assert.equal(got[0].address.kind, 'dm', 'dmRoomList 命中即 dm')
  assert.equal(fetch.matching('/members').length, 0, '点名房间不浪费成员面请求')
  await adapter.disconnect()
})

test('dm/group 判定：成员数 ≤2 判 dm、>2 判 group；成员面探测失败保守按 group', async () => {
  const DM = '!dmroom:example.org'
  const GP = '!gproom:example.org'
  const FAIL = '!failroom:example.org'
  const fetch = fakeFetch(
    makeRoute({
      members: (entry) => {
        const id = roomOf(entry)
        if (id === DM) return res(200, { chunk: [memberEvent(BOT, 'join', 'IM Bot'), memberEvent(ALICE, 'join', 'Alice')] })
        if (id === GP) {
          return res(200, {
            chunk: [
              memberEvent(BOT, 'join', 'IM Bot'),
              memberEvent(ALICE, 'join', 'Alice'),
              memberEvent('@carol:example.org', 'join', 'Carol'),
              memberEvent('@dave:example.org', 'invite'),
            ],
          })
        }
        return res(500, { error: 'boom' })
      },
    }),
    [
      () => syncBody({ join: { [DM]: roomFace([]), [GP]: roomFace([]), [FAIL]: roomFace([]) } }, 's1'),
      () =>
        syncBody(
          {
            join: {
              [DM]: roomFace([msgEvent({ event_id: 'D1', content: { body: '私聊' } })]),
              [GP]: roomFace([msgEvent({ event_id: 'G1', content: { body: '群里闲聊' } })]),
              [FAIL]: roomFace([msgEvent({ event_id: 'F1', sender: '@zoe:example.org', content: { body: '成员面挂了' } })]),
            },
          },
          's2',
        ),
    ],
  )
  const got = []
  const adapter = new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: BASE, fetchImpl: fetch.impl })
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  await waitUntil(() => syncProcessed(fetch, 2))
  assert.deepEqual(got.map((m) => [m.address.chatId, m.address.kind]), [
  [DM, 'dm'],
  [GP, 'group'],
  [FAIL, 'group'],
])
  assert.equal(got[2].userDisplayName, 'zoe', '成员面挂了 → 显示名回退本地部分')
  await adapter.disconnect()
})

test('群内点名：文本含 bot user_id / 缓存 displayname 算点名；纯文本不算（D6 未点名不响应）', async () => {
  const fetch = fakeFetch(
    makeRoute({ members: res(200, { chunk: [memberEvent(BOT, 'join', 'IM Bot'), memberEvent(ALICE, 'join', 'Alice'), memberEvent('@carol:example.org', 'join')] }) }),
    [() => syncBody({ join: { [ROOM]: roomFace([]) } }, 's1')],
  )
  const adapter = new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: BASE, fetchImpl: fetch.impl })
  await adapter.connect()
  assert.equal(adapter.normalizeEvent(ROOM, msgEvent()).address.kind, 'group', '3 名 join 成员 → group')
  assert.equal(adapter.normalizeEvent(ROOM, msgEvent({ content: { body: '@BOT:Example.org 帮个忙' } })).mentionedBot, true, '大小写不敏感匹配 user_id')
  assert.equal(adapter.normalizeEvent(ROOM, msgEvent({ content: { body: 'IM Bot 看下这个' } })).mentionedBot, true, '已缓存 displayname 也算点名')
  assert.equal(adapter.normalizeEvent(ROOM, msgEvent({ content: { body: '今天天气好' } })).mentionedBot, false)
  assert.equal(adapter.normalizeEvent(ROOM, msgEvent({ content: { body: '' } })).mentionedBot, false)
  await adapter.disconnect()
})

test('回复回退：剥离引用块 + quoteText；回复本 bot 消息不算点名（已知缺陷登记）', async () => {
  const fetch = fakeFetch(
    makeRoute({ members: res(200, { chunk: [memberEvent(BOT, 'join', 'IM Bot'), memberEvent(ALICE, 'join'), memberEvent('@carol:example.org', 'join')] }), send: res(200, { event_id: 'EVSELF' }) }),
    [() => syncBody({ join: { [ROOM]: roomFace([]) } }, 's1')],
  )
  const adapter = new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: BASE, fetchImpl: fetch.impl })
  await adapter.connect()
  const receipt = await adapter.reply(groupAddr, '原始回复')
  assert.equal(receipt.platformMessageId, 'EVSELF')
  // 规范回复形态：m.relates_to 只有 m.in_reply_to，无同级 event_id
  const replyEv = msgEvent({
    event_id: 'ER1',
    content: { body: '> <' + BOT + '> 原始回复\n> \n继续说', 'm.relates_to': { 'm.in_reply_to': { event_id: 'EVSELF' } } },
  })
  const m = adapter.normalizeEvent(ROOM, replyEv)
  assert.equal(m.text, '继续说', '引用回退块必须剥离')
  assert.equal(m.quoteText, `<${BOT}> 原始回复`)
  // 修复回归：判据已改 m.in_reply_to.event_id——纯回复本 bot 消息即算点名（D6 语义落地）
  assert.equal(m.mentionedBot, true, '回复本 bot 的消息必须算点名')
  // 同一条自检面：仅当 m.relates_to.event_id 命中自发事件（即编辑+回复混排）才置位
  const both = msgEvent({
    event_id: 'ER2',
    content: {
      msgtype: 'm.text',
      body: '无关回退',
      'm.new_content': { msgtype: 'm.text', body: '编辑后的正文' },
      'm.relates_to': { rel_type: 'm.replace', event_id: 'EVSELF', 'm.in_reply_to': { event_id: 'EVSELF' } },
    },
  })
  const edited = adapter.normalizeEvent(ROOM, both)
  assert.equal(edited.text, '编辑后的正文', '编辑事件取 m.new_content 为有效体')
  assert.equal(edited.mentionedBot, true)
  await adapter.disconnect()
})

test('normalizeEvent 直验：非消息事件/缺 sender/undefined → undefined；未判定房间保守 group；回声过滤依赖 whoami', async () => {
  const fetch = fakeFetch(makeRoute(), [() => syncBody({}, 's1')])
  const adapter = new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: BASE, fetchImpl: fetch.impl })
  // 未 connect（userId 空）→ 回声过滤不生效
  assert.ok(adapter.normalizeEvent(ROOM, msgEvent({ sender: BOT })) !== undefined, '未取到自身 id 时无法判回声')
  assert.equal(adapter.normalizeEvent(ROOM, undefined), undefined)
  assert.equal(adapter.normalizeEvent(ROOM, { type: undefined, sender: ALICE }), undefined)
  assert.equal(adapter.normalizeEvent(ROOM, { type: 'm.room.create', sender: ALICE, event_id: 'X' }), undefined)
  assert.equal(adapter.normalizeEvent(ROOM, { type: 'm.room.message', event_id: 'X', content: { msgtype: 'm.text', body: '无 sender' } }), undefined)
  assert.equal(adapter.normalizeEvent(ROOM, { type: 'm.room.message', event_id: 'X', sender: '', content: {} }), undefined)
  const unknown = adapter.normalizeEvent('!pending:example.org', msgEvent({ content: { msgtype: 'm.text', body: 'x' } }))
  assert.equal(unknown.address.kind, 'group', '未判定房间按 group（未点名不响应）')
  assert.equal(adapter.normalizeEvent(ROOM, { type: 'm.room.message', event_id: 'EN', sender: ALICE, content: {} }).text, '[暂不支持的消息类型: unknown]', '无 msgtype → unknown 占位')
  await adapter.connect()
  assert.equal(adapter.normalizeEvent(ROOM, msgEvent({ sender: BOT })), undefined, 'whoami 后自身回声丢弃')
  await adapter.disconnect()
})

test('onMessage：退订函数移除监听', async () => {
  const fetch = fakeFetch(makeRoute(), [
    () => syncBody({ join: { [ROOM]: roomFace([]) } }, 's1'),
    () => syncBody({ join: { [ROOM]: roomFace([msgEvent()]) } }, 's2'),
  ])
  const got = []
  const adapter = new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: BASE, fetchImpl: fetch.impl, dmRoomList: [ROOM] })
  const off = adapter.onMessage((m) => got.push(m))
  off()
  await adapter.connect()
  await waitUntil(() => syncProcessed(fetch, 2))
  assert.deepEqual(got, [])
  await adapter.disconnect()
})

// —— 出站面 ——————————————————————————————————————

test('reply：PUT /rooms/{roomId}/send/m.room.message/{txnId} + body 形态 + txnId 互异 + Receipt', async () => {
  const { adapter, fetch } = newAdapter()
  const r1 = await adapter.reply(dmAddr, '第一条')
  const r2 = await adapter.reply(dmAddr, '第二条')
  const puts = fetch.sends()
  assert.equal(puts.length, 2)
  assert.equal(puts[0].method, 'PUT')
  assert.equal(puts[0].path, `/_matrix/client/v3/rooms/${encodeURIComponent(ROOM)}/send/m.room.message/${encodeURIComponent(txnOf(puts[0]))}`)
  assert.equal(roomOf(puts[0]), ROOM, 'roomId 走路径且被正确编码')
  assert.match(txnOf(puts[0]), /^imu-[0-9a-z]+-[0-9a-z]+$/)
  assert.notEqual(txnOf(puts[0]), txnOf(puts[1]), '同设备 txnId 必须单调唯一')
  assert.equal(puts[0].headers.authorization, `Bearer ${TOKEN}`)
  assert.deepEqual(puts[0].body, { msgtype: 'm.text', body: '第一条' })
  assert.equal(r1.platformMessageId, 'EV1')
  assert.equal(r1.uncertain, false)
  assert.equal(r2.platformMessageId, 'EV2')
})

test('reply：正文按 4000 码点封顶截断（修复回归：不再切代理对）', async () => {
  const { adapter, fetch } = newAdapter()
  await adapter.reply(dmAddr, 'x'.repeat(MATRIX_MAX_MESSAGE + 1))
  const body = fetch.sends()[0].body.body
  assert.equal(MATRIX_MAX_MESSAGE, 4000)
  assert.equal(body.length, 4000)
  assert.ok(body.endsWith('…'))
  // 修复后按码点计数：3998 个 a + 😀 + b = 4000 码点 → 不截；超一码点才截且整对代理同进同出
  const cut = 'a'.repeat(3998) + '😀' + 'b'
  await adapter.reply(dmAddr, cut)
  const b2 = fetch.sends()[1].body.body
  assert.equal(b2, cut, '码点口径恰好 4000 不截断')
  const over = 'a'.repeat(3999) + '😀' + 'b'
  await adapter.reply(dmAddr, over)
  const b3 = fetch.sends()[2].body.body
  assert.ok(!/[\ud800-\udfff]$/.test(b3.slice(0, -1)) || b3.endsWith('…'), '截断位不留孤立高位代理')
  assert.ok(b3.endsWith('…'))
})

test('reply：200 无 event_id 视为「已接受但无 id」；4xx 确定性；5xx/体不可解/网络断 = Uncertain', async () => {
  const a = newAdapter({ fetch: fakeFetch(makeRoute({ send: res(200, {}) })) })
  assert.deepEqual(await a.adapter.reply(dmAddr, 'x'), { uncertain: false })
  const b = newAdapter({
    fetch: fakeFetch(makeRoute({ send: (entry, n) => (n === 1 ? res(403, { errcode: 'M_FORBIDDEN', error: 'You are not in the room' }) : res(200, {})) })),
  })
  await assert.rejects(b.adapter.reply(dmAddr, 'x'), (error) => {
    assert.ok(error instanceof MatrixApiError)
    assert.equal(error.status, 403)
    assert.equal(error.errcode, 'M_FORBIDDEN')
    assert.match(error.message, /M_FORBIDDEN You are not in the room/)
    return true
  })
  const c = newAdapter({ fetch: fakeFetch(makeRoute({ send: res(500, { error: 'boom' }) })) })
  await assert.rejects(c.adapter.reply(dmAddr, 'x'), (error) => {
    assert.ok(error instanceof MatrixUncertainError)
    assert.match(error.message, /HTTP 500/)
    return true
  })
  const d = newAdapter({ fetch: fakeFetch(makeRoute({ send: { ok: true, status: 200, json: async () => { throw new Error('bad json') }, headers: { get: () => null } } })) })
  await assert.rejects(d.adapter.reply(dmAddr, 'x'), /成功响应体不可解析/)
  const e = newAdapter({ fetch: fakeFetch(makeRoute({ send: () => { throw new Error('socket hang up') } })) })
  await assert.rejects(e.adapter.reply(dmAddr, 'x'), (error) => {
    assert.ok(error instanceof MatrixUncertainError)
    assert.match(error.message, /网络异常 socket hang up/)
    return true
  })
  const f = newAdapter({ fetch: fakeFetch(makeRoute({ send: () => { throw abortError() } })) })
  await assert.rejects(f.adapter.reply(dmAddr, 'x'), { name: 'AbortError' }, 'abort 必须原样上抛，不谎报结果不明')
})

test('429 retry_after_ms：等待后重传「同一 txnId」（PUT 幂等面）', async () => {
  const { adapter, fetch } = newAdapter({
    fetch: fakeFetch(makeRoute({
      send: (entry, n) => (n === 1 ? res(429, { errcode: 'M_LIMIT_EXCEEDED', error: 'Too Many Requests', retry_after_ms: 5 }) : res(200, { event_id: 'EVOK' })),
    })),
  })
  const receipt = await adapter.reply(dmAddr, '限流后仍要发出去')
  const puts = fetch.sends()
  assert.equal(puts.length, 2, '429 只重试一次即成功')
  assert.equal(puts[0].url, puts[1].url, '同一 txnId 重传（协议许可的幂等面）')
  assert.deepEqual(puts[0].body, puts[1].body)
  assert.equal(receipt.platformMessageId, 'EVOK')
})

test('429 Retry-After 头（秒）同驱动重传；无任何重试提示 → 确定性拒绝不盲等', async () => {
  const byHeader = newAdapter({
    fetch: fakeFetch(makeRoute({
      send: (entry, n) => (n === 1 ? res(429, { errcode: 'M_LIMIT_EXCEEDED', error: 'Slow Down' }, { 'Retry-After': '0.01' }) : res(200, { event_id: 'EVH' })),
    })),
  })
  assert.equal((await byHeader.adapter.reply(dmAddr, 'x')).platformMessageId, 'EVH')
  assert.equal(byHeader.fetch.sends().length, 2, 'v1.10 起 Retry-After 头形态也要读')
  const bare = newAdapter({
    fetch: fakeFetch(makeRoute({ send: res(429, { errcode: 'M_LIMIT_EXCEEDED', error: 'Slow Down' }) })),
  })
  await assert.rejects(bare.adapter.reply(dmAddr, 'x'), (error) => {
    assert.ok(error instanceof MatrixApiError)
    assert.equal(error.status, 429)
    assert.equal(error.errcode, 'M_LIMIT_EXCEEDED')
    return true
  })
  assert.equal(bare.fetch.sends().length, 1, '没有重试提示就不猜')
})

test('429 retry_after_ms 超 5000ms 封顶 → 不盲等，直接确定性拒绝', async () => {
  const { adapter, fetch } = newAdapter({
    fetch: fakeFetch(makeRoute({ send: res(429, { errcode: 'M_LIMIT_EXCEEDED', error: 'Too Many Requests', retry_after_ms: 60000 }) })),
  })
  const start = Date.now()
  await assert.rejects(adapter.reply(dmAddr, 'x'), MatrixApiError)
  assert.ok(Date.now() - start < 1000, '绝不睡 60 秒等限流')
  assert.equal(fetch.sends().length, 1)
})

test('429 尝试上限 3：两次限流后第三次成功；三次全限流 → MatrixApiError', async () => {
  const ok3 = newAdapter({
    fetch: fakeFetch(makeRoute({
      send: (entry, n) => (n < 3 ? res(429, { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 1 }) : res(200, { event_id: 'EV3' })),
    })),
  })
  assert.equal((await ok3.adapter.reply(dmAddr, 'x')).platformMessageId, 'EV3')
  assert.equal(ok3.fetch.sends().length, 3)
  const always = newAdapter({
    fetch: fakeFetch(makeRoute({ send: res(429, { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 1 }) })),
  })
  await assert.rejects(always.adapter.reply(dmAddr, 'x'), MatrixApiError)
  assert.equal(always.fetch.sends().length, 3, '封顶 3 次尝试（1 首次 + 2 重传）')
})

test('429 只在幂等面重试：whoami（未开 retryOn429）429 → 立即抛，单次请求', async () => {
  const fetch = fakeFetch(makeRoute({ whoami: res(429, { errcode: 'M_LIMIT_EXCEEDED', error: 'Slow Down', retry_after_ms: 5 }) }))
  const adapter = new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: BASE, fetchImpl: fetch.impl })
  await assert.rejects(adapter.connect(), MatrixApiError)
  assert.equal(fetch.matching('/whoami').length, 1)
})

// —— 编辑流式 ——————————————————————————————————————

test('beginStream：首发取 event_id 为原始事件，后续 update 走 m.replace + m.new_content 且恒指原始 id', async () => {
  const { adapter, fetch } = newAdapter({ options: { editThrottleMs: 0 } })
  const stream = await adapter.beginStream(groupAddr)
  await stream.update('第一段')
  await stream.update('第一段改')
  await stream.update('第一段改二')
  const receipt = await stream.finish('最终版')
  const puts = fetch.sends()
  assert.equal(puts.length, 4)
  assert.deepEqual(puts[0].body, { msgtype: 'm.text', body: '第一段' }, '首发为普通消息，无关系字段')
  assert.equal(puts[1].body.msgtype, 'm.text')
  assert.equal(puts[1].body.body, '* 第一段改', '回退体带 `* ` 前缀（老客户端可读）')
  assert.deepEqual(puts[1].body['m.new_content'], { msgtype: 'm.text', body: '第一段改' })
  assert.deepEqual(puts[1].body['m.relates_to'], { rel_type: 'm.replace', event_id: 'EV1' })
  assert.deepEqual(puts[2].body['m.relates_to'], { rel_type: 'm.replace', event_id: 'EV1' }, '编辑的编辑仍指向原始事件（聚合语义）')
  assert.deepEqual(puts[3].body['m.new_content'], { msgtype: 'm.text', body: '最终版' })
  assert.equal(new Set(puts.map(txnOf)).size, 4, '每次 PUT 都用新 txnId')
  assert.equal(receipt.platformMessageId, 'EV1')
  assert.equal(receipt.uncertain, false)
})

test('beginStream：首发拿不到 event_id 时后续整条重发；编辑被确定性拒绝 → 补发新消息接替', async () => {
  const noId = newAdapter({ fetch: fakeFetch(makeRoute({ send: res(200, {}) })), options: { editThrottleMs: 0 } })
  const s1 = await noId.adapter.beginStream(dmAddr)
  await s1.update('a')
  await s1.update('b')
  assert.deepEqual(noId.fetch.sends().map((c) => c.body), [{ msgtype: 'm.text', body: 'a' }, { msgtype: 'm.text', body: 'b' }])
  assert.deepEqual(await s1.finish('c'), { uncertain: false })
  const refused = newAdapter({
    fetch: fakeFetch(makeRoute({
      send: (entry, n) => (n === 1 ? res(200, { event_id: 'E1' }) : n === 2 ? res(403, { errcode: 'M_FORBIDDEN', error: 'Cannot edit' }) : res(200, { event_id: 'E2' })),
    })),
    options: { editThrottleMs: 0 },
  })
  const s2 = await refused.adapter.beginStream(dmAddr)
  await s2.update('第一段')
  await s2.update('第二段')
  const puts = refused.fetch.sends()
  assert.equal(puts.length, 3, '编辑被拒后补发一条接替（宁可多发不丢）')
  assert.ok(puts[1].body['m.relates_to'] !== undefined, '第二次尝试的是编辑')
  assert.deepEqual(puts[2].body, { msgtype: 'm.text', body: '第二段' }, '接替走普通发送面')
})

test('beginStream：编辑结果不明（5xx）→ 上抛 Uncertain 不盲目接替；失败不带毒后续拍（修复回归）', async () => {
  const f = fakeFetch(makeRoute({ send: (entry, n) => (n === 1 ? res(200, { event_id: 'E1' }) : res(503, {})) }))
  const adapter = new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: BASE, fetchImpl: f.impl, editThrottleMs: 0 })
  const stream = await adapter.beginStream(dmAddr)
  await stream.update('a')
  await assert.rejects(stream.update('b'), MatrixUncertainError)
  assert.equal(f.sends().length, 2, '结果不明绝不盲重试/盲目补发')
  // 修复后：链体不带毒——后续拍照常执行；abort 后 update/finish 静默收尾并报 Receipt。
  stream.abort()
  await stream.update('c')
  const receipt = await stream.finish('d')
  assert.equal(receipt.platformMessageId, 'E1', 'abort 后 finish 仍能干净收尾')
  assert.equal(receipt.uncertain, false)
  assert.equal(f.sends().length, 2, 'abort 后确实不再发新请求')
})

test('beginStream：abort() 后停止发送，finish 仍回原始 event_id', async () => {
  const { adapter, fetch } = newAdapter({ options: { editThrottleMs: 0 } })
  const stream = await adapter.beginStream(dmAddr)
  await stream.update('a')
  stream.abort()
  await stream.update('b')
  const receipt = await stream.finish('c')
  assert.equal(fetch.sends().length, 1, 'abort 后不再发新请求')
  assert.equal(receipt.platformMessageId, 'EV1')
  assert.equal(receipt.uncertain, false)
})

test('beginStream：editThrottleMs 节流生效（Matrix 速率限制按设备桶）', async () => {
  const { adapter, fetch } = newAdapter({ options: { editThrottleMs: 40 } })
  const stream = await adapter.beginStream(dmAddr)
  await stream.update('a')
  await stream.update('ab')
  const puts = fetch.sends()
  assert.equal(puts.length, 2)
  assert.ok(puts[1].at - puts[0].at >= 30, `实测间隔 ${puts[1].at - puts[0].at}ms`)
})

test('setTyping：PUT /rooms/{roomId}/typing 体 {typing:true,timeout:20000}；失败不打断回合', async () => {
  const { adapter, fetch, lines } = newAdapter({ options: { dmRoomList: [ROOM] } })
  await adapter.setTyping(dmAddr)
  const typing = fetch.matching('/typing')[0]
  assert.equal(typing.method, 'PUT')
  assert.equal(typing.url, `${BASE}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM)}/typing`)
  assert.ok(!typing.url.includes(encodeURIComponent(BOT)), 'v1.1 起路径不再带 userId')
  assert.deepEqual(typing.body, { typing: true, timeout: 20000 })
  const bad = newAdapter({ fetch: fakeFetch(makeRoute({ typing: res(400, { errcode: 'M_BAD_JSON', error: 'bad' }) })) })
  await bad.adapter.setTyping(dmAddr)
  assert.ok(bad.lines.some((l) => l.includes('typing 失败')), '确定性失败只记日志')
  const net = newAdapter({ fetch: fakeFetch(makeRoute({ typing: res(500, {}) })) })
  await net.adapter.setTyping(dmAddr)
  assert.deepEqual(net.lines, [], '结果不明的 typing 静默')
})

// —— E2EE 两模式 ——————————————————————————————————————

test('E2EE optional（默认）：m.room.encrypted → 占位文案不丢事件，且不探加密状态', async () => {
  const fetch = fakeFetch(makeRoute(), [
    () => syncBody({ join: { [ROOM]: roomFace([]) } }, 's1'),
    () => syncBody({ join: { [ROOM]: roomFace([encEvent({ event_id: 'ENC1' })]) } }, 's2'),
  ])
  const got = []
  const adapter = new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: BASE, fetchImpl: fetch.impl, dmRoomList: [ROOM] })
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  await waitUntil(() => syncProcessed(fetch, 2))
  assert.deepEqual(got.map((m) => m.text), [ENCRYPTED_PLACEHOLDER], '加密消息不丢，回合可见「有消息但解不开」')
  assert.equal(got[0].address.kind, 'dm')
  assert.equal(got[0].userId, ALICE)
  assert.equal(fetch.matching('/state/m.room.encryption').length, 0, 'optional 模式不为加密判定花请求')
  assert.equal(adapter.refusedRoomIds.length, 0)
  await adapter.disconnect()
})

test('E2EE required：state 有 algorithm → 拒连房间（不消费事件、诊断 e2ee failed、出站本地拒发）', async () => {
  const fetch = fakeFetch(makeRoute({ encryption: res(200, { algorithm: 'm.megolm.v1.aes-sha2', rotation_period_ms: 604800000 }) }), [
    () => syncBody({ join: { [ROOM]: roomFace([msgEvent(), encEvent({ event_id: 'ENCX' })]) } }, 's1'),
    () => syncBody({ join: { [ROOM]: roomFace([msgEvent({ event_id: 'EZ' })]) } }, 's2'),
  ])
  const lines = []
  const got = []
  const adapter = new MatrixAdapter({
    accessToken: TOKEN,
    homeserverBaseUrl: BASE,
    encryption: 'required',
    fetchImpl: fetch.impl,
    logger: (m) => lines.push(m),
  })
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  await waitUntil(() => syncProcessed(fetch, 2))
  assert.deepEqual(adapter.refusedRoomIds, [ROOM])
  assert.deepEqual(got, [], '拒连房间的事件一律不消费')
  assert.equal(fetch.matching('/members').length, 0, '拒连先于 kind 判定，省掉成员面')
  assert.equal(fetch.matching('/state/m.room.encryption').length, 1, '探测结果按房间缓存')
  assert.ok(lines.some((l) => l.includes(`拒连加密房间 ${ROOM}`)))
  await assert.rejects(adapter.reply(dmAddr, '明文不得进加密房间'), (error) => {
    assert.ok(error instanceof MatrixApiError)
    assert.equal(error.status, 403)
    assert.equal(error.errcode, 'IMU_E2EE_REFUSED')
    assert.match(error.message, /E2EE required 模式拒连加密房间/)
    return true
  })
  assert.equal(fetch.sends().length, 0, '本地拒发，不发 PUT')
  const stream = await adapter.beginStream(dmAddr)
  await assert.rejects(stream.update('x'), /IMU_E2EE_REFUSED|E2EE required 模式拒连/)
  const checks = await adapter.diagnose()
  const e2ee = checks.find((c) => c.name === 'e2ee')
  assert.equal(e2ee.status, 'failed')
  assert.match(e2ee.hint, /required 模式已拒连 1 个加密房间/)
  assert.ok(e2ee.hint.includes(ROOM) && e2ee.hint.includes('olm'))
  const syncCheck = checks.find((c) => c.name === 'sync')
  assert.match(syncCheck.hint, /拒连 1 个/)
  await adapter.disconnect()
})

test('E2EE required：invite_state 声明加密的邀请不 join；明文邀请正常 POST /join（403 只记日志）', async () => {
  const ENC = '!encinvite:example.org'
  const OPEN = '!openinvite:example.org'
  const FORBID = '!forbid:example.org'
  const fetch = fakeFetch(
    makeRoute({
      join: (entry) => (roomOf(entry) === FORBID ? res(403, { errcode: 'M_FORBIDDEN', error: 'You are not invited' }) : res(200, { room_id: roomOf(entry) })),
    }),
    [
      () =>
        res(200, {
          next_batch: 's1',
          rooms: {
            invite: {
              [ENC]: { invite_state: { events: [memberEvent(ALICE, 'join', 'Alice'), { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }] } },
              [OPEN]: { invite_state: { events: [memberEvent(ALICE, 'join', 'Alice')] } },
              [FORBID]: { invite_state: { events: [] } },
            },
          },
        }),
    ],
  )
  const lines = []
  const adapter = new MatrixAdapter({
    accessToken: TOKEN,
    homeserverBaseUrl: BASE,
    encryption: 'required',
    fetchImpl: fetch.impl,
    logger: (m) => lines.push(m),
  })
  await adapter.connect()
  const joins = fetch.matching('/join/').map(roomOf)
  assert.deepEqual(joins, [OPEN, FORBID], '加密邀请面一律不 join')
  assert.ok(adapter.refusedRoomIds.includes(ENC))
  assert.ok(lines.some((l) => l.includes(`拒绝加入加密邀请房间 ${ENC}`)))
  assert.ok(lines.some((l) => l.includes(`加入 ${FORBID} 被拒（403，需邀请权限）`)), '403 不炸整轮 sync')
  assert.equal(fetch.matching('/state/m.room.encryption').length, 0, '邀请面只看 invite_state')
  await adapter.disconnect()
})

test('E2EE required：探测不明 fail-closed 拒连+负缓存；404 明文放行（e2ee passed）', async () => {
  const R1 = '!probe:example.org'
  const uncertain = newAdapter({
    options: { encryption: 'required', dmRoomList: [R1] },
    fetch: fakeFetch(makeRoute({ encryption: (entry, n) => (n === 1 ? res(500, { error: 'boom' }) : res(404, { errcode: 'M_NOT_FOUND' })) }), [
      () => syncBody({ join: { [R1]: roomFace([]) } }, 's1'),
      () => syncBody({ join: { [R1]: roomFace([msgEvent({ event_id: 'PU', content: { body: '不明不判死' } })]) } }, 's2'),
    ]),
  })
  const got = []
  uncertain.adapter.onMessage((m) => got.push(m))
  await uncertain.adapter.connect()
  await waitUntil(() => syncProcessed(uncertain.fetch, 2))
  // 修复后：required + 探测不明 → 无法证明非加密即拒连（明文泄漏风险重于误拒）
  assert.deepEqual(got.map((m) => m.text), [], '探测不明时拒连该房间，不投递内容')
  assert.deepEqual(uncertain.adapter.refusedRoomIds, [R1], '不明探测按拒连处理')
  assert.ok(uncertain.lines.some((l) => l.includes('加密状态探测不明')))
  // 修复后：拒连决策被记账，第二轮 rejected 直跳——探测只发生一次（负缓存）
  assert.equal(uncertain.fetch.matching('/state/m.room.encryption').length, 1, '拒连后不逐轮重探')
  const uChecks = await uncertain.adapter.diagnose()
  assert.equal(uChecks.find((c) => c.name === 'e2ee').status, 'failed', '拒连实锤即报 failed（fail-closed 可见）')
  assert.ok(uChecks.find((c) => c.name === 'e2ee').hint.includes(R1), 'hint 点名被拒房间与原因')
  await uncertain.adapter.disconnect()
  const plain = newAdapter({
    options: { encryption: 'required', dmRoomList: [R1] },
    fetch: fakeFetch(makeRoute(), [() => syncBody({ join: { [R1]: roomFace([]) } }, 's1')]),
  })
  await plain.adapter.connect()
  const checks = await plain.adapter.diagnose()
  assert.equal(checks.find((c) => c.name === 'e2ee').status, 'passed')
  assert.match(checks.find((c) => c.name === 'e2ee').hint, /未检出已启用加密的房间/)
  assert.equal(plain.fetch.matching('/state/m.room.encryption').length, 1, '404 明文结果被缓存')
  await plain.adapter.disconnect()
})

test('normalizeEvent 加密双保险：required 模式即使事件漏到归一半也丢事件', async () => {
  const adapter = new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: BASE, encryption: 'required' })
  assert.equal(adapter.normalizeEvent(ROOM, encEvent({ event_id: 'EB' })), undefined, '无解密面时不伪称解密成功')
  const optional = new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: BASE })
  assert.equal(optional.normalizeEvent(ROOM, encEvent({ event_id: 'EB2' })).text, ENCRYPTED_PLACEHOLDER)
})

// —— 诊断 ——————————————————————————————————————

test('诊断三态：token-valid/sync/e2ee/roundtrip，passed|failed|unverified 且 hint 零 token 回显', async () => {
  const fetch = fakeFetch(makeRoute(), [() => syncBody({ join: { [ROOM]: roomFace([]) } }, 's1')])
  const adapter = new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: BASE, fetchImpl: fetch.impl })
  await adapter.connect()
  const checks = await adapter.diagnose()
  assert.deepEqual(checks.map((c) => c.name), ['token-valid', 'sync', 'e2ee', 'roundtrip', 'file-surface'])
  assert.deepEqual(checks.map((c) => c.status), ['passed', 'passed', 'unverified', 'unverified', 'unverified'])
  assert.equal(checks[0].hint, BOT, 'hint 只回显 user_id')
  assert.ok(typeof checks[0].elapsedMs === 'number')
  assert.match(checks[1].hint, /已观测房间 1 个，游标已滚动/)
  assert.match(checks[2].hint, /optional 模式：olm 解密面未接/)
  assert.match(checks[3].hint, /真机验证/)
  assert.ok(!checks.some((c) => `${c.hint ?? ''}`.includes(TOKEN)), '任何 hint 不得带出 token')
  await adapter.disconnect()

  const idle = new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: BASE, fetchImpl: fakeFetch(makeRoute()).impl })
  const idleChecks = await idle.diagnose()
  assert.equal(idleChecks[1].status, 'unverified')
  assert.equal(idleChecks[1].hint, '未连接')
})

test('诊断：401 M_UNKNOWN_TOKEN → token-valid failed；网络断 → unverified（不把不确定说成失败）', async () => {
  const bad = new MatrixAdapter({
    accessToken: TOKEN,
    homeserverBaseUrl: BASE,
    fetchImpl: fakeFetch(makeRoute({ whoami: res(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Unrecognized access token' }) })).impl,
  })
  const checks = await bad.diagnose()
  assert.equal(checks[0].status, 'failed')
  assert.match(checks[0].hint, /access token 无效或已吊销/)
  const net = new MatrixAdapter({
    accessToken: TOKEN,
    homeserverBaseUrl: BASE,
    fetchImpl: fakeFetch(() => {
      throw new Error('socket hang up')
    }).impl,
  })
  const netChecks = await net.diagnose()
  assert.equal(netChecks[0].status, 'unverified')
  assert.match(netChecks[0].hint, /网络结果不明，未据此判死/)
  assert.equal(netChecks[3].status, 'unverified')
})

// —— 工具面 ——————————————————————————————————————

test('stripReplyFallback：引用块剥离、无回退块原样、单独 ">"/"> " 收尾、quote 200 字截断', () => {
  assert.deepEqual(stripReplyFallback('> <@a:b> 原文\n> \n正文'), { text: '正文', quote: '<@a:b> 原文' })
  assert.deepEqual(stripReplyFallback('> 一\n> 二\n>'), { text: '', quote: '一\n二' })
  assert.deepEqual(stripReplyFallback('直接正文'), { text: '直接正文' })
  assert.deepEqual(stripReplyFallback('> 没有收尾行的引用'), { text: '> 没有收尾行的引用' }, '修复回归：无 "> " 收尾行时全量当正文，不吞内容')
  assert.deepEqual(stripReplyFallback('> \n只有收尾行'), { text: '只有收尾行' }, '引用为空时不给 quote')
  const long = `> ${'字'.repeat(220)}\n> \n回`
  const out = stripReplyFallback(long)
  assert.equal(out.quote.length, 200)
  assert.equal(out.text, '回')
})

// —— 能力位与准入 ——————————————————————————————————————

test('能力位与准入：editStream true / nativeStream false / imageIn false / maxMessageLength 4000；authorize 恒 undefined', () => {
  const { adapter } = newAdapter()
  assert.deepEqual(adapter.caps, {
    editStream: true,
    nativeStream: false,
    nativeChoices: false,
    statusReaction: false,
    typing: true,
    imageIn: false,
    fileIn: true,
    fileOut: true,
    threads: false,
    voice: false,
    maxMessageLength: 4000,
  })
  assert.equal(adapter.authorize(), undefined, '私聊裁决归网关白名单（红线 D6），渠道不越权')
  assert.equal(typeof adapter.sendFile, 'function', 'fileOut=true ⇒ 必须真挂了方法（声明=实装）')
  assert.equal(adapter.askChoices, undefined, '本期无按钮面')
})

// —— 文件面（T2.4）——————————————————————————————————

const binRes = (status, bytes) => ({
  ok: status >= 200 && status < 399,
  status,
  json: async () => undefined,
  arrayBuffer: async () => new Uint8Array(bytes).buffer,
  headers: { get: () => null },
})

/** 媒体面路由：上传/下载 可逐例接管，其余走默认面。 */
function mediaRoute(over = {}) {
  const base = makeRoute()
  const state = { uploads: 0, downloads: 0 }
  const route = (entry, calls) => {
    if (entry.path.startsWith('/_matrix/media/v3/upload')) {
      state.uploads += 1
      return over.upload !== undefined ? over.upload(entry, state) : res(200, { content_uri: 'mxc://example.org/MEDIA1' })
    }
    if (entry.path.startsWith('/_matrix/client/v1/media/download/')) {
      state.downloads += 1
      return over.download !== undefined ? over.download(entry, state) : binRes(200, [9, 8, 7])
    }
    return base(entry, calls)
  }
  route.state = state
  return route
}

test('sendFile：POST /_matrix/media/v3/upload 原始字节 → PUT m.file 事件（url/file 同 mxc）', async () => {
  const route = mediaRoute()
  const fetch = fakeFetch(route)
  const { adapter } = newAdapter({ fetch })
  const receipt = await adapter.sendFile(
    { channel: 'matrix', kind: 'dm', chatId: ROOM },
    { name: 'data.csv', data: new Uint8Array([1, 2, 3]), mimeType: 'text/csv' },
  )
  const up = fetch.calls.find((c) => c.path === '/_matrix/media/v3/upload')
  assert.equal(up.method, 'POST')
  assert.equal(up.query.get('filename'), 'data.csv', 'filename 走查询参')
  assert.equal(up.headers.authorization, `Bearer ${TOKEN}`, '上传带 access token')
  assert.equal(up.headers['content-type'], 'text/csv')
  assert.ok(up.raw instanceof Uint8Array, '原始字节直传（不包 JSON/multipart）')
  assert.deepEqual([...up.raw], [1, 2, 3])
  assert.equal(up.body, undefined, '上传体不作 JSON 解析')
  assert.deepEqual(fetch.sends()[0].body, {
    msgtype: 'm.file',
    body: 'data.csv',
    url: 'mxc://example.org/MEDIA1',
    file: { url: 'mxc://example.org/MEDIA1', mimetype: 'text/csv', size: 3 },
  })
  assert.equal(fetch.sends()[0].method, 'PUT', '事件发送走 PUT + txnId（幂等位）')
  assert.deepEqual(receipt, { platformMessageId: 'EV1', uncertain: false })
})

test('sendFile：mimeType 缺省 → application/octet-stream（不伪造类型）', async () => {
  const route = mediaRoute()
  const fetch = fakeFetch(route)
  const { adapter } = newAdapter({ fetch })
  await adapter.sendFile({ channel: 'matrix', kind: 'dm', chatId: ROOM }, { name: 'a.bin', data: new Uint8Array([1]) })
  assert.equal(fetch.calls.find((c) => c.path === '/_matrix/media/v3/upload').headers['content-type'], 'application/octet-stream')
  assert.equal(fetch.sends()[0].body.file.mimetype, 'application/octet-stream')
})

test('sendFile：上传 4xx → MatrixApiError（确定性，不再发事件）', async () => {
  const route = mediaRoute({ upload: () => res(400, { errcode: 'M_TOO_LARGE', error: 'file too large' }) })
  const fetch = fakeFetch(route)
  const { adapter } = newAdapter({ fetch })
  await assert.rejects(
    adapter.sendFile({ channel: 'matrix', kind: 'dm', chatId: ROOM }, { name: 'a.bin', data: new Uint8Array([1]) }),
    (error) => error instanceof MatrixApiError && error.errcode === 'M_TOO_LARGE',
  )
  assert.equal(fetch.sends().length, 0, '上传未成即不发事件')
  assert.equal(route.state.uploads, 1, '确定性失败不自作重试')
})

test('sendFile：上传 5xx / 传输错 → uncertain（D7 禁自动重发）', async () => {
  const five = fakeFetch(mediaRoute({ upload: () => res(503, {}) }))
  const a1 = newAdapter({ fetch: five }).adapter
  await assert.rejects(
    a1.sendFile({ channel: 'matrix', kind: 'dm', chatId: ROOM }, { name: 'a.bin', data: new Uint8Array([1]) }),
    MatrixUncertainError,
  )
  assert.equal(five.calls.filter((c) => c.path === '/_matrix/media/v3/upload').length, 1, '结果不明也不重传（D7）')
  assert.equal(five.sends().length, 0, '上传未落即不发事件')
  const boom = fakeFetch(mediaRoute({ upload: () => { throw new Error('socket hang up') } }))
  const a2 = newAdapter({ fetch: boom }).adapter
  await assert.rejects(
    a2.sendFile({ channel: 'matrix', kind: 'dm', chatId: ROOM }, { name: 'a.bin', data: new Uint8Array([1]) }),
    MatrixUncertainError,
  )
})

test('sendFile：200 但无 content_uri → 确定性抛（不伪称已投）', async () => {
  const fetch = fakeFetch(mediaRoute({ upload: () => res(200, {}) }))
  const { adapter } = newAdapter({ fetch })
  await assert.rejects(
    adapter.sendFile({ channel: 'matrix', kind: 'dm', chatId: ROOM }, { name: 'a.bin', data: new Uint8Array([1]) }),
    (error) => error instanceof MatrixApiError && error.errcode === 'IMU_NO_CONTENT_URI',
  )
  assert.equal(fetch.sends().length, 0)
})

test('入站 m.file：走 /media/download 拉字节填 files（文本仅做可读标注）', async () => {
  const route = mediaRoute()
  const fetch = fakeFetch(
    route,
    [
      () => syncBody({ join: { [ROOM]: roomFace([]) } }, 's1'),
      () =>
        syncBody(
          {
            join: {
              [ROOM]: roomFace([
                msgEvent({
                  event_id: 'F1',
                  content: { msgtype: 'm.file', body: 'data.json', url: 'mxc://example.org/M1', size: 3 },
                }),
              ]),
            },
          },
          's2',
        ),
    ],
    { holdMs: 0 },
  )
  const got = []
  const adapter = new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: BASE, fetchImpl: fetch.impl })
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  await waitUntil(() => got.length === 1)
  assert.equal(got[0].text, '[文件消息]')
  assert.equal(got[0].files.length, 1)
  assert.equal(got[0].files[0].name, 'data.json')
  assert.deepEqual([...got[0].files[0].data], [9, 8, 7])
  const dl = fetch.calls.find((c) => c.path.startsWith('/_matrix/client/v1/media/download/'))
  assert.equal(dl.path, '/_matrix/client/v1/media/download/example.org/M1', 'mxc → 服务名/媒体id 分段')
  assert.equal(dl.headers.authorization, `Bearer ${TOKEN}`, '下载带 token')
  await adapter.disconnect()
})

test('入站文件降级：下载被拒/加密附件/超 20 MiB → 不丢消息且不填 files', async () => {
  const route = mediaRoute({ download: () => res(403, {}) })
  const fetch = fakeFetch(
    route,
    [
      () => syncBody({ join: { [ROOM]: roomFace([]) } }, 's1'),
      () =>
        syncBody(
          {
            join: {
              [ROOM]: roomFace([
                msgEvent({ event_id: 'F1', content: { msgtype: 'm.file', body: 'no.csv', url: 'mxc://example.org/M1' } }),
                msgEvent({
                  event_id: 'F2',
                  content: { msgtype: 'm.file', body: 'enc.csv', url: 'mxc://example.org/M2', file: { key: { kty: 'A256CTR' } } },
                }),
                msgEvent({
                  event_id: 'F3',
                  content: {
                    msgtype: 'm.file',
                    body: 'big.csv',
                    url: 'mxc://example.org/M3',
                    size: 21 * 1024 * 1024,
                  },
                }),
              ]),
            },
          },
          's2',
        ),
    ],
    { holdMs: 0 },
  )
  const got = []
  const adapter = new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: BASE, fetchImpl: fetch.impl })
  adapter.onMessage((m) => got.push(m))
  await adapter.connect()
  await waitUntil(() => got.length === 3)
  assert.deepEqual(got.map((m) => m.files), [undefined, undefined, undefined], '三种降级均不填字节')
  assert.deepEqual(got.map((m) => m.text), ['[文件消息]', '[文件消息]', '[文件消息]'], '降级不丢整条消息')
  assert.equal(route.state.downloads, 1, '仅第一个发起下载（加密/超限不拉）')
  await adapter.disconnect()
})

test('诊断：file-surface 恒 unverified（媒体面未实证不谎报 passed）', async () => {
  const { adapter } = newAdapter()
  const checks = await adapter.diagnose()
  const fileSurface = checks.find((c) => c.name === 'file-surface')
  assert.equal(fileSurface.status, 'unverified')
  assert.match(fileSurface.hint, /media\/v3\/upload/)
})

// —— 构造与工厂 ——————————————————————————————————————

test('构造校验：accessToken / homeserverBaseUrl 缺位即抛；尾斜杠剥离；默认档位 optional', () => {
  assert.throws(() => new MatrixAdapter({ accessToken: '', homeserverBaseUrl: BASE }), /accessToken 缺失/)
  assert.throws(() => new MatrixAdapter({ homeserverBaseUrl: BASE }), /accessToken 缺失/)
  assert.throws(() => new MatrixAdapter({ accessToken: TOKEN }), /homeserverBaseUrl 缺失/)
  assert.throws(() => new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: '' }), /homeserverBaseUrl 缺失/)
  const fetch = fakeFetch(makeRoute())
  const adapter = new MatrixAdapter({ accessToken: TOKEN, homeserverBaseUrl: `${BASE}///`, fetchImpl: fetch.impl })
  adapter.connect().catch(() => {})
  assert.equal(fetch.calls[0].url, `${BASE}/_matrix/client/v3/account/whoami`)
})

test('工厂校验：accessToken/homeserverBaseUrl 缺位即抛；encryption 严格解析', () => {
  const base = { accountId: 'dev', config: { homeserverBaseUrl: BASE }, secrets: { accessToken: TOKEN } }
  assert.throws(() => createMatrixAdapter({ ...base, secrets: {} }), /dev: accessToken 未入库/)
  assert.throws(() => createMatrixAdapter({ ...base, secrets: { accessToken: '' } }), /accessToken 未入库/)
  assert.throws(() => createMatrixAdapter({ accountId: 'dev', config: {}, secrets: { accessToken: TOKEN } }), /dev: homeserverBaseUrl 未配置/)
  assert.throws(
    () => createMatrixAdapter({ ...base, config: { homeserverBaseUrl: BASE, encryption: 'sometimes' } }),
    /config\.encryption 只能是 optional\|required/,
  )
  assert.ok(createMatrixAdapter(base) instanceof MatrixAdapter)
  assert.ok(createMatrixAdapter({ ...base, config: { homeserverBaseUrl: BASE, encryption: 'optional' } }) instanceof MatrixAdapter)
})

test('工厂配置生效（缺省走 globalThis.fetch，测试期临时替换）：required 拒连 + syncTimeoutMs + 尾斜杠', async () => {
  const fetch = fakeFetch(makeRoute({ encryption: res(200, { algorithm: 'm.megolm.v1.aes-sha2' }) }), [
    () => syncBody({ join: { [ROOM]: roomFace([msgEvent()]) } }, 's1'),
  ])
  await withGlobalFetch(fetch.impl, async () => {
    const adapter = createMatrixAdapter({
      accountId: 'dev',
      config: { homeserverBaseUrl: `${BASE}/`, encryption: 'required', syncTimeoutMs: '5000', dmRoomList: ROOM },
      secrets: { accessToken: TOKEN },
    })
    const got = []
    adapter.onMessage((m) => got.push(m))
    await adapter.connect()
    assert.equal(fetch.calls[0].url, `${BASE}/_matrix/client/v3/account/whoami`, '尾斜杠剥离且用全局 fetch')
    assert.equal(fetch.syncs[0].query.get('timeout'), '5000')
    assert.deepEqual(adapter.refusedRoomIds, [ROOM], 'config.encryption=required 生效')
    assert.equal(fetch.matching('/members').length, 0, '拒连先于成员面')
    await adapter.disconnect()
    assert.deepEqual(got, [])
  })
})

test('工厂：dmRoomList 逗号表（trim + 空项过滤）命中即 dm，未命中房间仍走成员面', async () => {
  const OTHER = '!other:example.org'
  const fetch = fakeFetch(makeRoute({ members: res(200, { chunk: [memberEvent(BOT, 'join'), memberEvent(ALICE, 'join'), memberEvent('@c:example.org', 'join')] }) }), [
    () => syncBody({ join: { [ROOM]: roomFace([]), [OTHER]: roomFace([]) } }, 's1'),
    () => syncBody({ join: { [ROOM]: roomFace([msgEvent({ event_id: 'DL' })]), [OTHER]: roomFace([msgEvent({ event_id: 'OL' })]) } }, 's2'),
  ])
  await withGlobalFetch(fetch.impl, async () => {
    const adapter = createMatrixAdapter({
      accountId: 'dev',
      config: { homeserverBaseUrl: BASE, dmRoomList: ` , ${ROOM},,${' '.repeat(2)}` },
      secrets: { accessToken: TOKEN },
    })
    const got = []
    adapter.onMessage((m) => got.push(m))
    await adapter.connect()
    await waitUntil(() => syncProcessed(fetch, 2))
    assert.deepEqual(got.map((m) => [m.address.chatId, m.address.kind]), [[ROOM, 'dm'], [OTHER, 'group']])
    assert.equal(fetch.matching('/members').length, 1, '点名房间不查成员面')
    await adapter.disconnect()
  })
})

test('工厂：syncTimeoutMs 非法值回落 30000；"0" 也拒收（修复回归：热循环下限）', async () => {
  const fetch = fakeFetch(makeRoute(), [() => syncBody({}, 's1')])
  await withGlobalFetch(fetch.impl, async () => {
    const adapter = createMatrixAdapter({
      accountId: 'dev',
      config: { homeserverBaseUrl: BASE, syncTimeoutMs: '-5' },
      secrets: { accessToken: TOKEN },
    })
    await adapter.connect()
    assert.equal(fetch.syncs[0].query.get('timeout'), '30000', '负值/非数字回落默认')
    await adapter.disconnect()
  })
  // 修复后：positiveIntOr 只收 >0，'0' 回落 30000（配合 pollLoop 最小间隔双重防热循环）
  const zero = fakeFetch(makeRoute(), [() => syncBody({}, 's1')])
  await withGlobalFetch(zero.impl, async () => {
    const adapter = createMatrixAdapter({ accountId: 'dev', config: { homeserverBaseUrl: BASE, syncTimeoutMs: '0' }, secrets: { accessToken: TOKEN } })
    await adapter.connect()
    assert.equal(zero.syncs[0].query.get('timeout'), '30000', '"0" 被拒收回落默认')
    await adapter.disconnect()
  })
})
