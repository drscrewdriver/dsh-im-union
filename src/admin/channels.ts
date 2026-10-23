/**
 * 渠道 rail 数据面组装（0.4.0）：im:union: 会话按渠道分组，合并绑定/历史/最近出站态。
 * 纯函数（零宿主依赖、零 secret 回显——行键白名单，D4）；scanLimit 防未归档会话刷屏。
 */

export interface ChannelSessionRow {
  sessionId: string
  title?: string
  running: boolean
  bound: boolean
  detached: boolean
  lastOutAt?: number
}

export interface ChannelGroup {
  channel: string
  sessions: ChannelSessionRow[]
}

export function groupChannelSessions(
  sessions: Array<{ id: string; title?: string; running?: boolean }>,
  face: {
    bound: Set<string>
    historical: (sessionId: string) => boolean
    lastOut: Map<string, number>
    /** 扫描上限：宿主会话极多时渠道 rail 不背全量（缺省 500）。 */
    scanLimit?: number
  },
): ChannelGroup[] {
  const groups = new Map<string, ChannelSessionRow[]>()
  for (const s of sessions.slice(0, face.scanLimit ?? 500)) {
    if (!s.id.startsWith('im:union:')) continue
    // id 形态 im:union:<channel>:<kind>:<chatId>[:<thread>][:<纪元>]，渠道固定第 3 段。
    const channel = s.id.split(':')[2] ?? 'unknown'
    const list = groups.get(channel) ?? []
    const lastOutAt = face.lastOut.get(s.id)
    list.push({
      sessionId: s.id,
      ...(s.title !== undefined && s.title !== '' ? { title: s.title } : {}),
      running: s.running === true,
      bound: face.bound.has(s.id),
      detached: face.historical(s.id),
      ...(lastOutAt !== undefined ? { lastOutAt } : {}),
    })
    groups.set(channel, list)
  }
  return [...groups.entries()].map(([channel, items]) => ({ channel, sessions: items }))
}
