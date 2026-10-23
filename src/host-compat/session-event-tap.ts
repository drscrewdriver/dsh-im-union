/**
 * 跨版本窄腰·会话事件总线（host 侧正统消费面）。
 *
 * 0.2.x 线真机实证（desktop）：@Remote('follow') 是 stream 形态，直调结果不产出
 * 事件帧（回合事件零到达 → 全部看门狗超时）。宿主侧插件消费回合输出的正统面是
 * cordis 总线 `session/event`（core/session Events 声明：`(session, event) => void`，
 * 全量 firehose；envelope {type, seq, time, data} 与引擎消费形一致）。
 *
 * 本面把总线按 sessionId 扇出给每回合订阅者；总线不可用（极老线）返回 undefined，
 * 引擎回退 sessionApi.follow 旧路。
 */
import type { CordisLike } from '../types.js'

export interface SessionEventTap {
  subscribe(sessionId: string, onEvent: (event: unknown) => void): () => void
}

export function createSessionEventTap(ctx: CordisLike): SessionEventTap | undefined {
  const ctxOn = (ctx as { on?: unknown }).on
  if (typeof ctxOn !== 'function') return undefined
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const handler = (...args: unknown[]) => {
    const session = args[0] as { id?: unknown } | undefined
    const event = args[1]
    const id =
      session !== null && typeof session === 'object' && typeof session.id === 'string' ? session.id : undefined
    if (id === undefined || event === undefined || event === null) return
    const set = listeners.get(id)
    if (set === undefined) return
    for (const onEvent of set) {
      try {
        onEvent(event)
      } catch {
        // 单订阅者异常不拖垮总线分发。
      }
    }
  }
  try {
    ctxOn.call(ctx, 'session/event', handler)
  } catch {
    return undefined
  }
  return {
    subscribe(sessionId, onEvent) {
      let set = listeners.get(sessionId)
      if (set === undefined) {
        set = new Set()
        listeners.set(sessionId, set)
      }
      set.add(onEvent)
      return () => {
        set?.delete(onEvent)
        if (set !== undefined && set.size === 0) listeners.delete(sessionId)
      }
    },
  }
}
