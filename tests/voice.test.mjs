// T3.5 语音管道单测：ffmpeg 注入面成败两路 / ENOENT 文案 / 预算 / DashScope 请求体与分型。
// 全链零真机：child_process 与 fetch 均为 fake，不发真实请求、不真起 ffmpeg。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VOICE_BUDGET,
  transcode,
  checkFfmpeg,
  dashscopeAsr,
  dashscopeTts,
  classifyStatus,
  estimateWavDurationMs,
  resolveInputFormat,
  resolveOutputArgs,
  voiceFailureText,
  VOICE_FAILURE_LABELS,
} from '../lib/engine/voice.js'

// —— fake spawn ——————————————————————————————————

function mkStream() {
  const handlers = {}
  return {
    on(event, cb) {
      ;(handlers[event] ??= []).push(cb)
      return this
    },
    emitData(chunk) {
      for (const cb of handlers.data ?? []) cb(chunk)
    },
    handlers,
  }
}

function fakeSpawn(scenario = {}) {
  const calls = []
  const impl = (command, args) => {
    const record = { command, args, input: [], ended: false, killed: [], handlers: {} }
    calls.push(record)
    const fire = (event, ...rest) => {
      for (const cb of record.handlers[event] ?? []) cb(...rest)
    }
    record.stdout = mkStream()
    record.stderr = mkStream()
    const child = {
      stdin: {
        write: (chunk) => record.input.push(chunk),
        end: () => {
          record.ended = true
        },
      },
      stdout: record.stdout,
      stderr: record.stderr,
      on: (event, cb) => {
        ;(record.handlers[event] ??= []).push(cb)
        return child
      },
      kill: (signal) => {
        record.killed.push(signal ?? 'SIGTERM')
        if (scenario.killCloses === true) fire('close', null)
        return true
      },
    }
    setImmediate(() => {
      const mode = scenario.mode ?? 'ok'
      if (mode === 'enoent') {
        fire('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }))
        return
      }
      if (mode === 'hang') return
      for (const chunk of scenario.out ?? []) record.stdout.emitData(chunk)
      for (const chunk of scenario.err ?? []) record.stderr.emitData(chunk)
      fire('close', mode === 'fail' ? (scenario.code ?? 1) : 0)
    })
    return child
  }
  return { impl, calls }
}

// —— fake fetch ———————————————————————————————————

function fakeFetch(route) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    })
    return route(url, init)
  }
  return { impl, calls }
}

const jsonResp = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
  arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
})

/** 造一段合法 RIFF/WAVE 头（用于时长估算，字节全零）；16bit 单声道，byteRate=字节/秒。 */
function makeWav(dataBytes, byteRate) {
  const head = new Uint8Array(44)
  const view = new DataView(head.buffer)
  const ascii = (at, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, Math.round(byteRate / 2), true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  return head
}

// —— transcode —————————————————————————————————————

test('transcode 成功：ffmpeg 参数（pipe:0/pipe:1 + wav/16k 单声道）与产物合并', async () => {
  const { impl, calls } = fakeSpawn({ out: [Uint8Array.from([1, 2]), Uint8Array.from([3])] })
  const result = await transcode(Uint8Array.from([9, 9]), 'ogg', 'wav', impl)
  assert.ok(result.audio, '有产物')
  assert.deepEqual([...result.audio], [1, 2, 3])
  assert.equal(result.format, 'wav')
  assert.equal(result.failure, undefined)
  const call = calls[0]
  assert.equal(call.command, 'ffmpeg')
  assert.deepEqual(call.args, ['-hide_banner', '-loglevel', 'error', '-f', 'ogg', '-i', 'pipe:0', '-y', '-f', 'wav', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', 'pipe:1'])
  assert.equal(call.ended, true, 'stdin 已关闭（流式无临时文件）')
  assert.equal(call.input.length, 1)
})

test('transcode opus 档：飞书语音条参数（libopus/-ac 1/-ar 16000）', async () => {
  const { impl, calls } = fakeSpawn({ out: [Uint8Array.from([7])] })
  const result = await transcode(Uint8Array.from([1]), 'wav', 'opus', impl)
  assert.deepEqual([...result.audio], [7])
  assert.equal(result.format, 'opus')
  assert.ok(calls[0].args.includes('libopus'))
  assert.ok(calls[0].args.includes('ogg'))
})

test('transcode 非 0 退出 → 降级不抛（undefined 产物 + ffmpeg-failed + stderr 片段）', async () => {
  const { impl } = fakeSpawn({ mode: 'fail', code: 234, err: [new TextEncoder().encode('Invalid data found when processing input')] })
  const result = await transcode(Uint8Array.from([1, 2]), 'ogg', 'wav', impl)
  assert.equal(result.audio, undefined)
  assert.equal(result.failure.kind, 'ffmpeg-failed')
  assert.equal(result.failure.uncertain, false)
  assert.match(result.failure.message, /退出码 234/)
  assert.match(result.failure.message, /Invalid data/)
})

test('transcode ENOENT（ffmpeg 缺位）→ 明确文案，不静默', async () => {
  const { impl } = fakeSpawn({ mode: 'enoent' })
  const result = await transcode(Uint8Array.from([1]), 'ogg', 'wav', impl)
  assert.equal(result.audio, undefined)
  assert.equal(result.failure.kind, 'ffmpeg-missing')
  assert.match(result.failure.message, /未安装 ffmpeg/)
})

test('transcode 超时 → 杀进程 + ffmpeg-timeout（不悬挂）', async () => {
  const { impl, calls } = fakeSpawn({ mode: 'hang' })
  const result = await transcode(Uint8Array.from([1]), 'ogg', 'wav', impl, { timeoutMs: 20 })
  assert.equal(result.audio, undefined)
  assert.equal(result.failure.kind, 'ffmpeg-timeout')
  assert.deepEqual(calls[0].killed, ['SIGKILL'])
})

test('transcode 产物为空 → ffmpeg-failed（不产假音）', async () => {
  const { impl } = fakeSpawn({ out: [] })
  const result = await transcode(Uint8Array.from([1]), 'ogg', 'wav', impl)
  assert.equal(result.audio, undefined)
  assert.equal(result.failure.kind, 'ffmpeg-failed')
})

test('transcode 入参护栏：空字节/超限/未知格式都零 spawn', async () => {
  const { impl, calls } = fakeSpawn({ out: [Uint8Array.from([1])] })
  assert.equal((await transcode(new Uint8Array(0), 'ogg', 'wav', impl)).failure.kind, 'bad-input')
  const big = new Uint8Array(VOICE_BUDGET.transcodeMaxBytes + 1)
  assert.equal((await transcode(big, 'ogg', 'wav', impl)).failure.kind, 'over-budget')
  assert.equal((await transcode(Uint8Array.from([1]), 'flv', 'wav', impl)).failure.kind, 'unsupported-format')
  assert.equal((await transcode(Uint8Array.from([1]), 'ogg', 'flv', impl)).failure.kind, 'unsupported-format')
  assert.equal(calls.length, 0, '护栏命中即不触 ffmpeg')
})

test('格式表：MIME 与 ffmpeg demuxer 对齐文档（ogg/mp3/wav）', () => {
  assert.deepEqual(resolveInputFormat('audio/ogg'), { ffmpegFmt: 'ogg', mime: 'audio/ogg' })
  assert.equal(resolveInputFormat('opus').ffmpegFmt, 'ogg')
  assert.equal(resolveInputFormat('mp3').mime, 'audio/mpeg')
  assert.equal(resolveInputFormat('flv'), undefined)
  assert.ok(resolveOutputArgs('WAV').includes('pcm_s16le'))
})

// —— checkFfmpeg / 时长估算 ————————————————————————

test('checkFfmpeg：退出 0=可用；ENOENT=ffmpeg-missing；无注入面=不真起进程', async () => {
  const ok = fakeSpawn({ out: [new TextEncoder().encode('ffmpeg version 7.1')] })
  const good = await checkFfmpeg({ spawnImpl: ok.impl })
  assert.equal(good.ok, true)
  assert.match(String(good.version), /ffmpeg version/)
  assert.deepEqual(ok.calls[0].args, ['-version'])

  const missing = fakeSpawn({ mode: 'enoent' })
  const bad = await checkFfmpeg({ spawnImpl: missing.impl })
  assert.equal(bad.ok, false)
  assert.equal(bad.failure.kind, 'ffmpeg-missing')

  const none = await checkFfmpeg()
  assert.equal(none.ok, false)
  assert.equal(none.failure.kind, 'missing-config')
})

test('estimateWavDurationMs：16k/16bit 单声道按时长回算；非 wav 不猜', () => {
  const wav = makeWav(32000, 32000)
  assert.equal(estimateWavDurationMs(wav), 1000)
  assert.equal(estimateWavDurationMs(Uint8Array.from([1, 2, 3])), undefined)
  assert.equal(estimateWavDurationMs(new TextEncoder().encode('OggSnotwav').slice(0, 44)), undefined)
})

// —— DashScope ASR ——————————————————————————————————

test('dashscopeAsr 请求体：模型名/Data URL 输入/asr_options；Authorization 头不回显 key', async () => {
  const fetch = fakeFetch(() =>
    jsonResp({
      output: { choices: [{ message: { role: 'assistant', content: [{ text: '欢迎使用阿里云。' }] } }] },
      usage: { seconds: 2 },
      request_id: 'req-1',
    }),
  )
  const result = await dashscopeAsr(Uint8Array.from([1, 2, 3]), { apiKey: 'sk-secret-value', fetchImpl: fetch.impl })
  assert.equal(result.text, '欢迎使用阿里云。')
  assert.equal(result.seconds, 2)
  const call = fetch.calls[0]
  assert.equal(call.method, 'POST')
  assert.ok(call.url.endsWith('/api/v1/services/aigc/multimodal-generation/generation'), call.url)
  assert.equal(call.headers.authorization, 'Bearer sk-secret-value')
  assert.equal(call.body.model, 'qwen3-asr-flash')
  assert.equal(call.body.input.messages[0].role, 'user')
  assert.match(call.body.input.messages[0].content[0].audio, /^data:audio\/wav;base64,/)
  assert.equal(call.body.parameters.asr_options.enable_itn, false)
  assert.ok(!JSON.stringify(result).includes('sk-secret-value'), '返回值零密钥')
})

test('dashscopeAsr：模型/语种/自建 base 可配', async () => {
  const fetch = fakeFetch(() => jsonResp({ output: { choices: [{ message: { content: [{ text: 'hi' }] } }] } }))
  await dashscopeAsr(Uint8Array.from([1]), {
    apiKey: 'k',
    model: 'qwen3-asr-flash-2025-05-19',
    language: 'zh',
    baseUrl: 'https://my-workspace.cn-beijing.maas.aliyuncs.com/api/v1/',
    fetchImpl: fetch.impl,
  })
  const call = fetch.calls[0]
  assert.equal(call.url, 'https://my-workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
  assert.equal(call.body.model, 'qwen3-asr-flash-2025-05-19')
  assert.equal(call.body.parameters.asr_options.language, 'zh')
})

test('dashscopeAsr 分型：4xx=rejected 确定；5xx/网络错=uncertain（D7 禁重发）', async () => {
  const four = fakeFetch(() => jsonResp({ code: 'InvalidApiKey', message: 'api key invalid' }, { ok: false, status: 401 }))
  const r4 = await dashscopeAsr(Uint8Array.from([1]), { apiKey: 'k', fetchImpl: four.impl })
  assert.equal(r4.text, undefined)
  assert.equal(r4.failure.kind, 'rejected')
  assert.equal(r4.failure.uncertain, false)
  assert.equal(r4.failure.status, 401)
  assert.ok(!JSON.stringify(r4.failure).includes('"k"'))

  const five = fakeFetch(() => jsonResp({ code: 'InternalError', message: 'boom' }, { ok: false, status: 500 }))
  const r5 = await dashscopeAsr(Uint8Array.from([1]), { apiKey: 'k', fetchImpl: five.impl })
  assert.equal(r5.failure.kind, 'uncertain')
  assert.equal(r5.failure.uncertain, true)

  const net = fakeFetch(() => {
    throw new Error('fetch failed: socket hang up')
  })
  const rn = await dashscopeAsr(Uint8Array.from([1]), { apiKey: 'k', fetchImpl: net.impl })
  assert.equal(rn.failure.kind, 'uncertain')
  assert.equal(rn.failure.uncertain, true)

  assert.equal(classifyStatus(200), undefined)
  assert.equal(classifyStatus(404).uncertain, false)
  assert.equal(classifyStatus(503).uncertain, true)
})

test('dashscopeAsr 响应无文本 → bad-response（不产假转写）', async () => {
  const fetch = fakeFetch(() => jsonResp({ output: { choices: [] }, request_id: 'r' }))
  const result = await dashscopeAsr(Uint8Array.from([1]), { apiKey: 'k', fetchImpl: fetch.impl })
  assert.equal(result.text, undefined)
  assert.equal(result.failure.kind, 'bad-response')
})

test('dashscopeAsr 预算：体积/时长超限零请求；缺 key=missing-config', async () => {
  const fetch = fakeFetch(() => jsonResp({ output: {} }))
  const big = new Uint8Array(VOICE_BUDGET.asrMaxInputBytes + 1)
  const over = await dashscopeAsr(big, { apiKey: 'k', fetchImpl: fetch.impl })
  assert.equal(over.failure.kind, 'over-budget')
  assert.match(over.failure.message, /10 MiB/)

  // 5 分钟上限：32000 B/s（16k/16bit 单声道）× 301s 的 data 段
  const long = makeWav(32000 * 301, 32000)
  const longResult = await dashscopeAsr(long, { apiKey: 'k', fetchImpl: fetch.impl })
  assert.equal(longResult.failure.kind, 'over-budget')
  assert.match(longResult.failure.message, /时长/)

  assert.equal(fetch.calls.length, 0, '护栏命中即不触网')
  const noKey = await dashscopeAsr(Uint8Array.from([1]), { apiKey: '', fetchImpl: fetch.impl })
  assert.equal(noKey.failure.kind, 'missing-config')
})

// —— DashScope TTS ——————————————————————————————————

test('dashscopeTts：SpeechSynthesizer 请求体 + 二次 GET 取回字节', async () => {
  const fetch = fakeFetch((url) => {
    if (url.includes('SpeechSynthesizer')) return jsonResp({ output: { audio: { url: 'https://dashscope-result.example/a.wav', expires: 1 }, format: 'wav' }, request_id: 'r2' })
    return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new Uint8Array([8, 7, 6, 5]).buffer }
  })
  const result = await dashscopeTts('你好，世界', { apiKey: 'sk-tts', model: 'cosyvoice-v3-flash', voice: 'longanyang', fetchImpl: fetch.impl })
  assert.deepEqual([...result.audio], [8, 7, 6, 5])
  assert.equal(result.format, 'wav')
  const post = fetch.calls[0]
  assert.equal(post.method, 'POST')
  assert.ok(post.url.endsWith('/api/v1/services/audio/tts/SpeechSynthesizer'), post.url)
  assert.equal(post.headers.authorization, 'Bearer sk-tts')
  assert.equal(post.body.model, 'cosyvoice-v3-flash')
  assert.equal(post.body.input.text, '你好，世界')
  assert.equal(post.body.input.voice, 'longanyang')
  assert.equal(post.body.input.format, 'wav')
  assert.equal(post.body.input.sample_rate, 24000)
  const get = fetch.calls[1]
  assert.equal(get.method, 'GET')
  assert.equal(get.url, 'https://dashscope-result.example/a.wav')
  assert.equal(get.headers.authorization, undefined, '签名下载地址不带密钥')
})

test('dashscopeTts：兼容 output.audio.data（base64 内联）', async () => {
  const inline = Buffer.from([42, 43]).toString('base64')
  const fetch = fakeFetch(() => jsonResp({ output: { audio: { data: inline, format: 'mp3' } } }))
  const result = await dashscopeTts('测试', { apiKey: 'k', fetchImpl: fetch.impl })
  assert.deepEqual([...result.audio], [42, 43])
  assert.equal(result.format, 'mp3')
  assert.equal(fetch.calls.length, 1)
})

test('dashscopeTts 失败：文本空/超长零请求；无产物=bad-response；下载网络错=uncertain', async () => {
  const fetch = fakeFetch(() => jsonResp({ output: {} }))
  assert.equal((await dashscopeTts('   ', { apiKey: 'k', fetchImpl: fetch.impl })).failure.kind, 'bad-input')
  const long = '字'.repeat(VOICE_BUDGET.ttsMaxChars + 1)
  const overLong = await dashscopeTts(long, { apiKey: 'k', fetchImpl: fetch.impl })
  assert.equal(overLong.failure.kind, 'over-budget')
  assert.match(overLong.failure.message, /500/)
  assert.equal(fetch.calls.length, 0)

  const empty = await dashscopeTts('正常文本', { apiKey: 'k', fetchImpl: fetch.impl })
  assert.equal(empty.failure.kind, 'bad-response')

  const dl = fakeFetch((url) => {
    if (url.includes('SpeechSynthesizer')) return jsonResp({ output: { audio: { url: 'https://x.example/a.wav' } } })
    throw new Error('network timeout')
  })
  const failed = await dashscopeTts('正常文本', { apiKey: 'k', fetchImpl: dl.impl })
  assert.equal(failed.audio, undefined)
  assert.equal(failed.failure.kind, 'uncertain')
  assert.equal(failed.failure.uncertain, true)

  const dlFail = fakeFetch((url) => {
    if (url.includes('SpeechSynthesizer')) return jsonResp({ output: { audio: { url: 'https://x.example/a.wav' } } })
    return { ok: false, status: 403, json: async () => ({ code: 'AccessDenied' }), arrayBuffer: async () => new Uint8Array(0).buffer }
  })
  const forbidden = await dashscopeTts('正常文本', { apiKey: 'k', fetchImpl: dlFail.impl })
  assert.equal(forbidden.failure.kind, 'rejected')
  assert.equal(forbidden.failure.uncertain, false)
})

test('占位文案：[语音转写失败：<原因类别>] 不带内部错误体', () => {
  assert.equal(voiceFailureText({ kind: 'ffmpeg-missing', message: '本机未安装 ffmpeg', uncertain: false }), `[语音转写失败：${VOICE_FAILURE_LABELS['ffmpeg-missing']}]`)
  assert.equal(voiceFailureText(undefined, '转写'), '[语音转写失败：响应异常]')
  assert.equal(voiceFailureText({ kind: 'uncertain', message: 'socket hang up', uncertain: true }, '合成'), '[语音合成失败：网络不确定]')
})
