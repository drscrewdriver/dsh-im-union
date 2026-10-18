# Changelog

本项目版本号遵循语义化版本；发布面与宿主兼容矩阵见 `scripts/hosts.mjs`（README 管理块同源）。

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
