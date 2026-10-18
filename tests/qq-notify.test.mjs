// QQ 推送通知档（qq-notify）单测：取凭证 / 主动档定档（无 msg_id）/ 确定性失败引导文案 /
// Receipt D7 二态 / caps 与方法面一致性 / 诊断三态 / 工厂凭据校验。
// 网络面全注入（fetchImpl），零真实请求；通知档不建 WS，故无 SocketImpl。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  QqNotifyAdapter,
  QQNotifyApiError,
  QQNotifyUncertainError,
  createQqNotifyAdapter,
  fitByteBudget,
} from '../lib/channels/qq-notify.js'

const APP = 'APPID-1'
const SEC = 'SUPERSECRETV'
const AT = 'AT-1'

const httpResp = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

function restRecorder(route) {
  const calls = []
  const impl = async (url, init) => {
    let parsed
    if (typeof init?.body === 'string') {
      try {
        parsed = JSON.parse(init.body)
      } catch {
        parsed = undefined
      }
    }
    calls.push({ url, method: init?.method ?? 'GET', body: parsed, headers: init?.headers ?? {} })
    return route(url, init?.method ?? 'GET', parsed, init)
  }
  return { impl, calls }
}

const tokenOk = (url) => url.endsWith('/app/getAppAccessToken')
const sendOk = (url, method) => method === 'POST' && /\/messages$/.test(url)

const BASE_ROUTE = (url, method) => {
  if (tokenOk(url)) return httpResp(200, { access_token: AT, expires_in: 7200 })
  if (sendOk(url, method)) return httpResp(200, { id: 'SENT-1', timestamp: '2026-10-18T10:00:00+08:00' })
  return httpResp(200, {})
}

function build(options = {}, route = BASE_ROUTE) {
  const rest = restRecorder(route)
  const adapter = new QqNotifyAdapter({
    appId: APP,
    appSecret: SEC,
    apiBase: 'https://api.test',
    tokenUrl: 'https://token.test/app/getAppAccessToken',
    fetchImpl: rest.impl,
    ...options,
  })
  return { adapter, rest }
}

const DM = { channel: 'qq-notify', kind: 'dm', chatId: 'OPENID-1' }
const GROUP = { channel: 'qq-notify', kind: 'group', chatId: 'GROUP-OPENID' }

// —— 1. 取凭证 + 通知档连接面 ————————————————————————————

test('connect 仅取凭证（getAppAccessToken），不建 WS、不取 gateway', async () => {
  const { adapter, rest } = build()
  await adapter.connect()
  assert.equal(adapter.connected, true)
  const tokenCalls = rest.calls.filter((c) => tokenOk(c.url))
  assert.equal(tokenCalls.length, 1, '应恰好一次取凭证')
  assert.equal(tokenCalls[0].body.appId, APP)
  assert.equal(tokenCalls[0].body.clientSecret, SEC, '取凭证体字段名为 clientSecret')
  assert.deepEqual(
    rest.calls.filter((c) => c.url.endsWith('/gateway')),
    [],
    '通知档不请求 gateway（无 WS 长连接）',
  )
})

test('凭证期内复用缓存：多次出站只取一次 token', async () => {
  const { adapter, rest } = build()
  await adapter.sendTo('U1', 'a', 'dm')
  await adapter.sendTo('U2', 'b', 'dm')
  assert.equal(rest.calls.filter((c) => tokenOk(c.url)).length, 1)
})

// —— 2. 主动档定档断言（官方有主动推送面 → 不带 msg_id）——————————

test('sendTo 单聊走主动档：POST /v2/users/{openid}/messages，msg_type=0，无 msg_id/msg_seq', async () => {
  const { adapter, rest } = build()
  const receipt = await adapter.sendTo('OPENID-1', '今日构建通过', 'dm')
  const send = rest.calls.find((c) => sendOk(c.url, c.method))
  assert.ok(send.url.endsWith('/v2/users/OPENID-1/messages'), `单聊路径: ${send.url}`)
  assert.equal(send.headers.authorization, `QQBot ${AT}`)
  assert.equal(send.body.msg_type, 0)
  assert.equal(send.body.content, '今日构建通过')
  assert.ok(!('msg_id' in send.body), '主动消息不得携带 msg_id')
  assert.ok(!('msg_seq' in send.body), '主动消息不得携带 msg_seq')
  assert.deepEqual(receipt, { platformMessageId: 'SENT-1', uncertain: false })
})

test('sendTo 群聊走 /v2/groups/{group_openid}/messages，仍为主动档（无 msg_id）', async () => {
  const { adapter, rest } = build()
  await adapter.sendTo('GROUP-OPENID', '公告', 'group')
  const send = rest.calls.find((c) => sendOk(c.url, c.method))
  assert.ok(send.url.endsWith('/v2/groups/GROUP-OPENID/messages'), `群聊路径: ${send.url}`)
  assert.ok(!('msg_id' in send.body))
})

test('reply 委托主动档：address.chatId→openid/group_openid，无 msg_id', async () => {
  const { adapter, rest } = build()
  const receipt = await adapter.reply(GROUP, '提醒一下')
  const send = rest.calls.find((c) => sendOk(c.url, c.method))
  assert.ok(send.url.endsWith('/v2/groups/GROUP-OPENID/messages'))
  assert.equal(send.body.content, '提醒一下')
  assert.ok(!('msg_id' in send.body))
  assert.deepEqual(receipt, { platformMessageId: 'SENT-1', uncertain: false })
})

// —— 3. 确定性失败 vs 网络不确定（D7）+ 主动推送引导文案 ——————————

test('用户关闭主动发送（1100100）→ 确定性失败 + 引导文案，非 uncertain', async () => {
  const route = (url, method) => {
    if (tokenOk(url)) return httpResp(200, { access_token: AT, expires_in: 7200 })
    if (sendOk(url, method)) return httpResp(200, { err_code: 1100100, message: '用户关闭了接收主动消息' })
    return httpResp(200, {})
  }
  const { adapter } = build({}, route)
  await assert.rejects(
    () => adapter.sendTo('OPENID-1', 'hi', 'dm'),
    (error) => {
      assert.ok(error instanceof QQNotifyApiError, '确定性拒绝')
      assert.ok(!(error instanceof QQNotifyUncertainError), '不属网络不确定')
      assert.equal(error.errCode, 1100100)
      assert.match(error.message, /引导：/)
      assert.match(error.message, /允许主动发送/, '引导文案指向用户开关')
      return true
    },
  )
})

test('主动消息超频控（40034100）→ 确定性失败 + 频控引导', async () => {
  const route = (url, method) => {
    if (tokenOk(url)) return httpResp(200, { access_token: AT, expires_in: 7200 })
    if (sendOk(url, method)) return httpResp(200, { err_code: 40034100, message: '主动消息超出频率限制' })
    return httpResp(200, {})
  }
  const { adapter } = build({}, route)
  await assert.rejects(
    () => adapter.sendTo('GROUP-OPENID', 'hi', 'group'),
    (error) => {
      assert.ok(error instanceof QQNotifyApiError)
      assert.match(error.message, /频控/)
      return true
    },
  )
})

test('主动消息无权限（40034105）→ 确定性失败 + 权限引导', async () => {
  const route = (url, method) => {
    if (tokenOk(url)) return httpResp(200, { access_token: AT, expires_in: 7200 })
    if (sendOk(url, method)) return httpResp(200, { err_code: 40034105, message: '主动消息无权限' })
    return httpResp(200, {})
  }
  const { adapter } = build({}, route)
  await assert.rejects(
    () => adapter.sendTo('OPENID-1', 'hi', 'dm'),
    (error) => {
      assert.ok(error instanceof QQNotifyApiError)
      assert.match(error.message, /权限/)
      return true
    },
  )
})

test('网络异常 → QQNotifyUncertainError（禁自动重发），非确定性', async () => {
  const route = (url, method) => {
    if (tokenOk(url)) return httpResp(200, { access_token: AT, expires_in: 7200 })
    if (sendOk(url, method)) throw new Error('socket hang up')
    return httpResp(200, {})
  }
  const { adapter } = build({}, route)
  await assert.rejects(
    () => adapter.sendTo('OPENID-1', 'hi', 'dm'),
    (error) => {
      assert.ok(error instanceof QQNotifyUncertainError)
      assert.ok(!(error instanceof QQNotifyApiError))
      return true
    },
  )
})

test('出站 5xx → 不确定（不吞成成功，不误判确定性）', async () => {
  const route = (url, method) => {
    if (tokenOk(url)) return httpResp(200, { access_token: AT, expires_in: 7200 })
    if (sendOk(url, method)) return httpResp(503, { message: 'unavailable' })
    return httpResp(200, {})
  }
  const { adapter } = build({}, route)
  await assert.rejects(() => adapter.sendTo('OPENID-1', 'hi', 'dm'), QQNotifyUncertainError)
})

test('401 凭证失效：换发 token 后重试一次，仍走成功', async () => {
  let tokenHits = 0
  let sendAttempts = 0
  const route = (url, method) => {
    if (tokenOk(url)) {
      tokenHits += 1
      return httpResp(200, { access_token: `${AT}-${tokenHits}`, expires_in: 7200 })
    }
    if (sendOk(url, method)) {
      // 第一次带 AT-1 被判 401（凭证类 11243），换发后带 AT-2 重试即成功
      sendAttempts += 1
      return sendAttempts === 1
        ? httpResp(401, { err_code: 11243, message: 'token invalid' })
        : httpResp(200, { id: 'SENT-2' })
    }
    return httpResp(200, {})
  }
  const { adapter, rest } = build({}, route)
  const receipt = await adapter.sendTo('OPENID-1', 'hi', 'dm')
  assert.deepEqual(receipt, { platformMessageId: 'SENT-2', uncertain: false })
  assert.equal(tokenHits, 2, '401 触发换发凭证重试一次')
  assert.equal(rest.calls.filter((c) => sendOk(c.url, c.method)).length, 2)
})

// —— 4. caps 与方法面一致性 ——————————————————————————————

test('caps 如实声明纯出站通知档（装饰/收发能力位全 false）', () => {
  const { adapter } = build()
  const caps = adapter.caps
  assert.equal(caps.editStream, false)
  assert.equal(caps.nativeStream, false)
  assert.equal(caps.nativeChoices, false)
  assert.equal(caps.statusReaction, false)
  assert.equal(caps.typing, false, '无交互会话 → typing 如实 false')
  assert.equal(caps.imageIn, false)
  assert.equal(caps.fileIn, false)
  assert.equal(caps.fileOut, false)
  assert.equal(caps.threads, false)
  assert.equal(caps.voice, false)
  assert.ok(Number.isFinite(caps.maxMessageLength) && caps.maxMessageLength > 0)
})

test('caps=false 的能力不提供对应方法（一致性：不谎报接口）', () => {
  const { adapter } = build()
  assert.equal(typeof adapter.beginStream, 'undefined')
  assert.equal(typeof adapter.sendFile, 'undefined')
  assert.equal(typeof adapter.setTyping, 'undefined')
  assert.equal(typeof adapter.askChoices, 'undefined')
  assert.equal(typeof adapter.speak, 'undefined')
})

test('id/label 定档为通知渠道；onMessage 登记但永不回调（无入站源）', async () => {
  const { adapter } = build()
  assert.equal(adapter.id, 'qq-notify')
  assert.equal(typeof adapter.label, 'string')
  let fired = 0
  const off = adapter.onMessage(() => {
    fired += 1
  })
  await adapter.connect()
  await adapter.sendTo('OPENID-1', 'hi', 'dm')
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(fired, 0, '通知档无收信事件源')
  off()
})

test('出站内容按 UTF-8 字节预算截断（不切裂代理对）', async () => {
  const { adapter, rest } = build()
  const long = '测'.repeat(2000) // 6000 字节 > 4000
  await adapter.sendTo('OPENID-1', long, 'dm')
  const send = rest.calls.find((c) => sendOk(c.url, c.method))
  const bytes = new TextEncoder().encode(send.body.content).length
  assert.ok(bytes <= 4000, `截断后字节 ${bytes} 应 ≤4000`)
  assert.ok(send.body.content.endsWith('…'))
  assert.equal(fitByteBudget('abc', 4000), 'abc', '未超限原样返回')
})

// —— 5. 诊断三态 —————————————————————————————————————————

test('诊断 token 实探：有凭据取凭证成功 → passed，另有 active-push-quota unverified', async () => {
  const { adapter } = build()
  const checks = await adapter.diagnose()
  const token = checks.find((c) => c.name === 'token-endpoint')
  assert.equal(token.status, 'passed')
  const quota = checks.find((c) => c.name === 'active-push-quota')
  assert.equal(quota.status, 'unverified', '主动推送频控/开关需实测，不谎报')
})

test('诊断 token 实探：平台拒绝凭证（401）→ failed', async () => {
  const route = (url) => (tokenOk(url) ? httpResp(401, { message: 'invalid appid/secret' }) : httpResp(200, {}))
  const { adapter } = build({}, route)
  const checks = await adapter.diagnose()
  assert.equal(checks.find((c) => c.name === 'token-endpoint').status, 'failed')
})

test('诊断 token 实探：取凭证网络不确定 → unverified', async () => {
  const route = (url) => {
    if (tokenOk(url)) throw new Error('dns fail')
    return httpResp(200, {})
  }
  const { adapter } = build({}, route)
  const checks = await adapter.diagnose()
  assert.equal(checks.find((c) => c.name === 'token-endpoint').status, 'unverified')
})

test('诊断三态之一：无凭据 → token-endpoint unverified（不谎报为可达）', async () => {
  const adapter = new QqNotifyAdapter({ appId: '', appSecret: '', apiBase: 'https://api.test', fetchImpl: restRecorder(BASE_ROUTE).impl })
  const checks = await adapter.diagnose()
  const token = checks.find((c) => c.name === 'token-endpoint')
  assert.equal(token.status, 'unverified')
  assert.match(token.hint, /无凭据/)
})

test('诊断文案零 secret 回显', async () => {
  const route = (url) => (tokenOk(url) ? httpResp(403, { message: `bad secret ${SEC}` }) : httpResp(200, {}))
  const { adapter } = build({}, route)
  const checks = await adapter.diagnose()
  for (const c of checks) assert.ok(!String(c.hint ?? '').includes(SEC), `hint 不得含 secret: ${c.hint}`)
})

// —— 6. 工厂凭据校验 ——————————————————————————————————————

test('工厂：缺凭据抛校验错', () => {
  assert.throws(() => createQqNotifyAdapter({ accountId: 'a1', config: {}, secrets: {} }), /appId 未入库/)
  assert.throws(
    () => createQqNotifyAdapter({ accountId: 'a1', config: { appId: APP }, secrets: {} }),
    /clientSecret 未入库/,
  )
})

test('工厂：secret 走 secrets（clientSecret），config 提供 appId 亦可装载', () => {
  const adapter = createQqNotifyAdapter({ accountId: 'a1', config: { appId: APP }, secrets: { clientSecret: SEC } })
  assert.ok(adapter instanceof QqNotifyAdapter)
  assert.equal(adapter.id, 'qq-notify')
})

test('工厂：兼容 secrets.appId / secrets.appSecret 注入', () => {
  const adapter = createQqNotifyAdapter({ accountId: 'a1', config: {}, secrets: { appId: APP, appSecret: SEC } })
  assert.ok(adapter instanceof QqNotifyAdapter)
})

test('工厂：config.apiBaseUrl/tokenUrl 覆盖不破坏装载（实例构造成功）', () => {
  const adapter = createQqNotifyAdapter({
    accountId: 'a1',
    config: { appId: APP, apiBaseUrl: 'https://sandbox.api.test/', tokenUrl: 'https://tok.test/app/getAppAccessToken' },
    secrets: { clientSecret: SEC },
  })
  assert.ok(adapter instanceof QqNotifyAdapter)
  assert.equal(adapter.id, 'qq-notify')
})
