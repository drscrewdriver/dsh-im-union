// M2 T2.6 主动投递：目标库文件态 / sendTo 帧形与三态 / broadcast 汇总 /
// syncBack 双向同步候选 / handleHttp 状态码纪律 / uncertain 不重发（D7）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProactiveDelivery, handleHttp } from '../lib/engine/proactive.js'

function tempFile(name = 'proactive-targets.json') {
  return join(mkdtempSync(join(tmpdir(), 'imu-proactive-')), name)
}

function fakeAdapter(receipt = { uncertain: false }) {
  const calls = []
  let replyImpl = async (address, text, signal) => receipt
  return {
    id: 'fake',
    calls,
    setReply(fn) {
      replyImpl = fn
    },
    async reply(address, text, signal) {
      calls.push({ address, text, signal })
      return replyImpl(address, text, signal)
    },
  }
}

/** 渠道唯一时忽略 botId 的朴素解析；botId 命中注册表则按表回。 */
function makeService(opts = {}) {
  const warns = []
  const resolveCalls = []
  const adapters = opts.adapters ?? { telegram: fakeAdapter(), feishu: fakeAdapter() }
  const accountByChannel = opts.accountByChannel ?? { telegram: 'tg-main', feishu: 'fs-1' }
  const registered = new Set(Object.values(accountByChannel))
  const accounts = opts.accounts ?? []
  for (const accountId of accounts) registered.add(accountId)
  const service = new ProactiveDelivery({
    file: opts.file ?? tempFile(),
    resolveAccount: (channel, botId) => {
      resolveCalls.push({ channel, botId })
      if (botId !== undefined) return botId !== '' && registered.has(botId) ? botId : undefined
      return accountByChannel[channel]
    },
    getAdapter: (accountId) => {
      for (const [channel, id] of Object.entries(accountByChannel)) {
        if (id === accountId) return adapters[channel]
      }
      return adapters[accountId]
    },
    now: opts.now ?? (() => 1000),
    logWarn: (m) => warns.push(String(m)),
  })
  return { service, warns, adapters, accountByChannel, resolveCalls }
}

const telegram = { channel: 'telegram', botId: 'tg-main', targetId: 'u1', text: 'hi' }

// —— 帧形 ——————————————————————————————————————————

test('sendTo：构造 dm 帧形调 adapter.reply，chatId 缺省即 targetId', async () => {
  const { service, adapters, resolveCalls } = makeService()
  const result = await service.sendTo({ channel: 'telegram', targetId: 'u1', text: 'hi' })
  assert.deepEqual(adapters.telegram.calls, [{ address: { channel: 'telegram', kind: 'dm', chatId: 'u1' }, text: 'hi', signal: undefined }])
  assert.deepEqual(resolveCalls, [{ channel: 'telegram', botId: undefined }])
  assert.deepEqual(result, {
    channel: 'telegram',
    botId: 'tg-main',
    targetId: 'u1',
    chatId: 'u1',
    accountId: 'tg-main',
    status: 'delivered',
  })
})

test('sendTo：opts.signal 透传 reply；opts.chatId 覆盖帧内地址', async () => {
  const { service, adapters } = makeService()
  const controller = new AbortController()
  await service.sendTo(telegram, { signal: controller.signal, chatId: 'chat-88' })
  assert.deepEqual(adapters.telegram.calls[0].address, { channel: 'telegram', kind: 'dm', chatId: 'chat-88' })
  assert.equal(adapters.telegram.calls[0].signal, controller.signal)
})

// —— 目标库文件态 ——————————————————————————————————

test('目标库原子写往返：delivered 落库后重命名 tmp 不存在、文件为纯 JSON 数组', async () => {
  const file = tempFile()
  const { service } = makeService({ file })
  await service.sendTo(telegram, { alias: '张三' })
  assert.ok(!existsSync(`${file}.tmp`), '原子写不留 tmp')
  const rows = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(rows, [
    { channel: 'telegram', botId: 'tg-main', targetId: 'u1', chatId: 'u1', syncBack: false, updatedAt: 1000, alias: '张三' },
  ])
})

test('目标库零 secret：回包与文件均不含凭据样式值', async () => {
  const file = tempFile()
  const { service } = makeService({ file })
  await service.sendTo({ ...telegram, text: 'BOT-TOKEN=abc123 内容' })
  assert.ok(!readFileSync(file, 'utf8').includes('abc123'), '投递正文绝不落目标库')
  assert.ok(!JSON.stringify(service.listTargets()).includes('abc123'))
})

test('损坏文件：warn + 转存 .corrupt-<ts> 从空表继续（对齐 delivery-log 姿态）', () => {
  const file = tempFile()
  writeFileSync(file, '{broken json', 'utf8')
  const { service, warns } = makeService({ file, now: () => Date.UTC(2026, 9, 18) })
  assert.deepEqual(service.listTargets(), [])
  assert.equal(warns.length, 1)
  assert.match(warns[0], /损坏，已转存 .* 并从空表继续/)
  const corrupt = `${file}.corrupt-2026-10-18T00-00-00-000Z`
  assert.ok(existsSync(corrupt), `实际 warn=${warns[0]}`)
  assert.ok(!existsSync(file), '原损坏文件已被改名让位')
})

// —— syncBack 双向同步与白名单候选 ——————————————————

test('syncBack 关闭时 observeInbound 不动作；开启后入站记入目标并出候选', async () => {
  const { service } = makeService()
  await service.sendTo(telegram)
  assert.equal(service.observeInbound({ channel: 'telegram', botId: 'tg-main', targetId: 'u1', accountId: 'tg-main' }), false)
  assert.deepEqual(service.pendingAllowlistSuggestions(), [])

  assert.equal(service.setSyncBack({ channel: 'telegram', botId: 'tg-main', targetId: 'u1', enabled: true }), true)
  assert.equal(service.observeInbound({ channel: 'telegram', botId: 'tg-main', targetId: 'u1', chatId: 'p-77', accountId: 'tg-main' }), true)
  const [row] = service.listTargets()
  assert.equal(row.chatId, 'p-77', '入站平台 chatId 回写映射')
  assert.equal(row.syncBack, true)
  assert.deepEqual(service.pendingAllowlistSuggestions(), [
    { channel: 'telegram', botId: 'tg-main', targetId: 'u1', accountId: 'tg-main', at: 1000 },
  ])
  // 候选只按目标去重（重复命中刷新 at，不加条目）
  service.observeInbound({ channel: 'telegram', botId: 'tg-main', targetId: 'u1', accountId: 'tg-main' })
  assert.equal(service.pendingAllowlistSuggestions().length, 1)
  assert.equal(service.resolveAllowlistSuggestion({ channel: 'telegram', botId: 'tg-main', targetId: 'u1' }), true)
  assert.deepEqual(service.pendingAllowlistSuggestions(), [])
})

test('observeInbound 未登记目标：不动作（双向同步只对 syncBack 目标生效）', () => {
  const { service } = makeService()
  assert.equal(service.observeInbound({ channel: 'telegram', targetId: 'ghost', accountId: 'tg-main' }), false)
  assert.deepEqual(service.listTargets(), [])
})

// —— sendTo 三态与 D7 ——————————————————————————————

test('uncertain：不重发只回状态，且不落新目标（D7）', async () => {
  const { service, adapters } = makeService({ adapters: { telegram: fakeAdapter({ uncertain: true }) } })
  const result = await service.sendTo(telegram)
  assert.equal(adapters.telegram.calls.length, 1, 'uncertain 绝不自动重发')
  assert.equal(result.status, 'uncertain')
  assert.deepEqual(service.listTargets(), [])
})

test('确定性失败（reply 抛错）：failed + 粗分类 error，异常原文只进 warn', async () => {
  const { service, adapters, warns } = makeService()
  adapters.telegram.setReply(async () => {
    throw new Error('HTTP 500 upstream leaked token=SECRET')
  })
  const result = await service.sendTo(telegram)
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'send-error')
  assert.equal(warns.length, 1)
  assert.match(warns[0], /HTTP 500/)
  assert.ok(!JSON.stringify(result).includes('SECRET'), '结果对象零异常原文')
  assert.deepEqual(service.listTargets(), [], '失败不落库')
})

test('解析不到账号/适配器：failed+no-account，不触 reply', async () => {
  const { service, adapters } = makeService()
  const r1 = await service.sendTo({ channel: 'myspace', targetId: 'u1', text: 'hi' })
  assert.equal(r1.status, 'failed')
  assert.equal(r1.error, 'no-account')
  const r2 = await service.sendTo({ ...telegram, botId: 'not-registered' })
  assert.equal(r2.error, 'no-account')
  assert.equal(adapters.telegram.calls.length, 0)
})

test('入参缺失：invalid 失败且不触网络面（text 空白同拦）', async () => {
  const { service, adapters } = makeService()
  assert.equal((await service.sendTo({ channel: '', targetId: 'u1', text: 'x' })).error, 'invalid')
  assert.equal((await service.sendTo({ channel: 'telegram', targetId: '', text: 'x' })).error, 'invalid')
  assert.equal((await service.sendTo({ channel: 'telegram', targetId: 'u1', text: '   ' })).error, 'invalid')
  assert.equal(adapters.telegram.calls.length, 0)
})

test('目标库 chatId 映射复用：入站改写后主动投递走新映射', async () => {
  const { service, adapters } = makeService()
  await service.sendTo(telegram)
  service.setSyncBack({ channel: 'telegram', botId: 'tg-main', targetId: 'u1', enabled: true })
  service.observeInbound({ channel: 'telegram', botId: 'tg-main', targetId: 'u1', chatId: 'p-77', accountId: 'tg-main' })
  await service.sendTo(telegram, { text: 'again' })
  assert.deepEqual(adapters.telegram.calls.at(-1).address, { channel: 'telegram', kind: 'dm', chatId: 'p-77' })
  assert.equal(service.listTargets().length, 1, '同目标覆盖不重复建档')
})

// —— broadcast ——————————————————————————————————————

test('broadcast：全量逐个投递回三态汇总；channel 过滤只出子集', async () => {
  const { service, adapters } = makeService()
  await service.sendTo(telegram)
  await service.sendTo({ channel: 'telegram', targetId: 'u2', text: 'hi' })
  await service.sendTo({ channel: 'feishu', targetId: 'f1', text: 'hi' })
  assert.equal(service.listTargets().length, 3)
  // 建档后才把飞书渠道置为结果不明：broadcast 计 uncertain 且不重发
  adapters.feishu.setReply(async () => ({ uncertain: true }))
  const feishuCallsBefore = adapters.feishu.calls.length
  const summary = await service.broadcast('全员通知')
  assert.deepEqual(summary.map((r) => [`${r.channel}:${r.targetId}`, r.status]).sort(), [
    ['feishu:f1', 'uncertain'],
    ['telegram:u1', 'delivered'],
    ['telegram:u2', 'delivered'],
  ])
  assert.equal(adapters.feishu.calls.length - feishuCallsBefore, 1, '汇总里的 uncertain 目标只发一次不补发（D7）')
  const filtered = await service.broadcast('hi', { channel: 'feishu' })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].accountId, 'fs-1')
})

test('broadcast：适配器故障账号计入 failed 不中断后续目标', async () => {
  const { service, adapters } = makeService()
  await service.sendTo(telegram)
  await service.sendTo({ channel: 'telegram', targetId: 'u2', text: 'hi' })
  adapters.telegram.setReply(async (address) => {
    if (address.chatId === 'u1') throw new Error('boom')
    return { uncertain: false }
  })
  const summary = await service.broadcast('ping')
  assert.deepEqual(summary.map((r) => r.status), ['failed', 'delivered'])
  assert.equal(summary[0].error, 'send-error')
})

test('目标库重载往返：新实例读回既有目标且 syncBack/alias 保留', async () => {
  const file = tempFile()
  const first = makeService({ file })
  await first.service.sendTo(telegram, { alias: '持久', syncBack: true })
  const second = makeService({ file })
  assert.deepEqual(second.service.listTargets(), [
    { channel: 'telegram', botId: 'tg-main', targetId: 'u1', chatId: 'u1', syncBack: true, alias: '持久', updatedAt: 1000 },
  ])
  assert.equal(second.service.observeInbound({ channel: 'telegram', botId: 'tg-main', targetId: 'u1', accountId: 'tg-main' }), true, 'syncBack 跨实例保留')
})

// —— handleHttp 状态码 ——————————————————————————————

function httpCtx(opts = {}) {
  const ctx = makeService(opts)
  const deps = { service: ctx.service, logWarn: (m) => ctx.warns.push(String(m)) }
  return { ...ctx, deps }
}

test('handleHttp /proactive/send：200 回三态；空文本/缺字段 400；body 非对象 400', async () => {
  const { deps, adapters } = httpCtx()
  const ok = await handleHttp(deps, { method: 'POST', path: '/proactive/send', body: { channel: 'telegram', targetId: 'u1', text: 'hi' } })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.status, 'delivered')
  assert.equal(adapters.telegram.calls.length, 1)

  const empty = await handleHttp(deps, { method: 'POST', path: '/proactive/send', body: { channel: 'telegram', targetId: 'u1', text: '  ' } })
  assert.equal(empty.status, 400)
  assert.equal(empty.json.error, '投递内容不能为空')
  const missing = await handleHttp(deps, { method: 'POST', path: '/proactive/send', body: { channel: 'telegram' } })
  assert.equal(missing.status, 400)
  assert.equal(missing.json.error, 'channel 与 targetId 必填')
  assert.equal(adapters.telegram.calls.length, 1, '400 一律不触 reply')
  assert.equal((await handleHttp(deps, { method: 'POST', path: '/proactive/send', body: 'nope' })).status, 400)
})

test('handleHttp /proactive/send：结果不明原样回 uncertain 状态（200）', async () => {
  const { deps } = httpCtx({ adapters: { telegram: fakeAdapter({ uncertain: true }) } })
  const res = await handleHttp(deps, { method: 'POST', path: '/proactive/send', body: { channel: 'telegram', targetId: 'u1', text: 'hi' } })
  assert.equal(res.status, 200)
  assert.equal(res.json.status, 'uncertain')
})

test('handleHttp GET /proactive/targets：只出脱敏目标列表', async () => {
  const { deps } = httpCtx()
  await deps.service.sendTo(telegram, { alias: '小明' })
  const res = await handleHttp(deps, { method: 'GET', path: '/proactive/targets' })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.targets, [
    { channel: 'telegram', botId: 'tg-main', targetId: 'u1', chatId: 'u1', syncBack: false, updatedAt: 1000, alias: '小明' },
  ])
})

test('handleHttp /proactive/targets/remove：命中 200，未知目标 404，缺参 400', async () => {
  const { deps } = httpCtx()
  await deps.service.sendTo(telegram)
  const ok = await handleHttp(deps, { method: 'POST', path: '/proactive/targets/remove', body: { channel: 'telegram', targetId: 'u1' } })
  assert.equal(ok.status, 200)
  assert.deepEqual(deps.service.listTargets(), [])
  const miss = await handleHttp(deps, { method: 'POST', path: '/proactive/targets/remove', body: { channel: 'telegram', targetId: 'ghost' } })
  assert.equal(miss.status, 404)
  assert.equal(miss.json.error, '未找到该投递目标')
  assert.equal((await handleHttp(deps, { method: 'POST', path: '/proactive/targets/remove', body: {} })).status, 400)
})

test('handleHttp /proactive/syncback：开/关回显，未知目标 404，enabled 非布尔 400', async () => {
  const { deps } = httpCtx()
  await deps.service.sendTo(telegram)
  const on = await handleHttp(deps, { method: 'POST', path: '/proactive/syncback', body: { channel: 'telegram', targetId: 'u1', enabled: true } })
  assert.equal(on.status, 200)
  assert.equal(on.json.syncBack, true)
  assert.equal(deps.service.listTargets()[0].syncBack, true)
  const off = await handleHttp(deps, { method: 'POST', path: '/proactive/syncback', body: { channel: 'telegram', botId: 'tg-main', targetId: 'u1', enabled: false } })
  assert.equal(off.status, 200)
  assert.equal(deps.service.listTargets()[0].syncBack, false)
  const miss = await handleHttp(deps, { method: 'POST', path: '/proactive/syncback', body: { channel: 'telegram', targetId: 'ghost', enabled: true } })
  assert.equal(miss.status, 404)
  const bad = await handleHttp(deps, { method: 'POST', path: '/proactive/syncback', body: { channel: 'telegram', targetId: 'u1' } })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error, 'enabled 需为布尔值')
})

test('handleHttp：未知路径 404、方法不符 405', async () => {
  const { deps } = httpCtx()
  assert.equal((await handleHttp(deps, { method: 'POST', path: '/proactive/nope', body: {} })).status, 404)
  const wrongMethod = await handleHttp(deps, { method: 'GET', path: '/proactive/send' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.json.ok, false)
})

test('handleHttp：服务内部异常吞成 500 通用文案，细节只进 warn 零回显', async () => {
  const { deps, warns } = httpCtx()
  deps.service.listTargets = () => {
    throw new Error('internal detail BOT-TOKEN=leak')
  }
  const res = await handleHttp(deps, { method: 'GET', path: '/proactive/targets' })
  assert.equal(res.status, 500)
  assert.deepEqual(res.json, { ok: false, error: '操作失败，请查看本机日志' })
  assert.ok(!JSON.stringify(res.json).includes('leak'))
  assert.equal(warns.length, 1)
  assert.match(warns[0], /internal detail/)
})
