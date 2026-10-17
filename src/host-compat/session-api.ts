/**
 * 跨版本窄腰·会话 API。
 *
 * 主路径 = 宿主原生 agents + sessionController/workspaceController（im-connect 范式）。
 * 能力缺位（sessionBackend=none）时**显式抛 UnsupportedError**，由上层转成
 * "该宿主线不支持"的用户可见降级，而不是静默半死。
 * 各线参数契约差异（如 agents.create 单参/双参、0.1.5 显式传 Agent）在 M1
 * 用逐线契约测试坐实后在本文件内收敛，调用方不见版本差异。
 */
import type { CordisLike } from '../types.js'
import { optionalService, sessionServices, type UnionCapabilities } from './services.js'

export class UnsupportedError extends Error {
  constructor(feature: string) {
    super(`dsh-im-union: 当前宿主缺少 ${feature} 接口，该能力已降级`)
    this.name = 'UnsupportedError'
  }
}

export interface SessionInfo {
  id: string
  title?: string
}

export interface CreateSessionOptions {
  workspace?: string
  model?: string
  preset?: string
  /** IM 侧生成的稳定会话 id（imu: 前缀），宿主不接受时由实现方生成并回传。 */
  sessionIdHint?: string
}

export interface SessionApi {
  backend: 'native' | 'none'
  createSession(options: CreateSessionOptions): Promise<SessionInfo>
  prompt(sessionId: string, input: string | unknown[]): Promise<void>
  /** 订阅会话事件流；返回退订函数。 */
  follow(sessionId: string, onEvent: (event: unknown) => void): () => void
  cancel(sessionId: string): Promise<void>
  listSessions(workspace?: string): Promise<SessionInfo[]>
  selectModel(sessionId: string, model: string): Promise<void>
}

function asFn<T extends object>(value: unknown, key: string): T[keyof T] | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const fn = (value as Record<string, unknown>)[key]
  return typeof fn === 'function' ? (fn as T[keyof T]) : undefined
}

export function createSessionApi(ctx: CordisLike, caps: UnionCapabilities): SessionApi {
  const { agents, sessionController, workspaceController } = sessionServices(ctx)
  const sessionPersistence = optionalService(ctx, 'sessionPersistence')

  if (caps.sessionBackend !== 'native') {
    return {
      backend: 'none',
      async createSession(): Promise<SessionInfo> {
        throw new UnsupportedError('agents/sessionController')
      },
      async prompt(): Promise<void> {
        throw new UnsupportedError('sessionController.prompt')
      },
      follow(): () => void {
        throw new UnsupportedError('session follow')
      },
      async cancel(): Promise<void> {
        throw new UnsupportedError('session cancel')
      },
      async listSessions(): Promise<SessionInfo[]> {
        return []
      },
      async selectModel(): Promise<void> {
        throw new UnsupportedError('model selection')
      },
    }
  }

  const create = asFn<{ create(...args: any[]): any }>(agents, 'create')!
  const promptFn = asFn<{ prompt(...args: any[]): any }>(sessionController, 'prompt')
  const followFn = asFn<{ follow(...args: any[]): any }>(sessionController, 'follow')
  const cancelFn = asFn<{ cancel(...args: any[]): any }>(sessionController, 'cancel')
  const listFn = asFn<{ list(...args: any[]): any }>(sessionPersistence, 'list')
  const wfFollowFn = asFn<{ follow(...args: any[]): any }>(workspaceController, 'follow')

  return {
    backend: 'native',
    async createSession(options) {
      // TODO(M1-contract): 逐线坐实 create 的参数形态（seed/meta/agentOptions），
      // 0.1.5 线需显式传 Agent 的分支在此收敛。
      const created = await create.call(agents, {
        seed: [],
        meta: { origin: 'dsh-im-union', workspace: options.workspace },
      })
      const id: string =
        (created && typeof created.sessionId === 'string' && created.sessionId) ||
        (created && typeof created.id === 'string' && created.id) ||
        options.sessionIdHint ||
        `imu:union:generated:${Date.now()}`
      const title = created && typeof created.title === 'string' ? created.title : undefined
      return { id, title }
    },
    async prompt(sessionId, input) {
      if (!promptFn) throw new UnsupportedError('sessionController.prompt')
      await promptFn.call(sessionController, sessionId, input)
    },
    follow(sessionId, onEvent) {
      // sessionController.follow 优先，缺失退到 workspaceController.follow。
      const fn = followFn ?? wfFollowFn
      if (!fn) throw new UnsupportedError('session follow')
      const ret = fn.call(followFn ? sessionController : workspaceController, sessionId, onEvent)
      if (typeof ret === 'function') return ret as () => void
      return () => undefined
    },
    async cancel(sessionId) {
      if (!cancelFn) throw new UnsupportedError('session cancel')
      await cancelFn.call(sessionController, sessionId)
    },
    async listSessions(workspace) {
      if (!listFn) return []
      const rows = (await listFn.call(sessionPersistence, workspace)) as unknown
      if (!Array.isArray(rows)) return []
      return rows
        .map((row): SessionInfo | undefined => {
          if (row !== null && typeof row === 'object') {
            const r = row as Record<string, unknown>
            const id = typeof r.id === 'string' ? r.id : typeof r.sessionId === 'string' ? r.sessionId : undefined
            if (id === undefined) return undefined
            return { id, title: typeof r.title === 'string' ? r.title : undefined }
          }
          return undefined
        })
        .filter((row): row is SessionInfo => row !== undefined)
    },
    async selectModel(sessionId, model) {
      const selectFn = asFn<{ selectModel(...args: any[]): any }>(sessionController, 'selectModel')
      if (!selectFn) throw new UnsupportedError('model selection')
      await selectFn.call(sessionController, sessionId, model)
    },
  }
}
