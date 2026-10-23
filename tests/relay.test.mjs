// Phase 8 relay 绑定存储：bind/get/list/unbind/byNotifyAccount + 原子写与损坏恢复。
// 纪律姿态对齐 delivery-log/proactive：可丢弃运行态，损坏不 brick。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRelayStore } from '../lib/engine/relay.js'

function stateFile() {
  const dir = mkdtempSync(join(tmpdir(), 'imu-relay-'))
  return join(dir, 'relay-bindings.json')
}

test('bind/get/list/unbind/byNotifyAccount 基本语义；重复 bind 幂等覆盖', () => {
  const file = stateFile()
  const store = createRelayStore(file)
  assert.deepEqual(store.list(), [])
  assert.equal(store.get('nope'), undefined)

  store.bind('im:union:telegram:dm:c1', 'acct-notify')
  store.bind('im:union:feishu:dm:c2', 'acct-notify', 'oc_target')
  assert.equal(store.list().length, 2)
  assert.equal(store.get('im:union:telegram:dm:c1')?.notifyAccountId, 'acct-notify')
  assert.equal(store.get('im:union:feishu:dm:c2')?.targetId, 'oc_target')
  assert.deepEqual(store.byNotifyAccount('acct-notify').map((b) => b.sessionId).sort(), [
    'im:union:feishu:dm:c2',
    'im:union:telegram:dm:c1',
  ], '多对一：同通知账号列出全部会话')

  // 幂等覆盖：同会话重绑只留最新账号，不追加行。
  store.bind('im:union:telegram:dm:c1', 'acct-other')
  assert.equal(store.list().length, 2)
  assert.equal(store.get('im:union:telegram:dm:c1')?.notifyAccountId, 'acct-other')
  assert.equal(store.get('im:union:telegram:dm:c1')?.targetId, undefined, '重绑不带 target 即清')

  assert.equal(store.unbind('im:union:feishu:dm:c2'), true)
  assert.equal(store.unbind('im:union:feishu:dm:c2'), false, '重复解绑返回 false')
  assert.equal(store.get('im:union:feishu:dm:c2'), undefined)
})

test('空白 sessionId/notifyAccountId 拒绝入账；list 返回副本不被外部改写', () => {
  const store = createRelayStore(stateFile())
  store.bind('', 'acct-1')
  store.bind('  ', 'acct-1')
  store.bind('s1', '')
  assert.deepEqual(store.list(), [])
  store.bind('s1', 'acct-1')
  const rows = store.list()
  rows[0].sessionId = 'hacked'
  assert.equal(store.get('s1')?.sessionId, 's1', '外部改副本不脏内部态')
})

test('落盘持久：bind/unbind 原子写文件，重载存储看到同一状态', () => {
  const file = stateFile()
  const store = createRelayStore(file)
  store.bind('s1', 'acct-1', 'tgt')
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk[0].sessionId, 's1')
  assert.equal(onDisk[0].notifyAccountId, 'acct-1')
  assert.equal(onDisk[0].targetId, 'tgt')
  assert.equal(typeof onDisk[0].boundAt, 'number')
  assert.equal(existsSync(`${file}.tmp`), false, 'tmp 已 rename，不残留')
  assert.deepEqual(Object.keys(onDisk[0]).sort(), ['boundAt', 'notifyAccountId', 'sessionId', 'targetId'], '零 secret 行键（D4）')

  store.unbind('s1')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [], '解绑同文件态同步')

  // 重载：先前绑定的存储重建后仍可见。
  store.bind('s2', 'acct-2')
  const reloaded = createRelayStore(file)
  assert.equal(reloaded.get('s2')?.notifyAccountId, 'acct-2')
})

test('损坏恢复：非法 JSON → warn + 改名 .corrupt-<ts> + 空表继续，不 brick', () => {
  const file = stateFile()
  writeFileSync(file, '{not json!!', 'utf8')
  const warns = []
  const store = createRelayStore(file, (m) => warns.push(String(m)))
  assert.deepEqual(store.list(), [])
  assert.equal(warns.length, 1)
  assert.match(warns[0], /relay-bindings\.json 损坏/)
  assert.equal(existsSync(file), false, '损坏原件已转存')
  assert.ok(readdirSync(join(file, '..')).some((n) => n.startsWith('relay-bindings.json.corrupt-')))
  // 从空表继续可写
  store.bind('s1', 'acct-1')
  assert.equal(createRelayStore(file).get('s1')?.notifyAccountId, 'acct-1')
})

test('行级消毒：数组外形但行缺字段/非对象 → 只收合规行；顶层非数组当空表', () => {
  const file = stateFile()
  writeFileSync(
    file,
    JSON.stringify([
      { sessionId: 's-ok', notifyAccountId: 'acct-1' },
      { sessionId: '', notifyAccountId: 'acct-1' },
      { sessionId: 's-noacct' },
      null,
      'junk',
      { sessionId: ' s-pad ', notifyAccountId: 'acct-1 ', boundAt: 'not-a-number' },
    ]),
    'utf8',
  )
  const store = createRelayStore(file)
  assert.deepEqual(store.list().map((b) => b.sessionId).sort(), ['s-ok', 's-pad'])
  assert.equal(store.get('s-pad')?.sessionId, 's-pad', '两端空白被 trim')
  assert.equal(typeof store.get('s-pad')?.boundAt, 'number', '非法 boundAt 兜底为数字')

  writeFileSync(file, JSON.stringify({ nope: true }), 'utf8')
  assert.deepEqual(createRelayStore(file).list(), [], '顶层非数组=空表不抛错')
})
