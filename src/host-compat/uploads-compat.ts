/**
 * 跨版本窄腰·文件上传面（T2.4 文件输入）。
 *
 * 宿主面查实（dsh-repo 工作副本，0.2.x 线；证据=文件:行号）：
 * - 服务本体：`ctx.fileUploads` = FileUploads —— packages/client/file-upload/src/index.ts:18-23（Context 声明）、:57（类）；
 * - 可直接调用的一等面：`uploadStream({sessionId, data: AsyncIterable<Uint8Array>, signal?, name?})`
 *   —— 同文件 :119-131（普通方法，内部 ctx.agents.get(sessionId) 解析活 Agent，:216-224；
 *   `@Remote('upload')(agent, …)` 同文件 :105 需要 Agent scope，插件侧不调）；
 * - HTTP 上传路由：`POST /api/session/uploadFileBinary?sessionId=&name=`，
 *   content-type 必须 application/octet-stream，回包 `{ok:true,value:{receiptId,file}}`
 *   —— packages/client/file-upload/src/protocol.ts:2、http-route.ts:22-67；
 *   插件侧经 `connection.createSharedFetchHandler('/api').fetch(request)` 进程内派发
 *   —— packages/client/connection/src/rpc.ts:176、rpc-host.ts:117-137；
 * - prompt 侧文件引用形：`{type:'file', receiptId}`
 *   —— packages/api/session-controller/src/commands.ts:564-583（receiptId 未入 staged 即 FILE_NOT_STAGED）。
 *
 * 纪律：本模块是全仓唯一允许触碰 fileUploads / fetch handler 的地方；探测一次求值冻结，
 * engine 只吃返回的 UploadsCompat 对象（禁在 engine 里 ctx.get）。老线缺位（mode='none'）
 * = 调用方走纯文本回退，不抛错（checklist E1）。
 */
import type { CordisLike, LoggerLike } from '../types.js'
import type { UnionCapabilities } from './services.js'

export const FILE_UPLOAD_PATH = '/api/session/uploadFileBinary'

export interface UploadResult {
  /** 宿主 staged receipt（进 prompt 的 {type:'file', receiptId} 引用）；失败=undefined。 */
  receiptId?: string
  /** 用户可见说明素材（零内部异常细节）。 */
  message?: string
}

export interface UploadsCompat {
  /** stream=宿主 uploadStream 可调；http=共享 fetch 上传路由；none=该线缺位（纯文本回退）。 */
  readonly mode: 'stream' | 'http' | 'none'
  /** 永不抛错：失败回 {message}，调用方按缺位降级。 */
  upload(sessionId: string, file: { name: string; data: Uint8Array }): Promise<UploadResult>
}

interface UploadStreamLike {
  uploadStream?: (request: {
    sessionId: string
    data: AsyncIterable<Uint8Array>
    signal?: AbortSignal
    name?: string
  }) => unknown
}

interface SharedFetchLike {
  createSharedFetchHandler?: (channel: '/api') => {
    fetch?: (request: unknown) => unknown
    requestBodyMode?: (request: { method: string; url: URL }) => unknown
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 一次求值冻结上传面（构造期调用，禁每调用重探）。 */
export function createUploadsCompat(
  ctx: CordisLike,
  caps: UnionCapabilities,
  opts?: { fetchImpl?: typeof globalThis.fetch },
): UploadsCompat {
  const log: LoggerLike = ctx.logger('dsh-im-union')
  const uploads = caps.fileUploads as UploadStreamLike | undefined
  const canStream = typeof uploads?.uploadStream === 'function'
  const connection = caps.connection as SharedFetchLike | undefined
  const canHttp = typeof connection?.createSharedFetchHandler === 'function'
  const fetchImpl = opts?.fetchImpl ?? (globalThis as { fetch?: typeof globalThis.fetch }).fetch

  if (!canStream && !canHttp) {
    return Object.freeze({ mode: 'none' as const, upload: async (): Promise<UploadResult> => ({ message: '宿主无文件上传面' }) })
  }

  async function uploadViaStream(sessionId: string, file: { name: string; data: Uint8Array }): Promise<UploadResult> {
    try {
      const value = (await uploads!.uploadStream!({
        sessionId,
        data: (async function* one() {
          yield file.data
        })(),
        name: file.name,
      })) as { receiptId?: unknown } | undefined
      const receiptId = typeof value?.receiptId === 'string' ? value.receiptId : undefined
      return receiptId !== undefined ? { receiptId } : { message: '上传未返回文件引用' }
    } catch (error) {
      log.warn(`fileUploads.uploadStream 失败: ${messageOf(error)}`)
      return { message: '文件上传失败' }
    }
  }

  async function uploadViaHttp(sessionId: string, file: { name: string; data: Uint8Array }): Promise<UploadResult> {
    try {
      const handler = connection!.createSharedFetchHandler!('/api')
      if (typeof handler?.fetch !== 'function') return { message: '宿主上传路由不可用' }
      const url = `http://dsh.local${FILE_UPLOAD_PATH}?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(file.name)}`
      const request = new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file.data,
      })
      const response = (await handler.fetch(request)) as { status?: number; json?: () => Promise<unknown> } | undefined
      if (typeof response?.json !== 'function') return { message: '上传路由回包形态异常' }
      const parsed = (await response.json()) as { ok?: unknown; value?: { receiptId?: unknown } } | null
      const receiptId = parsed?.ok === true && typeof parsed.value?.receiptId === 'string' ? parsed.value.receiptId : undefined
      return receiptId !== undefined ? { receiptId } : { message: '上传被宿主拒绝' }
    } catch (error) {
      log.warn(`上传路由调用失败: ${messageOf(error)}`)
      return { message: '文件上传失败' }
    }
  }

  const mode: 'stream' | 'http' = canStream ? 'stream' : 'http'
  const run = mode === 'stream' ? uploadViaStream : uploadViaHttp
  return Object.freeze({
    mode,
    upload: (sessionId: string, file: { name: string; data: Uint8Array }) => run(sessionId, file),
  })
}

/** prompt 文件引用 part（宿主形：{type:'file', receiptId}）。 */
export function filePromptPart(receiptId: string): Record<string, unknown> {
  return { type: 'file', receiptId }
}
