/**
 * hosts.mjs —— 宿主版本枚举的**唯一事实源**（dsh-im-union）。
 *
 * 枚举口径（2026-10-17 定稿，机制移植自 dsh-tidy-display/scripts/hosts.mjs 的
 * 单源纪律，版本集合按 IM 插件的宿主面裁剪）：
 * - 起步支持 0.1.2-rc.1 .. 0.2.1-rc.4 共 14 个 tag（对标 MichengAI/dsh-im-connect
 *   的声明面），由本地隔离矩阵逐格验证后**删红留绿**；矩阵结论落 `.compat-results/`。
 * - 0.1.0/0.1.1 线**不入列**：缺认证与会话控制接口（IM 插件硬依赖），装上也必挂；
 *   代码里保留 gen1 设置面兜底路径仅为家族其他插件复用 settings-compat 服务。
 * - 0.1.6-alpha.1/2 不入列：未成线 alpha 且卡面塌缩断代（VD-015-016-01），
 *   首版不承诺；矩阵若绿可后补。
 * 升级流程：本数组加版本 → `node scripts/sync-hosts.mjs --write` → 矩阵绿 → 发版。
 *
 * 本数组与由它生成的声明写点（package.json peerDependencies 的 6 个 dsh-* 项 /
 * package.json engines.dsh / dsh.plugin.json engines.dsh + version 镜像 /
 * README 管理块）**禁止手改**，由 sync-hosts.mjs 校验/下发。
 * cordis / schemastery / react 例外（见 cordisRange 注释）。
 */

/** 全部声明支持的宿主 tag（冻结；新增只在此处追加）。 */
export const supportedHosts = Object.freeze([
  // 0.1.2 线（1 个 rc）
  '0.1.2-rc.1',
  // 0.1.5 线（3 个 rc）
  '0.1.5-rc.1',
  '0.1.5-rc.2',
  '0.1.5-rc.3',
  // 0.1.7 线（2 个 rc）
  '0.1.7-rc.1',
  '0.1.7-rc.2',
  // 0.2.0 线（2 个 rc；0.2.0 与 0.1.7-rc.2 宿主面零 diff，不设专属适配分支）
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  // 0.2.1 线（2 个 alpha + rc.1/rc.2/rc.3；rc.1 于 2026-10-17 农场实证后入列；
  // rc.2 于 2026-10-18 按用户裁定入列：本插件无搜索类断裂触点，与 rc.1 同面；
  // npm 存在性已核 @deepseek-ai/dsh-web versions 含 0.2.1-rc.2；
  // rc.3 于 2026-10-24 同裁定入列：rc.2→rc.3 契约面零断裂（host-matrix 探针 14 列
  // rc.2↔rc.3 复核 + source-analysis v0.2.1-rc.3 四件套），本插件不触 ctx.web
  // provider 钉选/模型标签槽/startSession 系；三域条目仅用户可隐藏，不破功能；
  // rc.4 于 2026-10-28 同裁定入列：rc.3→rc.4 纯修复车契约面零 diff（source-analysis
  // v0.2.1-rc.4 四件套 + 配对探针 14 列全等），本插件不触页签 tooltip 探针锚/ACP stdout 抓取的声明面）
  '0.2.1-alpha.2',
  '0.2.1-alpha.3',
  '0.2.1-rc.1',
  '0.2.1-rc.2',
  '0.2.1-rc.3',
  '0.2.1-rc.4',
])

/** peerDependencies / engines.dsh 共用的枚举串（精确枚举无暗坑：caret 与 `<x-0` 上界实测漏 rc 线）。 */
export const peerRange = supportedHosts.join(' || ')

/** 本地开发矩阵默认宿主。 */
export const developmentHost = '0.2.0-rc.2'

/**
 * peer 闸指向的宿主子包（本插件消费的全部 `@deepseek-ai/dsh-*` 面）。
 *
 * 机制事实（宿主 app-boot/src/plugin-compatibility.ts）：宿主 peer 闸把**每一个**
 * dsh-* peer 的范围拿去匹配**宿主运行时版本**（semver.satisfies + includePrerelease），
 * 不按包名跳过、也不按子包自身版本比对——因此所有项必须携带**全量枚举**，
 * 按"包存在线"拆分范围会导致老线整体拒载。"某子包在某线不存在"由矩阵运行时断言
 * 裁决，不由声明面预判。
 */
export const hostPeerPackages = Object.freeze([
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-host-webserver',
])

/**
 * cordis / schemastery 独立版本空间，不随宿主 rc 逐版发布，不适用枚举法：
 * cordis 放宽 ^4.0.2 横跨两代；schemastery ^3.18.2（volatile 面需 >=3.18.2）。
 * react 为上游生态 peer（optional），本脚本不碰。
 */
export const cordisRange = '^4.0.2'
export const schemasteryRange = '^3.18.2'
