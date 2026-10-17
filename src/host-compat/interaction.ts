/**
 * 跨版本窄腰·事件与交互接管（审批 / 交互提问 / 会话事件流）。
 *
 * 接管姿态（红线）：approval/request 与 user-questions/request 是宿主
 * **waterfall** 事件（@0.2.x 锚点 packages/interaction/user-approval/src/types.ts）：
 * handler **返回值即 outcome/answer**，调 next() 才委派下游（网页 UI）；
 * 因此本层必须把返回值透传给 cordis、把 next 透传给 handler——吞返回值
 * 等于整个接管面假接管（订阅了但永远委派）。以 {global, prepend} 抢在
 * 网页 UI 之前拿到请求。ctx.on 签名代际差异（4 参带 options vs 2 参直挂）
 * 一次探测收敛分派；老线 userQuestions.ask 装饰分支在 P1 落地（见 TODO）。
 */
import type { CordisLike } from '../types.js'

/** 宿主审批四值（字面量对齐 api-catalog ApprovalOutcome）。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface ApprovalRequest {
  agent?: unknown
  toolName?: string
  callId?: unknown
  reason?: string
  signal?: AbortSignal
  [key: string]: unknown
}

export interface QuestionRequest {
  questions?: Array<{
    id: string
    question?: string
    detail?: string
    header?: string
    multiSelect?: boolean
    options?: Array<{ label: string; description?: string }>
  }>
  agent?: unknown
  signal?: AbortSignal
  [key: string]: unknown
}

export interface QuestionAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

export interface InteractionHandlers {
  /** 返回 outcome 即接管；不调 next 则网页 UI 拿不到。 */
  onApproval?: (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome> | ApprovalOutcome
  onQuestion?: (request: QuestionRequest, next: () => Promise<QuestionAnswer>) => Promise<QuestionAnswer | undefined> | QuestionAnswer | undefined
  onSessionEvent?: (event: unknown) => void
  onAssistantStream?: (chunk: unknown) => void
}

type Unsubscribe = () => void

/** 探测式订阅：先按 4 参 + options 形态，抛错退 2 参形态，再退 3 参形态。
 * handler 允许返回值（waterfall 接管语义长在返回值上）。 */
export function subscribeEvent(
  ctx: CordisLike,
  event: string,
  handler: (...args: any[]) => unknown,
  options?: { global?: boolean; prepend?: boolean },
): Unsubscribe {
  if (typeof ctx.on !== 'function') return () => undefined
  const attempts: Array<() => unknown> = [
    () => (ctx.on as any)(event, {}, handler, options),
    () => (ctx.on as any)(event, handler),
    () => (ctx.on as any)(event, {}, handler),
  ]
  let lastError: unknown
  for (const attempt of attempts) {
    try {
      const ret = attempt()
      if (typeof ret === 'function') return ret as Unsubscribe
      return () => undefined
    } catch (error) {
      lastError = error
    }
  }
  ctx.logger('dsh-im-union').warn(`事件订阅失败 ${event}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
  return () => undefined
}

/** 挂全部交互监听，返回总退订。 */
export function attachInteraction(ctx: CordisLike, handlers: InteractionHandlers): Unsubscribe {
  const disposers: Unsubscribe[] = []
  if (handlers.onApproval) {
    disposers.push(
      subscribeEvent(
        ctx,
        'approval/request',
        // 返回值透传：waterfall 的接管语义就长在返回值上，这里吞一下
        // 下游（网页 UI）就永远拿回请求——接管面变监听面的静默假死。
        (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) =>
          handlers.onApproval?.(request, typeof next === 'function' ? next : async () => 'unavailable'),
        { global: true, prepend: true },
      ),
    )
  }
  if (handlers.onQuestion) {
    disposers.push(
      subscribeEvent(
        ctx,
        'user-questions/request',
        (request: QuestionRequest, next: () => Promise<QuestionAnswer>) =>
          handlers.onQuestion?.(request, typeof next === 'function' ? next : async () => ({ answers: [] })),
        { global: true, prepend: true },
      ),
    )
  }
  // TODO(P1): legacy userQuestions.ask 装饰分支（0.1.1 线可变 provider 藏在
  // 稳定 service.ask 后，需 Object.defineProperty 包裹接管）。
  if (handlers.onSessionEvent) {
    disposers.push(
      subscribeEvent(ctx, 'session/event', (event: unknown) => handlers.onSessionEvent?.(event), { global: true }),
    )
  }
  if (handlers.onAssistantStream) {
    disposers.push(
      subscribeEvent(ctx, 'agent/assistant-stream', (chunk: unknown) => handlers.onAssistantStream?.(chunk), {
        global: true,
      }),
    )
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 退订失败不阻断卸载。
      }
    }
  }
}
