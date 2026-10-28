# Changelog

本项目版本号遵循语义化版本；发布面与宿主兼容矩阵见 `scripts/hosts.mjs`（README 管理块同源）。

## 0.5.2（Discord 服务器频道消息失联：Gateway intents 位值修正）

感谢 @lide4144 在 #1 里的报告与双连接对照实验，定位、根因与修正值全部准确。

### Fixed

- **Gateway intents 位值写错导致服务器频道消息永远收不到**（#1）：`GUILD_MESSAGES` 实写为 `1 << 15`（应为 `1 << 9`）、`MESSAGE_CONTENT` 实写为 `1 << 24`（应为 `1 << 15`，且 `1 << 24` 不是任何已定义 intent）。于是 IDENTIFY 实际请求的是 `MESSAGE_CONTENT | DIRECT_MESSAGES | 未定义位`，**从未订阅 GUILD_MESSAGES**——Discord 因此不推送服务器频道的 `MESSAGE_CREATE`；而握手/READY/心跳全部正常，连接看着是健康的，故极难发现。有有效值 `16814080 → 37377`。**不引入新的门户勾选要求**：`MESSAGE_CONTENT`（特权位）此前已被 `1 << 15` 误命名请求着，行为不变。
- **IDENTIFY 补齐 `GUILDS`（`1 << 0`）**：此前 `INTENTS.GUILDS` 定了却从未使用，招不到 `GUILD_CREATE`，部分场景（刚加入的服务器、缓存缺失的频道）拿不到上下文。
- **`createDiscordAdapter` 透传 `logger`**：`ChannelFactory` 契约早已有 `logger` 字段（宿主接线到 `plugin.log`），本工厂始终丢弃它，导致 Discord 适配器的全量生命周期日志（含“Gateway 断开”）不落盘——#1 里“`plugin.log` 没有任何入站记录”的次因。
- **测试不得拿实现值自证**：`tests/discord.test.mjs` 原本把错误位值 `(1<<15)|(1<<12)|(1<<24)` 钉进了断言，这是本缺陷能存活的原因。现改为按官方文档值逐位断言，并加“`1<<24` 必须为 0”的回归守卫；新增 logger 透传用例。全量 771/771 绿。

### Known（本版本未动，另单跟踪）

- Gateway `close` 后无自动重连（仅记日志），op 7 RECONNECT 后靠重建；`AccountManager.ensureConnected` 只在操作时触发——Discord 定期下发 RECONNECT 时会静默失联直到手动重启。属代码内已标注的 **T2.5 挂账**（需退避策略 + RESUME/session 生命周期设计），与本次位值修正无关。

## 0.5.0（QQ 渠道能力补齐：出站图片 / Markdown / 入站图片文件 / 审批按钮 / 群管理）

对照 `_ref-im/dsh-qqbot`（同一套 QQ 官方 api-v2）逐面解锁 `src/channels/qq.ts`，遵守净室 / 零运行时依赖 / D7 纪律。

### Added

- **出站图片 `caps.fileOut` + `sendFile`**：上传换 file_info → msg_type=7 携带 **`media: { file_info }`**（体形按官方 `@tencent-connect/qqbot-nodejs` 1.0.5 `sendMediaMessage` 对账，非旧式 `image: file_info`）；上传采用**双形态递降**：先官方 SDK 小文件形态（JSON + base64 `file_data`，`file_type=1`、`srv_send_msg=false`），被平台确定性拒绝再回退官方文档记载的 multipart/form-data 形态一次（网络不确定绝不重试，D7 免白占配额）；群/单聊分 `/files` 端点，窗口内带 msg_id/seq；一举激活网关 SVG→PNG 附图链、产物回传与 `/export`。非图片 mime（zip/文件）优雅拒绝（官方 file_type=4 未开放）；304080/40093002 确定性转译
- **Markdown 出站 msg_type=2**：正文含 `![` 图片内嵌或 `qqbot-media://` 时走 markdown 通道；被平台确定性拒绝（如 304036 无模板权限）自动降级纯文本重发一次
- **Markdown 内联本地图片自动上传（task_8）**：新增 `QqAdapter.uploadMarkdownImage`（3 步 `/v2/media-images`：prepare→COS 直传→complete，sha256 内容指纹去重、10MB 上限），gateway 投递前将正文 `![](本地路径)` 经宿主 `workspaceFiles` 受管读（workspaceRoot 限定，适配器不碰盘）取字节上传、回替 `qqbot-media://` url；非 QQ/无本地图/读失败/上传失败均原样保留
- **入站图片/文件 `caps.imageIn/fileIn`**：事件 `attachments[].url`（rkey 时效）即时下载填 `images[]/files[]`（含 mimeType）；群聊图片 content_type 实测为 'file' → 兼用 URL 形态判定；无 arrayBuffer/非 2xx/空字节按占位不丢事件；入站派发改串行链保序（异步下载不打乱消息顺序）
- **审批/提问按钮 `askChoices`（keyboard）**：msg_type=2 + **`keyboard: { content: { rows } }`**（官方 InlineKeyboard 包装层，少一层平台不渲染），action.type=1 回传；收到 INTERACTION_CREATE 后**best-effort `PUT /interactions/{id} {code:0}` 上确认**再结算；D5 仅接受发起者点按；`config.keyboard=on` 才订阅 INTERACTION intent 并置 `nativeChoices=true`（默认关=零风险，未配置回退数字菜单）
- **语音入站免解码**：优先取事件原生 `asr_refer_text` 作正文，无则占位；不引入 silk 解码依赖
- **QQ 群管理**：新建 `src/channels/qq-group-admin.ts`（FEATURE_GATES 门控 + 端点/错误码人话映射），QqAdapter 暴露入群申请列表/审批、群禁言查询/设置、消息撤回；经 `/qq` 命令面可达，仅群聊、作用于本群、需 `config.groupAdminUsers` 授权名单（空=命令惰性拒绝）+ 机器人为群管理员

### Notes

- 撤回/编辑 `editStream`、原生流式 `nativeStream` 本轮不做（协议语义未逐面核实、与 dsh-qqbot 打平）
- 全量 753 单测绿（QQ +8）；真机农场冒烟需 QQ 凭据待验

## 0.4.12（飞书审批卡片：权限 ask 走按钮确认）

### Added

- **飞书 `askChoices` 实装（本插件第一个真按钮面渠道）**：宿主审批（T1.9）不只能回「1/2/c」文本，而是直接收到一张带「允许一次 / 拒绝」按钮的卡片，点按钮即定夺。`caps.nativeChoices` 由 false 改 true（此前所有渠道都是 false 或缺面，飞书是第一个把这条分支跑通的）
- **协议事实（真机实测，写进代码注释）**：飞书 2.0 schema 的 `body.elements` **已不支持 `action` 标签**（`230099 / 200861 unsupported tag action`），按钮卡片必须走 1.0 形态（顶层 `elements` + `action`/`button`）；而内联 `interactive` 消息不碰 cardkit 实体面，**不需要 `cardkit:card:write`**（与流式卡片不同一条权限链）
- **回传走同一条长连接**：`EventDispatcher` 注册 `card.action.trigger`（官方 SDK 1.76 自带该分发 + 按 chatId 去重/加锁/排队），无需另开 webhook；回包给 `toast` 让用户看到「已记录：拒绝」

### Fixed

- **按钮期间用户打字会被当成新任务丢给模型**：原 `handleApproval` 的按钮分支是直接 `await adapter.askChoices(...)`，期间**不登记 pending**，所以用户习以为常地回一句「可以」会落进会话队列。现改为**按钮 + 文本双路竞速**（`approvalViaButtons`）：卡片在位时「1/2/c」同样定夺，先到为准
- **按钮面无渠道侧超时**：适配器 `askChoices` 自带 5 分钟上限（与 D5 对齐）+ `signal` abort 即收；`disconnect()` 释放所有在位卡片（空答=取消，fail-closed）

### Changed

- `askChoices` 契约加第 6 个可选参 `opts.ownerUserId`：卡片回传带的是点击者身份，需比对发起者才能守 D5（**只有发起者能定夺**，他人点击不改判，只回 toast 说明）
- 飞书 `multi=true` 明确拒接（卡片无多选原语）：抛错后 broker 回落文本菜单，不造假成单选
- 迟到的重复点按（卡还在、pending 已清）一律忽略；审批卡按 `message_id` 键控，同聊天先后两张卡不会串台

## 0.4.11（回合内「处理中」信号 — 引擎接线 + 飞书表情落地）

### Added

- **引擎侧第一次真正调 `setTyping`**：`runTurn` 在 prompt 前发回合开始信号（`caps.typing` 位 + `setTyping` 方法双门控）。此前 Discord/Telegram/Matrix/QQ/微信 六个适配器都实现了 `setTyping`，但引擎侧**零调用点**——它们全是死代码；这次一并激活
- **飞书「处理中」落地为表情回应**：飞书无 typing API（客户端不暴露），实测 `POST/DELETE /open-apis/im/v1/messages/{id}/reactions` 全链 `code 0`，因此在用户本条入站消息上贴 `OnIt`（官方「需处理/进行中」语义）：回合开始贴、回复/卡片落定即删、没删成 2 分钟 TTL 自清；同一聊天只留一个；表情接口缺权/限频/消息被撕一律静默，不阻断回合
- 飞书 `caps.typing` / `caps.statusReaction` 由 false 改 true（声明=真实现：两个位同一个落地物）

### Changed

- 入站接收时记住 `chatId → message_id`（状态位锚点）；状态位仅沾在用户那条消息上，不额外发一条「思考中…」占位消息，不污染会话历史

## 0.4.10（多回合接续：同一聊天不得被劈成两条轨迹）

### Fixed

- **飞书第二回合另起会话，轨迹分叉（真机 desktop 实证）**：`apply` 期会话后端是 `none`，首回合入站时 `ensureSessionId` 直接返回隐式 id（`im:union:feishu:dm:oc_…`）——宿主按该 id 落了盘（目录 `im~003Aunion…`）；惰性后端随后升级 `native`，第二回合就调 `createSession(hint)`，而 desktop 线 `sessionController.create` 面缺位 → 回退 `agents.create`（不收 sessionId）→ 宿主生成 `session-uuid`，`router.bind` 改绑到 UUID。结果同一聊天被劈成两段：首段在 `im:union:` 目录（进「频道」分组），第二段在 `session-uuid` 目录（落「未分组」），jsonl 各写各的
- **修法（先查后建）**：`ensureSessionId` 在 `createSession` 之前先查宿主会话列表，已有该 `im:union:` id 则直接接续（不 create、不重复应用账号偏好——存量会话不动）；命中后进进程内缓存，后续回合不重复查。查询面异常/缺位按「未存在」处理，仍走 create 兜底
- **可操作的排障日志**：宿主改派成非 `im:` 前缀 id（会落「未分组」）时，除既有「请求 id → 宿主实际 id」info，另打一条 warn 给出 `/session <原隐式 id>` 的接回手段；不再只留一条 id 差异让人猜

## 0.4.9（飞书诊断假红收口 + 可选密钥不再算缺失）

### Fixed

- **飞书「凭据无效」假红（真机 desktop 实证）**：`diagnose` 凭据位探的是 `GET /open-apis/bot/v2/info`——该路径不存在（服务端回 `404 page not found` 纯文本，SDK 对非 2xx 直接抛），于是任何正确凭据都落 catch 分支报「凭据或网络无效」。现改探 `POST /open-apis/auth/v3/tenant_access_token/internal`（唯一对 appSecret 做真裁决的面：错 secret → 10014），并把「机器人能力」拆成独立位 `bot-ability`（`GET /open-apis/bot/v3/info`：有 bot → code 0；无 bot → 11205）——bot 面本身不校验 secret（错 secret 同样回 11205），探它只能验能力不能验凭据
- **「长连接通过」不再被误读为可收发**：`ws-long-connection` 置 passed 时附提示「长连接已建立（不能据此推定机器人能力/消息权限已开通）」——无机器人能力时事件不投递、消息发不出，与长连接握手是两件事
- **可选密钥被算成「凭据缺失」**：`listPublic` 对 meta 里所有 `secret:true` 字段一律下发 `configured`，设置页据此把未入库的**可选**键（飞书 `dashScopeKey` 语音、微信 `botToken` 扫码自动写）标成红徽标「凭据缺失：…」，观感上等同连接被阻断。现 `secretFields` 随字段下发 `required`，客户端只对 `required!==false` 的缺失出红徽标

### Changed

- 诊断 hint 不再一律「凭据或网络无效」：网络类错误回「网络不可达：<message>」，其余回「凭据探测失败：<message>」（只取 error.message，不透传 axios config——那里带着 Authorization 与请求体）

## 0.4.8（宿主枚举补票：0.2.1-rc.3）

### Changed

- hosts.mjs 单源追加 `0.2.1-rc.3`（12→13 tag），sync-hosts 下发 package.json engines/6 个 dsh-* peers、dsh.plugin.json、README 双语管理块与 locale/plugin 描述同串。
- 补票依据：rc.2→rc.3 契约面零断裂（host-matrix 14 列配对探针复核 + source-analysis v0.2.1-rc.3 四件套）；本插件不触 `ctx.web` provider 钉选、模型标签槽与 `startSession` 系调用面。
## 0.4.7（/relay 别名解析）

### Added

- **通知账号可用别名绑定**：`/relay <账号>` 先按代理键 `accountId` 直查，缺位再按别名唯一匹配（`AccountPolicy.alias` 由 account-manager 在 registerAccount/updatePolicy 两处同步给引擎）；**别名歧义绝不猜账号**（与主动投递「歧义不猜」同纪），回执明确要用户改用账号 ID；`/relay` 无参未绑定时回可操作用法提示（钉钉无需目标 / QQ 用 `账号:openid`）

## 0.4.6（IM 简洁预设 + SVG 图表 + 富结构净化）

### Added

- **IM 简洁预设 `im-concise`（预设层屏蔽，架构正解）**：插件把内置 agent 预设幂等供给到 `$DSH_HOME/.agent-presets/im-concise/`（`managed-by` 所有权头；用户自管不覆盖），IM 会话默认使用（账号级 agentPreset 优先）。`persona.complete: true` 完整系统提示模式——genui（dsh-ui 围栏教学）与 dsh-raw-html-v2（裸 HTML 引导）追加的 prompt 段一律进不来，从源头压掉结构体输出；persona 是系统提示，不随轮次累积（prompt cache 可命中），比每回合前缀省 token
- **SVG 图表出图**：IM 会话输出 svg 围栏 → 出站提取 → sharp 渲染 PNG（宿主 profile 自带则用，缺位降级）→ 渠道图片消息发送（微信 iLink type:2 image_item）；失败不阻断正文
- **出站净化（兜底，零 prompt 成本）**：dsh-ui / html 围栏替换为省略提示；裸 svg 抽为图表；raw-html 卡片（vcp-root/style 等）剥结构留文字；其它代码围栏占位保护不误伤；SVG 上限 3 张

### Changed

- **每回合 IM 纪律前缀默认关闭**（imReplyDiscipline 默认 false）：每轮拼接会进对话历史累积浪费；仅预设不可用的老宿主需置 true

## 0.4.4（任务树过滤 + tab 随会话类型）

### Fixed

- **任务页不再出现「未分组 IM 会话」**：官方任务树吃 `props.useSessions`，改注入过滤版（ids 滤 `im:` 前缀 + byId 重建）
- **tab 随会话类型而非硬切**：打开 `im:` 会话留在/切到「频道」，打开普通任务切回「任务」

## 0.4.3（wrap 样式对齐参考 + 会话点击修复）

### Fixed

- **tab 样式去自造框**：任务/频道切换改为参考（dsh-im-connect `ima-tab`）同款——无框透明底、`gap:18px`、底部 1px 分隔线、选中态 `box-shadow:inset 0 -2px 0 currentColor` 下划线高亮；删除自造圆角边框按钮
- **频道内会话点击无效**：`openUnionSession` 旧实现直读 `ctx.uiWorkspace`（未 inject 服务属性访问被 Cordis 代理抛错并吞掉，且 alpha.2+ 宿主 `sessions.retain` 存在时 `sessions.open` 不写 mainView）；改 `probeService` 软读（reflect.get → ctx.get）+ 参考同款打开链：`props.openSession/open` 优先 → `uiWorkspace.openSession` → `retain` 存在禁回退 → `sessions.open`；打开成功后自动切回任务页（参考 followSidebarTab 同语义）

## 0.4.2（侧栏 wrap 真形态：任务/频道分离标签）

### Fixed

- **任务/频道分离标签（Phase 6 task_20 补正）**：0.4.1 仍在往宿主 `__dshNativeTabs` registry 插页签（宿主无该面时整块不显示）——按用户裁定重写为真 wrap：直接包裹 `sidebar.workspaces` 官方任务树组件，自建顶部「任务 / 频道」两页签（任务=渲染原官方组件，频道=本插件 rail），`slots.subscribe` + 250ms×40 重试环保同步；已包裹检测（`__imConnectWrapped`/`__dshNativeTabHost`/`__dshAutomationWrapped`）绝不插手；渲染失败 ErrorBoundary 回落官方树

## 0.4.1（渠道视图自持 + 标题投影 + 模型白名单 + relay 抄送）

### Added

- **模型白名单（Phase 7）**：插件级 `model-whitelist.json` 存储，`/models` 只列白名单内模型，`/model` 越界拒绝并列可用项；空数组=不限（现状兼容）；admin `GET/POST /model-whitelist` 管理面 + 设置面板 textarea 编辑
- **final 抄送 relay（Phase 8）**：会话级绑定到通知渠道账号（`relay-bindings.json`，持久化，多对一）；收轮后 `finalText` 自动推送到对应通知渠道（带 `[渠道/会话]` 前缀 + 同款收轮后缀）；`/relay <账号|->` 命令绑定/解绑/列表；admin `GET/POST /relay-bindings` 端点 + 设置面板通知账号行「绑定会话」UI；支持 `accountId:targetId` 形（qq-notify 等显式推送目标）
- **/sessions 标题投影**：两级提取 `projections.values.title` → `r.title`（参考 dsh-im-connect chat-commands.ts:17），行格式「N. 标题〔标注〕+ 次行完整 id」，无标题回退 chatId 段
- **渠道视图自持（Phase 6）**：不再插别人注册的切换标签，自持 wrap 形态包裹宿主官方会话树（检测 `__dshNativeTabHost`/`__imConnectWrapped` 即绝不插手、隔离优先）；rail 降级为设置面板「渠道」卡片可用

## 0.4.0（会话轮换 + 会话过滤 + 原生渠道侧栏 + 发送链路加固）

### Added

- **/new 真轮换**：会话 id 此前确定性派生（`im:union:<channel>:<kind>:<chatId>`，无纪元），/new 解绑后下一条消息重建同 id，宿主原样续旧会话——「/new 无效」根因。现轮换 id 追加 13 位毫秒纪元（同毫秒单调自增防撞，dsh-im-connect session-id 同款）；空闲守卫（运行中提示先 /stop）；先建新会话成功才换绑（失败保持旧绑定可用，D7 邻近纪律）；旧绑定转入历史（`/sessions` 标「已解绑」、`/session` 可再接续）
- **/sessions 过滤口径**：默认只列 `im:union:` 前缀的本插件会话（防未归档会话刷屏，用户裁定），每页 10 条 + ←当前/[运行中]/[已解绑] 标注；`/sessions all` 展开宿主全量同分页；序号选择走 15 分钟 TTL 缓存（≤256 条，chatKey 隔离，dsh-im-connect 同款量级）——所见即所绑
- **原生渠道侧栏（渠道视角）**：数据面 `GET /api/dsh-im-union/channels`（im:union: 会话按渠道分组，合并绑定/历史/最近出站态，行键白名单零 secret，扫描上限 500）；客户端 rail（渠道分组 + 搜索框 + 运行状态点 + 相对时间 + 点击打开会话），挂载降级链：原生 tab registry（宿主自带或 im-connect 壳）插 `im-union-channels` 页签 → 独立 `sidebar.channels` 槽 → 仅日志；`--dsw-alias-*` 令牌全带 fallback；9 语本地化

### Fixed

- **发送链路「受理≠送达」（desktop 实证：ret=0 受理但微信端不显示）**：getupdates 游标持久化（滚动即落盘、connect 恢复，dsh-im setGetUpdatesBuf 对齐）——重启不再空游标重放旧消息窗；sendmessage 应答落 info 日志（to/项数/ret，不落正文）；token/context 类确定性失败换最近入站 token 单次重发（被拒发送无重复投递，不违 D7），token 无更新不重发如实抛；账号行「最近发送」诊断位（lastSendOk/lastSendAt）

## 0.3.9（入站失聪根因 + 全链路排障可见性）

### Fixed

- **多轮对话后「无反应」且零日志（desktop 真机实证）**：投递账本显示插件侧四个回合全部 `delivered`（微信服务器受理），但 12:16 后入站零记录——微信 iLink 长轮询循环在会话过期（`-14`）等故障下**静默退出**，而连接器生命周期日志从未接线（工厂调用漏传 `logger`，缺省无操作函数），排障死角。现：连接器日志接通 plugin.log（info 级：连接建立/轮询退出/`-14` 过期/退避重试全部可见）；`-14` 会话过期在设置页账号行以红条提示「需重新扫码」；`TimeoutError` 死分支清理（超时已被归一为不确定错误走退避重试，永不退轮——回归测试锁定）
- **排障基线日志（plugin.log 可见）**：入站到达（渠道/类型/用户）、会话解析（请求 id → 宿主实际 id，UI 会话列表对号的关键证据）、回合完成摘要（turn/收轮原因/投递字数）三级 info 落盘——此后任何「没反应」都能在日志对上号

## 0.3.8（会话事件总线 + im: 前缀——频道分组与回传闭环）

### Fixed

- **回答不回传（desktop 真机实证）**：@Remote('follow') 是 stream 形态，直调结果不产出事件帧——回合事件零到达，全部走 10 分钟看门狗超时。新增会话事件面：宿主 cordis 总线 **session/event**（core/session Events 声明的全量 firehose，envelope {type,seq,time,data} 与引擎消费形一致）按 sessionId 扇出给每回合订阅者，总线优先、缺位自动回退 follow 旧路；启动日志标明当前事件面
- **wx 会话落在「任务/未分组」**：宿主侧栏按 sessionId 前缀分「频道」页（dsh-im-connect 源码锚点：「IM 与任务的区分靠 sessionId 的 im: 前缀」），旧 imu: 前缀永远进不了频道。隐式会话 id 改为 **im:union:<channel>:<kind>:<chatId>**（union 段防其它 IM 插件撞名）。旧绑定在内存、重启即换新前缀；旧 imu: 会话仍在盘上，可从任务列表手动删除

## 0.3.7（0.2.x 宿主 Remote 形态收敛——任务提交 roundtrip 闭环）

### Fixed

- **desktop 真机实证「任务提交失败：Cannot read properties of undefined (reading 'throwIfAborted')」**：0.2.x 线 `@Remote('prompt')` 签名是 `(request, signal)`（index.ts:346-349 进门即 `signal.throwIfAborted()`），旧调用只传 request 一参。现 prompt/steer/list 全部按新形态带 `AbortController().signal`，并补 `clientTimeZone`（类型面可选）；老线位置参形保留为回退
- **follow 双形态收敛**：0.2.x 线 `follow({address}, signal)` 返回 **AsyncIterable 帧流**（snapshot / event / assistant-stream 三种），旧线 `(sessionId, onEvent) → 退订函数`。运行时探测：返回异步迭代器即泵帧（只投 `event` 帧的 `.event`，snapshot 防重放、assistant-stream 为 Web 呈现专用均不投），否则以正确实参落旧形态；退订 = abort 泵

## 0.3.6（插件自有文件日志 + 检查连接不再 500）

### Added

- **`<stateDir>/plugin.log`**：desktop/Electron 宿主的日志管线无文件落点（AppData 只有 crash dump，~/.dsh/logs 只有 CLI 启动日志），管理面 500 的「请查看本机日志」无处可看。插件现在把 info/warn/error 分流追加到 plugin.log（512KB 滚动保留 .1），宿主管线照走；管理面 500 的真实错误随之落盘
- 「检查连接」在适配器构建失败（如凭据缺失工厂即抛）时不再抛 500「操作失败」——转诊断行 `{name:'connect', status:'failed', hint}`，面板直接看到原因

## 0.3.5（凭据读取面修复——botToken「缺失」真相收口）

### Fixed

- **凭据缺失（真机 desktop 实证三层叠加，token 其实一直在库里）**：
  ① `ServiceVault.resolve` 只解包 `{ secret }`，而宿主锚点（packages/credentials/credentials）的 resolve 回 **`ResolvedCredential { value, source }`**——值在宿主凭据库里、读取永远 miss。现按 `裸串 / { value } / { secret }` 三形解包，空串按缝规则视作未存储；
  ② 历史写入路径遗留**双前缀 ref**（真机 `.credentials.yaml` 里是 `IM_UNION_WEIXIN_WEIXIN_<id>_BOTTOKEN`，规范 ref 是单前缀）——读取增加旧别名兜底，命中即自愈写回规范 ref（归一失败不阻断本次应答）；
  ③ 0.3.3 迁移包装的顺序缺陷：`primary.set` 后**不回读就删旧文件副本**——主库读写形态不一致时会把唯一副本删成永久丢失。现改为回读校验通过才清理，回读失败保留旧副本并告警（set 路径同纪律）

## 0.3.4（会话后端惰性升级 + 权限预设/命令执行开关——账号设置补齐）

### Fixed

- desktop 装上 0.3.2/0.3.3 后仍报「当前宿主缺少 会话后端 接口」：真机证明会话子系统在 desktop 上是**晚于插件 apply 才提供**（不是已提供未激活——reflect 非严格读同样拿不到），任何 apply 期冻结探测都必然误判 none 且永不恢复
- session-api 重构为**惰性后端**：apply 未见子系统时起步 none 面，`backend` 每次访问（引擎每回合 / /session-catalog / /state 诊断都经此）重新软读；子系统一旦就绪立即升级原生面并**粘住不回退**（服务提供后不会消失），升级打一条 info 日志；`probeSessionBackend` 导出供诊断复用；agentPresets 改升级时点软读（不再依赖 caps 快照）

### Added

- **权限预设**（对齐 dsh-im-connect / webhook 宿主锚点 `permissionPresets`）：账号会话偏好新增「权限预设」——`/session-catalog` 回宿主 `permissionPresets` 目录（names+optionOf+defaultPreset）；新会话在 create 后 `permissionPresets.set(session, preset)` 落位（webhook 范式）；**改偏好即生效**：对该账号已回路会话逐个补应用（同值重存不重复）
- **命令执行开关**（im-connect 同款语义）：账号设置新增「私聊命令执行」「群聊命令执行」两档，关闭只拦 `/` 命令并回提示明说，普通对话不受影响；`/mute` 保留为静音期唯一逃生门
- 编辑弹窗设置面常显：后端未就绪时不再整块隐藏——准入/命令开关/工作区（插件本地语义）照常可编辑即时生效，模型/预设/权限等宿主目录类下拉禁用并提示自动升级

## 0.3.3（凭据迁移 + 会话偏好可见性）

### Fixed

- **0.3.2 回归**：desktop 上 credentials 服务接线修好后 vault 主存从文件切到宿主凭据库，旧文件库里已存的 secret（微信 botToken）被孤儿化 → 账号「凭据缺失」掉线。vault 增加迁移包装：主库 resolve 未命中时查历史文件库，命中即自动搬迁进主库再返回（带日志）；set/unset 双清旧文件副本防旧值复活；迁移失败不阻断（本次按旧值应答，下次再试）

### Changed

- 账号卡新增会话偏好摘要行（目录尾段 · 预设 · 模型@推理档），有值才显示——修「新设置藏在编辑弹窗里不可见」

## 0.3.2（desktop/Electron 宿主会话后端修复 + 软读接线全面审计）

### Fixed

- desktop/Electron 宿主报「当前宿主缺少 会话后端 接口，该能力已降级」且会话偏好全区不可选——两处宿主线差异叠加：
  ① desktop 上插件 apply 可能早于 agents/sessionController 提供方 fiber 激活，`ctx.get` 的 strict 语义（cordis lib/index.js:770，fiber.state!==2 即 undefined）把已在册的服务读丢 → `optionalService` 增加 `ctx.reflect.get(name, false)` 非严格反射兜底（cordis :756 免 inject 要求读取口）；
  ② 顶层 inject 只声明 webServer，未走 cordis 等待语义 → 对照 dsh-im-connect 同 peer range 同款先例，inject 增加 `agents`/`agentPresets`，宿主备好服务才跑 apply
- 同类软读接线全量审计后补齐（同一 strict 语义下的另外两处静默降级）：
  inject 再增 `credentials`（读丢 → 凭据静默降级明文文件 vault，安全质量损失）与 `llm`（读丢 → 图片输入视觉判定永远 unknown，图片一律走降级文案）——两者均为 dsh-im-connect 同 peer range inject 表成员（全支持线必有）且有实际消费点；`settings-compat.configFormsOf` 的裸 `ctx.get` 补同一 reflect 兜底（内联实现，避免与 services.ts 成 import 环）
- 接线判定口径（审计结论，注释同步进 inject 声明处）：核心必有服务（webServer/agents/agentPresets/credentials/llm）走 inject 等待语义；真可选面（sessionController/workspaceController/sessionPersistence/connection/configForms/fileUploads/workspaceFiles）保持软读 + reflect 兜底，缺位照旧诚实降级；无消费点的 permissionPresets/agentDefaultModel/tools 不接线

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
