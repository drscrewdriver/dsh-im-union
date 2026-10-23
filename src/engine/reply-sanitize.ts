/**
 * IM 出站净化（0.4.5）：把富结构回复压回纯文字 + 提取 SVG 图表。
 *
 * 背景（用户实测）：
 * - genui 插件教模型用 ```dsh-ui 围栏输出交互组件——IM 端只能显示源码噪声；
 * - dsh-raw-html-v2 直接输出裸 HTML（vcp-root 卡片）——IM 端同样是源码噪声；
 * - 微信只有纯文字/简单媒体可看，长结构体必须压制。
 *
 * 纪律：
 * - 纯函数、零依赖（逐线矩阵之外单测全覆盖）；
 * - 非目标的代码围栏（```ts 等）原样保留——先占位后还原，防标签剥离误伤；
 * - SVG 块（```svg 或裸 <svg>）提取为图表素材（由调用方渲染成图片发送）；
 * - 清理有上限（SVG 最多 3 张），防模型刷屏式输出。
 */

export interface SanitizeResult {
  /** 净化后正文（纯文字；可能为空串）。 */
  text: string
  /** 提取的 SVG 源码（未渲染；调用方负责转图片）。 */
  svgBlocks: string[]
}

const FENCE_RE = /```([A-Za-z0-9_-]*)\n([\s\S]*?)```/g
const MAX_SVG_BLOCKS = 3
const SVG_FENCE_LANGS = new Set(['svg', 'xml'])
const DROPPED_BLOCK_TAGS = ['style', 'script', 'iframe', 'canvas', 'template', 'noscript', 'head', 'svg']

function looksLikeSvg(body: string): boolean {
  return /^\s*<svg[\s>]/i.test(body)
}

/**
 * 净化 IM 出站文本：剥离富结构围栏与裸 HTML，提取 SVG 图表。
 * 其它代码围栏（```ts / ```json 等）保留原文。
 */
export function sanitizeImReply(raw: string): SanitizeResult {
  const svgBlocks: string[] = []
  const keptFences: string[] = []
  const pushSvg = (svg: string): void => {
    if (svgBlocks.length < MAX_SVG_BLOCKS) svgBlocks.push(svg)
  }

  // 1) 围栏分流：svg 抽走 / dsh-ui·html 省略 / 其它代码围栏占位保护。
  let text = raw.replace(FENCE_RE, (whole, lang: string, body: string) => {
    const lower = String(lang ?? '').toLowerCase()
    if (SVG_FENCE_LANGS.has(lower) || (lower === '' && looksLikeSvg(body))) {
      pushSvg(body.trim())
      return ''
    }
    if (lower === 'dsh-ui') return '（交互组件已省略：IM 渠道不支持）'
    if (lower === 'html') return '（HTML 内容已省略：IM 渠道不支持）'
    keptFences.push(whole)
    return `\u0000FENCE${keptFences.length - 1}\u0000`
  })

  // 2) 裸 SVG（非围栏）同样抽走作图表素材。
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, (match) => {
    pushSvg(match)
    return ''
  })

  // 3) 裸 HTML 结构块（raw-html-v2 卡片式输出）：剥掉整套 style/script 等块。
  for (const tag of DROPPED_BLOCK_TAGS) {
    if (tag === 'svg') continue // 已在第 2 步处理（避免把已抽走的再匹配一遍）
    text = text.replace(new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, 'gi'), '')
  }

  // 4) 剩余 HTML 标签：只剥标签保留内部文字（限 500 字符，防跨大段误伤）。
  text = text.replace(/<[^>]{0,500}>/g, '')

  // 5) 还原受保护的代码围栏。
  text = text.replace(/\u0000FENCE(\d+)\u0000/g, (_match, index: string) => keptFences[Number(index)] ?? '')

  // 6) 空白整理：行尾空白、三连空行压成两行。
  text = text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { text, svgBlocks }
}
