/**
 * 图片输入公共层（T1.7）。
 *
 * 纪律（checklist E4）：模型是否收图**查宿主 capability 元数据**——
 * `ctx.llm.resolveModelInfo(provider, model).inputModalities`（@0.2.x 锚点
 * packages/api/session-controller/src/commands.ts 的入站 gate 与 acp content.ts
 * 同一逻辑）；元数缺失=未知放行（宿主自己会拒），**禁按模型名猜视觉**。
 *
 * 预算：单图/总量/张数三重上限，超限按序丢弃并生成用户可见说明；
 * base64 内联进 PromptContentPart.image（宿主面把 bytes 升为持久引用，
 * 传输层 1/3 膨胀在预算里已计）。
 */
import type { UnionCapabilities } from '../host-compat/services.js'

export interface ImagePart {
  name: string
  data: Uint8Array
  mimeType: string
}

export interface PreparedImages {
  /** 进入 prompt 的图片（base64 内联）。 */
  parts: Array<{ type: 'image'; mediaType: string; data: string; name?: string }>
  /** 被丢弃原因说明（用户可见文案素材，非内部异常）。 */
  notes: string[]
}

export const IMAGE_BUDGET = Object.freeze({
  perImageMaxBytes: 2 * 1024 * 1024,
  totalMaxBytes: 6 * 1024 * 1024,
  maxCount: 4,
})

const IMAGE_MIME_RE = /^image\/(png|jpe?g|gif|webp|heic|heif|bmp)$/i

function base64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64')
}

/**
 * 视觉能力判定：selection 缺 provider/model 或 llm 面缺失 → undefined（未知，
 * 放行让宿主裁决）；元数据明确不含 image → false。
 */
export async function visionSupported(
  caps: UnionCapabilities,
  selection: { provider?: string; model?: string } | undefined,
): Promise<boolean | undefined> {
  const llm = caps.llm as
    | { resolveModelInfo?: (provider: string, model: string) => Promise<{ inputModalities?: readonly string[] }> }
    | undefined
  if (typeof llm?.resolveModelInfo !== 'function') return undefined
  if (selection === undefined || selection.provider === undefined || selection.model === undefined) return undefined
  try {
    const info = await llm.resolveModelInfo(selection.provider, selection.model)
    if (info?.inputModalities === undefined) return undefined
    return info.inputModalities.includes('image')
  } catch {
    // 元数据查询失败=未知，不替宿主做否定判断。
    return undefined
  }
}

/** 预算裁剪 + 视觉 gate + base64 内联。supported=false 时全部丢弃（text 照常）。 */
export function prepareImages(images: ImagePart[], supported: boolean | undefined, budget = IMAGE_BUDGET): PreparedImages {
  const notes: string[] = []
  const parts: PreparedImages['parts'] = []
  if (images.length === 0) return { parts, notes }
  if (supported === false) {
    return { parts: [], notes: [`当前模型不支持图片输入，已忽略 ${images.length} 张图片。`] }
  }
  let total = 0
  const accepted: ImagePart[] = []
  for (const image of images) {
    if (accepted.length >= budget.maxCount) {
      notes.push(`图片数量上限 ${budget.maxCount} 张，超出部分已忽略。`)
      break
    }
    if (!IMAGE_MIME_RE.test(image.mimeType)) {
      notes.push(`不支持的图片格式（${image.mimeType || '未知'}），该张已忽略。`)
      continue
    }
    if (image.data.byteLength > budget.perImageMaxBytes) {
      notes.push('单图超过 2 MiB，该张已忽略（可截图/压缩后重发）。')
      continue
    }
    if (total + image.data.byteLength > budget.totalMaxBytes) {
      notes.push('图片总量超过 6 MiB，后续已忽略。')
      break
    }
    total += image.data.byteLength
    accepted.push(image)
  }
  for (const image of accepted) {
    parts.push({ type: 'image', mediaType: image.mimeType, data: base64(image.data), ...(image.name !== '' ? { name: image.name } : {}) })
  }
  return { parts, notes }
}

/** text + images → PromptContentPart[]（文本在前，图片依序；notes 不进 prompt，由调用方回给渠道用户）。 */
export function toPromptParts(text: string, images: PreparedImages): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = []
  if (text !== '') parts.push({ type: 'text', text })
  for (const part of images.parts) parts.push({ ...part })
  if (parts.length === 0) parts.push({ type: 'text', text: '' })
  return parts
}
