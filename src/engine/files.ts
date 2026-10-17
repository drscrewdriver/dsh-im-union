/**
 * 净室文件输入公共层（T2.4 前半）。
 *
 * 纪律与 media.ts 同源：
 * - 超限**丢弃 + 用户可见说明**（notes 回渠道用户，绝不混进模型 prompt）；
 * - 上传面缺位时的纯文本回退只报「文件名 + 大小」清单，不假称内容已送达；
 * - 本文件零宿主依赖（纯函数），窄腰探测在 host-compat/uploads-compat.ts。
 */
import type { ChannelCaps } from '../channels/types.js'

export interface InboundFile {
  name: string
  data: Uint8Array
}

export interface PreparedFiles {
  /** 进入上传队列的文件（已裁限额）。 */
  accepted: InboundFile[]
  /** 被丢弃原因说明（用户可见文案素材，非内部异常）。 */
  notes: string[]
}

export const FILE_BUDGET = Object.freeze({
  perFileMaxBytes: 20 * 1024 * 1024,
  maxCount: 4,
})

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** 张数/单文件体积限额裁剪（按序保留，超限丢弃并记说明）。 */
export function prepareFiles(files: InboundFile[], budget = FILE_BUDGET): PreparedFiles {
  const notes: string[] = []
  const accepted: InboundFile[] = []
  for (const file of files) {
    if (accepted.length >= budget.maxCount) {
      notes.push(`文件数量上限 ${budget.maxCount} 个，其余 ${files.length - accepted.length} 个已忽略。`)
      break
    }
    if (file.data.byteLength > budget.perFileMaxBytes) {
      notes.push(`「${file.name || '未命名文件'}」超过单文件 20 MiB 上限（${formatSize(file.data.byteLength)}），已忽略。`)
      continue
    }
    accepted.push(file)
  }
  return { accepted, notes }
}

/**
 * 上传面缺位的纯文本回退：把文件名/大小列进 prompt 说明，
 * 并明示「附件暂不可用」——不伪装模型能读到内容。
 */
export function filesUnavailableNote(files: readonly InboundFile[]): string {
  if (files.length === 0) return ''
  const lines = files.map((file) => `- ${file.name || '未命名文件'}（${formatSize(file.data.byteLength)}）`)
  return ['（附件暂不可用，当前宿主无文件上传面；以下文件未进入模型上下文：', ...lines, '）'].join('\n')
}

/** 文件输入是否被渠道声明支持（caps.fileIn 缺省按不支持处理）。 */
export function channelAcceptsFiles(caps: Pick<ChannelCaps, 'fileIn'> | undefined): boolean {
  return caps?.fileIn === true
}

/** 渠道不支持文件回传时的替代说明（caps.fileOut=false 走文字降级，不抛）。 */
export function fileOutUnavailableNote(files: ReadonlyArray<{ name: string; sizeBytes?: number }>): string {
  if (files.length === 0) return ''
  const lines = files.map((file) => `- ${file.name}${file.sizeBytes !== undefined ? `（${formatSize(file.sizeBytes)}）` : ''}`)
  return ['本回合产出文件，但当前渠道不支持文件回传，请到网页端会话下载：', ...lines].join('\n')
}

export { formatSize }
