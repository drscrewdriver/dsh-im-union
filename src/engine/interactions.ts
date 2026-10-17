/**
 * 审批与交互提问的 IM 闭环（T1.9）。
 *
 * 红线语义（D5）：
 * - 默认拒绝：投递明确失败 → 立即 rejected；结果不明（uncertain）→ 保持 pending
 *   等到超时按 cancelled（两种都是 fail-closed，不伪装批准）；
 * - 原聊天闭环：请求路由回触发该会话的聊天，不另开通道、不回退网页——
 *   会话面查不到的请求**交还 next()**（网页 UI 仍可处理）；
 * - 群聊仅发起者：答案只认发起该任务的 userId，他人消息不消费；
 * - 5 分钟取消：超时/宿主 signal abort → cancelled；
 * - 不自动恢复 allowAllUsers：本模块无档位写面。
 *
 * 状态机纪律：每个 pending 的终结走唯一 once-settle（用户回复/超时/abort/
 * 拆除四方竞争，先到先得，后到静默忽略）——多路径 clear+resolve 组合会出
 * 「cleanup 抢答覆盖用户决定」与递归重入两类事故，禁止复发。
 *
 * 协议锚点（@0.2.x packages/interaction/user-approval/src/types.ts、api-catalog）：
 * approval/request waterfall 返回 ApprovalOutcome 即接管；
 * user-questions/request 返回 {answers:[{id,selected,custom?}]} 即接管。
 */
import type { ChannelAdapter } from '../channels/types.js'
import type { ChatAddress } from './router.js'
import { chatKey } from './router.js'
import type { ApprovalOutcome, ApprovalRequest, QuestionAnswer, QuestionRequest } from '../host-compat/interaction.js'

export interface ChatSessionRef {
  accountId: string
  address: ChatAddress
  /** 任务发起者（群聊审批只认这个 userId）。 */
  userId: string
}

export interface BrokerDeps {
  resolveChat: (sessionId: string) => ChatSessionRef | undefined
  getAdapter: (accountId: string) => ChannelAdapter | undefined
  timeoutMs?: number
  logWarn: (msg: string) => void
}

type AskValue = ApprovalOutcome | QuestionAnswer['answers'][number]

interface PendingBase {
  chat: ChatSessionRef
  settle: (value: AskValue) => void
}

interface PendingApproval extends PendingBase {
  kind: 'approval'
}

interface PendingQuestion extends PendingBase {
  kind: 'question'
  item: NonNullable<QuestionRequest['questions']>[number]
}

type Pending = PendingApproval | PendingQuestion

const APPROVE_WORDS = ['1', 'y', 'yes', 'allow', '允许', '同意', '批准']
const REJECT_WORDS = ['2', 'n', 'no', 'deny', 'reject', '拒绝', '否决']
const CANCEL_WORDS = ['c', 'cancel', '取消']

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

/** 从 agent 对象防御式取会话 id（ACP 先例：agent.session.id；不保证老线同形）。 */
export function sessionIdOfAgent(agent: unknown): string | undefined {
  if (agent === null || typeof agent !== 'object') return undefined
  const a = agent as Record<string, unknown>
  const direct = typeof a.sessionId === 'string' ? a.sessionId : undefined
  const nested = (a.session as Record<string, unknown> | undefined)?.id
  return typeof nested === 'string' ? nested : direct
}

function normalize(text: string): string {
  return text.trim().toLowerCase()
}

const EMPTY_ANSWER_FOR = (item: { id: string }): QuestionAnswer['answers'][number] => ({
  id: item.id,
  selected: [],
  custom: '',
})

export class InteractionBroker {
  private pendings = new Map<string, Pending>()
  private readonly timeoutMs: number

  constructor(private readonly deps: BrokerDeps) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private keyOf(address: ChatAddress): string {
    return chatKey(address)
  }

  /**
   * 统一 once-settle：登记删除/清定时器/摘 abort 监听/终结 promise 只发生一次。
   * abort/超时各自带类型正确的兼值（approval=cancelled，question=空答）；
   * 监听器引用固定（匿名函数 removeEventListener 摘不掉是低级事故高发区）。
   * signal 已 aborted 时返回 armed=false，调用方直接放弃挂 pending。
   */
  private beginWait(
    key: string,
    resolveOuter: (value: AskValue) => void,
    opts: { abortValue: AskValue; timeoutValue: AskValue; signal?: AbortSignal },
  ): { armed: boolean; settle: (value: AskValue) => void; armTimeout: () => void } {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (value: AskValue): void => {
      if (settled) return
      settled = true
      this.pendings.delete(key)
      if (timer !== undefined) clearTimeout(timer)
      if (opts.signal !== undefined) opts.signal.removeEventListener('abort', onAbort)
      resolveOuter(value)
    }
    const onAbort = (): void => settle(opts.abortValue)
    if (opts.signal !== undefined) {
      if (opts.signal.aborted) {
        settle(opts.abortValue)
        return { armed: false, settle, armTimeout: () => undefined }
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    return {
      armed: true,
      settle,
      armTimeout: () => {
        timer = setTimeout(() => settle(opts.timeoutValue), this.timeoutMs)
      },
    }
  }

  /**
   * 审批接管入口（attachInteraction onApproval）。会话面查不到/同聊天已有
   * pending/无适配器 → next() 委派（网页 UI 照常可用）。
   */
  async handleApproval(request: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const sessionId = sessionIdOfAgent(request.agent)
    const chat = sessionId !== undefined ? this.deps.resolveChat(sessionId) : undefined
    if (chat === undefined) return next()
    const adapter = this.deps.getAdapter(chat.accountId)
    if (adapter === undefined) return next()
    const key = this.keyOf(chat.address)
    if (this.pendings.has(key)) return next()

    // 按钮面（caps.nativeChoices + askChoices）优先；失败语义统一 fail-closed。
    if (typeof adapter.askChoices === 'function' && adapter.caps.nativeChoices === true) {
      try {
        const { answer, uncertain } = await adapter.askChoices(
          chat.address,
          `需要审批：工具 ${request.toolName ?? '未知'}${request.reason ? `（${request.reason}）` : ''}`,
          ['允许一次', '拒绝'],
          false,
          request.signal,
        )
        if (uncertain) return 'cancelled'
        if (answer === '允许一次') return 'allowed-once'
        if (answer === '拒绝') return 'rejected'
        return 'cancelled'
      } catch (error) {
        this.deps.logWarn(`askChoices 失败，回落文本审批: ${(error as Error).message}`)
        // 按钮面炸了不吞请求：继续走文本菜单（下方）。
      }
    }

    const text = [
      `需要审批：工具 ${request.toolName ?? '未知'}${request.reason ? `（${request.reason}）` : ''}`,
      '回复 1 允许一次 / 2 拒绝 / c 取消（5 分钟内有效）',
    ].join('\n')
    try {
      const receipt = await adapter.reply(chat.address, text)
      if (receipt.uncertain) {
        this.deps.logWarn('审批投递结果不明，等待用户回复（超时按取消）')
      }
    } catch (error) {
      // 明确投递失败 = 用户根本看不到请求：按拒绝（D5 失败按拒绝）。
      this.deps.logWarn(`审批投递失败，按拒绝处理: ${(error as Error).message}`)
      return 'rejected'
    }

    const signal = request.signal
    return new Promise<ApprovalOutcome>((resolveOuter) => {
      const wait = this.beginWait(key, (v) => resolveOuter(v as ApprovalOutcome), {
        abortValue: 'cancelled',
        timeoutValue: 'cancelled',
        ...(signal !== undefined ? { signal } : {}),
      })
      if (!wait.armed) return
      wait.armTimeout()
      this.pendings.set(key, { kind: 'approval', chat, settle: wait.settle })
    })
  }

  /** 入站消息消费审批/回答；true=已消费（不进会话队列）。 */
  consumeInbound(chatAccountId: string, address: ChatAddress, userId: string, text: string): boolean {
    const key = this.keyOf(address)
    const pending = this.pendings.get(key)
    if (pending === undefined) return false
    if (pending.chat.accountId !== chatAccountId) return false
    // 仅发起者可答（D5）：他人回复落回正常会话流。
    if (userId !== pending.chat.userId) return false

    if (pending.kind === 'approval') {
      const word = normalize(text)
      if (APPROVE_WORDS.includes(word)) {
        pending.settle('allowed-once')
        return true
      }
      if (REJECT_WORDS.includes(word)) {
        pending.settle('rejected')
        return true
      }
      if (CANCEL_WORDS.includes(word)) {
        pending.settle('cancelled')
        return true
      }
      // 无效回复：pending 不终结，只回提示（消息已消费，不进任务队列）。
      const adapter = this.deps.getAdapter(chatAccountId)
      void adapter?.reply(address, '请回复 1（允许一次）、2（拒绝）或 c（取消）。')
      return true
    }

    // question：数字菜单解析（单选序号 / 多选逗号 / 其余为自由文本 custom）
    const item = pending.item
    const options = item.options ?? []
    const word = text.trim()
    let answer: QuestionAnswer['answers'][number]
    if (options.length > 0 && /^\d+(?:\s*,\s*\d+)*$/.test(word)) {
      const idxs = word
        .split(',')
        .map((v) => Number(v.trim()) - 1)
        .filter((n) => Number.isInteger(n) && n >= 0 && n < options.length)
      const selected = idxs.map((n) => String(options[n]?.label ?? ''))
      if (selected.length === 0) {
        const adapter = this.deps.getAdapter(chatAccountId)
        void adapter?.reply(address, `序号超出范围（1-${options.length}）。`)
        return true
      }
      answer = item.multiSelect === true ? { id: item.id, selected } : { id: item.id, selected: [selected[0] ?? ''] }
    } else {
      answer = { id: item.id, selected: [], custom: word }
    }
    pending.settle(answer)
    return true
  }

  /** 逐题问答（文本菜单形态；askChoices 的按钮形态随渠道真机验收接入）。 */
  async handleQuestion(request: QuestionRequest, next: () => Promise<QuestionAnswer>): Promise<QuestionAnswer> {
    const sessionId = sessionIdOfAgent(request.agent)
    const chat = sessionId !== undefined ? this.deps.resolveChat(sessionId) : undefined
    const items = request.questions ?? []
    if (chat === undefined || items.length === 0) return next()
    const adapter = this.deps.getAdapter(chat.accountId)
    if (adapter === undefined) return next()
    const key = this.keyOf(chat.address)
    if (this.pendings.has(key)) return next()

    const answers: QuestionAnswer['answers'] = []
    for (const item of items) {
      const lines = [item.header ? `【${item.header}】` : '', item.question ?? '', item.detail ? `说明：${item.detail}` : '']
        .filter((line) => line !== '')
        .join('\n')
      const optionLines = (item.options ?? []).map((opt, i) => `${i + 1}. ${opt.label}`)
      const hint =
        optionLines.length > 0
          ? item.multiSelect === true
            ? '回复序号（可多选，逗号分隔）或直接输入自定义答案'
            : '回复序号或直接输入自定义答案'
          : '请直接输入答案'
      try {
        await adapter.reply(chat.address, [lines, ...optionLines, hint].join('\n'))
      } catch (error) {
        this.deps.logWarn(`提问投递失败，交还网页: ${(error as Error).message}`)
        return next()
      }
      const answer = await new Promise<QuestionAnswer['answers'][number]>((resolveAnswer) => {
        const wait = this.beginWait(key, (v) => resolveAnswer(v as QuestionAnswer['answers'][number]), {
          abortValue: EMPTY_ANSWER_FOR(item),
          timeoutValue: EMPTY_ANSWER_FOR(item),
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        })
        if (!wait.armed) return
        wait.armTimeout()
        this.pendings.set(key, { kind: 'question', chat, item, settle: wait.settle })
      })
      answers.push(answer)
    }
    return { answers }
  }

  /** 会话/账号拆除时清理其 pending（避免账号删除后审批悬挂）。 */
  dropChat(address: ChatAddress): void {
    const pending = this.pendings.get(this.keyOf(address))
    if (pending === undefined) return
    if (pending.kind === 'approval') pending.settle('cancelled')
    else pending.settle(EMPTY_ANSWER_FOR(pending.item))
  }

  /** 账号拆除连带：该账号全部 pending 按 fail-closed 终结。 */
  dropAccount(accountId: string): void {
    for (const pending of [...this.pendings.values()]) {
      if (pending.chat.accountId !== accountId) continue
      if (pending.kind === 'approval') pending.settle('cancelled')
      else pending.settle(EMPTY_ANSWER_FOR(pending.item))
    }
  }

  hasPending(address: ChatAddress): boolean {
    return this.pendings.has(this.keyOf(address))
  }
}
