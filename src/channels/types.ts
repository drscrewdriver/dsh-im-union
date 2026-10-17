/**
 * 渠道契约（净室核心接口）。
 *
 * 设计约束：
 * - 能力位 caps 缺省即"明确降级"——引擎按 caps 走，适配器不抛"不支持"；
 * - 回复原语返回 Receipt：平台接受 ≠ 已送达；uncertain=true 时引擎禁止
 *   自动重发（宁可漏发不双发）；
 * - 适配器不创建 agent/会话——会话归 engine，渠道只管收发。
 */
import type { ChatAddress } from '../engine/router.js'

export interface ChannelCaps {
  /** 编辑同一条消息做流式输出 */
  editStream: boolean
  /** 原生流式接口（卡片/富文本直播） */
  nativeStream: boolean
  /** 原生按钮/选项卡（否则数字菜单回退） */
  nativeChoices: boolean
  /** 状态表情回应/标签 */
  statusReaction: boolean
  /** "正在输入"提示 */
  typing: boolean
  /** 收图片 */
  imageIn: boolean
  /** 收文件 */
  fileIn: boolean
  /** 回传文件 */
  fileOut: boolean
  /** 话题/线程模型 */
  threads: boolean
  /** 语音交互（P2，飞书专属） */
  voice: boolean
  /** 单条消息长度上限（超限由引擎分段） */
  maxMessageLength: number
}

export interface Receipt {
  /** 平台侧消息 id（能拿到就给，用于后续编辑/撤回） */
  platformMessageId?: string
  /** 发送结果不确定（超时/断连）——true 时禁自动重发 */
  uncertain: boolean
}

export interface SemanticMessage {
  address: ChatAddress
  userId: string
  /** 显示名，仅用于白名单管理页展示，不参与鉴权 */
  userDisplayName?: string
  text: string
  /** 原始消息是否 @ 了本机器人 */
  mentionedBot: boolean
  /** 被引用消息的文本摘要（引擎做上下文增强用） */
  quoteText?: string
  /** 图片附件（渠道下载后的字节，M1 起填） */
  images?: Array<{ name: string; data: Uint8Array; mimeType: string }>
  /** 普通文件附件（P1） */
  files?: Array<{ name: string; data: Uint8Array }>
  /** 平台原始时间戳（ms） */
  timestamp?: number
}

export interface ReplyStream {
  update(markdown: string): Promise<void>
  finish(markdown: string): Promise<Receipt>
  abort(): void
}

export interface OutboundFile {
  name: string
  data: Uint8Array
  mimeType?: string
}

export type MessageListener = (message: SemanticMessage) => void

export interface ChannelAdapter {
  readonly id: string
  readonly label: string
  readonly caps: ChannelCaps
  connect(signal?: AbortSignal): Promise<void>
  disconnect(): Promise<void>
  readonly connected: boolean
  onMessage(listener: MessageListener): () => void
  reply(address: ChatAddress, text: string, signal?: AbortSignal): Promise<Receipt>
  /** caps.editStream || caps.nativeStream 才有；否则引擎退化为 reply。 */
  beginStream?(address: ChatAddress, signal?: AbortSignal): Promise<ReplyStream>
  sendFile?(address: ChatAddress, file: OutboundFile, signal?: AbortSignal): Promise<Receipt>
  /** 交互式提问/审批按钮；返回用户回包（文本或选项）。 */
  askChoices?(
    address: ChatAddress,
    question: string,
    options: readonly string[],
    multi: boolean,
    signal?: AbortSignal,
  ): Promise<{ answer: string; uncertain: boolean }>
  setTyping?(address: ChatAddress): Promise<void>
  /** 渠道内准入三态：true 放行 / false 拒绝 / undefined 交给全局白名单。 */
  authorize?(message: SemanticMessage): boolean | undefined
  diagnose?(signal?: AbortSignal): Promise<ChannelDiagnosisCheck[]>
}

export interface ChannelDiagnosisCheck {
  name: string
  status: 'passed' | 'failed' | 'unverified'
  hint?: string
  elapsedMs?: number
}

/** 适配器工厂：凭 meta.fields 收集的配置 + 已解析的 secret 构造适配器。 */
export type ChannelFactory = (options: {
  accountId: string
  config: Record<string, string>
  secrets: Record<string, string | undefined>
  signal?: AbortSignal
}) => Promise<ChannelAdapter> | ChannelAdapter
