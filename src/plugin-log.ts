/**
 * 插件自有文件日志。desktop/Electron 线真机实证：宿主日志管线无文件落点
 * （AppData 下只有 crash dump，~/.dsh/logs 只有 CLI 启动日志），管理面 500 的
 * 「请查看本机日志」无处可看。本文件日志把插件的 info/warn/error 追加落到
 * `<stateDir>/plugin.log`，512KB 滚动保留一份 .1，诊断通道自身失败一律静默。
 */
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { LoggerLike } from './types.js'

const MAX_BYTES = 512 * 1024

export class PluginFileLog {
  private readonly filePath: string

  constructor(stateDir: string) {
    this.filePath = join(stateDir, 'plugin.log')
  }

  write(level: 'info' | 'warn' | 'error', message: string): void {
    try {
      this.rotateIfNeeded()
      appendFileSync(this.filePath, `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`, { encoding: 'utf8' })
    } catch {
      // 日志失败静默：诊断通道不能反过来成为故障源。
    }
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.filePath) || statSync(this.filePath).size < MAX_BYTES) return
    const prev = `${this.filePath}.1`
    try {
      unlinkSync(prev)
    } catch {
      // 首次滚动无旧档。
    }
    try {
      renameSync(this.filePath, prev)
    } catch {
      // 文件被占用等异常下次再滚。
    }
  }
}

let active: PluginFileLog | undefined

/** apply 期初始化一次；此后任意模块可取（未初始化返回 undefined，调用方自行降级）。 */
export function initPluginFileLog(stateDir: string): PluginFileLog {
  active = new PluginFileLog(stateDir)
  return active
}

export function fileLog(): PluginFileLog | undefined {
  return active
}

/** 宿主 logger 分流包装：原管线照走，info/warn/error 追加落文件。 */
export function withFileLog(logger: LoggerLike): LoggerLike {
  return {
    debug: (...args) => logger.debug(...args),
    info: (message, ...rest) => {
      logger.info(message, ...rest)
      active?.write('info', typeof message === 'string' ? message : String(message))
    },
    warn: (message, ...rest) => {
      logger.warn(message, ...rest)
      active?.write('warn', typeof message === 'string' ? message : String(message))
    },
    error: (message, ...rest) => {
      logger.error(message, ...rest)
      active?.write('error', typeof message === 'string' ? message : String(message))
    },
  }
}
