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
