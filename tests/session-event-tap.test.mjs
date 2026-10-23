// 会话事件总线（0.3.8）：desktop 线 @Remote follow 流帧收不到事件——
// session/event firehose 才是宿主侧正统消费面；总线按 sessionId 扇出。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionEventTap } from '../lib/host-compat/session-event-tap.js'

function fakeCtx() {
  const handlers = new Map()
  return {
    ctx: {
      on(name, handler) {
        handlers.set(name, handler)
      },
    },
    emit(session, event) {
      handlers.get('session/event')?.(session, event)
    },
  }
}

test('session/event 总线：按 sessionId 扇出；退订即停；他-session/异常隔离', async () => {
  const { ctx, emit } = fakeCtx()
  const tap = createSessionEventTap(ctx)
  assert.ok(tap !== undefined)
  const got = []
  const gotOther = []
  const unsub = tap.subscribe('s1', (e) => got.push(e))
  tap.subscribe('s2', () => {
    throw new Error('订阅者异常不得拖垮分发')
  })
  tap.subscribe('s2', (e) => gotOther.push(e))

  emit({ id: 's1' }, { type: 'assistant/message', seq: 1, time: 1, data: {} })
  emit({ id: 's2' }, { type: 'turn/end', seq: 2, time: 2, data: { reason: { kind: 'completed' } } })
  emit({ id: 's1' }, { type: 'turn/end', seq: 3, time: 3, data: { reason: { kind: 'completed' } } })

  assert.deepEqual(got.map((e) => e.type), ['assistant/message', 'turn/end'])
  assert.deepEqual(gotOther.map((e) => e.type), ['turn/end'], '同 session 异常订阅者被隔离')

  unsub()
  emit({ id: 's1' }, { type: 'assistant/message', seq: 4, time: 4, data: {} })
  assert.equal(got.length, 2, '退订后不再接收')
  // 无 id 的 session 对象安全忽略。
  emit(undefined, { type: 'turn/end', seq: 5, time: 5, data: {} })
  emit({ /* 无 id */ }, { type: 'turn/end', seq: 6, time: 6, data: {} })
})

test('总线缺位（ctx.on 不存在）返回 undefined → 引擎回退 follow', () => {
  assert.equal(createSessionEventTap({ logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }), undefined)
})
