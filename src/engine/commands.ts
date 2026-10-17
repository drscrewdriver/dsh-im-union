/**
 * 命令面板公共层（T1.1）：IM 文本命令 → 解析/分派 → 回复文案。
 *
 * 纪律：
 * - 一切宿主面走 SessionApi/caps 的运行时探测结果，缺位=降级文案不抛错
 *   （"能力缺位=明确降级而非抛错"——checklist E1）；
 * - 分派层不碰渠道细节（按钮/数字菜单回退归渠道 caps.nativeChoices）；
 * - 白名单/群 @ 准入在网关 admitted() 先于命令分派执行（红线 D6），
 *   本文件默认进来即已获授权；
 * - /reasoning 需要当前模型上下文：selections 记账在引擎态（按 sessionId），
 *   丢失时退 catalog.default——两种来源都缺则明示无法合并。
 */
import type { ChatAddress, ChatRouter } from './router.js'
import { chatKey } from './router.js'
import type { ModelCatalogLike, SessionApi, SessionInfo } from '../host-compat/session-api.js'
import type { UnionCapabilities } from '../host-compat/services.js'
import type { DeliveryLog } from './delivery-log.js'

export interface CommandDeps {
  sessionApi: SessionApi
  router: ChatRouter
  caps: UnionCapabilities
  /** 宿主会话 id → 最近一次模型选择；键统一为 chatKey（与 runTurn 真 id 解耦，
   *  否则 /model 记隐式 id、投递查宿主 id，两边永不相见）。 */
  selections: Map<string, { model?: string; provider?: string; reasoningEffort?: string }>
  /** 渠道会话 id → 工作区覆盖（/workspace 设定，createSession 消费）。 */
  workspaceOverrides: Map<string, string>
  vaultKind: string
  logWarn: (msg: string) => void
  // —— M2 能力包挂点（缺位=命令降级文案，E1）——
  deliveryLog?: DeliveryLog
  /** /delivery retry：网关用原 adapter+outbox 补发，回用户文案。 */
  retryDelivery?: (seq: number) => Promise<string>
  /** /export：网关打 ZIP 并尽量 sendFile，回文案。 */
  exportChat?: (address: ChatAddress, sessionId: string) => Promise<string>
  /** /queue：本聊天队列快照（引擎态）。 */
  queueInfo?: (address: ChatAddress) => { running: boolean; pending: number }
  /** /mute：切换本聊天静音，回文案。 */
  toggleMute?: (address: ChatAddress) => string
  /** /goal：IM 侧目标备忘（chatKey → 文本）。 */
  goals: Map<string, string>
  /** /speak：语音回本聊天（T3.5 飞书语音档）；缺位=降级文案。 */
  speakText?: (address: ChatAddress, text: string) => Promise<string>
}

export interface ParsedCommand {
  name: string
  arg: string
}

const COMMAND_TABLE: Array<{ name: string; usage: string; desc: string }> = [
  { name: 'help', usage: '/help', desc: '命令列表' },
  { name: 'menu', usage: '/menu', desc: '同 /help（按钮渠道会渲染菜单）' },
  { name: 'status', usage: '/status', desc: '连接与能力状态' },
  { name: 'new', usage: '/new', desc: '重开会话（解除绑定）' },
  { name: 'stop', usage: '/stop', desc: '停止当前任务' },
  { name: 'steer', usage: '/steer <文本>', desc: '向运行中的任务插话' },
  { name: 'models', usage: '/models', desc: '列出可用模型' },
  { name: 'model', usage: '/model <id>', desc: '切换模型' },
  { name: 'reasoning', usage: '/reasoning <档位>', desc: '调整思考强度' },
  { name: 'presets', usage: '/presets', desc: '列出智能体预设' },
  { name: 'preset', usage: '/preset <名称>', desc: '切换预设' },
  { name: 'sessions', usage: '/sessions', desc: '列出近期会话' },
  { name: 'session', usage: '/session <id|序号>', desc: '绑定既有会话' },
  { name: 'workspaces', usage: '/workspaces', desc: '列出工作区' },
  { name: 'workspace', usage: '/workspace <路径|序号>', desc: '设定新会话工作区' },
  { name: 'fork', usage: '/fork', desc: '分叉当前会话另起新会话' },
  { name: 'rename', usage: '/rename <标题>', desc: '重命名当前会话' },
  { name: 'queue', usage: '/queue', desc: '查看本聊天排队状态' },
  { name: 'mute', usage: '/mute', desc: '静音/恢复本聊天（静音期只读）' },
  { name: 'unbind', usage: '/unbind', desc: '解除会话绑定（不新开会话）' },
  { name: 'goal', usage: '/goal <文本|->', desc: '设定/清除本聊天目标备忘' },
  { name: 'delivery', usage: '/delivery [retry <序号>]', desc: '投递日志/补发失败项' },
  { name: 'export', usage: '/export', desc: '导出本聊天投递记录 ZIP' },
  { name: 'speak', usage: '/speak <文本>', desc: '语音回复（仅开启语音档的渠道）' },
]

/** 行首 `/词` 才是命令；`/path` 之类文本不触发（群聊粘贴路径的误触面）。 */
export function parseCommand(text: string): ParsedCommand | undefined {
  const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (match === null) return undefined
  return { name: match[1].toLowerCase(), arg: (match[2] ?? '').trim() }
}

export function isCommandName(name: string): boolean {
  return COMMAND_TABLE.some((row) => row.name === name)
}

function helpText(): string {
  return ['可用命令：', ...COMMAND_TABLE.map((row) => `${row.usage} — ${row.desc}`)].join('\n')
}

function shortId(sessionId: string): string {
  const tail = sessionId.split(':').filter(Boolean)
  return (tail[tail.length - 1] ?? sessionId).slice(0, 12)
}

function renderCatalog(catalog: ModelCatalogLike): string {
  const lines: string[] = []
  if (typeof catalog.default?.model === 'string') {
    lines.push(`默认: ${catalog.default.model}${catalog.default.reasoningEffort ? `（${catalog.default.reasoningEffort}）` : ''}`)
  }
  for (const group of catalog.groups ?? []) {
    const models = (group.models ?? []).map((m) => m.id).join(', ')
    if (models !== '') lines.push(`${group.name ?? group.id}: ${models}`)
  }
  for (const failure of catalog.failures ?? []) {
    lines.push(`（通道 ${failure.name ?? failure.id} 目录加载失败，暂不可选）`)
  }
  return lines.length > 0 ? lines.join('\n') : '模型目录为空（宿主通道未加载）。'
}

/** 执行命令并返回要回复的文本；返回空串表示无需回复。 */
export async function runCommand(
  deps: CommandDeps,
  address: ChatAddress,
  sessionId: string,
  command: ParsedCommand,
): Promise<string> {
  const { sessionApi, router, caps } = deps
  switch (command.name) {
    case 'help':
    case 'menu':
      return helpText()
    case 'status':
      return [
        'dsh-im-union 状态',
        `设置面代际: ${caps.settingsGeneration}`,
        `会话后端: ${sessionApi.backend}`,
        `凭据: ${deps.vaultKind === 'service' ? '宿主凭据库' : '文件 vault'}`,
        `渠道: ${address.channel}（会话 ${shortId(sessionId)}）`,
      ].join('\n')
    case 'new':
      router.unbind(address)
      return '已解除会话绑定，下一条消息将开启新会话。'
    case 'stop':
      try {
        await sessionApi.cancel(sessionId)
        return '已请求停止当前任务。'
      } catch (error) {
        return error instanceof Error && error.name === 'UnsupportedError'
          ? '当前宿主不支持会话停止，请等待任务结束或使用网页端停止。'
          : '停止请求失败，请查看本机日志。'
      }
    case 'steer':
      if (command.arg === '') return '用法：/steer <要插的话>'
      return (await sessionApi.steer(sessionId, command.arg))
        ? '插话已注入当前任务。'
        : '当前宿主不支持插话注入；请等本轮结束后重新发送，或先 /stop。'
    case 'models': {
      const catalog = await sessionApi.modelCatalog()
      return catalog === undefined ? '当前宿主未暴露模型目录面，无法列模型。' : renderCatalog(catalog)
    }
    case 'model': {
      if (command.arg === '') return '用法：/model <id> 或 /model <provider>/<id>（/models 查看列表）'
      const slash = command.arg.indexOf('/')
      const selection = slash > 0
        ? { provider: command.arg.slice(0, slash), model: command.arg.slice(slash + 1) }
        : { model: command.arg }
      try {
        await sessionApi.selectModel(sessionId, selection)
        deps.selections.set(chatKey(address), selection)
        return `已切换模型：${command.arg}`
      } catch (error) {
        deps.logWarn(`selectModel 失败: ${(error as Error).message}`)
        return `模型切换失败：${command.arg}（原因已记入本机日志）`
      }
    }
    case 'reasoning': {
      if (command.arg === '') return '用法：/reasoning <low|medium|high>（以宿主支持的档位为准）'
      const current = deps.selections.get(chatKey(address))
      const catalog = current?.model === undefined ? await sessionApi.modelCatalog() : undefined
      const model = current?.model ?? catalog?.default?.model
      if (typeof model !== 'string') return '无法确定当前模型，请先 /model <id> 再调思考强度。'
      const provider = current?.provider ?? catalog?.default?.provider
      try {
        await sessionApi.selectModel(sessionId, {
          model,
          ...(provider !== undefined ? { provider } : {}),
          reasoningEffort: command.arg,
        })
        deps.selections.set(chatKey(address), { model, ...(provider !== undefined ? { provider } : {}), reasoningEffort: command.arg })
        return `已设置思考强度：${command.arg}（模型 ${model}）`
      } catch (error) {
        deps.logWarn(`selectModel(reasoning) 失败: ${(error as Error).message}`)
        return `思考强度设置失败（原因已记入本机日志）。`
      }
    }
    case 'presets': {
      const presets = await sessionApi.presetsList()
      return presets.length === 0
        ? '当前宿主未暴露智能体预设面，或无预设。'
        : ['可用预设：', ...presets.map((p, i) => `${i + 1}. ${p.name}`)].join('\n')
    }
    case 'preset': {
      if (command.arg === '') return '用法：/preset <名称>（/presets 查看列表）'
      const result = await sessionApi.presetSelect(command.arg)
      return result.ok ? `已切换预设：${command.arg}` : (result.message ?? '预设切换失败。')
    }
    case 'sessions': {
      const sessions = await sessionApi.listSessions()
      if (sessions.length === 0) return '未读到会话列表。'
      const lines = sessions.slice(0, 10).map((s: SessionInfo, i: number) => {
        const marks = [s.id === sessionId ? '←当前' : '', s.running === true ? '[运行中]' : ''].filter(Boolean).join('')
        return `${i + 1}. ${shortId(s.id)}${s.title !== undefined ? ` ${s.title}` : ''}${marks !== '' ? ` ${marks}` : ''}`
      })
      return ['近期会话（/session <序号|id 片段> 绑定）：', ...lines].join('\n')
    }
    case 'session': {
      if (command.arg === '') return '用法：/session <序号|id 片段>（/sessions 查看列表）'
      const sessions = await sessionApi.listSessions()
      const numeric = /^(\d+)$/.exec(command.arg)
      let target: string | undefined
      if (numeric !== null) {
        target = sessions[Number(numeric[1]) - 1]?.id
      } else {
        const hits = sessions.filter((s) => s.id.includes(command.arg))
        if (hits.length > 0) target = hits[0]?.id
      }
      if (target === undefined) return `未找到匹配会话：${command.arg}（先 /sessions 看列表）`
      router.bind(address, target)
      return `本聊天已绑定会话 ${shortId(target)}。`
    }
    case 'workspaces': {
      const sessions = await sessionApi.listSessions()
      const counts = new Map<string, number>()
      for (const s of sessions) {
        if (typeof s.cwd === 'string' && s.cwd !== '') counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1)
      }
      if (counts.size === 0) return '未读到工作区信息（宿主会话列表缺 cwd 面）。'
      const override = deps.workspaceOverrides.get(chatOverrideKey(address))
      return [
        '工作区（/workspace <路径|序号> 设定新会话默认）：',
        ...[...counts.entries()].map(([cwd, n], i) => `${i + 1}. ${cwd}（${n} 个会话）${override === cwd ? ' ←默认' : ''}`),
      ].join('\n')
    }
    case 'workspace': {
      const key = chatOverrideKey(address)
      if (command.arg === '') {
        const current = deps.workspaceOverrides.get(key)
        return current !== undefined ? `当前默认工作区：${current}（清除请用 /workspace -）` : '未设定默认工作区（跟随宿主）。'
      }
      if (command.arg === '-') {
        deps.workspaceOverrides.delete(key)
        return '已清除默认工作区设定。'
      }
      deps.workspaceOverrides.set(key, command.arg)
      return `新会话将使用工作区：${command.arg}`
    }
    case 'fork': {
      try {
        const newId = await sessionApi.fork(sessionId)
        deps.router.bind(address, newId)
        return `已分叉到新会话 ${shortId(newId)}，后续消息进新会话（历史在网页端查看）。`
      } catch (error) {
        return error instanceof Error && error.name === 'UnsupportedError'
          ? '当前宿主不支持会话分叉，请在网页端分叉后用 /session 绑定。'
          : '分叉失败，原因已记入本机日志。'
      }
    }
    case 'rename': {
      if (command.arg === '') return '用法：/rename <新标题>'
      return (await sessionApi.rename(sessionId, command.arg))
        ? `会话已重命名为：${command.arg}`
        : '当前宿主不支持会话重命名。'
    }
    case 'queue': {
      const info = deps.queueInfo?.(address)
      if (info === undefined) return '队列面不可用。'
      return `任务${info.running ? '进行中' : '空闲'}，排队 ${info.pending} 条。`
    }
    case 'mute':
      return deps.toggleMute !== undefined ? deps.toggleMute(address) : '静音面不可用。'
    case 'unbind':
      deps.router.unbind(address)
      return '已解除会话绑定（下一条消息惰性新建会话；与 /new 同机制，不归档旧会话）。'
    case 'goal': {
      const key = chatKey(address)
      if (command.arg === '') return deps.goals.get(key) !== undefined ? `当前目标：${deps.goals.get(key)}` : '未设定目标（/goal <文本> 设定，/goal - 清除）。'
      if (command.arg === '-') {
        deps.goals.delete(key)
        return '已清除目标备忘。'
      }
      deps.goals.set(key, command.arg)
      return `目标已记录：${command.arg}`
    }
    case 'delivery': {
      const retry = /^retry\s+(\d+)$/i.exec(command.arg)
      if (retry !== null) {
        if (deps.retryDelivery === undefined) return '投递日志未启用，无法补发。'
        return await deps.retryDelivery(Number(retry[1]))
      }
      if (deps.deliveryLog === undefined) return '投递日志未启用（本机状态目录磁盘/配置异常时降级）。'
      const rows = deps.deliveryLog.recent(10, { chatId: address.chatId, channel: address.channel })
      if (rows.length === 0) return '本聊天暂无投递记录（7 天内）。'
      return [
        '最近投递（/delivery retry <序号> 补发确定性失败项）：',
        ...rows.map((r) => `#${r.seq} [${r.status}] ×${r.attempts} ${r.summary}`),
      ].join('\n')
    }
    case 'export':
      if (deps.exportChat === undefined) return '导出面未启用。'
      return await deps.exportChat(address, sessionId)
    case 'speak': {
      if (command.arg === '') return '用法：/speak <要念的文本>'
      if (deps.speakText === undefined) return '当前宿主无语音面。'
      return await deps.speakText(address, command.arg)
    }
    default:
      return `未知命令 /${command.name}（/help 看可用命令）`
  }
}

export function chatOverrideKey(address: ChatAddress): string {
  return `${address.channel}:${address.chatId}`
}
