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
  running?: boolean
  /** 工作区位置（/workspaces 聚合键）。 */
  cwd?: string
  updatedAt?: number
}

/** 宿主 ModelCatalog 的宽松形（@0.2.x api/session-controller types 锚点，缺位即降级）。 */
export interface ModelCatalogLike {
  default?: { provider?: string; model?: string; reasoningEffort?: string }
  groups?: Array<{ id?: string; name?: string; models?: Array<{ id?: string; name?: string }> }>
  failures?: Array<{ id?: string; name?: string; message?: string }>
  routableProviders?: readonly string[]
}

export interface ModelSelectionInput {
  model: string
  provider?: string
  reasoningEffort?: string
}

export interface PresetInfo {
  id: string
  name: string
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
  /** /steer 插话：宿主 prompt 面 mode:'steer'；面不可用返回 false（调用方转排队文案）。 */
  steer(sessionId: string, text: string): Promise<boolean>
  /** 订阅会话事件流；返回退订函数。 */
  follow(sessionId: string, onEvent: (event: unknown) => void): () => void
  cancel(sessionId: string): Promise<void>
  listSessions(workspace?: string): Promise<SessionInfo[]>
  selectModel(sessionId: string, selection: ModelSelectionInput): Promise<void>
  /** 模型目录；无面返回 undefined（/models 降级）。 */
  modelCatalog(): Promise<ModelCatalogLike | undefined>
  presetsList(): Promise<PresetInfo[]>
  presetSelect(nameOrId: string): Promise<{ ok: boolean; message?: string }>
  /** /fork：分叉当前会话，回新会话 id；无面抛 UnsupportedError（/ 命令层降级）。 */
  fork(sessionId: string): Promise<string>
  /** /rename：改会话标题；false=面缺位（不伪装成功）。 */
  rename(sessionId: string, title: string): Promise<boolean>
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
      async steer(): Promise<boolean> {
        return false
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
      async modelCatalog(): Promise<ModelCatalogLike | undefined> {
        return undefined
      },
      async presetsList(): Promise<PresetInfo[]> {
        return []
      },
      async presetSelect(): Promise<{ ok: boolean; message?: string }> {
        return { ok: false, message: '当前宿主无预设面' }
      },
      async fork(): Promise<string> {
        throw new UnsupportedError('session fork')
      },
      async rename(): Promise<boolean> {
        return false
      },
    }
  }

  const create = asFn<{ create(...args: any[]): any }>(agents, 'create')!
  const promptFn = asFn<{ prompt(...args: any[]): any }>(sessionController, 'prompt')
  const followFn = asFn<{ follow(...args: any[]): any }>(sessionController, 'follow')
  const cancelFn = asFn<{ cancel(...args: any[]): any }>(sessionController, 'cancel')
  const listFn = asFn<{ list(...args: any[]): any }>(sessionPersistence, 'list')
  const wfFollowFn = asFn<{ follow(...args: any[]): any }>(workspaceController, 'follow')
  const sessionListFn = asFn<{ list(...args: any[]): any }>(sessionController, 'list')
  const selectModelFn = asFn<{ selectModel(...args: any[]): any }>(sessionController, 'selectModel')
  const catalogFn = asFn<{ modelCatalog(...args: any[]): any }>(sessionController, 'modelCatalog')
  const presetsListFn = asFn<{ list(...args: any[]): any }>(caps.agentPresets, 'list')
  const presetSelectFn = asFn<{ select(...args: any[]): any }>(caps.agentPresets, 'select')
  const forkFn = asFn<{ fork(...args: any[]): any }>(sessionController, 'fork')
  const renameFn = asFn<{ rename(...args: any[]): any }>(sessionController, 'rename')

  /**
   * 形态归一：宿主 @Remote 面收 request 对象（@0.2.x 锚点 api/session-controller），
   * 老线/位置参变体作为运行时回退——探测不了的形态差异用调用试探+回退收敛，
   * 两形都失败时抛首错（保留真实错误面供矩阵取证）。
   */
  async function callWithShapeFallback<T>(
    primary: () => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    try {
      return await primary()
    } catch (firstError) {
      try {
        return await fallback()
      } catch {
        throw firstError
      }
    }
  }

  function promptRequest(sessionId: string, mode: 'queue' | 'steer', input: string | unknown[]): Record<string, unknown> {
    const content =
      typeof input === 'string'
        ? [{ type: 'text', text: input }]
        : Array.isArray(input)
          ? input
          : [{ type: 'text', text: String(input) }]
    return { sessionId, mode, content, requestId: `imu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }
  }

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
      const request = promptRequest(sessionId, 'queue', input)
      await callWithShapeFallback(
        () => promptFn.call(sessionController, request) as Promise<void>,
        () => promptFn.call(sessionController, sessionId, input) as Promise<void>,
      )
    },
    async steer(sessionId, text) {
      if (!promptFn) return false
      const request = promptRequest(sessionId, 'steer', text)
      try {
        await callWithShapeFallback(
          () => promptFn.call(sessionController, request) as Promise<void>,
          () => promptFn.call(sessionController, sessionId, [{ type: 'text', text }]) as Promise<void>,
        )
        return true
      } catch {
        // mode:'steer' 面不存在/被拒：调用方转排队提示，不伪装成功。
        return false
      }
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
      await callWithShapeFallback(
        () => cancelFn.call(sessionController, { sessionId }) as Promise<void>,
        () => cancelFn.call(sessionController, sessionId) as Promise<void>,
      )
    },
    async listSessions(workspace) {
      // 首选 sessionController.list（摘要带 running/cwd，命令面需要），缺位退 sessionPersistence.list。
      if (sessionListFn) {
        const value = (await sessionListFn.call(sessionController, workspace !== undefined && workspace !== '' ? { workspace } : {})) as unknown
        const items = value !== null && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)
          ? (value as { items: unknown[] }).items
          : Array.isArray(value)
            ? value
            : []
        return items
          .map((row): SessionInfo | undefined => {
            if (row === null || typeof row !== 'object') return undefined
            const r = row as Record<string, unknown>
            const id = typeof r.sessionId === 'string' ? r.sessionId : typeof r.id === 'string' ? r.id : undefined
            if (id === undefined) return undefined
            return {
              id,
              title: typeof r.title === 'string' ? r.title : undefined,
              running: typeof r.running === 'boolean' ? r.running : undefined,
              cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
              updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : undefined,
            }
          })
          .filter((row): row is SessionInfo => row !== undefined)
      }
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
    async selectModel(sessionId, selection) {
      if (!selectModelFn) throw new UnsupportedError('model selection')
      await callWithShapeFallback(
        () => selectModelFn.call(sessionController, { sessionId, ...selection }) as Promise<void>,
        () => selectModelFn.call(sessionController, sessionId, selection.model) as Promise<void>,
      )
    },
    async modelCatalog() {
      if (!catalogFn) return undefined
      try {
        const catalog = await catalogFn.call(sessionController)
        return catalog !== null && typeof catalog === 'object' ? (catalog as ModelCatalogLike) : undefined
      } catch {
        return undefined
      }
    },
    async presetsList() {
      if (!presetsListFn) return []
      try {
        const value = await presetsListFn.call(caps.agentPresets)
        const rows =
          Array.isArray(value) ? value : value !== null && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items) ? (value as { items: unknown[] }).items : []
        return rows
          .map((row): PresetInfo | undefined => {
            if (row === null || typeof row !== 'object') return undefined
            const r = row as Record<string, unknown>
            const id = typeof r.id === 'string' ? r.id : typeof r.name === 'string' ? r.name : undefined
            if (id === undefined) return undefined
            return { id, name: typeof r.name === 'string' ? r.name : id }
          })
          .filter((row): row is PresetInfo => row !== undefined)
      } catch {
        return []
      }
    },
    async presetSelect(nameOrId) {
      if (!presetSelectFn) return { ok: false, message: '当前宿主无预设选择面' }
      try {
        await presetSelectFn.call(caps.agentPresets, { id: nameOrId })
        return { ok: true }
      } catch (error) {
        try {
          await presetSelectFn.call(caps.agentPresets, nameOrId)
          return { ok: true }
        } catch {
          return { ok: false, message: `预设切换失败：${(error as Error).message}` }
        }
      }
    },
    async fork(sessionId) {
      if (!forkFn) throw new UnsupportedError('session fork')
      const result = await callWithShapeFallback(
        () => forkFn.call(sessionController, { sessionId, requestId: `imu-f-${Date.now().toString(36)}` }) as Promise<unknown>,
        () => forkFn.call(sessionController, sessionId) as Promise<unknown>,
      )
      // 回包形收敛：新会话 id 可能在顶层或嵌 session/descriptor；拿不到即缺位。
      if (typeof result === 'string') return result
      if (result !== null && typeof result === 'object') {
        const r = result as Record<string, unknown>
        for (const key of ['sessionId', 'id']) {
          if (typeof r[key] === 'string') return r[key] as string
        }
        const nested = (r.session ?? r.descriptor ?? r.forked) as Record<string, unknown> | undefined
        if (nested !== null && typeof nested === 'object') {
          for (const key of ['sessionId', 'id']) {
            if (typeof nested[key] === 'string') return nested[key] as string
          }
        }
      }
      throw new UnsupportedError('fork 回包无新会话 id')
    },
    async rename(sessionId, title) {
      if (!renameFn) return false
      try {
        await callWithShapeFallback(
          () => renameFn.call(sessionController, { sessionId, title }) as Promise<void>,
          () => renameFn.call(sessionController, sessionId, title) as Promise<void>,
        )
        return true
      } catch {
        return false
      }
    },
  }
}
