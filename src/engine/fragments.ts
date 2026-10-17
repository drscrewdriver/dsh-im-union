/**
 * 碎片续写合并（T2.8 前半）。
 *
 * 语义（spec）：
 * - **仅私聊**参与（群聊多用户串碎片=事故，直接不参与）；
 * - 以 `..` 结尾 → 挂起（去掉结尾标记），5 秒合并窗，窗口内多条按序 join；
 * - 单独 `!!` → 立即提交挂起碎片（触发回合）；无挂起时给明确提示；
 * - 窗口到期自动提交已挂起内容（用户没写完也算一轮，不吞消息）。
 *
 * 零宿主依赖：计时器与提交回调全部注入，单测用短窗 + fake 时钟。
 */

export const FRAGMENT_WINDOW_MS = 5000
export const CONTINUE_SUFFIX = '..'
export const SUBMIT_COMMAND = '!!'

export type FragmentVerdict =
  | { handled: false }
  | { handled: true; action: 'held'; count: number }
  | { handled: true; action: 'submitted'; text: string }
  | { handled: true; action: 'empty' }

export interface FragmentDeps {
  /** 提交合并后的整段文本（由网关转成一次正常入站回合）。 */
  submit: (chatKey: string, text: string) => void | Promise<void>
  windowMs?: number
  /** 注入计时器（返回取消函数），测试用假时钟。 */
  schedule?: (fn: () => void, ms: number) => () => void
  logWarn?: (msg: string) => void
}

interface Hold {
  parts: string[]
  cancel: () => void
}

export class FragmentBuffer {
  private holds = new Map<string, Hold>()
  private readonly windowMs: number

  constructor(private readonly deps: FragmentDeps) {
    this.windowMs = deps.windowMs ?? FRAGMENT_WINDOW_MS
  }

  pending(chatKey: string): string[] {
    return [...(this.holds.get(chatKey)?.parts ?? [])]
  }

  size(): number {
    return this.holds.size
  }

  /** 立即提交（`!!` 或关停）；无挂起回 false。 */
  async flush(chatKey: string): Promise<boolean> {
    const hold = this.holds.get(chatKey)
    if (hold === undefined) return false
    hold.cancel()
    this.holds.delete(chatKey)
    const text = hold.parts.join('').trim()
    if (text === '') return false
    await this.deps.submit(chatKey, text)
    return true
  }

  /** 丢弃该聊天的挂起内容（注销/清绑定时用）。 */
  drop(chatKey: string): void {
    const hold = this.holds.get(chatKey)
    if (hold === undefined) return
    hold.cancel()
    this.holds.delete(chatKey)
  }

  dispose(): void {
    for (const key of [...this.holds.keys()]) this.drop(key)
  }

  /**
   * 入站前置判定。
   * @param isDm 私聊才参与；群聊一律 handled=false（走原流程）。
   */
  async accept(chatKey: string, rawText: string, isDm: boolean): Promise<FragmentVerdict> {
    const text = rawText.trim()
    if (!isDm) return { handled: false }

    if (text === SUBMIT_COMMAND) {
      return (await this.flush(chatKey)) ? { handled: true, action: 'submitted', text: '' } : { handled: true, action: 'empty' }
    }

    const continuing = text.endsWith(CONTINUE_SUFFIX)
    if (!continuing && this.holds.get(chatKey)?.parts.length !== 0) return { handled: false }

    // 有挂起 → 窗口内追加并按序 join；无挂起且以 .. 结尾 → 开新挂起。
    const payload = continuing ? text.slice(0, -CONTINUE_SUFFIX.length) : text
    if (continuing && payload.trim() === '') return { handled: false }

    const hold = this.holds.get(chatKey) ?? { parts: [], cancel: () => undefined }
    hold.parts.push(payload)
    hold.cancel()
    hold.cancel = this.arm(chatKey)
    this.holds.set(chatKey, hold)
    return { handled: true, action: 'held', count: hold.parts.length }
  }

  private arm(chatKey: string): () => void {
    const fire = () => {
      void this.flush(chatKey).catch((error: Error) => this.deps.logWarn?.(`碎片自动提交失败: ${error.message}`))
    }
    if (typeof this.deps.schedule === 'function') return this.deps.schedule(fire, this.windowMs)
    const timer = setTimeout(fire, this.windowMs)
    timer.unref?.()
    return () => clearTimeout(timer)
  }
}
