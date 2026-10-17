/**
 * 跨版本窄腰·事件与交互接管（审批 / 交互提问 / 会话事件流）。
 *
 * 接管姿态（红线）：approval/request 与 user-questions/request 以
 * {global:true, prepend:true} 订阅，抢在网页 UI 之前拿到请求对象；
 * ctx.on 的签名在代际间有差异（4 参带 options vs 2 参直挂），此处一次探测、
 * 收敛成分派，调用方不见差异。老线 userQuestions.ask 藏在可变 provider 后的
 * 装饰分支在 P1 落地（见 TODO）。
 */
import type { CordisLike } from '../types.js'

export interface ApprovalRequest {
  sessionId?: string
  [key: string]: unknown
}

export interface InteractionHandlers {
  onApproval?: (request: ApprovalRequest) => void | Promise<void>
  onQuestion?: (request: ApprovalRequest) => void | Promise<void>
  onSessionEvent?: (event: unknown) => void
  onAssistantStream?: (chunk: unknown) => void
}

type Unsubscribe = () => void

/** 探测式订阅：先按 4 参 + options 形态，抛错退 2 参形态，再退 3 参形态。 */
export function subscribeEvent(
  ctx: CordisLike,
  event: string,
  handler: (...args: any[]) => void | Promise<void>,
  options?: { global?: boolean; prepend?: boolean },
): Unsubscribe {
  if (typeof ctx.on !== 'function') return () => undefined
  const attempts: Array<() => unknown> = [
    () => ctx.on!(event, {}, handler, options),
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
      subscribeEvent(ctx, 'approval/request', (request: ApprovalRequest) => void handlers.onApproval?.(request), {
        global: true,
        prepend: true,
      }),
    )
  }
  if (handlers.onQuestion) {
    disposers.push(
      subscribeEvent(
        ctx,
        'user-questions/request',
        (request: ApprovalRequest) => void handlers.onQuestion?.(request),
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
