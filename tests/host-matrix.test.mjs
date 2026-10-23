// 宿主兼容矩阵一致性：要求支持的宿主版本必须是声明范围的**子集**。
// 三处声明（dsh.plugin.json engines / package.json 每个 @deepseek-ai/dsh-* peer /
// scripts/hosts.mjs supportedHosts 矩阵）必须同源且互相覆盖，防止单点改动收窄。
// 范围是精确 tag 的 OR 列表，字符串成员判断即严格语义，无需 semver。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { supportedHosts, peerRange, hostPeerPackages } from '../scripts/hosts.mjs'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const plugin = JSON.parse(readFileSync(join(root, 'dsh.plugin.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// 用户点名的六个宿主版本（0.1.7-rc.x / 0.2.0-rc.x / 0.2.1-rc.x 全 rc 线）。
const REQUIRED = [
  '0.1.7-rc.1',
  '0.1.7-rc.2',
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  '0.2.1-rc.1',
  '0.2.1-rc.2',
]

const tagsOf = (range) => new Set(String(range).split('||').map((s) => s.trim()).filter((s) => s !== ''))

test('六个 rc 宿主版本是支持矩阵的子集', () => {
  const matrix = new Set(supportedHosts)
  for (const v of REQUIRED) {
    assert.ok(matrix.has(v), `hosts.mjs 矩阵缺 ${v}`)
  }
})

test('六个 rc 宿主版本在 dsh.plugin.json engines 范围内', () => {
  const declared = tagsOf(plugin.engines.dsh)
  for (const v of REQUIRED) {
    assert.ok(declared.has(v), `engines.dsh 缺 ${v}`)
  }
})

test('engines 与 hosts.mjs 矩阵同源（无单点漂移）', () => {
  assert.equal(plugin.engines.dsh, peerRange)
  assert.deepEqual([...tagsOf(plugin.engines.dsh)].sort(), [...supportedHosts].sort())
})

test('每个 @deepseek-ai/dsh-* peer 都覆盖同一版本集', () => {
  const peers = hostPeerPackages
  assert.ok(peers.length >= 6, 'dsh peer 包数量不正常')
  for (const name of peers) {
    const range = pkg.peerDependencies[name]
    assert.ok(typeof range === 'string', `peerDependencies 缺 ${name}`)
    const declared = tagsOf(range)
    for (const v of REQUIRED) {
      assert.ok(declared.has(v), `peer ${name} 缺 ${v}`)
    }
    assert.equal(range, peerRange, `peer ${name} 与矩阵不同源`)
  }
})
