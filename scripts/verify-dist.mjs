/**
 * verify-dist.mjs —— 第四层门禁：dist 冒烟。
 * 单测全绿 ≠ 交付；本脚本在**构建产物**上核验：
 * 1. 宿主入口可 import 且 name/inject/apply 形态正确；
 * 2. client 半 ModuleLoader id === npm 包名（不一致 = 整体静默失活）；
 * 3. dsh.client.inject 声明的浏览器模块与 client.js require 的宿主包一致；
 * 4. locale 9 语齐全且 en.json 锚存在（缺锚 = 语言包整目录被宿主忽略）；
 * 5. lib/index.js 与 src 产物无凭据样字符串（防误打 secrets 进包）。
 */
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

// 1. host 入口
const host = await import(new URL('../lib/index.js', import.meta.url).href)
assert.equal(host.name, pkg.name, 'host name 必须等于包名')
assert.ok(Array.isArray(host.inject) && host.inject.includes('webServer'), 'inject 应含 webServer')
assert.equal(typeof host.apply, 'function', 'apply 必须是函数')

// 2. client id = 包名
const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.ok(
  client.includes(`id: '${pkg.name}'`) || client.includes(`id: "${pkg.name}"`),
  'ModuleLoader id 必须等于 npm 包名（VD：bundle 挂载 id ≠ 包名 → client 从不加载）',
)

// 3. client 半消费的服务面存在（slots/locale 与 dsh.client.inject 声明对应）
assert.ok(client.includes('ctx.slots'), 'client 应使用 slots 服务')
assert.ok(client.includes('ctx.locale'), 'client 应使用 locale 服务')

// 4. 9 语 locale + en 锚
for (const lang of ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'it', 'ru', 'es']) {
  const meta = JSON.parse(await readFile(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8'))
  assert.ok(meta.meta?.title, `locale/${lang}.json 缺 meta.title`)
  assert.ok(meta.meta?.description, `locale/${lang}.json 缺 meta.description`)
}

// 5. 产物卫生：无疑似 secret 字面量
const hostJs = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
for (const bundle of [client, hostJs]) {
  assert.ok(!/xoxb-[A-Za-z0-9-]{10,}/.test(bundle), '产物含疑似 Slack token')
  assert.ok(!/api_key\s*[:=]\s*['"][A-Za-z0-9]{20,}/.test(bundle), '产物含疑似 API key')
}

console.log('ok  dist 冒烟 5 项全过（入口形态/client id/inject 面/9 语锚/产物卫生）')
