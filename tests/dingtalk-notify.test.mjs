// dingtalk-notify 单测：钉钉自定义机器人 Webhook 纯推送通知渠道。
// 三档安全帧形（sign 拼 query / keyword 自动补前缀 / none 直发）·
// body.errcode 判成败（反「HTTP 200 即成功」坑）· 310000 转译 · 网络 uncertain ·
// 工厂校验（缺 access_token / sign 档缺 secret 抛）· caps 全收信位 false · onMessage no-op。
// 网络面全注入 fake fetch + 固定时钟，不发真实请求。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  DingtalkNotifyAdapter,
  DingtalkNotifyApiError,
  DingtalkNotifyUncertainError,
  createDingtalkNotifyAdapter,
} from '../lib/channels/dingtalk-notify.js'

const OK = { errcode: 0, errmsg: 'ok' }

/** 记录式 fake fetch：按序返回 canned 响应（或抛错模拟网络故障）。 */
function makeFetch(...outcomes) {
  const calls = []
  let index = 0
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers })
    const outcome = outcomes[Math.min(index, outcomes.length - 1)]
    index += 1
    if (outcome instanceof Error) throw outcome
    if (typeof outcome === 'function') return outcome()
    const status = outcome?.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (outcome?.throwJson) throw new Error('unparseable')
        return outcome?.json ?? OK
      },
    }
  }
  return { fetchImpl, calls }
}

function adapter(options) {
  return new DingtalkNotifyAdapter({ token: 'TOK', security: 'none', ...options })
}

// —— 生命周期 / onMessage no-op ————————————————————

test('connect/disconnect 仅维护就绪标记（无长连接）', async () => {
  const a = adapter({})
  assert.equal(a.connected, false)
  await a.connect()
  assert.equal(a.connected, true)
  await a.disconnect()
  assert.equal(a.connected, false)
})

test('onMessage 返回 no-op 取消函数，listener 永不被回调（通知类渠道无入站）', async () => {
  const { fetchImpl } = makeFetch({ json: OK })
  const a = adapter({ fetchImpl })
  let fired = 0
  const off = a.onMessage(() => fired += 1)
  await a.reply({ channel: 'dingtalk-notify', kind: 'group', chatId: 'g' }, '通知')
  assert.equal(fired, 0, '出站发送不应触发入站 listener')
  assert.equal(typeof off, 'function')
  off()
})

// —— caps 一致性 ————————————————————————————

test('caps 全收信/交互位 false，maxMessageLength=20000，未挂流式/文件方法', () => {
  const a = adapter({})
  const c = a.caps
  for (const key of ['editStream', 'nativeStream', 'nativeChoices', 'statusReaction', 'statusProgress', 'typing', 'imageIn', 'fileIn', 'fileOut', 'threads', 'voice']) {
    assert.equal(c[key], false, `caps.${key} 应为 false`)
  }
  assert.equal(c.maxMessageLength, 20000)
  assert.equal(typeof a.beginStream, 'undefined', 'editStream/nativeStream=false → 不挂 beginStream')
  assert.equal(typeof a.sendFile, 'undefined', 'fileOut=false → 不挂 sendFile')
})

// —— none 档帧形 ————————————————————————————

test('none 档：query 仅 access_token（无 timestamp/sign），正文原样，errcode=0 判成', async () => {
  const { fetchImpl, calls } = makeFetch({ json: OK })
  const a = adapter({ security: 'none', fetchImpl })
  const receipt = await a.reply({ channel: 'dingtalk-notify', kind: 'group', chatId: 'g' }, '磁盘告警 90%')
  assert.equal(receipt.uncertain, false)
  assert.equal(receipt.keywordPrefixed, undefined, 'none 档不涉及补前缀')
  const url = new URL(calls[0].url)
  assert.equal(url.origin + url.pathname, 'https://oapi.dingtalk.com/robot/send')
  assert.equal(url.searchParams.get('access_token'), 'TOK')
  assert.equal(url.searchParams.get('timestamp'), null, 'none 档不应带 timestamp')
  assert.equal(url.searchParams.get('sign'), null, 'none 档不应带 sign')
  assert.deepEqual(calls[0].body, { msgtype: 'text', text: { content: '磁盘告警 90%' } })
  assert.equal(calls[0].headers['Content-Type'], 'application/json')
})

// —— keyword 档：自动补前缀（K1）————————————————

test('keyword 档未命中关键词 → 自动前置补入并在回执注明', async () => {
  const { fetchImpl, calls } = makeFetch({ json: OK })
  const a = adapter({ security: 'keyword', keyword: '【告警】', fetchImpl })
  const receipt = await a.reply({ channel: 'dingtalk-notify', kind: 'group', chatId: 'g' }, '数据库连接失败')
  assert.equal(calls[0].body.text.content, '【告警】 数据库连接失败')
  assert.equal(receipt.keywordPrefixed, true)
  assert.match(receipt.note, /已按关键词模板补前缀/)
})

test('keyword 档已含关键词 → 不重复补前缀', async () => {
  const { fetchImpl, calls } = makeFetch({ json: OK })
  const a = adapter({ security: 'keyword', keyword: '【告警】', fetchImpl })
  const receipt = await a.reply({ channel: 'dingtalk-notify', kind: 'group', chatId: 'g' }, '【告警】已确认的正文')
  assert.equal(calls[0].body.text.content, '【告警】已确认的正文', '命中即原样，不叠加前缀')
  assert.equal(receipt.keywordPrefixed, undefined)
})

// —— sign 档：拼 timestamp/sign（D 档算法）——————————————

test('sign 档：timestamp 毫秒 + sign=urlencode(base64(HmacSHA256(secret, ts+"\\n"+secret)))', async () => {
  const ts = '1700000000000'
  const secret = 'SECtestsecretvalue'
  const { fetchImpl, calls } = makeFetch({ json: OK })
  const a = adapter({ security: 'sign', signSecret: secret, now: () => Number(ts), fetchImpl })
  await a.reply({ channel: 'dingtalk-notify', kind: 'group', chatId: 'g' }, '加签通知')
  const raw = createHmac('sha256', secret).update(`${ts}\n${secret}`, 'utf8').digest('base64')
  const enc = encodeURIComponent(raw)
  const query = calls[0].url.split('?')[1]
  assert.ok(query.includes(`timestamp=${ts}`), 'query 应带毫秒 timestamp')
  assert.ok(query.includes(`sign=${enc}`), `query 应带 urlencode 后的 sign（期望片段 sign=${enc}）`)
  // 解码回原值一致（证明编码/拼接对象正确：仅 sign 被编码，timestamp 未编码）
  const url = new URL(calls[0].url)
  assert.equal(url.searchParams.get('sign'), raw)
  assert.equal(url.searchParams.get('timestamp'), ts)
  // sign 片段不应残留未编码的 base64 特殊字符（+ / =），否则服务端解出与本地不一致 → sign not match
  const signFragment = query.split('&').find((p) => p.startsWith('sign=')).slice('sign='.length)
  assert.ok(!/[+/=]/.test(signFragment), 'base64 中的 +/ 必须被 URL 编码')
})

// —— body.errcode 判成败（反「假成功」坑，K2）——————————————

test('HTTP 200 但 errcode≠0 → 确定性失败抛 ApiError（不看 HTTP 状态判成）', async () => {
  const { fetchImpl } = makeFetch({ json: { errcode: 310000, errmsg: 'keywords not in content' } })
  const a = adapter({ security: 'none', fetchImpl })
  await assert.rejects(
    a.reply({ channel: 'dingtalk-notify', kind: 'group', chatId: 'g' }, 'hi'),
    (err) => err instanceof DingtalkNotifyApiError && err.errcode === 310000,
  )
})

test('errcode 其它非零值（如 300001 token 无效）同样确定性抛', async () => {
  const { fetchImpl } = makeFetch({ json: { errcode: 300001, errmsg: 'token is not found' } })
  const a = adapter({ fetchImpl })
  await assert.rejects(a.reply({ channel: 'dingtalk-notify', kind: 'group', chatId: 'g' }, 'hi'), DingtalkNotifyApiError)
})

// —— 网络/5xx → uncertain（D7）————————————————

test('网络抛错 → DingtalkNotifyUncertainError（结果不明，禁重发）', async () => {
  const { fetchImpl } = makeFetch(new Error('ECONNRESET'))
  const a = adapter({ fetchImpl })
  await assert.rejects(
    a.reply({ channel: 'dingtalk-notify', kind: 'group', chatId: 'g' }, 'hi'),
    DingtalkNotifyUncertainError,
  )
})

test('HTTP 5xx → uncertain（不伪装确定性失败）', async () => {
  const { fetchImpl } = makeFetch({ status: 502, json: OK })
  const a = adapter({ fetchImpl })
  await assert.rejects(a.reply({ channel: 'dingtalk-notify', kind: 'group', chatId: 'g' }, 'hi'), DingtalkNotifyUncertainError)
})

test('2xx 但响应不可解析 → uncertain（拿不到 errcode 不谎报成功）', async () => {
  const { fetchImpl } = makeFetch({ throwJson: true })
  const a = adapter({ fetchImpl })
  await assert.rejects(a.reply({ channel: 'dingtalk-notify', kind: 'group', chatId: 'g' }, 'hi'), DingtalkNotifyUncertainError)
})

// —— at 块（顶层平级）——————————————————————

test('atAll=true → body.at.isAtAll=true（at 与 text 平级）', async () => {
  const { fetchImpl, calls } = makeFetch({ json: OK })
  const a = adapter({ atAll: true, atMobiles: ['180xxxx'], fetchImpl })
  await a.reply({ channel: 'dingtalk-notify', kind: 'group', chatId: 'g' }, '需要全员知晓')
  assert.equal(calls[0].body.at.isAtAll, true)
  assert.deepEqual(calls[0].body.at.atMobiles, ['180xxxx'])
  assert.equal(calls[0].body.text.content, '需要全员知晓')
  assert.ok('at' in calls[0].body && !('at' in calls[0].body.text), 'at 应在顶层，不嵌套进 text')
})

test('无 @ 需求 → body 不含 at', async () => {
  const { fetchImpl, calls } = makeFetch({ json: OK })
  const a = adapter({ fetchImpl })
  await a.reply({ channel: 'dingtalk-notify', kind: 'group', chatId: 'g' }, '普通通知')
  assert.equal('at' in calls[0].body, false)
})

// —— markdown 帧 ——————————————————————————

test('sendMarkdown：msgtype=markdown，title/text 结构正确且关键词补前缀作用于 text', async () => {
  const { fetchImpl, calls } = makeFetch({ json: OK })
  const a = adapter({ security: 'keyword', keyword: '日报', fetchImpl })
  const receipt = await a.sendMarkdown({ channel: 'dingtalk-notify', kind: 'group', chatId: 'g' }, '', '## 构建结果\n成功')
  assert.equal(calls[0].body.msgtype, 'markdown')
  assert.equal(calls[0].body.markdown.title, 'dsh-im-union 通知', '空标题回退默认标题')
  assert.match(calls[0].body.markdown.text, /^日报 ## 构建结果/, 'markdown.text 亦应用关键词前缀')
  assert.equal(receipt.keywordPrefixed, true)
})

// —— 诊断三态 ————————————————————————————

test('diagnose：errcode=0 → webhook-delivery passed（含 security-config 静态位）', async () => {
  const { fetchImpl } = makeFetch({ json: OK })
  const a = adapter({ security: 'none', fetchImpl })
  const checks = await a.diagnose()
  const delivery = checks.find((c) => c.name === 'webhook-delivery')
  const secCfg = checks.find((c) => c.name === 'security-config')
  assert.equal(delivery.status, 'passed')
  assert.equal(secCfg.status, 'passed')
})

test('diagnose：310000 → failed 且 hint 转译为「关键词/安全设置不匹配」', async () => {
  const { fetchImpl } = makeFetch({ json: { errcode: 310000, errmsg: 'sign not match' } })
  const a = adapter({ security: 'sign', signSecret: 'SECx', fetchImpl })
  const checks = await a.diagnose()
  const delivery = checks.find((c) => c.name === 'webhook-delivery')
  assert.equal(delivery.status, 'failed')
  assert.match(delivery.hint, /关键词\/安全设置不匹配/)
})

test('diagnose：网络错 → webhook-delivery unverified', async () => {
  const { fetchImpl } = makeFetch(new Error('ETIMEDOUT'))
  const a = adapter({ fetchImpl })
  const checks = await a.diagnose()
  const delivery = checks.find((c) => c.name === 'webhook-delivery')
  assert.equal(delivery.status, 'unverified')
})

// —— 工厂校验 ————————————————————————————

test('工厂：缺 access_token 抛；sign 档缺 signSecret 抛', () => {
  assert.throws(
    () => createDingtalkNotifyAdapter({ accountId: 'a1', config: {}, secrets: {} }),
    /access_token 缺失/,
  )
  assert.throws(
    () => createDingtalkNotifyAdapter({ accountId: 'a1', config: { security: 'sign' }, secrets: { webhook: 'TOK' } }),
    /signSecret 必填/,
  )
})

test('工厂：secrets.webhook 接受整条 URL（解析出 access_token 与基址）', async () => {
  const a = createDingtalkNotifyAdapter({
    accountId: 'a1',
    config: {},
    secrets: { webhook: 'https://oapi.dingtalk.com/robot/send?access_token=ABC123' },
  })
  const url = a.buildUrl()
  assert.ok(url.startsWith('https://oapi.dingtalk.com/robot/send?'))
  assert.ok(url.includes('access_token=ABC123'))
})

test('工厂：config.atAll="true" 落到 isAtAll；security 大小写/空白归一', async () => {
  const { fetchImpl, calls } = makeFetch({ json: OK })
  const a = createDingtalkNotifyAdapter({
    accountId: 'a1',
    config: { security: ' KEYWORD ', keyword: 'hi', atAll: 'true' },
    secrets: { webhook: 'TOK' },
    fetchImpl,
  })
  await a.reply({ channel: 'dingtalk-notify', kind: 'group', chatId: 'g' }, 'there')
  assert.equal(calls[0].body.at.isAtAll, true)
  assert.equal(calls[0].body.text.content, 'hi there', 'KEYWORD 归一后仍自动补前缀')
  // keyword 档不应带 sign 查询参数（归一为 keyword 而非误判 sign/none）
  assert.ok(!calls[0].url.includes('sign='), 'keyword 档 query 不应出现 sign')
})

test('工厂：security=" SIGN " 归一为 sign 档（buildUrl 带 timestamp/sign）', () => {
  const a = createDingtalkNotifyAdapter({
    accountId: 'a1',
    config: { security: ' SIGN ' },
    secrets: { webhook: 'TOK', signSecret: 'SECx' },
    now: () => 1700000000000,
  })
  const url = new URL(a.buildUrl())
  assert.equal(url.searchParams.get('timestamp'), '1700000000000')
  assert.ok(url.searchParams.get('sign'), 'sign 档应带签名')
})
