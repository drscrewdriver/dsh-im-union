// 插件文件日志（0.3.6）：desktop 宿主管线无文件落点——plugin.log 让
// 「请查看本机日志」有处可看；withFileLog 原管线照走 + 文件分流。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initPluginFileLog, withFileLog } from '../lib/plugin-log.js'

test('plugin.log：warn/error/info 落文件，宿主管线照走', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imu-log-'))
  try {
    const fileLog = initPluginFileLog(dir)
    const piped = []
    const log = withFileLog({
      debug(...a) { piped.push(['debug', ...a]) },
      info(...a) { piped.push(['info', ...a]) },
      warn(...a) { piped.push(['warn', ...a]) },
      error(...a) { piped.push(['error', ...a]) },
    })
    log.info('信息行')
    log.warn('警告行')
    log.error('错误行')
    log.debug('调试不落盘')
    assert.equal(piped.length, 4, '宿主管线全量照走')
    const text = await readFile(join(dir, 'plugin.log'), 'utf8')
    assert.match(text, /INFO 信息行/)
    assert.match(text, /WARN 警告行/)
    assert.match(text, /ERROR 错误行/)
    assert.ok(!text.includes('调试不落盘'), 'debug 不落文件')
    assert.equal(fileLog, (await import('../lib/plugin-log.js')).fileLog())
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
