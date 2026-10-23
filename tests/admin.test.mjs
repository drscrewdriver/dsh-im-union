import test from 'node:test'
import assert from 'node:assert/strict'
import { validateMutation, BASE_PATH, CLIENT_HEADER } from '../lib/admin/api.js'

const req = (method, headers) => ({ method, headers })

test('GET/HEAD/OPTIONS 免检', () => {
  assert.equal(validateMutation(req('GET', {})), undefined)
  assert.equal(validateMutation(req('HEAD', {})), undefined)
  assert.equal(validateMutation(req('OPTIONS', {})), undefined)
})

test('POST 非 JSON → 415', () => {
  assert.equal(validateMutation(req('POST', { 'content-type': 'text/plain' })), 415)
  assert.equal(validateMutation(req('POST', {})), 415)
})

test('POST JSON 缺客户端标识头 → 400', () => {
  assert.equal(validateMutation(req('POST', { 'content-type': 'application/json' })), 400)
})

test('POST JSON + 客户端标识头 → 放行', () => {
  assert.equal(
    validateMutation(req('POST', { 'content-type': 'application/json; charset=utf-8', [CLIENT_HEADER]: '1' })),
    undefined,
  )
})

test('BASE_PATH 与包名一致（管理面路径纪律）', () => {
  assert.equal(BASE_PATH, '/api/dsh-im-union')
})

// —— 渠道 rail 数据面（0.4.0）——————————————————————

test('groupChannelSessions：im:union: 过滤 + 渠道分组 + 绑定/历史/最近出站合并', async () => {
  const { groupChannelSessions } = await import('../lib/admin/channels.js')
  const sessions = [
    { id: 'im:union:weixin:dm:u1', title: '[WX] 你好', running: true },
    { id: 'im:union:weixin:dm:u1:1729600000000', title: '', running: false },
    { id: 'im:union:telegram:dm:t1', running: false },
    { id: 'host-web-1', title: '网页', running: false },
  ]
  const groups = groupChannelSessions(sessions, {
    bound: new Set(['im:union:weixin:dm:u1']),
    historical: (id) => id.endsWith('1729600000000'),
    lastOut: new Map([['im:union:weixin:dm:u1', 1792732145923]]),
  })
  assert.equal(groups.length, 2, '只出 weixin/telegram 两组（host-web-1 被滤）')
  const wx = groups.find((g) => g.channel === 'weixin')
  assert.equal(wx.sessions.length, 2)
  assert.equal(wx.sessions[0].bound, true)
  assert.equal(wx.sessions[0].running, true)
  assert.equal(wx.sessions[0].lastOutAt, 1792732145923)
  assert.equal(wx.sessions[1].detached, true, '纪元 id 标注已解绑（轮换旧会话）')
  assert.equal(wx.sessions[1].title, undefined, '空标题不落字段')
})

test('groupChannelSessions：零 secret 键白名单 + scanLimit 截断 + 空输入', async () => {
  const { groupChannelSessions } = await import('../lib/admin/channels.js')
  const sessions = Array.from({ length: 600 }, (_, i) => ({ id: `im:union:weixin:dm:u${i}`, botToken: 'SHOULD-LEAK-NOT' }))
  const groups = groupChannelSessions(sessions, {
    bound: new Set(),
    historical: () => false,
    lastOut: new Map(),
    scanLimit: 500,
  })
  const all = groups[0].sessions
  assert.equal(all.length, 500, 'scanLimit 截断')
  assert.deepEqual(Object.keys(all[0]).sort(), ['bound', 'detached', 'running', 'sessionId'], '行键白名单（无 config/secret 回显，D4）')
  assert.equal(groupChannelSessions([], { bound: new Set(), historical: () => false, lastOut: new Map() }).length, 0)
})
