/**
 * 跨版本窄腰·产物文件回传面（T2.4 后半）。
 *
 * 宿主面查实（dsh-repo 工作副本 0.2.x 线，证据=文件:行号）：
 * - 事件源：`deliverables/presented` —— packages/core/session/src/known-event-types.ts:36；
 *   payload 形 packages/fs/tool-present/src/types.ts:5-16
 *   `{turn, callId, files: Array<{path, description?}>}`——给的是**工作区文件系统路径**，
 *   插件必须再读一次字节才能回渠道（宿主不代发文件）；
 * - `tool/result` —— packages/core/session/src/types.ts:353-360
 *   形 `{turn, step, message, error?, meta?}`：**无文件引用字段**（查实为缺位）。
 *   本模块只在 `meta.files` 意外携带同形数组时防御式取用，不臆造宿主字段语义；
 * - 读字节面：`ctx.workspaceFiles` —— packages/api/workspace-files/src/index.ts:46-51（Context 声明）；
 *   `@Remote('readAll')(scope, path, signal)` → `{offset, data: base64, eof}` 同文件 :277-289；
 *   `readBytes(scope, path, range, signal)` 同文件 :256-268；
 *   scope 形 `{sessionId, workspaceRoot}` 同文件 :54-59。
 *
 * 纪律：探测一次冻结（B6）；老线缺位 mode='none' → 调用方走文字降级 + 诊断登记
 * unverified（E1/E5），engine 层禁直接 ctx.get。
 */
import type { CordisLike, LoggerLike } from '../types.js'
import type { UnionCapabilities } from './services.js'

export interface DeliverableRef {
  /** 工作区内路径（宿主给什么就读什么，绝对路径由宿主 scope 归一）。 */
  path: string
  /** 渠道展示名（basename）。 */
  name: string
  description?: string
}

export interface DeliverableBytes {
  name: string
  data: Uint8Array
  description?: string
}

export interface DeliverablesCompat {
  /** workspace=宿主 workspaceFiles 读面可用；none=该线缺位（回传降级为文字）。 */
  readonly mode: 'workspace' | 'none'
  /** 读产物字节；缺面/读失败回 undefined（永不抛）。 */
  read(sessionId: string, ref: DeliverableRef, workspaceRoot?: string): Promise<DeliverableBytes | undefined>
  /** 诊断快照（登记到 /accounts/check 与 /status 用）。 */
  status(): { name: string; status: 'passed' | 'unverified'; hint?: string }
}

interface WorkspaceFilesLike {
  readAll?: (...args: unknown[]) => unknown
  readBytes?: (...args: unknown[]) => unknown
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== '')
  return parts[parts.length - 1] ?? path
}

/** 从 turn 事件里抽产物引用（present 主源 + tool/result 防御式兼容）。 */
export function extractDeliverables(event: unknown): DeliverableRef[] {
  const e = event as { data?: { files?: unknown; meta?: { files?: unknown } } } | undefined
  const candidates = [e?.data?.files, e?.data?.meta?.files]
  for (const raw of candidates) {
    if (!Array.isArray(raw)) continue
    const refs = raw
      .map((row): DeliverableRef | undefined => {
        if (row === null || typeof row !== 'object') return undefined
        const r = row as Record<string, unknown>
        const path = typeof r.path === 'string' ? r.path : typeof r.file === 'string' ? r.file : undefined
        if (path === undefined) return undefined
        return {
          path,
          name: typeof r.name === 'string' && r.name !== '' ? r.name : basename(path),
          description: typeof r.description === 'string' ? r.description : undefined,
        }
      })
      .filter((row): row is DeliverableRef => row !== undefined)
    if (refs.length > 0) return refs
  }
  return []
}

/** 一次求值冻结产物读面。 */
export function createDeliverablesCompat(ctx: CordisLike, caps: UnionCapabilities): DeliverablesCompat {
  const log: LoggerLike = ctx.logger('dsh-im-union')
  const service = caps.workspaceFiles as WorkspaceFilesLike | undefined
  const canRead = typeof service?.readAll === 'function' || typeof service?.readBytes === 'function'
  const sizeCap = 20 * 1024 * 1024

  function decode(value: unknown): Uint8Array | undefined {
    if (value === null || typeof value !== 'object') return undefined
    const data = (value as { data?: unknown }).data
    if (typeof data === 'string') return new Uint8Array(Buffer.from(data, 'base64'))
    if (data instanceof Uint8Array) return data
    if (Array.isArray(data)) return new Uint8Array(data)
    return undefined
  }

  async function readOnce(sessionId: string, ref: DeliverableRef, workspaceRoot?: string): Promise<Uint8Array | undefined> {
    const scope = workspaceRoot !== undefined && workspaceRoot !== '' ? { sessionId, workspaceRoot } : { sessionId }
    const attempts: Array<() => unknown> = []
    if (typeof service?.readAll === 'function') {
      attempts.push(() => service.readAll!(scope, ref.path))
      attempts.push(() => service.readAll!(ref.path, scope))
    }
    if (typeof service?.readBytes === 'function') {
      attempts.push(() => service.readBytes!(scope, ref.path, { offset: 0, length: sizeCap }))
    }
    for (const attempt of attempts) {
      try {
        const value = await (attempt() as Promise<unknown>)
        const bytes = decode(value)
        if (bytes !== undefined) return bytes
      } catch (error) {
        log.warn(`workspaceFiles 读取失败（${ref.path}）: ${(error as Error).message}`)
      }
    }
    return undefined
  }

  if (!canRead) {
    return Object.freeze({
      mode: 'none' as const,
      async read(): Promise<DeliverableBytes | undefined> {
        return undefined
      },
      status: () => ({ name: 'file-out', status: 'unverified' as const, hint: '宿主无 workspaceFiles 读面' }),
    })
  }

  return Object.freeze({
    mode: 'workspace' as const,
    async read(sessionId: string, ref: DeliverableRef, workspaceRoot?: string): Promise<DeliverableBytes | undefined> {
      const bytes = await readOnce(sessionId, ref, workspaceRoot)
      if (bytes === undefined) return undefined
      if (bytes.byteLength > sizeCap) {
        log.warn(`产物超过 20 MiB，未回传：${ref.path}`)
        return undefined
      }
      return { name: ref.name, data: bytes, description: ref.description }
    },
    status: () => ({ name: 'file-out', status: 'passed' as const, hint: 'workspaceFiles 读面在位' }),
  })
}
