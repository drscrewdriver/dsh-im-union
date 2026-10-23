// 0.4.5/0.4.6 出站净化 + 预设供给单测（node:test，从 lib/ 产物导入）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { sanitizeImReply } = await import('../lib/engine/reply-sanitize.js')
const { renderSvgToPng } = await import('../lib/engine/svg-render.js')
const { registerImPreset, imPresetDefinition, IM_PRESET_ID } = await import('../lib/engine/preset-supply.js')

// ── 净化：富结构围栏 ────────────────────────────────────────────────
test('净化：```dsh-ui 围栏被替换为省略提示，原文不外泄', () => {
  const raw = '前言\n```dsh-ui\n{"type":"card","title":"x"}\n```\n结语'
  const out = sanitizeImReply(raw)
  assert.equal(out.text.includes('dsh-ui'), false)
  assert.equal(out.text.includes('"type":"card"'), false)
  assert.match(out.text, /交互组件已省略/)
  assert.match(out.text, /前言/)
  assert.match(out.text, /结语/)
})

test('净化：```html 围栏被替换为省略提示', () => {
  const out = sanitizeImReply('看这个：\n```html\n<div class="card">x</div>\n```')
  assert.equal(out.text.includes('<div'), false)
  assert.match(out.text, /HTML 内容已省略/)
})

test('净化：```svg 围栏抽出为图表素材，正文不留源码', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
  const out = sanitizeImReply(`数据如图\n\`\`\`svg\n${svg}\n\`\`\`\n以上`)
  assert.equal(out.svgBlocks.length, 1)
  assert.equal(out.svgBlocks[0], svg)
  assert.equal(out.text.includes('<svg'), false)
  assert.match(out.text, /数据如图/)
  assert.match(out.text, /以上/)
})

test('净化：裸 <svg>（非围栏）同样抽出', () => {
  const out = sanitizeImReply('<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>')
  assert.equal(out.svgBlocks.length, 1)
  assert.equal(out.text.trim(), '')
})

test('净化：raw-html 卡片（vcp-root + style）剥结构留文字', () => {
  const raw = '<vcp-root><style>.a{color:red}</style><div class="a">结论：一切正常</div></vcp-root>'
  const out = sanitizeImReply(raw)
  assert.equal(out.text.includes('<'), false)
  assert.equal(out.text.includes('color:red'), false)
  assert.match(out.text, /结论：一切正常/)
})

test('净化：普通代码围栏（ts）原样保留，不被标签剥离误伤', () => {
  const raw = '示例：\n```ts\nconst a = new Map<string, number>()\n```'
  const out = sanitizeImReply(raw)
  assert.match(out.text, /new Map<string, number>\(\)/)
  assert.match(out.text, /```ts/)
})

test('净化：纯文本恒等（仅空白整理）', () => {
  const out = sanitizeImReply('第一行\n\n\n\n第二行   ')
  assert.equal(out.text, '第一行\n\n第二行')
  assert.deepEqual(out.svgBlocks, [])
})

test('净化：SVG 上限 3 张（防刷屏）', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
  const out = sanitizeImReply(Array.from({ length: 5 }, () => svg).join('\n'))
  assert.equal(out.svgBlocks.length, 3)
})

// ── SVG 渲染：sharp 在位出 PNG，缺位/坏输入回 undefined ─────────────
test('SVG 渲染：合法 SVG 出 PNG（sharp 缺位环境回 undefined，两者皆合法）', async () => {
  const png = await renderSvgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#000"/></svg>')
  if (png !== undefined) {
    assert.equal(png.mimeType, 'image/png')
    assert.ok(png.name.endsWith('.png'))
    // PNG magic: 89 50 4E 47
    assert.deepEqual([png.data[0], png.data[1], png.data[2], png.data[3]], [0x89, 0x50, 0x4e, 0x47])
  }
})

test('SVG 渲染：非 SVG / 空串回 undefined（不抛）', async () => {
  assert.equal(await renderSvgToPng(''), undefined)
  assert.equal(await renderSvgToPng('not svg at all'), undefined)
})

// ── 预设：运行时注册（.agent-presets/ 目录形态已被宿主废弃）────────
test('预设定义：persona 完整模式 + 富结构禁令 + svg 围栏门', () => {
  const def = imPresetDefinition()
  assert.equal(def.id, IM_PRESET_ID)
  const persona = def.plugins.find((p) => p.id === 'persona')
  assert.equal(persona.name, '@deepseek-ai/dsh-persona')
  assert.equal(persona.config.complete, true, '完整模式才能阻断其它插件追加 prompt 段')
  assert.equal(persona.config.includeRuntimeContext, false)
  assert.match(persona.config.prefix, /dsh-ui/)
  assert.match(persona.config.prefix, /```svg/)
})

test('预设注册：宿主无 agentPresets.register 面 → ok=false 降级（老宿主）', async () => {
  assert.equal((await registerImPreset(undefined)).ok, false)
  assert.equal((await registerImPreset({})).ok, false)
})

test('预设注册：成功回 disposer；Duplicate 视为已在册；其它错误降级', async () => {
  let disposed = 0
  const okResult = await registerImPreset({
    register: (def) => async () => {
      assert.equal(def.id, IM_PRESET_ID)
      disposed += 1
    },
  })
  assert.equal(okResult.ok, true)
  await okResult.dispose?.()
  assert.equal(disposed, 1)

  const dup = await registerImPreset({
    register: () => {
      throw new Error('Duplicate agent preset: im-concise')
    },
  })
  assert.equal(dup.ok, true)
  assert.equal(dup.reason, 'already registered')

  const hard = await registerImPreset({
    register: () => {
      throw new Error('activation failed: unknown plugin')
    },
  })
  assert.equal(hard.ok, false)
  assert.match(hard.reason, /unknown plugin/)
})
