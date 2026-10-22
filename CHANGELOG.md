# Changelog

本项目版本号遵循语义化版本；发布面与宿主兼容矩阵见 `scripts/hosts.mjs`（README 管理块同源）。

## 0.3.1（中文环境语言修复 + 投稿审查修复）

### Added

- `@whiskeysockets/baileys` 声明为 `optionalDependencies`（^6.7.24，随包分发；离线被跳过时渠道启动明确报错不崩溃），修复 awesome 投稿审查指出的「WhatsApp 依赖不随包」问题
- README 双语新增「安装前提」小节：baileys 随包机制、飞书语音档需系统 ffmpeg（二进制不随包）、iMessage 仅 macOS

### Fixed

- 声明面陈旧枚举串同步：`package.json` description、`dsh.plugin.json` 双语 description、`scripts/gen-locales.mjs`（及 9 语 locale 产物）中「0.2.1-alpha.3」统一改「0.2.1-rc.2」，与 hosts.mjs 12 tag 枚举对齐（管理块本就同源，此次清的是手写残留）
- 中文环境面板锁英文：宿主初始 HTML 是 `<html lang="en">`，i18n 启动后才改写为真实语言（真机实测 zh-CN）；client 在 factory 顶层冻结语言判定，装载早于宿主 i18n → 中文环境锁死英文面。改为**取词时懒解析** `<html lang>`（`currentLang()`），未知/缺空前缀保守归 zh，其余语言缺键逐条回落 zh 词典；宿主词典层保留逐键优先（`hostDictionary`），语言判定不再走它

## 0.3.0（私聊准入 + 会话偏好 + 连接保稳）

针对真机反馈三连修：发消息无反应（白名单静默拒）、无预设/模型入口（创建参数丢失）、编辑触发替换凭据（全量重建）。

### Added

- 私聊准入两档（对齐 IM助理）：`approved`=仅白名单（缺省，D6 默认拒绝不变）/`all`=所有私聊；账号行显示「私聊全开」标签，编辑弹窗可切
- 拒绝可见化：私聊被拒回一次带对方 userId 的未授权提示（每用户 10 分钟冷却，防回复风暴）；群聊仅在显式 @ 且开关关闭时提示一次，未 @ 保持静默
- 账号级会话偏好：工作区 cwd / Agent 预设 / 模型（provider+model）/ 推理等级，仅在该账号新建会话时应用；存储于 accounts.json（`session` 对象），设置页弹窗编辑（选项来自新 `/session-catalog` 目录：现有会话 cwd 去重 + sessionController.modelCatalog + agentPresets.list）
- createSession 主路径换 `sessionController.create`（锚点 dsh-repo packages/api/session-controller：SessionCreateRequest 收 `sessionId/cwd/agentPreset`，sessionIdHint 幂等采纳；老线回退 agents.create meta 路径）；模型偏好 create 后 `selectModel` 落位，失败只降级不阻断建会话
- `/session-catalog` 只读目录接口（回包零凭据）

### Fixed

- 「发消息无反应」根因：扫码绑定后无任何代码把用户加入白名单（网关注释声称「渠道层自动入表」但渠道层未实现）→ 全部私聊被静默丢弃；现由拒绝提示 + 准入两档双路解决
- 编辑保存触发「替换凭据」体感：upsert 原来无条件 teardown+重连；现在仅渠道/config 变化或提供新 secret 值才重建，别名/白名单/准入/偏好编辑原位生效（`updatePolicy` 下发，不再重挂 onMessage——顺带修掉 setAllowlist 重复注册监听导致的消息双投）

## 0.2.0（设置面板重设计）

对齐 dsh-im（DSH-IM）渠道卡视觉与 dsh-im-connect（IM助理）账号手风琴两个参照系的净室重写。

### Added

- 面板 v2 骨架：头部（品牌 + 副标语 + GitHub/刷新）→ 统计条（渠道/账号/在线）→ 折叠「运行时诊断」（代际/后端/凭据/上传/产物/Connector + 渠道实现度清单）→ 渠道手风琴卡
- 渠道卡：品牌色块 logo（15 渠道净室简化 glyph，非官方素材）+ 「仅通知 / 仅 macOS / 规划中」标签 + 账号数 + 添加账号；未实现渠道垫底灰显
- 账号行：别名 + 内部键 + 状态徽章（已连接/未连接/已暂停）+ 凭据缺失提示（缺哪些键）+ 检查连接 / 编辑 / 暂停恢复 / 两步删除；白名单编辑收进折叠节，纯通知渠道自动隐藏
- 添加/编辑统一弹窗：微信为扫码流（先建档 skipConnect 再取码，confirmed 后别名/配置保留）；其余渠道按 meta.fields 出双列表单，secret 用 password 框（留空=保持）、helpUrl 外链、必填星标
- 账号编辑：/accounts 回显明文 config（按 meta plain 字段白名单过滤，secret 永不回显，D4 同源）供编辑预填
- UI 语言按宿主 `<html lang>` 选取内置词典（9 语，缺键逐条回落 zh）

### Fixed

- client 把 plain 字段也塞进 secrets 提交，而 upsert 只入库 secret 字段——email 的 address/imapHost/smtpHost 等必填明文、飞书语音档位等全部被静默丢弃；现按字段类型归位（plain → record.config，secret → secrets）

### Changed

- 样式从内联 style 改为单 `<style data-plugin>` 注入；颜色全部走 `var(--dsw-alias-*, fallback)` 消费链（本地 `--diu-*` 别名），暗/浅色零分支，窄容器容器查询降列
- /state 渠道清单增发 hostRequirement（设置页打「仅 macOS」标签）

## 0.1.0（首个功能版，dist-tag=latest）

M1–M3 代码侧全量：12 渠道适配器（11 平台）+ 跨版本窄腰 + 会话引擎 + 管理面。

### Added

- 渠道（P0）：微信 iLink（官方 ClawBot 协议 + 扫码绑定 UI）、飞书（WS 长连 + 流式卡片/逐步消息双档 + 语音档可选）、Telegram（长轮询 + 编辑流式）、Discord（Gateway v10 + 表格转竖排）、企微智能机器人（长连 + 思考中/工具进度原生显示）
- 渠道（P1）：钉钉 stream + AI Card；QQ 官方 API v2（被动窗口）；Slack Socket Mode 零 SDK + thread 模型
- 渠道（P2）：WhatsApp（Baileys，QR 配对 + auth 目录持久化）；Matrix（CS API，E2EE 两档诚实档位）；iMessage（仅 macOS，非 darwin 硬拒载）；企微自建应用（回调验签 + 加解密，webhook 白名单路由）
- 能力：命令面板 24 命令（含 /fork /rename /delivery /export /speak /mute /goal）；审批与交互提问 IM 闭环（waterfall 返回即接管，fail-closed D5）；图片/文件输入（宿主元数据判视觉 E4）；产物文件回传；投递日志与断线补发（≤3 次，uncertain 绝不重发 D7）；超时迟到结果收割；主动投递目标库 + 双向同步；碎片续写（.. / !!）；引用上下文增强；会话标题渠道徽章
- AI Office Connector：查实宿主无公开 connector 协议面 → 离线 Job 队列诚实档（https 强制/租约/审批/并发上限）

### Fixed

- Cordis ctx 代理未 inject 属性访问即抛（可选链拦不住）→ 窄腰全 try/catch 守卫
- 静音判定吞掉 /mute 自身导致的永久静默死锁；/model 与投递链 selections 键不一致导致的视觉判定永命中 unknown

### Changed

- publishConfig.tag：next → latest；THIRD_PARTY_NOTICES 运行时依赖清单与实现对齐（纠未采纳的 SDK 列表）

## 0.0.1（首发占位，tag=next）

预发布占位版本，非推荐安装线；语义为「协议层与跨版本骨架完成、真机验收进行中」。

### Added

- 跨版本窄腰（host-compat）：services 能力探测冻结 / settings-compat 三态代际分派（gen1/gen2/gen3）/ session-api（宿主 @Remote request-object 主形 + 位置参回退）/ interaction（waterfall 返回即接管）/ fs-api
- 会话引擎：每聊天串行队列、follow-before-prompt 投递状态机（assistant/message 按 step 聚合 → 流式快照）、turn/end 六因映射、看门狗兜底
- 命令面板 15 命令（/help /status /new /stop /steer /models /model /reasoning /presets /preset /workspace(s) /session(s) /menu），能力缺位=降级文案不抛
- P0 五渠道协议层（净室重实现）：微信 iLink（官方 ClawBot 协议：长轮询/context_token/AES-128-ECB CDN 全链/typing/扫码绑定）、Telegram（Bot API 长轮询+编辑流式+Markdown 回退链）、Discord（Gateway v10+Thread 模型+表格转竖排）、飞书（官方 SDK 长连接+逐步消息）、企业微信智能机器人（长连接 aibot 协议+stream 编辑流式）
- 审批与交互提问 IM 闭环（once-settle 状态机、发起者限定、fail-closed、5 分钟取消）
- 图片输入公共层（宿主 capability 元数据判视觉、三重预算、渠道图片下载）
- 多账号管理：AccountManager（原子文件态、secret 单向入库、暂停/恢复/白名单/诊断）+ 管理 API（requestRejection/Host/Origin/Cookie 三查、零凭据回包）+ client 半账号 CRUD 面板（九语）
- 门禁四件套：typecheck / 单测 164 项 / dist 冒烟 / hosts:check 单源下发；peer 全枚举 0.1.2-rc.1..0.2.1-rc.1（11 tag）

### Known (intentionally pre-release)

- 各渠道真机 round-trip 验收进行中（T1.10）
- 飞书流式卡片档/QR 创建机器人、企微原生进度显示、微信设置页扫码 UI 流为后续迭代
