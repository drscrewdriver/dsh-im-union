import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSessionId, chatKey, shouldRespondToGroup, ChatRouter } from '../lib/engine/router.js'

test('makeSessionId：dm/group 与 thread 变体稳定且可sanitize', () => {
  assert.equal(makeSessionId({ channel: 'telegram', kind: 'dm', chatId: '123' }), 'im:union:telegram:dm:123')
  assert.equal(
    makeSessionId({ channel: 'feishu', kind: 'group', chatId: 'oc_x', threadId: 'omt_y' }),
    'im:union:feishu:group:oc_x:omt_y',
  )
  // 非法字符归一为下划线，避免注入额外分隔符
  assert.equal(makeSessionId({ channel: 'a:b', kind: 'dm', chatId: 'x/y' }), 'im:union:a_b:dm:x_y')
})

test('同地址两次解析得到同一会话（每聊天独立会话）', () => {
  const router = new ChatRouter()
  const address = { channel: 'weixin', kind: 'dm', chatId: 'wx1' }
  const first = router.resolve(address)
  const second = router.resolve(address)
  assert.equal(first.sessionId, 'im:union:weixin:dm:wx1')
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(first.explicit, false)
})

test('bind/unbind 与 list 前缀过滤', () => {
  const router = new ChatRouter()
  const dm = { channel: 'discord', kind: 'dm', chatId: 'u9' }
  const thread = { channel: 'discord', kind: 'group', chatId: 'c1', threadId: 't1' }
  router.resolve(dm)
  router.resolve(thread)
  router.resolve({ ...thread, threadId: 't2' })
  router.bind(dm, 'legacy-session')
  assert.equal(router.resolve(dm).sessionId, 'legacy-session')
  assert.equal(router.resolve(dm).explicit, true)
  // list 只收本聊天（含 thread 变体）
  const listed = router.list(thread).map((b) => b.sessionId).sort()
  assert.deepEqual(listed, ['im:union:discord:group:c1:t1', 'im:union:discord:group:c1:t2'])
  router.unbind(dm)
  assert.equal(router.resolve(dm).sessionId, 'im:union:discord:dm:u9')
})

test('群聊触发规则：只认显式 @', () => {
  assert.equal(shouldRespondToGroup(true), true)
  assert.equal(shouldRespondToGroup(false), false)
})

test('轮换：纪元段存在；旧绑定入历史；resolve 落新 id；chatKey 不含纪元', () => {
  const router = new ChatRouter()
  const dm = { channel: 'weixin', kind: 'dm', chatId: 'wx1' }
  const base = router.resolve(dm).sessionId
  assert.equal(base, 'im:union:weixin:dm:wx1')
  const rotated = router.makeRotatedSessionId(dm)
  assert.match(rotated, /^im:union:weixin:dm:wx1:\d{13}$/, '轮换 id = base + 13 位毫秒纪元')
  assert.equal(chatKey(dm), base, '策略键（selections/muted）不含纪元，跨轮换稳定')
  router.rotate(dm, rotated, base)
  assert.equal(router.resolve(dm).sessionId, rotated, 'resolve 落在新 id')
  assert.equal(router.isHistorical(base), true, '旧 id 转历史')
  assert.equal(router.isHistorical(rotated), false)
  assert.deepEqual(router.boundSessionIds(), [rotated])
})

test('轮换无旧绑定时也成立；历史快照只记轮换过的', () => {
  const router = new ChatRouter()
  const dm = { channel: 'weixin', kind: 'dm', chatId: 'fresh' }
  const rotated = router.makeRotatedSessionId(dm)
  router.rotate(dm, rotated)
  assert.equal(router.resolve(dm).sessionId, rotated)
  assert.equal(router.isHistorical('im:union:weixin:dm:fresh'), false, '首绑不走历史')
  const second = router.makeRotatedSessionId(dm)
  router.rotate(dm, second, rotated)
  assert.equal(router.isHistorical(rotated), true, '二次轮换把上一轮转入历史')
  assert.equal(router.boundSessionIds().length, 1)
})

test('chatKey 与 makeSessionId 一致', () => {
  const address = { channel: 'qq', kind: 'group', chatId: 'g1' }
  assert.equal(chatKey(address), makeSessionId(address))
})
