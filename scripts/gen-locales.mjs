/** gen-locales.mjs —— 一次性生成 9 语 locale 元数据（zh 真理源）。 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'locale')

const META = {
  zh: { title: 'IM 联合桥', description: '把主流 IM 机器人接入本机 DeepSeek Harness：多平台多账号、每聊天独立会话、跨宿主版本兼容（0.1.2-rc.1 至 0.2.1-rc.2）。' },
  en: { title: 'IM Union Bridge', description: 'Connect IM bots to local DeepSeek Harness: multi-platform multi-account, one session per chat, compatible across host 0.1.2-rc.1 .. 0.2.1-rc.2.' },
  ja: { title: 'IM ユニオンブリッジ', description: '主要 IM ボットをローカル DeepSeek Harness に接続：マルチプラットフォーム・マルチアカウント、チャットごとに独立セッション。' },
  ko: { title: 'IM 유니온 브리지', description: '주요 IM 봇을 로컬 DeepSeek Harness에 연결: 멀티 플랫폼 멀티 계정, 채팅별 독립 세션. ' },
  fr: { title: 'Pont IM Union', description: "Connectez les bots IM à votre DeepSeek Harness local : multi-plateforme, multi-comptes, une session par conversation." },
  de: { title: 'IM-Union-Brücke', description: 'IM-Bots mit lokalem DeepSeek Harness verbinden: Multi-Plattform, Multi-Konto, eigene Sitzung je Chat.' },
  it: { title: 'Bridge IM Union', description: "Collega i bot IM all'Harness DeepSeek locale: multipiattaforma, multiaccount, una sessione per chat." },
  ru: { title: 'Мост IM Union', description: 'Подключение IM-ботов к локальному DeepSeek Harness: мультиплатформенность, мультиаккаунтность, сессия на каждый чат.' },
  es: { title: 'Puente IM Union', description: 'Conecta bots de IM al DeepSeek Harness local: multiplataforma, multicuenta, una sesión por chat.' },
}

for (const [lang, meta] of Object.entries(META)) {
  await writeFile(join(ROOT, `${lang}.json`), JSON.stringify({ meta }) + '\n', 'utf8')
  console.log(`ok  locale/${lang}.json`)
}
