/**
 * Relay 绑定存储（relay-bindings 文件态）。
 *
 * 用途：gateway relay 钩子按 sessionId 查通知账号，把会话产出转发到绑定的
 * 通知渠道；绑定关系是会话级的，允许多对一（多个会话指向同一通知账号）。
 *
 * 纪律：
 * - 文件态 `<stateDir>/relay-bindings.json`：原子写（tmp+rename），
 *   损坏 → warn + 改名 `.corrupt-<ts>` 后从空表继续
 *   （对齐 delivery-log / proactive 目标库姿态——这是可丢弃的运行态，不是凭据库）；
 * - **零 secret（D4）**：只存 sessionId/notifyAccountId/boundAt，
 *   绝不写 token、原始平台响应、内部异常堆栈（细节只进本机日志）；
 * - **不 import gateway / account-manager / proactive**（防环）：本模块只是纯
 *   存储面，账号是否有效由调用方（主会话接线侧）负责校验；
 * - 文件操作全部用 node:fs 同步 API；不 mkdir，stateDir 存在性由调用方保证。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

/** 绑定记录（零 secret）：一个会话 → 一个通知账号 + 可选推送目标。 */
export interface RelayBinding {
  sessionId: string
  notifyAccountId: string
  /** 推送目标（qq-notify 等需要显式 chatId 的渠道）；缺省由适配器自行解析。 */
  targetId?: string
  boundAt: number
}

export interface RelayStore {
  /** 全部绑定（admin 列表用）。 */
  list(): RelayBinding[]
  /** 按 sessionId 查通知账号（gateway relay 钩子用）。 */
  get(sessionId: string): RelayBinding | undefined
  /** 绑定（幂等：同 sessionId 覆盖旧绑定）。 */
  bind(sessionId: string, notifyAccountId: string, targetId?: string): void
  /** 解绑；返回是否曾存在。 */
  unbind(sessionId: string): boolean
  /** 按通知账号列出绑定的会话（设置面板用）。 */
  byNotifyAccount(notifyAccountId: string): RelayBinding[]
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 创建 relay-bindings 存储：构造时即完成加载（损坏不 brick，从空表继续）。
 * logWarn 缺省时吞掉警告（与 delivery-log/proactive 同姿态）。
 */
export function createRelayStore(file: string, logWarn?: (msg: string) => void): RelayStore {
  const bindings = loadBindings(file, logWarn)

  const persist = (): void => {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(bindings, null, 2), 'utf8')
    renameSync(tmp, file)
  }

  return {
    list(): RelayBinding[] {
      return bindings.map((b) => ({ ...b }))
    },

    get(sessionId: string): RelayBinding | undefined {
      const hit = bindings.find((b) => b.sessionId === str(sessionId))
      return hit ? { ...hit } : undefined
    },

    bind(sessionId: string, notifyAccountId: string, targetId?: string): void {
      const sid = str(sessionId)
      const nid = str(notifyAccountId)
      if (sid === '' || nid === '') return
      const existing = bindings.find((b) => b.sessionId === sid)
      if (existing !== undefined) {
        // 幂等覆盖：同会话重复绑定只保留最新通知账号，boundAt 刷新。
        existing.notifyAccountId = nid
        existing.targetId = targetId !== undefined && targetId !== '' ? targetId : undefined
        existing.boundAt = Date.now()
      } else {
        bindings.push({ sessionId: sid, notifyAccountId: nid, ...(targetId !== undefined && targetId !== '' ? { targetId } : {}), boundAt: Date.now() })
      }
      persist()
    },

    unbind(sessionId: string): boolean {
      const idx = bindings.findIndex((b) => b.sessionId === str(sessionId))
      if (idx === -1) return false
      bindings.splice(idx, 1)
      persist()
      return true
    },

    byNotifyAccount(notifyAccountId: string): RelayBinding[] {
      const nid = str(notifyAccountId)
      return bindings.filter((b) => b.notifyAccountId === nid).map((b) => ({ ...b }))
    },
  }
}

// —— 文件态加载（对齐 delivery-log/proactive 的损坏处理姿态）——————————

function loadBindings(file: string, logWarn?: (msg: string) => void): RelayBinding[] {
  if (!existsSync(file)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const corrupt = `${file}.corrupt-${stamp}`
    try {
      renameSync(file, corrupt)
    } catch {
      // 改名失败也不阻塞运行。
    }
    logWarn?.(`relay-bindings.json 损坏，已转存 ${corrupt} 并从空表继续: ${(error as Error).message}`)
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : []
  return rows
    .map((row): RelayBinding | undefined => {
      if (row === null || typeof row !== 'object') return undefined
      const r = row as Record<string, unknown>
      const sessionId = str(r.sessionId)
      const notifyAccountId = str(r.notifyAccountId)
      if (sessionId === '' || notifyAccountId === '') return undefined
      return {
        sessionId,
        notifyAccountId,
        ...(typeof r.targetId === 'string' && r.targetId !== '' ? { targetId: r.targetId } : {}),
        boundAt: typeof r.boundAt === 'number' ? r.boundAt : Date.now(),
      }
    })
    .filter((row): row is RelayBinding => row !== undefined)
}
