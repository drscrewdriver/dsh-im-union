/**
 * SVG → PNG 渲染（0.4.5）：把模型输出的 SVG 图表转成 IM 可显示的图片。
 *
 * 依赖策略（零新增运行时依赖纪律）：
 * - 宿主 profile 自带 `sharp` 时 lazy require 使用（desktop 线实装在位）；
 * - 缺位/渲染失败 → 返回 undefined，调用方降级为纯文字（绝不抛错打断投递）；
 * - sharp 以可执行 crate 形式分发，require 失败只在个别平台发生，不算错误路径。
 *
 * 防护：宽高上限（默认 1000px 宽）、超时靠 sharp 自身 + 调用方 try/catch、
 * 白底 flatten（SVG 无背景时微信客户端可能显示为透明/黑底）。
 */
import { createRequire } from 'node:module'

export interface RenderedImage {
  name: string
  data: Uint8Array
  mimeType: string
}

const DEFAULT_MAX_WIDTH = 1000

interface SharpLike {
  (input: Buffer, options?: Record<string, unknown>): {
    resize(options: Record<string, unknown>): unknown
    flatten(options: Record<string, unknown>): unknown
    png(options?: Record<string, unknown>): { toBuffer(): Promise<Buffer> }
  }
}

function loadSharp(): SharpLike | undefined {
  try {
    const require = createRequire(import.meta.url)
    const mod = require('sharp') as unknown
    if (typeof mod === 'function') return mod as SharpLike
    // ESM/CJS 双形态：有些分发把可调用体挂在 default 上。
    if (mod !== null && typeof mod === 'object' && typeof (mod as { default?: unknown }).default === 'function') {
      return (mod as { default: SharpLike }).default
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 渲染 SVG 为 PNG 图片；失败/环境缺位返回 undefined（调用方降级纯文字）。
 * @param svg SVG 源码
 * @param maxWidth 目标最大宽度（默认 1000，等比缩放）
 */
export async function renderSvgToPng(svg: string, maxWidth = DEFAULT_MAX_WIDTH): Promise<RenderedImage | undefined> {
  const trimmed = svg.trim()
  if (trimmed === '' || !/<svg[\s>]/i.test(trimmed)) return undefined
  const sharp = loadSharp()
  if (sharp === undefined) return undefined
  try {
    const pipeline = sharp(Buffer.from(trimmed))
    // 链式调用顺序：先按宽缩放（不放大小图），再拍平白底，最后出 PNG。
    const resized = pipeline.resize({ width: maxWidth, withoutEnlargement: true }) as {
      flatten(options: Record<string, unknown>): { png(options?: Record<string, unknown>): { toBuffer(): Promise<Buffer> } }
    }
    const flattened = resized.flatten({ background: '#ffffff' })
    const buffer = await flattened.png().toBuffer()
    return {
      name: `chart-${Date.now()}.png`,
      data: new Uint8Array(buffer),
      mimeType: 'image/png',
    }
  } catch {
    return undefined
  }
}
