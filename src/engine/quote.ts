/**
 * 引用原文合并（T3.6 上下文增强·公共小工具）。
 *
 * 各渠道「按消息 id 回取被引用原文」面查实（公开文档，逐条对照现网镜像）：
 * - **Discord 有公开面 → 实装**：Get Channel Message
 *   `GET /channels/{channel.id}/messages/{message.id}`
 *   （https://discord.com/developers/docs/resources/message#get-message）。
 *   同页 Message Reference Object/Types：`message_reference.type` 缺省按 DEFAULT(0) 处理，
 *   DEFAULT 耦合消息体字段 `referenced_message`、FORWARD(1) 耦合 `message_snapshot`；
 *   `channel_id` 在事件侧「总是存在」。→ 先读内联字段，不在位才发 REST。
 * - **Slack 有公开面 → 实装（线程语境）**：`conversations.replies`
 *   （https://docs.slack.dev/reference/methods/conversations.replies —— channel+ts 必填，
 *   ts 可为线程根或线程内任一消息；https://docs.slack.dev/messaging/retrieving-messages ——
 *   返回的 messages 数组首元素即线程父消息）。Slack 无独立「引用」消息类型，线程才是
 *   回复载体；事件体父位字段是 `thread_ts`，**没有** `parent_message_id`。
 *   成本：同页 usage info 记非 Marketplace 新装应用被限到 1 req/min → 调用面加缓存收敛。
 * - **Telegram 无公开面 → 诚实不接**：Bot API 方法总表
 *   （https://core.telegram.org/bots/methods）内不存在按消息 id 取单条消息的方法
 *   （无 getMessage/getMessageById）；引用原文本就随 `Message.reply_to_message` 内联下发
 *   （https://core.telegram.org/bots/types#message）→ 渠道现有截断即协议上限内的最优解，
 *   本批不改 telegram.ts（截断位保持 200）。
 * - **微信 iLink / 企业微信（含应用）回调 → 诚实不接**：公开回调/消息体只给消息本身，
 *   无「按 id 取历史原文」的公开 REST 面（企微 API 检索面为企业内部应用消息，不覆盖
 *   会话历史原文）→ 保持渠道现状。
 *
 * 上限：注入宿主 prompt 的引用块取 800 **码点**（不是 UTF-16 长度）——渠道摘要原为 200，
 * 取回原文后要扩到 800 才有上下文价值，同时避免无限长原文挤占会话窗口。截断按码点走，
 * 不把代理对（emoji/生僻字）劈成半个。
 */

/** 引用块总长上限（码点，含标记）。 */
export const QUOTE_MAX_CODEPOINTS = 800

/** 标记形态：`\n[引用#<messageId>]`；refId 为空则无标记。 */
export function quoteMarker(refId: string): string {
  const id = typeof refId === 'string' ? refId.trim() : ''
  return id === '' ? '' : `\n[引用#${id}]`
}

/** 按码点截断（不超过 max；max 非正数回空串）。 */
export function capCodepoints(text: string, max: number): string {
  const source = typeof text === 'string' ? text : ''
  if (!Number.isFinite(max) || max <= 0) return ''
  const chars = Array.from(source)
  if (chars.length <= max) return source
  return `${chars.slice(0, max - 1).join('')}…`
}

function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * 合并引用文本：
 * - **现有值优先**：渠道已判定并写入的 quoteText（例如自带内联摘要的渠道）不被覆盖；
 * - 无新值（fetched 空/失败）时**原样回** existing；两者皆空回 `''`；
 * - refId 非空时尾部附「引用#msgId」标记（同 id 已存在则不重复追加）；
 * - 结果按 {@link QUOTE_MAX_CODEPOINTS} 码点截断，标记位优先保留（截正文不截标记）。
 *
 * 纯函数：不触网、不改入参。
 */
export function mergeQuote(existing: string | undefined, fetched: string | undefined, refId: string): string {
  const base = hasText(existing) ? (existing as string) : hasText(fetched) ? (fetched as string) : ''
  if (base === '') return ''
  const marker = quoteMarker(refId)
  const marked = marker === '' || base.includes(marker.trim()) ? base : `${base}${marker}`
  if (marker === '' || marked.length <= QUOTE_MAX_CODEPOINTS) {
    return capCodepoints(marked, QUOTE_MAX_CODEPOINTS)
  }
  const body = capCodepoints(base, QUOTE_MAX_CODEPOINTS - Array.from(marker).length)
  return `${body}${marker}`
}

/**
 * 入站正文 + 引用上下文（网关唯一触点，T3.6）：
 * 无引用（未填/空串）时原样回正文，不给模型添噪声。
 * 引用块以「引用上下文：」领起，与用户本轮指令显式分开。
 */
export function withQuoteContext(text: string, quoteText: string | undefined): string {
  const body = typeof text === 'string' ? text : ''
  if (!hasText(quoteText)) return body
  const quote = (quoteText as string).trim()
  return body === '' ? `引用上下文：\n${quote}` : `${body}\n\n引用上下文：\n${quote}`
}
