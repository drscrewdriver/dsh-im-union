/**
 * 语音管道公共层（T3.5 飞书语音：ffmpeg 转码 + DashScope ASR/TTS）。
 *
 * 纪律：
 * - **不 import 渠道**，纯函数 + 全注入面（spawnImpl / fetchImpl），单测零真机、
 *   零真实网络、零真起 ffmpeg；运行时依赖零新增（node:child_process 懒 import，
 *   DashScope 走 Node≥22 全局 fetch 的公开 REST）。
 * - 失败**不抛**：一律回「无产物 + failure」，由渠道侧拼占位文案（降级不丢事件）。
 * - 失败分型对齐 D7：4xx/协议性拒绝 = 确定性（rejected，可安全重试同请求）；
 *   网络错/超时/5xx = 结果不确定（uncertain=true，调用方禁自动重发）。本模块只
 *   回 undefined + 错误对象，不自己重发。
 * - 密钥零明文：apiKey 只进 Authorization 头，绝不出现在返回值/文案里。
 *
 * 协议锚点（2026-10 检索核实的公开文档）：
 * - ASR（DashScope 同步调用，千问3-ASR-Flash）：
 *   POST {base}/services/aigc/multimodal-generation/generation
 *   body {model, input:{messages:[{role:'user', content:[{audio:<Data URL>}]}]},
 *        parameters:{asr_options:{language?, enable_itn?}}}
 *   resp output.choices[0].message.content[0].text（usage.seconds=音频秒数）
 *   输入支持 Base64 Data URL（编码后 ≤10 MiB）、本地文件、公网 URL；最长 5 分钟录音。
 *   https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference
 *   https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide
 * - 长录音异步路线（paraformer / qwen3-asr-flash-filetrans 同族）：
 *   POST {base}/services/audio/asr/transcription + header X-DashScope-Async: enable，
 *   input.file_url 必须是**公网可访问 URL**，再轮询 GET {base}/tasks/{task_id}。
 *   IM 语音是本机字节流、无公网 URL，故本版本不接异步路线，ASR 走上面的同步 Base64。
 * - TTS（非实时语音合成，HTTP）：POST {base}/services/audio/tts/SpeechSynthesizer
 *   body {model, input:{text, voice, format, sample_rate}}
 *   resp output.audio.url（24h 有效，需二次 GET 取字节）/ 流式档 output.audio.data(base64)
 *   https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide
 *   注：Sambert 公开形态只有 WebSocket/SDK（wss …/api-ws/v1/inference），无净室可写的
 *   HTTP REST——故合成走已核实的「非实时语音合成」HTTP 面，模型/音色全配置驱动
 *   （可填 cosyvoice-v3-flash / qwen3-tts-flash 等，见文档「支持模型」）。
 *   text 单次 ≤500 字符（CosyVoice HTTP API：https://help.aliyun.com/zh/isi/developer-reference/http-cosyvoice-api/）。
 * - 两个 base 域：业务空间专属域名（{WorkspaceId}.cn-beijing.maas.aliyuncs.com）与
 *   现有通用域名 https://dashscope.aliyuncs.com/api/v1（文档明确「现有域名仍可正常使用」）。
 *   本模块默认后者，baseUrl 可注入替换。
 * - ffmpeg 参数口径取飞书官方上传文档示例（OPUS：-acodec libopus -ac 1 -ar 16000；
 *   识别侧惯用 wav/16k 单声道）：https://open.feishu.cn/document/server-docs/im-v1/file/create
 */
import { FILE_BUDGET } from './files.js'

// —— 预算（口径依据见注释，与 media.ts / files.ts 同源：超限=丢弃 + 用户可见说明） ————

export const VOICE_BUDGET = Object.freeze({
  /**
   * ASR 输入原始字节上限。依据：DashScope 明确「Base64 编码会增大体积，请控制原文件
   * 大小，确保编码后仍符合输入音频上限 10 MB」；base64 膨胀 4/3 → 原始 7 MiB
   * （编码后恰 9⅓ MiB < 10 MB）。与 media.ts「传输层 1/3 膨胀在预算里已计」同纪律。
   */
  asrMaxInputBytes: 7 * 1024 * 1024,
  /** ASR 时长上限：千问3-ASR-Flash「支持最长 5 分钟录音」。 */
  asrMaxDurationMs: 300_000,
  /** TTS 单次文本上限：CosyVoice/Qwen-Audio-TTS HTTP 文档「长度不超过 500 字符」。 */
  ttsMaxChars: 500,
  /** 转码输入/输出上限不自设更大值——沿用引擎 FILE_BUDGET 单文件 20 MiB。 */
  transcodeMaxBytes: FILE_BUDGET.perFileMaxBytes,
  /** ffmpeg 单次执行墙钟上限（超时=杀进程降级，不让转码悬挂住整轮）。 */
  ffmpegTimeoutMs: 15_000,
  /** DashScope 单次请求墙钟上限（识别/合成都是秒级任务，30s 已是宽档）。 */
  dashscopeTimeoutMs: 30_000,
  /** stderr/错误体片段截断长度（防把上游大段响应灌进渠道文案）。 */
  messageMaxChars: 200,
})

export const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/api/v1'
export const DEFAULT_ASR_MODEL = 'qwen3-asr-flash'
export const DEFAULT_TTS_MODEL = 'cosyvoice-v3-flash'
export const DEFAULT_TTS_VOICE = 'longanyang'

// —— 失败分型 ——————————————————————————————————————

export type VoiceFailureKind =
  | 'bad-input'
  | 'over-budget'
  | 'unsupported-format'
  | 'ffmpeg-missing'
  | 'ffmpeg-failed'
  | 'ffmpeg-timeout'
  | 'missing-config'
  | 'rejected'
  | 'uncertain'
  | 'bad-response'
  | 'download-failed'

/** 原因类别（渠道占位文案用：[语音转写失败：<类别>]）。 */
export const VOICE_FAILURE_LABELS: Record<VoiceFailureKind, string> = {
  'bad-input': '音频为空',
  'over-budget': '音频超限',
  'unsupported-format': '格式不支持',
  'ffmpeg-missing': '本机缺 ffmpeg',
  'ffmpeg-failed': '转码失败',
  'ffmpeg-timeout': '转码超时',
  'missing-config': '未配置语音密钥',
  rejected: '平台拒绝',
  uncertain: '网络不确定',
  'bad-response': '响应异常',
  'download-failed': '语音资源下载失败',
}

export interface VoiceFailure {
  kind: VoiceFailureKind
  /** 可读说明（截断后），不含密钥。 */
  message: string
  /** D7 位：true=结果不确定（网络/超时/5xx），调用方禁自动重发。 */
  uncertain: boolean
  status?: number
  /** 上游原始错误（只透传对象引用，不进文案）。 */
  cause?: unknown
}

function clip(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= VOICE_BUDGET.messageMaxChars ? text : `${text.slice(0, VOICE_BUDGET.messageMaxChars)}…`
}

function failure(kind: VoiceFailureKind, message: string, extra: { uncertain?: boolean; status?: number; cause?: unknown } = {}): VoiceFailure {
  return { kind, message: clip(message), uncertain: extra.uncertain ?? false, ...(extra.status === undefined ? {} : { status: extra.status }), ...(extra.cause === undefined ? {} : { cause: extra.cause }) }
}

/** 网络类错误判定（与渠道侧同口径：结果不明）。 */
function isNetworkError(error: unknown): boolean {
  return error instanceof Error && /网络|timeout|timed out|unreachable|socket|ECONN|ENOTFOUND|abort|fetch|aborted/i.test(error.message)
}

// —— 格式表 ——————————————————————————————————————

interface InputFormat {
  /** ffmpeg demuxer 名（管道输入必须显式 -f，ogg/opus 探测常失败）。 */
  ffmpegFmt: string
  /** Data URL 的 MIME（DashScope 音频格式↔MIME 对照见 qwen-asr 文档）。 */
  mime: string
}

const INPUT_FORMATS: Record<string, InputFormat> = {
  ogg: { ffmpegFmt: 'ogg', mime: 'audio/ogg' },
  opus: { ffmpegFmt: 'ogg', mime: 'audio/ogg' },
  wav: { ffmpegFmt: 'wav', mime: 'audio/wav' },
  wave: { ffmpegFmt: 'wav', mime: 'audio/wav' },
  pcm: { ffmpegFmt: 's16le', mime: 'audio/wav' },
  mp3: { ffmpegFmt: 'mp3', mime: 'audio/mpeg' },
  m4a: { ffmpegFmt: 'mp4', mime: 'audio/mp4' },
  aac: { ffmpegFmt: 'aac', mime: 'audio/aac' },
  amr: { ffmpegFmt: 'amr', mime: 'audio/amr' },
  flac: { ffmpegFmt: 'flac', mime: 'audio/flac' },
  mp4: { ffmpegFmt: 'mp4', mime: 'audio/mp4' },
}

/** 输出侧 ffmpeg 参数组（识别用 wav/16k 单声道；飞书语音条用 OPUS/ogg）。 */
const OUTPUT_FORMATS: Record<string, string[]> = {
  wav: ['-f', 'wav', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000'],
  wav16: ['-f', 'wav', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000'],
  pcm: ['-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000'],
  opus: ['-f', 'ogg', '-acodec', 'libopus', '-ac', '1', '-ar', '16000'],
  ogg: ['-f', 'ogg', '-acodec', 'libopus', '-ac', '1', '-ar', '16000'],
  mp3: ['-f', 'mp3', '-acodec', 'libmp3lame', '-ac', '1', '-ar', '44100'],
}

function normalizeFormat(value: string): string {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  const short = raw.startsWith('audio/') ? raw.slice('audio/'.length) : raw
  if (short === 'mpeg') return 'mp3'
  if (short === 'x-wav' || short === 'wave') return 'wav'
  if (short === 'ogg-opus' || short === 'oga') return 'ogg'
  return short
}

export function resolveInputFormat(fromFmt: string): InputFormat | undefined {
  return INPUT_FORMATS[normalizeFormat(fromFmt)]
}

export function resolveOutputArgs(toFmt: string): string[] | undefined {
  return OUTPUT_FORMATS[normalizeFormat(toFmt)]
}

export function audioMime(fmt: string): string {
  return resolveInputFormat(fmt)?.mime ?? 'application/octet-stream'
}

// —— ffmpeg 注入面 ——————————————————————————————————————

export interface FfmpegStdinLike {
  write(chunk: Uint8Array): void
  end(): void
}

export interface FfmpegStreamLike {
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown
  on(event: 'end' | 'close' | 'error', listener: (...args: unknown[]) => void): unknown
}

/** node:child_process spawn 返回面的最小子集（fake 只需实现这些）。 */
export interface FfmpegChildLike {
  stdin: FfmpegStdinLike
  stdout?: FfmpegStreamLike
  stderr?: FfmpegStreamLike
  on(event: 'error', listener: (error: Error & { code?: string }) => void): unknown
  on(event: 'close' | 'exit', listener: (code: number | null, signal?: string) => void): unknown
  kill?(signal?: string | number): void
}

export type SpawnLike = (command: string, args: readonly string[], options?: Record<string, unknown>) => FfmpegChildLike

let cachedSpawn: SpawnLike | undefined

/** 真机缺省面：懒 import node:child_process（测试全量注入 fake，永不触达）。 */
async function loadDefaultSpawn(): Promise<SpawnLike> {
  if (cachedSpawn !== undefined) return cachedSpawn
  const { spawn } = await import('node:child_process')
  cachedSpawn = (command, args, options) => spawn(command, [...args], { windowsHide: true, ...options }) as unknown as FfmpegChildLike
  return cachedSpawn
}

function toBytes(chunk: Uint8Array | string): Uint8Array {
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk)
  return chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk as ArrayLike<number>)
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function collect(stream: FfmpegStreamLike | undefined, into: Uint8Array[]): void {
  if (stream === undefined || typeof stream.on !== 'function') return
  stream.on('data', (chunk) => into.push(toBytes(chunk)))
  stream.on('error', () => undefined)
}

/** WAV(RIFF) 时长估算：非 wav 或头不全 → undefined（不猜）。 */
export function estimateWavDurationMs(bytes: Uint8Array): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 44) return undefined
  const tag = (at: number): string => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined
  let at = 12
  let byteRate = 0
  let dataSize = 0
  while (at + 8 <= bytes.byteLength) {
    const size = view.getUint32(at + 4, true)
    if (tag(at) === 'fmt ') byteRate = view.getUint32(at + 16, true)
    else if (tag(at) === 'data') dataSize = size
    at += 8 + size + (size % 2)
  }
  if (byteRate <= 0 || dataSize <= 0) return undefined
  return Math.round((dataSize / byteRate) * 1000)
}

export interface TranscodeOptions {
  /** ffmpeg 可执行名/路径（缺省 ffmpeg，走 PATH）。 */
  ffmpegPath?: string
  timeoutMs?: number
  budget?: typeof VOICE_BUDGET
  signal?: AbortSignal
}

export interface TranscodeResult {
  /** 无产物时 undefined（降级不抛）。 */
  audio?: Uint8Array
  format?: string
  failure?: VoiceFailure
}

/**
 * 流式转码：pipe:0 → ffmpeg → pipe:1。失败/超时回 undefined（不抛）；
 * ffmpeg 缺位（ENOENT）给明确文案，渠道据此占位而不谎报成功。
 */
export async function transcode(
  input: Uint8Array,
  fromFmt: string,
  toFmt: string,
  spawnImpl?: SpawnLike,
  opts: TranscodeOptions = {},
): Promise<TranscodeResult> {
  const budget = opts.budget ?? VOICE_BUDGET
  if (!(input instanceof Uint8Array) || input.byteLength === 0) {
    return { failure: failure('bad-input', '转码输入为空') }
  }
  if (input.byteLength > budget.transcodeMaxBytes) {
    return { failure: failure('over-budget', `转码输入 ${input.byteLength} 字节超上限 ${budget.transcodeMaxBytes} 字节`) }
  }
  const src = resolveInputFormat(fromFmt)
  if (src === undefined) return { failure: failure('unsupported-format', `不支持的输入格式：${String(fromFmt)}`) }
  const outArgs = resolveOutputArgs(toFmt)
  if (outArgs === undefined) return { failure: failure('unsupported-format', `不支持的输出格式：${String(toFmt)}`) }
  const format = normalizeFormat(toFmt) === 'wav16' ? 'wav' : normalizeFormat(toFmt)

  const command = opts.ffmpegPath ?? 'ffmpeg'
  const args = ['-hide_banner', '-loglevel', 'error', '-f', src.ffmpegFmt, '-i', 'pipe:0', '-y', ...outArgs, 'pipe:1']

  let spawnFn: SpawnLike
  try {
    spawnFn = spawnImpl ?? (await loadDefaultSpawn())
  } catch (error) {
    return { failure: failure('ffmpeg-missing', `无法启动转码进程：${String((error as Error)?.message ?? error)}`, { cause: error }) }
  }

  const timeoutMs = opts.timeoutMs ?? budget.ffmpegTimeoutMs
  const run = await new Promise<{ out: Uint8Array[]; err: Uint8Array[]; code: number | null; error?: Error; timedOut: boolean }>((resolve) => {
    const out: Uint8Array[] = []
    const err: Uint8Array[] = []
    let settled = false
    let timedOut = false
    let child: FfmpegChildLike
    try {
      child = spawnFn(command, args)
    } catch (error) {
      resolve({ out, err, code: null, error: error as Error, timedOut: false })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill?.('SIGKILL')
      } catch {
        // 杀不掉也只能按超时降级
      }
      finish(new Error(`ffmpeg 转码超时（>${timeoutMs}ms）`), null)
    }, timeoutMs)
    const finish = (error: Error | undefined, code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ out, err, code, ...(error === undefined ? {} : { error }), timedOut })
    }
    collect(child.stdout, out)
    collect(child.stderr, err)
    child.on('error', (error) => {
      const code = (error as Error & { code?: string })?.code
      const wrapped = code === 'ENOENT' ? Object.assign(new Error(`ffmpeg 不在本机 PATH（未安装 ffmpeg）：${command}`), { code: 'ENOENT' }) : error ?? new Error('转码进程启动失败')
      finish(wrapped, null)
    })
    child.on('close', (code) => finish(undefined, code ?? 0))
    child.on('exit', () => undefined)
    try {
      child.stdin.write(input)
      child.stdin.end()
    } catch {
      // EPIPE 等写失败由 close/error 统一判定（ffmpeg 早退是常态）
    }
  })

  if (run.error !== undefined) {
    if ((run.error as Error & { code?: string }).code === 'ENOENT') {
      return { failure: failure('ffmpeg-missing', '本机未安装 ffmpeg（或不在 PATH），语音转码不可用') }
    }
    if (run.timedOut) return { failure: failure('ffmpeg-timeout', run.error.message, { cause: run.error }) }
    return { failure: failure('ffmpeg-failed', run.error.message, { cause: run.error }) }
  }
  if (run.code !== 0) {
    const tail = concat(run.err)
    return { failure: failure('ffmpeg-failed', `ffmpeg 退出码 ${String(run.code)}${tail.byteLength > 0 ? `：${new TextDecoder('utf-8', { fatal: false }).decode(tail.slice(0, 512))}` : ''}`) }
  }
  const audio = concat(run.out)
  if (audio.byteLength === 0) return { failure: failure('ffmpeg-failed', 'ffmpeg 产物为空') }
  if (audio.byteLength > budget.transcodeMaxBytes) {
    return { failure: failure('over-budget', `转码产物 ${audio.byteLength} 字节超上限 ${budget.transcodeMaxBytes} 字节`) }
  }
  return { audio, format }
}

/** ffmpeg 到位探测（diagnose 用）：ENOENT/非 0 退出 → 不可用，仍不抛。 */
export async function checkFfmpeg(opts: { spawnImpl?: SpawnLike; ffmpegPath?: string; timeoutMs?: number } = {}): Promise<{ ok: boolean; version?: string; failure?: VoiceFailure }> {
  const spawnFn = opts.spawnImpl
  const version = opts.ffmpegPath ?? 'ffmpeg'
  if (spawnFn === undefined) {
    // 不注入面时不做真机探测（真起进程属于运行路径，交给诊断侧显式注入）。
    return { ok: false, failure: failure('missing-config', '未注入 ffmpeg 探测面') }
  }
  let collected = ''
  let code: number | null | undefined
  let timedOut = false
  let spawnError: (Error & { code?: string }) | undefined
  await new Promise<void>((resolve) => {
    let child: FfmpegChildLike
    try {
      child = spawnFn(version, ['-version'])
    } catch (error) {
      spawnError = error as Error & { code?: string }
      resolve()
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill?.('SIGKILL')
      } catch {
        // 忽略
      }
      timedOut = true
      code = null
      resolve()
    }, opts.timeoutMs ?? VOICE_BUDGET.ffmpegTimeoutMs)
    const err: Uint8Array[] = []
    collect(child.stderr, err)
    collect(child.stdout, err)
    child.on('error', (error) => {
      spawnError = error ?? new Error('探测失败')
      clearTimeout(timer)
      resolve()
    })
    child.on('close', (exitCode) => {
      code = exitCode ?? 0
      collected = new TextDecoder('utf-8', { fatal: false }).decode(concat(err)).slice(0, 160)
      clearTimeout(timer)
      resolve()
    })
    child.stdin.end()
  })
  if (spawnError !== undefined) {
    if (spawnError.code === 'ENOENT') return { ok: false, failure: failure('ffmpeg-missing', '本机未安装 ffmpeg（或不在 PATH），语音转码不可用') }
    return { ok: false, failure: failure('ffmpeg-failed', spawnError.message, { cause: spawnError }) }
  }
  if (code !== 0) {
    if (timedOut) return { ok: false, failure: failure('ffmpeg-timeout', `ffmpeg -version 探测超时（>${String(opts.timeoutMs ?? VOICE_BUDGET.ffmpegTimeoutMs)}ms）`) }
    return { ok: false, failure: failure('ffmpeg-failed', `ffmpeg -version 退出码 ${String(code)}`) }
  }
  return { ok: true, version: clip(collected) }
}

// —— DashScope 注入面 ——————————————————————————————————————

export interface FetchInitLike {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

export interface FetchResponseLike {
  ok: boolean
  status: number
  json(): Promise<Record<string, any>>
  arrayBuffer?(): Promise<ArrayBuffer>
}

export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>

function defaultFetch(): FetchLike | undefined {
  const fn = (globalThis as { fetch?: unknown }).fetch
  return typeof fn === 'function' ? (fn as FetchLike) : undefined
}

/** HTTP 状态 → 分型：2xx 无失败；4xx 确定性拒绝；其余（含 5xx）= 不确定。 */
export function classifyStatus(status: number): { kind: VoiceFailureKind; uncertain: boolean } | undefined {
  if (status >= 200 && status < 300) return undefined
  if (status >= 400 && status < 500) return { kind: 'rejected', uncertain: false }
  return { kind: 'uncertain', uncertain: true }
}

/** 上游错误体只取 code/message（不进密钥，不回显请求头）。 */
function bodyHint(json: Record<string, any> | undefined): string {
  const code = typeof json?.code === 'string' || typeof json?.code === 'number' ? String(json.code) : ''
  const message = typeof json?.message === 'string' ? json.message : ''
  return clip([code, message].filter((part) => part !== '').join(' ')) || '无错误体'
}

async function postJson(fetchImpl: FetchLike, url: string, apiKey: string, payload: Record<string, unknown>, timeoutMs: number): Promise<{ json?: Record<string, any>; status: number; failure?: VoiceFailure }> {
  const controller = new AbortController()
  const call = fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
    ...(timeoutMs > 0 ? { signal: controller.signal } : {}),
  })
  // 超时不悬挂：race 出确定性失败并尽力 abort（注入面若忽略 signal 也不阻塞调用方）。
  call.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      call,
      timeoutMs > 0
        ? new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`DashScope 请求超时（>${timeoutMs}ms）`)), timeoutMs)
          })
        : undefined,
    ])
    if (response === undefined) throw new Error('DashScope 响应缺失')
    let json: Record<string, any> | undefined
    try {
      json = await response.json()
    } catch {
      json = undefined
    }
    const byStatus = classifyStatus(response.status)
    if (byStatus !== undefined) {
      return { status: response.status, failure: failure(byStatus.kind, `HTTP ${response.status} ${bodyHint(json)}`, { uncertain: byStatus.uncertain, status: response.status }) }
    }
    // 200 但带业务错误码（DashScope 兼容层偶发）：无 output 视为确定性拒绝。
    if (json?.output === undefined && json?.code !== undefined) {
      return { status: response.status, failure: failure('rejected', `HTTP ${response.status} ${bodyHint(json)}`, { status: response.status }) }
    }
    return { json, status: response.status }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/超时|timeout/i.test(message)) {
      try {
        controller.abort()
      } catch {
        // 忽略
      }
      return { status: 0, failure: failure('uncertain', message, { uncertain: true, cause: error }) }
    }
    return { status: 0, failure: failure(isNetworkError(error) ? 'uncertain' : 'bad-response', message, { uncertain: isNetworkError(error), cause: error }) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function dataUrl(bytes: Uint8Array, fmt: string): string {
  return `data:${audioMime(fmt)};base64,${Buffer.from(bytes).toString('base64')}`
}

export interface AsrOptions {
  apiKey: string
  model?: string
  baseUrl?: string
  /** 音频格式（决定 MIME），缺省 wav。 */
  format?: string
  /** 已知语种时指定可提升准确率（qwen-asr 文档 language）。 */
  language?: string
  enableItn?: boolean
  fetchImpl?: FetchLike
  timeoutMs?: number
  budget?: typeof VOICE_BUDGET
}

export interface AsrResult {
  text?: string
  /** 上游给出的音频秒数（usage.seconds），拿不到则 undefined。 */
  seconds?: number
  failure?: VoiceFailure
}

/**
 * 录音识别（同步 Base64 Data URL 路线）。任一失败回 {failure}，text=undefined。
 */
export async function dashscopeAsr(bytes: Uint8Array, opts: AsrOptions): Promise<AsrResult> {
  const budget = opts.budget ?? VOICE_BUDGET
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return { failure: failure('bad-input', '识别输入为空') }
  if (typeof opts.apiKey !== 'string' || opts.apiKey === '') return { failure: failure('missing-config', '未配置 DashScope API Key') }
  const format = opts.format ?? 'wav'
  if (resolveInputFormat(format) === undefined) return { failure: failure('unsupported-format', `不支持的识别输入格式：${format}`) }
  if (bytes.byteLength > budget.asrMaxInputBytes) {
    return { failure: failure('over-budget', `识别输入 ${bytes.byteLength} 字节超上限 ${budget.asrMaxInputBytes} 字节（base64 后需 <10 MiB），请缩短语音后重发`) }
  }
  const duration = estimateWavDurationMs(bytes)
  if (duration !== undefined && duration > budget.asrMaxDurationMs) {
    return { failure: failure('over-budget', `识别时长约 ${(duration / 1000).toFixed(0)}s 超上限 ${(budget.asrMaxDurationMs / 1000).toFixed(0)}s`) }
  }
  const fetchImpl = opts.fetchImpl ?? defaultFetch()
  if (fetchImpl === undefined) return { failure: failure('missing-config', '宿主无 fetch 面') }
  const base = (opts.baseUrl ?? DASHSCOPE_BASE).replace(/\/+$/, '')
  const payload: Record<string, unknown> = {
    model: opts.model ?? DEFAULT_ASR_MODEL,
    input: { messages: [{ role: 'user', content: [{ audio: dataUrl(bytes, format) }] }] },
    parameters: {
      asr_options: { enable_itn: opts.enableItn ?? false, ...(typeof opts.language === 'string' && opts.language !== '' ? { language: opts.language } : {}) },
    },
  }
  const call = await postJson(fetchImpl, `${base}/services/aigc/multimodal-generation/generation`, opts.apiKey, payload, opts.timeoutMs ?? budget.dashscopeTimeoutMs)
  if (call.failure !== undefined) return { failure: call.failure }
  const output = call.json?.output as Record<string, any> | undefined
  const text = extractAsrText(output)
  if (typeof text !== 'string' || text === '') {
    return { failure: failure('bad-response', `识别响应无文本（${bodyHint(call.json)}）`) }
  }
  const seconds = Number((call.json?.usage as Record<string, any> | undefined)?.seconds)
  return { text, ...(Number.isFinite(seconds) && seconds > 0 ? { seconds } : {}) }
}

function extractAsrText(output: Record<string, any> | undefined): string | undefined {
  const choices = Array.isArray(output?.choices) ? (output.choices as Array<Record<string, any>>) : undefined
  const content = choices?.[0]?.message?.content
  if (Array.isArray(content)) {
    for (const part of content as Array<Record<string, any>>) {
      if (typeof part?.text === 'string' && part.text !== '') return part.text
    }
  }
  if (typeof output?.text === 'string' && output.text !== '') return output.text
  const sentences = Array.isArray(output?.sentences) ? (output.sentences as Array<Record<string, any>>) : undefined
  if (sentences !== undefined) {
    const joined = sentences.map((s) => (typeof s?.text === 'string' ? s.text : '')).filter((part) => part !== '').join('')
    if (joined !== '') return joined
  }
  return undefined
}

export interface TtsOptions {
  apiKey: string
  model?: string
  voice?: string
  /** 合成格式（缺省 wav；飞书语音条需再转 opus，由渠道侧 transcode）。 */
  format?: string
  sampleRate?: number
  baseUrl?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
  budget?: typeof VOICE_BUDGET
}

export interface TtsResult {
  audio?: Uint8Array
  format?: string
  failure?: VoiceFailure
}

/**
 * 语音合成：SpeechSynthesizer 非流式 → output.audio.url（24h）二次下载；
 * 兼容 output.audio.data（base64）直接取字节。失败回 failure，audio=undefined。
 */
export async function dashscopeTts(text: string, opts: TtsOptions): Promise<TtsResult> {
  const budget = opts.budget ?? VOICE_BUDGET
  if (typeof text !== 'string' || text.trim() === '') return { failure: failure('bad-input', '合成文本为空') }
  if (typeof opts.apiKey !== 'string' || opts.apiKey === '') return { failure: failure('missing-config', '未配置 DashScope API Key') }
  if (text.length > budget.ttsMaxChars) {
    return { failure: failure('over-budget', `合成文本 ${text.length} 字符超上限 ${budget.ttsMaxChars} 字符`) }
  }
  const fetchImpl = opts.fetchImpl ?? defaultFetch()
  if (fetchImpl === undefined) return { failure: failure('missing-config', '宿主无 fetch 面') }
  const base = (opts.baseUrl ?? DASHSCOPE_BASE).replace(/\/+$/, '')
  const format = opts.format ?? 'wav'
  const payload = {
    model: opts.model ?? DEFAULT_TTS_MODEL,
    input: { text, voice: opts.voice ?? DEFAULT_TTS_VOICE, format, sample_rate: opts.sampleRate ?? 24000 },
  }
  const call = await postJson(fetchImpl, `${base}/services/audio/tts/SpeechSynthesizer`, opts.apiKey, payload, opts.timeoutMs ?? budget.dashscopeTimeoutMs)
  if (call.failure !== undefined) return { failure: call.failure }
  const audio = call.json?.output?.audio as Record<string, any> | undefined
  const inline = typeof audio?.data === 'string' ? audio.data : undefined
  if (inline !== undefined && inline !== '') {
    const bytes = Uint8Array.from(Buffer.from(inline, 'base64'))
    if (bytes.byteLength === 0) return { failure: failure('bad-response', '合成响应 base64 解出空字节') }
    return { audio: bytes, format: typeof audio?.format === 'string' ? audio.format : format }
  }
  const url = typeof audio?.url === 'string' ? audio.url : typeof call.json?.output?.audio_url === 'string' ? call.json.output.audio_url : ''
  if (url === '') return { failure: failure('bad-response', `合成响应无音频产物（${bodyHint(call.json)}）`) }
  // URL 是上游签名地址，不带 Authorization 头（二次 GET，24h 有效）。
  let response: FetchResponseLike
  try {
    response = await fetchImpl(url, { method: 'GET' })
  } catch (error) {
    return { failure: failure('uncertain', `合成音频下载失败：${error instanceof Error ? error.message : String(error)}`, { uncertain: true, cause: error }) }
  }
  const byStatus = classifyStatus(response.status)
  if (byStatus !== undefined) return { failure: failure(byStatus.kind, `合成音频下载 HTTP ${response.status}`, { uncertain: byStatus.uncertain, status: response.status }) }
  if (typeof response.arrayBuffer !== 'function') return { failure: failure('bad-response', '宿主 fetch 无 arrayBuffer 面，无法取回合成音频') }
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    return { failure: failure('uncertain', `合成音频读取失败：${error instanceof Error ? error.message : String(error)}`, { uncertain: true, cause: error }) }
  }
  if (bytes.byteLength === 0) return { failure: failure('bad-response', '合成音频下载体为空') }
  if (bytes.byteLength > budget.transcodeMaxBytes) {
    return { failure: failure('over-budget', `合成音频 ${bytes.byteLength} 字节超上限 ${budget.transcodeMaxBytes} 字节`) }
  }
  return { audio: bytes, format }
}

/** 占位文案：[语音转写失败：<原因类别>]（不丢事件，不含内部错误体）。 */
export function voiceFailureText(failureValue: VoiceFailure | undefined, action = '转写'): string {
  const kind = failureValue?.kind ?? 'bad-response'
  return `[语音${action}失败：${VOICE_FAILURE_LABELS[kind]}]`
}
