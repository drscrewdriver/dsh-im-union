import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVault, credentialRef } from '../lib/credentials/vault.js'

test('credentialRef：POSIX 标识符归一', () => {
  assert.equal(credentialRef('feishu', 'app-secret'), 'IM_UNION_FEISHU_APP_SECRET')
  assert.equal(credentialRef('we-com', 'a.b/c'), 'IM_UNION_WE_COM_A_B_C')
})

test('文件 vault：set/resolve/describe/unset 往返', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imu-vault-'))
  try {
    const vault = createVault(undefined, dir)
    assert.equal(vault.kind, 'file')
    await vault.set('IM_UNION_TEST_A', 'secret-a')
    await vault.set('IM_UNION_TEST_B', 'secret-b')
    assert.equal(await vault.resolve('IM_UNION_TEST_A'), 'secret-a')
    const described = await vault.describe()
    assert.deepEqual(described.map((d) => d.ref).sort(), ['IM_UNION_TEST_A', 'IM_UNION_TEST_B'])
    await vault.unset('IM_UNION_TEST_A')
    assert.equal(await vault.resolve('IM_UNION_TEST_A'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('文件 vault：损坏即抛，不覆盖唯一副本', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imu-vault-'))
  try {
    const file = join(dir, 'secrets.json')
    await writeFile(file, '{ this is not json', 'utf8')
    const vault = createVault(undefined, dir)
    await assert.rejects(() => vault.resolve('anything'))
    // 抛错后原文件仍在（未被覆盖）
    assert.match(await readFile(file, 'utf8'), /this is not json/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('credentials 服务在位时优先 serviceVault', async () => {
  const store = new Map()
  const credentials = {
    set: async (ref, secret) => void store.set(ref, secret),
    resolve: async (ref) => store.get(ref),
    unset: async (ref) => void store.delete(ref),
  }
  const dir = await mkdtemp(join(tmpdir(), 'imu-vault-'))
  try {
    const vault = createVault(credentials, dir)
    assert.equal(vault.kind, 'service')
    await vault.set('IM_UNION_X_K', 'v')
    assert.equal(await vault.resolve('IM_UNION_X_K'), 'v')
    assert.equal(store.get('IM_UNION_X_K'), 'v')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('迁移包装：主库 miss 时从旧文件库搬迁，写/删双清防复活', async () => {
  const store = new Map()
  const credentials = {
    set: async (ref, secret) => void store.set(ref, secret),
    resolve: async (ref) => store.get(ref),
    unset: async (ref) => void store.delete(ref),
  }
  const dir = await mkdtemp(join(tmpdir(), 'imu-vault-'))
  try {
    // 先用纯文件库落一份历史 secret（模拟 0.3.2 接线修复前的旧数据）。
    const legacyOnly = createVault(undefined, dir)
    await legacyOnly.set('IM_UNION_WEIXIN_BOTTOKEN', 'legacy-token')
    // STALE 需在迁移前写入：文件库实例各持整份内存缓存，迁移后经旧实例
    // 写入对被测包装不可见（生产共享单例，此处纯属测试器物）。
    await legacyOnly.set('IM_UNION_STALE', 'old')
    // 换 service 主存（接线修复后的形态）：resolve 未命中应自动迁移。
    const warns = []
    const vault = createVault(credentials, dir, (m) => warns.push(m))
    assert.equal(vault.kind, 'service')
    assert.equal(await vault.resolve('IM_UNION_WEIXIN_BOTTOKEN'), 'legacy-token')
    assert.equal(store.get('IM_UNION_WEIXIN_BOTTOKEN'), 'legacy-token', '已搬迁进宿主凭据库')
    assert.ok(warns.some((m) => m.includes('迁移')), '迁移有日志')
    const secretsFile = await readFile(join(dir, 'secrets.json'), 'utf8')
    assert.ok(!secretsFile.includes('legacy-token'), '迁移后旧文件副本已清理')
    // 主库命中时不查文件库（不再回读旧值）。
    await vault.set('IM_UNION_WEIXIN_BOTTOKEN', 'new-token')
    assert.equal(await vault.resolve('IM_UNION_WEIXIN_BOTTOKEN'), 'new-token')
    // unset 双清：主库与旧文件库都不残留。
    await vault.set('IM_UNION_WEIXIN_BOTTOKEN', 'rotate')
    await vault.unset('IM_UNION_WEIXIN_BOTTOKEN')
    assert.equal(store.has('IM_UNION_WEIXIN_BOTTOKEN'), false)
    assert.equal(await vault.resolve('IM_UNION_STALE'), 'old', '无关 ref 不受影响')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('service vault：resolve 解包 ResolvedCredential { value } / { secret } / 裸串；空串=未存储', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imu-vault-'))
  try {
    const cases = [
      [{ value: 'v1' }, 'v1'],
      [{ value: 'v1', source: { layer: 'file' } }, 'v1'],
      [{ secret: 's1' }, 's1'],
      ['plain', 'plain'],
      [{ value: '' }, undefined],
      [{ other: 1 }, undefined],
    ]
    for (const [resolved, expected] of cases) {
      const credentials = {
        set: async () => {},
        resolve: async () => resolved,
        unset: async () => {},
      }
      const vault = createVault(credentials, dir)
      assert.equal(await vault.resolve('IM_UNION_X'), expected, JSON.stringify(resolved))
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('迁移包装：主库写后回读失败时保留旧文件副本（不删唯一副本）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imu-vault-'))
  try {
    const legacy = createVault(undefined, dir)
    await legacy.set('IM_UNION_K', 'old-value')
    // 主库：set 假成功但永远读不回（形态异常的最坏情形，0.3.3 真机教训）。
    const blackHole = {
      kind: 'service',
      set: async () => {},
      resolve: async () => undefined,
      describe: async () => [],
      unset: async () => {},
    }
    const warns = []
    const vault = createVault(blackHole, dir, (m) => warns.push(m))
    assert.equal(vault.kind, 'service')
    // resolve：主库 miss → 文件命中 → 迁移 set → 回读失败 → 仍按旧值应答。
    assert.equal(await vault.resolve('IM_UNION_K'), 'old-value')
    assert.ok(warns.some((m) => m.includes('回读失败')), '有回读失败告警')
    // 唯一副本必须还在文件库里。
    assert.equal(await legacy.resolve('IM_UNION_K'), 'old-value', '旧副本未被删除')
    // set 同纪律：写主库回读失败 → 旧副本保留。
    warns.length = 0
    await vault.set('IM_UNION_K2', 'v2')
    assert.ok(warns.some((m) => m.includes('回读失败')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
