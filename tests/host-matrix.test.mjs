// 宿主兼容矩阵一致性：要求支持的宿主版本必须是声明范围的**子集**。
// 声明面（2026-11-14 版本上下限改造后）：dsh.plugin.json / package.json 的
// engines.dsh 发有界区间（下限＝矩阵起点、上限 `<0.3.0-0`），peerDependencies 每个
// @deepseek-ai/dsh-* 仍逐 rc 枚举（包管理器解析不带 includePrerelease），
// scripts/hosts.mjs supportedHosts 矩阵必须被区间完整覆盖，防止单点改动收窄。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { supportedHosts, peerRange, enginesRange, hostPeerPackages } from '../scripts/hosts.mjs'

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

// 极简 semver 比较（只覆盖本仓声明的 `x.y.z(-tag.n)` 形态；预发布低于同号正式版）。
const parseVer = (v) => {
  const [core, pre = ''] = String(v).split('-')
  return {
    nums: core.split('.').map(Number),
    pre: pre === '' ? [] : pre.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s)),
  }
}
const cmpVer = (a, b) => {
  const A = parseVer(a)
  const B = parseVer(b)
  for (let i = 0; i < 3; i += 1) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1
  }
  if (A.pre.length === 0 || B.pre.length === 0) {
    if (A.pre.length === B.pre.length) return 0
    return A.pre.length === 0 ? 1 : -1
  }
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i += 1) {
    const x = A.pre[i]
    const y = B.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

test('六个 rc 宿主版本是支持矩阵的子集', () => {
  const matrix = new Set(supportedHosts)
  for (const v of REQUIRED) {
    assert.ok(matrix.has(v), `hosts.mjs 矩阵缺 ${v}`)
  }
})

test('engines.dsh 是有界区间：下限＝矩阵起点、上限 <0.3.0-0', () => {
  assert.equal(enginesRange, `>=${supportedHosts[0]} <0.3.0-0`)
  assert.equal(plugin.engines.dsh, enginesRange)
  assert.equal(pkg.engines.dsh, enginesRange)
})

test('六个 rc 宿主版本在 dsh.plugin.json engines 范围内', () => {
  const m = plugin.engines.dsh.match(/^>=(\S+) <(\S+)$/)
  assert.ok(m !== null, `engines.dsh 不是 '>=a <b' 区间形态：${plugin.engines.dsh}`)
  const [, floor, ceiling] = m
  for (const v of REQUIRED) {
    assert.ok(cmpVer(v, floor) >= 0, `engines.dsh 下限 ${floor} 高于 ${v}`)
    assert.ok(cmpVer(v, ceiling) < 0, `engines.dsh 上限 ${ceiling} 低于 ${v}`)
  }
})

test('engines 区间完整覆盖 hosts.mjs 矩阵（无单点收窄）', () => {
  const m = plugin.engines.dsh.match(/^>=(\S+) <(\S+)$/)
  assert.ok(m !== null, `engines.dsh 不是 '>=a <b' 区间形态：${plugin.engines.dsh}`)
  const [, floor, ceiling] = m
  for (const v of supportedHosts) {
    assert.ok(cmpVer(v, floor) >= 0, `区间下限 ${floor} 丢弃了矩阵声明的 ${v}`)
    assert.ok(cmpVer(v, ceiling) < 0, `区间上限 ${ceiling} 丢弃了矩阵声明的 ${v}`)
  }
})

test('每个 @deepseek-ai/dsh-* peer 都与 engines 同串且覆盖矩阵', () => {
  const peers = hostPeerPackages
  assert.ok(peers.length >= 6, 'dsh peer 包数量不正常')
  const m = peerRange.match(/^>=(\S+) <(\S+)$/)
  assert.ok(m !== null, `peerRange 不是 '>=a <b' 区间形态：${peerRange}`)
  const [, floor, ceiling] = m
  for (const name of peers) {
    const range = pkg.peerDependencies[name]
    assert.ok(typeof range === 'string', `peerDependencies 缺 ${name}`)
    // peer 与矩阵同源：既等于 peerRange，也等于 engines.dsh（2026-11-14 形状统一）
    assert.equal(range, peerRange, `peer ${name} 与矩阵不同源`)
    assert.equal(range, pkg.engines.dsh, `peer ${name} 与 engines.dsh 不同串`)
    // 区间必须覆盖每个 REQUIRED 细胞
    for (const v of REQUIRED) {
      assert.ok(cmpVer(v, floor) >= 0, `peer ${name} 下限 ${floor} 高于 ${v}`)
      assert.ok(cmpVer(v, ceiling) < 0, `peer ${name} 上限 ${ceiling} 低于 ${v}`)
    }
  }
})
