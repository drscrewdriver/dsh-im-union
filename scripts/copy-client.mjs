/** copy-client.mjs —— 浏览器半是手写 JS（无构建），仅做 src→lib 搬运。 */
import { copyFile, mkdir } from 'node:fs/promises'

await mkdir(new URL('../lib/', import.meta.url), { recursive: true })
await copyFile(new URL('../client.js', import.meta.url), new URL('../lib/client.js', import.meta.url))
console.log('ok  client.js -> lib/client.js')
