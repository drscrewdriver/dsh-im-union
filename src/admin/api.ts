/**
 * 管理 API（安全红线 D2/D3/D4）。
 *
 * - 每请求动态读 connection 并过 requestRejection（Host/Origin/Cookie 三查在宿主侧）；
 *   connection 缺失或无该方法 → 503，**不降级匿名**；
 * - 写请求（非 GET/HEAD）：Content-Type 必须 application/json、携带客户端标识头、
 *   body ≤1 MiB；违者 415/400/413；
 * - 响应一律 Cache-Control: no-store；错误回包只有面向用户的说明文案，
 *   零 token/secret/原始用户标识/内部异常细节（细节只进本机日志）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CordisLike, WebServerLike } from '../types.js'
import { optionalService } from '../host-compat/services.js'

export const BASE_PATH = '/api/dsh-im-union'
export const CLIENT_HEADER = 'x-dsh-im-union-client'
const MAX_BODY_BYTES = 1024 * 1024

export interface AdminResponder {
  (status: number, body: unknown): void
}

export interface AdminRequest {
  method: string
  /** 已剥离 basePath 的路径，以 / 开头。 */
  path: string
  url: URL
  body: unknown
  respond: AdminResponder
  /** raw 路由（第三方回调）专用：原文 body 文本 + 查询参数表 + 非 JSON 应答面。 */
  rawBody?: string
  query?: Record<string, string>
  respondText?: (status: number, text: string) => void
}

export type AdminHandler = (request: AdminRequest) => void | Promise<void>

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(payload)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > MAX_BODY_BYTES) {
      const error = new Error('body too large') as Error & { status: number }
      error.status = 413
      throw error
    }
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 写请求前置检查；返回错误状态码或 undefined。 */
export function validateMutation(req: IncomingMessage): number | undefined {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return undefined
  const contentType = req.headers['content-type'] ?? ''
  if (!String(contentType).toLowerCase().includes('application/json')) return 415
  if (req.headers[CLIENT_HEADER] === undefined) return 400
  return undefined
}

export interface AdminApiHandle {
  dispose(): void
}

/**
 * 第三方回调路由白名单（T3.4 企微自建应用等 inbound webhook）。
 * 口径登记：D2/D3 的 requestRejection/JSON 闸适用于**管理面**（浏览器/本机调用）；
 * 平台回调来自厂商服务器、无登录 Cookie，其认证就是签名验证（SHA1+AES，
 * fail-closed）——因此命中的路径跳过 requestRejection 与 JSON 前置闸，
 * 改由 handler 自身验签；仍走同一前缀注册、no-store、体积上限与错误零回显纪律。
 */
export interface RawRoute {
  path: string
  /** 允许 GET 回明文（echostr 验证面原样输出，不包 JSON）。 */
  plainText?: boolean
}

/**
 * 注册管理面。routes 用精确路径匹配（M0 只挂 /ping 与 /state 两个只读探针，
 * 账号 CRUD 随 M1 渠道层落地）。webServer 缺失（非 web profile）→ 不注册，
 * 记日志不抛错——CLI/TUI 宿主上插件其余部分照常。
 */
export function registerAdminApi(
  ctx: CordisLike,
  routes: Record<string, AdminHandler>,
  opts?: { rawRoutes?: RawRoute[] },
): AdminApiHandle {
  const rawPaths = new Map((opts?.rawRoutes ?? []).map((r) => [r.path, r]))
  const log = ctx.logger('dsh-im-union')
  const webServer = optionalService<WebServerLike>(ctx, 'webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    log.warn('宿主无 webServer 服务，管理 API 未注册（仅影响设置页，不影响已运行机器人）')
    return { dispose: () => undefined }
  }

  const dispose = webServer.register({
    kind: 'prefix',
    path: BASE_PATH,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const method = (req.method ?? 'GET').toUpperCase()
        if (url.pathname !== BASE_PATH && !url.pathname.startsWith(BASE_PATH + '/')) {
          send(res, 404, { ok: false, error: 'not found' })
          return
        }
        const path = url.pathname.slice(BASE_PATH.length) || '/'
        const handler = routes[path]
        if (handler === undefined) {
          send(res, 404, { ok: false, error: 'not found' })
          return
        }
        const rawRoute = rawPaths.get(path)
        if (rawRoute !== undefined) {
          // 第三方回调面：验签即认证，读原文 body（≤1 MiB）后交 handler 处置。
          let rawBody = ''
          if (method !== 'GET' && method !== 'HEAD') {
            const chunks: Buffer[] = []
            let total = 0
            for await (const chunk of req) {
              const buf = chunk as Buffer
              total += buf.length
              if (total > MAX_BODY_BYTES) {
                send(res, 413, { ok: false, error: '请求体超限' })
                return
              }
              chunks.push(buf)
            }
            rawBody = Buffer.concat(chunks).toString('utf8')
          }
          const query: Record<string, string> = {}
          url.searchParams.forEach((value, key) => {
            query[key] = value
          })
          let settled = false
          await handler({
            method,
            path,
            url,
            body: query,
            rawBody,
            query,
            respond: (status, payload) => {
              settled = true
              send(res, status, payload)
            },
            respondText: rawRoute.plainText
              ? (status, text) => {
                  settled = true
                  res.statusCode = status
                  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
                  res.setHeader('Cache-Control', 'no-store')
                  res.end(text)
                }
              : undefined,
          })
          if (!settled) send(res, 200, { ok: true })
          return
        }
        // 以下 requestRejection/JSON 闸只约束管理面（动态读取，不缓存认证实例）。
        const connection = optionalService<{
          requestRejection?: (request: { headers: IncomingMessage['headers'] }) => 401 | 403 | undefined
        }>(ctx, 'connection')
        if (typeof connection?.requestRejection !== 'function') {
          send(res, 503, { ok: false, error: '宿主认证服务未就绪或版本不支持；请重启 DSH 或升级宿主。' })
          return
        }
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined) {
          send(res, rejection, {
            ok: false,
            error: rejection === 401 ? '请先登录 DSH' : '宿主拒绝此 Host/跨站请求',
          })
          return
        }
        const mutationError = validateMutation(req)
        if (mutationError !== undefined) {
          send(res, mutationError, { ok: false, error: '写请求需 application/json 与客户端标识头' })
          return
        }
        let body: unknown = {}
        if (method !== 'GET' && method !== 'HEAD') {
          try {
            body = await readJson(req)
          } catch (error) {
            const status = (error as { status?: number }).status ?? 400
            send(res, status, { ok: false, error: status === 413 ? '请求体超过 1 MiB 上限' : 'JSON 解析失败' })
            return
          }
        }
        let settled = false
        await handler({
          method,
          path,
          url,
          body,
          respond: (status, payload) => {
            settled = true
            send(res, status, payload)
          },
        })
        if (!settled) send(res, 200, { ok: true })
      } catch (error) {
        // 细节只进本机日志；回包零内部信息。
        log.error(`管理 API 处理失败: ${error instanceof Error ? error.message : String(error)}`)
        send(res, 500, { ok: false, error: '操作失败，请查看本机日志' })
      }
    },
  })

  return {
    dispose: () => {
      if (typeof dispose === 'function') (dispose as () => void)()
    },
  }
}
