/** run-tests.mjs —— 跨平台测试入口：展开 tests/*.test.mjs 后交给 node --test。 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))
const files = readdirSync(join(ROOT, 'tests'))
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => join('tests', name))
if (files.length === 0) {
  console.error('tests/ 下没有 *.test.mjs')
  process.exit(1)
}
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: ROOT })
process.exit(result.status ?? 1)
