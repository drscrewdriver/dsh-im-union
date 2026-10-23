/**
 * dsh-im-union 浏览器半（ModuleLoader 工厂，id 必须等于 npm 包名，否则整体静默失活）。
 *
 * 注册纪律：槽位注册必须发生在 client apply 期顶层——关在任何 inject 回调里
 * 是两代事故的根因。设置面代际差异在浏览器侧的体现：
 * - gen3（0.1.7+/0.2.x）：settings.section 槽位挂面板；
 * - gen2（0.1.2~0.1.6）：设置节由宿主半 installSection 出表单，client 只补状态卡；
 * - gen1（0.1.0/0.1.1）：无设置页 → 自带浮窗兜底（本文件 overlayFallback）。
 * 宿主未声明的槽位会抛 SlotOwnershipError 并让整块 UI 消失——所有 renderSlot
 * 一律 try/catch，失败只当该槽位没有内容。
 *
 * 面板设计（v2，借鉴 dsh-im 的渠道卡视觉与 dsh-im-connect 的账号手风琴）：
 * - 头部（品牌 + 副标语 + GitHub/刷新）→ 统计条 → 折叠诊断 → 渠道手风琴卡；
 * - 渠道卡 = 品牌色块 logo + 名称/标签 + 账号数 + 添加账号 + 展开箭头；
 * - 账号行 = 名称/内部键 + 状态徽章 + 检查/编辑/暂停/删除（两步确认）+ 白名单；
 * - 添加/编辑走同一弹窗：微信为扫码流（先建档后取码），其余渠道按 meta.fields
 *   出双列表单——secret 字段只写不读（留空=保持），plain 字段进 record.config
 *   （修复旧版全塞 secrets 导致明文字段被 upsert 丢弃的问题）。
 * - 样式单 <style data-plugin> 注入；颜色全部走 var(--dsw-alias-*, fallback)
 *   消费链，暗色/浅色零分支，主题切换由宿主令牌接管。
 */
window.__ModuleLoader__.load({
  id: 'dsh-im-union',
  factory: function (require) {
    // 插桩（真机诊断）：宿主装载链哪一段没走到这里，日志即缺席——与 apply 入口日志
    // 成对，可二分「bundle 加载但 factory 未调」vs「factory 调了但 apply 未调」。
    console.info('[dsh-im-union] client factory invoked')
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var ReactDOM = null;
    try { ReactDOM = require('react-dom'); } catch (noReactDOM) { ReactDOM = null; }
    if (ReactDOM === null && typeof window !== 'undefined') ReactDOM = window.ReactDOM || null;

    var API_BASE = '/api/dsh-im-union';
    var REPO_URL = 'https://github.com/drscrewdriver/dsh-im-union';
    var STATE_POLL_MS = 60000;
    var ACCOUNTS_POLL_MS = 15000;
    var STYLE_ID = 'dsh-im-union-settings';

    // ── 语言词典（zh 真理源；其余语言缺键回落 zh，运行时字典与
    // locale/*.json 元数据两处分层，此处只放 client 侧 UI 文案）─────────────
    var LOCALES = {
      zh: {
        'settings.title': 'IM 联合桥',
        'panel.subtitle': '把多个 IM 平台接入本机 Harness：多账号独立会话、主动投递、跨宿主版本兼容。',
        'panel.loading': '正在读取本机状态…',
        'panel.error': '无法连接管理接口，请重启 Host 后刷新。',
        'panel.refresh': '刷新',
        'panel.github': 'GitHub',
        'panel.debug': '运行时诊断',
        'panel.generation': '设置面代际',
        'panel.sessionBackend': '会话后端',
        'panel.vault': '凭据存储',
        'panel.uploads': '文件上传',
        'panel.deliverables': '产物回传',
        'panel.connector': 'AI Office Connector',
        'panel.on': '已启用',
        'panel.off': '未启用',
        'panel.channels': '渠道实现度',
        'panel.implemented': '已实现',
        'panel.planned': '规划中',
        'panel.stat.channels': '渠道',
        'panel.stat.accounts': '账号',
        'panel.stat.online': '在线',
        'channel.feishu': '飞书',
        'channel.weixin': '微信',
        'channel.telegram': 'Telegram',
        'channel.discord': 'Discord',
        'channel.wecom': '企业微信',
        'channel.dingtalk': '钉钉',
        'channel.qq': 'QQ',
        'channel.slack': 'Slack',
        'channel.whatsapp': 'WhatsApp',
        'channel.matrix': 'Matrix',
        'channel.imessage': 'iMessage',
        'channel.wecom-app': '企业微信（自建应用）',
        'channel.email': '邮箱（IMAP/SMTP）',
        'channel.dingtalk-notify': '钉钉通知（群机器人）',
        'channel.qq-notify': 'QQ 通知（主动推送）',
        'channel.tag.planned': '规划中',
        'channel.tag.notify': '仅通知',
        'channel.tag.macos': '仅 macOS',
        'channel.count': '{n} 个账号',
        'channel.emptyHint': '点击「添加账号」接入第一个机器人。',
        'accounts.title': '账号管理',
        'accounts.add': '添加账号',
        'accounts.edit': '编辑',
        'accounts.check': '检查连接',
        'accounts.checking': '检查中…',
        'accounts.pause': '暂停',
        'accounts.resume': '恢复',
        'accounts.remove': '删除',
        'accounts.remove.confirm': '确认删除',
        'accounts.state.connected': '已连接',
        'accounts.state.expired': '会话过期，需重新扫码',
        'accounts.state.disconnected': '未连接',
        'accounts.state.paused': '已暂停',
        'accounts.secret.missing': '凭据缺失：{keys}',
        'accounts.alias': '别名（可选）',
        'accounts.alias.placeholder': '给账号起个好认的名字',
        'accounts.allowlist': '私聊白名单',
        'accounts.allowlist.hint': '每行一个用户 ID；留空 = 拒绝所有私聊',
        'accounts.allowlist.save': '保存白名单',
        'accounts.prefs': '会话偏好',
        'accounts.saved': '已保存',
        'accounts.saved.bindhint': '已保存（未连接）：用「生成登录二维码」完成扫码授权后自动连接',
        'accounts.removed': '已删除',
        'accounts.qr.get': '生成登录二维码',
        'accounts.qr.refresh': '重新获取二维码',
        'accounts.qr.cancel': '取消扫码',
        'accounts.qr.needid': '请先填写账号 ID 再获取二维码',
        'accounts.qr.wait': '等待扫码…（用手机微信扫左侧二维码）',
        'accounts.qr.scaned': '已扫码，请在手机上确认授权',
        'accounts.qr.expired': '二维码已过期，请重新获取',
        'accounts.qr.need_verifycode': '请输入手机上显示的验证码',
        'accounts.qr.verify_code_blocked': '验证码错误次数过多，请重新获取二维码',
        'accounts.qr.binded_redirect': '该 Bot 已绑定其它实例',
        'accounts.qr.scaned_but_redirect': '已扫码，正在重定向等待确认',
        'accounts.qr.code.submit': '提交验证码',
        'accounts.qr.confirmed': '扫码绑定完成，凭据已保存并连接',
        'accounts.qr.desc': '二维码由腾讯微信 iLink 服务签发。扫码确认后凭据只写入本机 Host，浏览器不会收到 bot_token。',
        'modal.add.title': '添加{channel}账号',
        'modal.edit.title': '编辑账号',
        'modal.cancel': '取消',
        'modal.save': '保存',
        'modal.saving': '保存中…',
        'modal.required': '* 为必填',
        'modal.editSecretHint': '凭据留空表示保持现有值不变。',
        'modal.autoId': '账号 ID 由系统自动生成，无需填写；别名用于列表展示。',
        'modal.session.title': '会话偏好（新会话生效）',
        'modal.session.hint': '工作区/模型/预设/权限对新会话生效；权限预设同时即时应用到该账号已活跃会话；命令执行开关即时生效。',
        'modal.session.none': '会话后端未就绪（宿主就绪后自动升级，无需重启）；以下设置仍可编辑保存，命令执行/准入/工作区即时生效。',
        'access.title': '私聊准入',
        'access.approved': '仅已批准用户',
        'access.all': '所有私聊',
        'access.all.tag': '私聊全开',
        'access.hint': '「所有私聊」= 任何人都可私聊该机器人；白名单外的用户会收到未授权提示。',
        'prefs.workspace': '工作区目录（cwd）',
        'prefs.workspace.placeholder': '留空 = 宿主默认工作区',
        'prefs.preset': 'Agent 预设',
        'prefs.preset.default': '宿主默认',
        'prefs.model': '模型',
        'prefs.model.default': '宿主默认',
        'prefs.effort': '推理等级',
        'prefs.effort.default': '模型默认',
        'prefs.permission': '权限预设',
        'prefs.permission.default': '宿主默认',
        'exec.dm': '私聊命令执行',
        'exec.group': '群聊命令执行',
        'exec.on': '允许',
        'exec.off': '关闭',
        'catalog.loading': '目录读取中…',
        'check.title': '诊断结果',
        'check.passed': '通过',
        'check.failed': '失败',
        'check.unverified': '未验证',
      },
      en: {
        'settings.title': 'IM Union Bridge',
        'panel.subtitle': 'Connect IM platforms to your local Harness: multi-account sessions, proactive delivery, cross-version host support.',
        'panel.loading': 'Loading local state…',
        'panel.error': 'Management API unreachable. Restart the host and refresh.',
        'panel.refresh': 'Refresh',
        'panel.github': 'GitHub',
        'panel.debug': 'Runtime diagnostics',
        'panel.generation': 'Settings generation',
        'panel.sessionBackend': 'Session backend',
        'panel.vault': 'Credential vault',
        'panel.uploads': 'File uploads',
        'panel.deliverables': 'Deliverables',
        'panel.connector': 'AI Office Connector',
        'panel.on': 'enabled',
        'panel.off': 'disabled',
        'panel.channels': 'Channels',
        'panel.implemented': 'implemented',
        'panel.planned': 'planned',
        'panel.stat.channels': 'Channels',
        'panel.stat.accounts': 'Accounts',
        'panel.stat.online': 'Online',
        'channel.feishu': 'Feishu / Lark',
        'channel.weixin': 'WeChat (iLink)',
        'channel.telegram': 'Telegram',
        'channel.discord': 'Discord',
        'channel.wecom': 'WeCom',
        'channel.dingtalk': 'DingTalk',
        'channel.qq': 'QQ',
        'channel.slack': 'Slack',
        'channel.whatsapp': 'WhatsApp',
        'channel.matrix': 'Matrix',
        'channel.imessage': 'iMessage',
        'channel.wecom-app': 'WeCom (self-built app)',
        'channel.email': 'Email (IMAP/SMTP)',
        'channel.dingtalk-notify': 'DingTalk notify (webhook)',
        'channel.qq-notify': 'QQ notify (push)',
        'channel.tag.planned': 'planned',
        'channel.tag.notify': 'notify only',
        'channel.tag.macos': 'macOS only',
        'channel.count': '{n} accounts',
        'channel.emptyHint': 'Click "Add account" to connect your first bot.',
        'accounts.title': 'Accounts',
        'accounts.add': 'Add account',
        'accounts.edit': 'Edit',
        'accounts.check': 'Check connection',
        'accounts.checking': 'Checking…',
        'accounts.pause': 'Pause',
        'accounts.resume': 'Resume',
        'accounts.remove': 'Remove',
        'accounts.remove.confirm': 'Confirm remove',
        'accounts.state.connected': 'Connected',
        'accounts.state.expired': 'Session expired — re-scan QR',
        'accounts.state.disconnected': 'Disconnected',
        'accounts.state.paused': 'Paused',
        'accounts.secret.missing': 'Credential missing: {keys}',
        'accounts.alias': 'Alias (optional)',
        'accounts.alias.placeholder': 'A recognizable name for this account',
        'accounts.allowlist': 'DM allowlist',
        'accounts.allowlist.hint': 'One user ID per line; empty = reject all DMs',
        'accounts.allowlist.save': 'Save allowlist',
        'accounts.prefs': 'Session prefs',
        'accounts.saved': 'Saved',
        'accounts.saved.bindhint': 'Saved (disconnected): use "Get login QR code" to bind, it connects automatically',
        'accounts.removed': 'Removed',
        'accounts.qr.get': 'Get login QR code',
        'accounts.qr.refresh': 'Refresh QR code',
        'accounts.qr.cancel': 'Cancel',
        'accounts.qr.needid': 'Fill the account ID first, then get the QR code',
        'accounts.qr.wait': 'Waiting for scan… (scan with WeChat)',
        'accounts.qr.scaned': 'Scanned — confirm on your phone',
        'accounts.qr.expired': 'QR expired, fetch a new one',
        'accounts.qr.need_verifycode': 'Enter the code shown on your phone',
        'accounts.qr.verify_code_blocked': 'Too many wrong codes, fetch a new QR',
        'accounts.qr.binded_redirect': 'This bot is already bound to another instance',
        'accounts.qr.scaned_but_redirect': 'Scanned — redirecting, waiting for confirm',
        'accounts.qr.code.submit': 'Submit code',
        'accounts.qr.confirmed': 'QR binding done — credentials saved and connected',
        'accounts.qr.desc': 'The QR code is signed by Tencent WeChat iLink. After scanning, credentials go straight into the local Host; the browser never sees the bot token.',
        'modal.add.title': 'Add {channel} account',
        'modal.edit.title': 'Edit account',
        'modal.cancel': 'Cancel',
        'modal.save': 'Save',
        'modal.saving': 'Saving…',
        'modal.required': '* required',
        'modal.editSecretHint': 'Leave credentials blank to keep the current values.',
        'modal.autoId': 'The account ID is generated automatically; the alias is for display only.',
        'modal.session.title': 'Session preferences (new sessions only)',
        'modal.session.hint': 'Workspace/model/preset/permission apply to sessions this account creates later; the permission preset also applies to this account\'s live sessions right away; command switches take effect immediately.',
        'modal.session.none': 'Session backend not ready yet (auto-upgrades once the host provides it — no restart needed); the settings below stay editable, and command switches / DM access / workspace apply immediately.',
        'access.title': 'DM access',
        'access.approved': 'Approved users only',
        'access.all': 'Everyone',
        'access.all.tag': 'open DM',
        'access.hint': '"Everyone" lets anybody DM this bot; rejected users get a notice with their user ID.',
        'prefs.workspace': 'Workspace directory (cwd)',
        'prefs.workspace.placeholder': 'Empty = host default workspace',
        'prefs.preset': 'Agent preset',
        'prefs.preset.default': 'Host default',
        'prefs.model': 'Model',
        'prefs.model.default': 'Host default',
        'prefs.effort': 'Reasoning effort',
        'prefs.effort.default': 'Model default',
        'prefs.permission': 'Permission preset',
        'prefs.permission.default': 'Host default',
        'exec.dm': 'DM commands',
        'exec.group': 'Group commands',
        'exec.on': 'Allow',
        'exec.off': 'Block',
        'catalog.loading': 'Loading catalog…',
        'check.title': 'Diagnostics',
        'check.passed': 'passed',
        'check.failed': 'failed',
        'check.unverified': 'unverified',
      },
      ja: { 'settings.title': 'IM Union', 'accounts.title': 'アカウント', 'accounts.add': '追加', 'accounts.edit': '編集', 'accounts.save': '保存', 'modal.cancel': 'キャンセル', 'accounts.check': '接続確認', 'accounts.pause': '一時停止', 'accounts.resume': '再開', 'accounts.remove': '削除', 'accounts.state.connected': '接続済', 'accounts.state.expired': 'セッション失効・再スキャン', 'accounts.state.disconnected': '未接続', 'accounts.state.paused': '停止中', 'check.passed': '成功', 'check.failed': '失敗', 'check.unverified': '未検証', 'prefs.permission': '権限プリセット', 'prefs.permission.default': 'ホスト既定', 'exec.dm': 'DMコマンド実行', 'exec.group': 'グループコマンド実行', 'exec.on': '許可', 'exec.off': '遮断' },
      ko: { 'settings.title': 'IM Union', 'accounts.title': '계정', 'accounts.add': '추가', 'accounts.edit': '편집', 'accounts.save': '저장', 'modal.cancel': '취소', 'accounts.check': '연결 확인', 'accounts.pause': '일시정지', 'accounts.resume': '재개', 'accounts.remove': '삭제', 'accounts.state.connected': '연결됨', 'accounts.state.expired': '세션 만료(재스캔 필요)', 'accounts.state.disconnected': '미연결', 'accounts.state.paused': '정지됨', 'check.passed': '통과', 'check.failed': '실패', 'check.unverified': '미검증', 'prefs.permission': '권한 프리셋', 'prefs.permission.default': '호스트 기본', 'exec.dm': 'DM 명령 실행', 'exec.group': '그룹 명령 실행', 'exec.on': '허용', 'exec.off': '차단' },
      fr: { 'settings.title': 'IM Union', 'accounts.title': 'Comptes', 'accounts.add': 'Ajouter', 'accounts.edit': 'Modifier', 'accounts.save': 'Enregistrer', 'modal.cancel': 'Annuler', 'accounts.check': 'Vérifier', 'accounts.pause': 'Suspendre', 'accounts.resume': 'Reprendre', 'accounts.remove': 'Supprimer', 'accounts.state.connected': 'Connecté', 'accounts.state.expired': 'Session expirée — rescanner', 'accounts.state.disconnected': 'Déconnecté', 'accounts.state.paused': 'Suspendu', 'check.passed': 'réussi', 'check.failed': 'échoué', 'check.unverified': 'non vérifié', 'prefs.permission': 'Préréglage de permission', 'prefs.permission.default': 'Défaut hôte', 'exec.dm': 'Commandes en MP', 'exec.group': 'Commandes en groupe', 'exec.on': 'Autoriser', 'exec.off': 'Bloquer' },
      de: { 'settings.title': 'IM Union', 'accounts.title': 'Konten', 'accounts.add': 'Hinzufügen', 'accounts.edit': 'Bearbeiten', 'accounts.save': 'Speichern', 'modal.cancel': 'Abbrechen', 'accounts.check': 'Verbindung prüfen', 'accounts.pause': 'Pausieren', 'accounts.resume': 'Fortsetzen', 'accounts.remove': 'Entfernen', 'accounts.state.connected': 'Verbunden', 'accounts.state.expired': 'Sitzung abgelaufen — neu scannen', 'accounts.state.disconnected': 'Getrennt', 'accounts.state.paused': 'Pausiert', 'check.passed': 'ok', 'check.failed': 'fehlgeschlagen', 'check.unverified': 'ungeprüft', 'prefs.permission': 'Berechtigungsprofil', 'prefs.permission.default': 'Host-Standard', 'exec.dm': 'DM-Befehle', 'exec.group': 'Gruppenbefehle', 'exec.on': 'Erlauben', 'exec.off': 'Blockieren' },
      it: { 'settings.title': 'IM Union', 'accounts.title': 'Account', 'accounts.add': 'Aggiungi', 'accounts.edit': 'Modifica', 'accounts.save': 'Salva', 'modal.cancel': 'Annulla', 'accounts.check': 'Controlla', 'accounts.pause': 'Pausa', 'accounts.resume': 'Riprendi', 'accounts.remove': 'Rimuovi', 'accounts.state.connected': 'Connesso', 'accounts.state.expired': 'Sessione scaduta — riscansionare', 'accounts.state.disconnected': 'Disconnesso', 'accounts.state.paused': 'In pausa', 'check.passed': 'ok', 'check.failed': 'fallito', 'check.unverified': 'non verificato', 'prefs.permission': 'Preset permessi', 'prefs.permission.default': 'Predefinito host', 'exec.dm': 'Comandi in DM', 'exec.group': 'Comandi in gruppo', 'exec.on': 'Consenti', 'exec.off': 'Blocca' },
      ru: { 'settings.title': 'IM Union', 'accounts.title': 'Аккаунты', 'accounts.add': 'Добавить', 'accounts.edit': 'Изменить', 'accounts.save': 'Сохранить', 'modal.cancel': 'Отмена', 'accounts.check': 'Проверить', 'accounts.pause': 'Пауза', 'accounts.resume': 'Возобновить', 'accounts.remove': 'Удалить', 'accounts.state.connected': 'Подключено', 'accounts.state.expired': 'Сессия истекла — пересканируйте', 'accounts.state.disconnected': 'Отключено', 'accounts.state.paused': 'Пауза', 'check.passed': 'успех', 'check.failed': 'ошибка', 'check.unverified': 'не проверено', 'prefs.permission': 'Пресет разрешений', 'prefs.permission.default': 'По умолчанию хоста', 'exec.dm': 'Команды в ЛС', 'exec.group': 'Команды в группе', 'exec.on': 'Разрешить', 'exec.off': 'Запретить' },
      es: { 'settings.title': 'IM Union', 'accounts.title': 'Cuentas', 'accounts.add': 'Añadir', 'accounts.edit': 'Editar', 'accounts.save': 'Guardar', 'modal.cancel': 'Cancelar', 'accounts.check': 'Comprobar', 'accounts.pause': 'Pausar', 'accounts.resume': 'Reanudar', 'accounts.remove': 'Eliminar', 'accounts.state.connected': 'Conectado', 'accounts.state.expired': 'Sesión caducada — reescanear', 'accounts.state.disconnected': 'Desconectado', 'accounts.state.paused': 'Pausado', 'check.passed': 'correcto', 'check.failed': 'fallido', 'check.unverified': 'sin verificar', 'prefs.permission': 'Preajuste de permisos', 'prefs.permission.default': 'Predeterminado del host', 'exec.dm': 'Comandos por DM', 'exec.group': 'Comandos en grupo', 'exec.on': 'Permitir', 'exec.off': 'Bloquear' },
    };

    // UI 语言：**取词时懒解析**，不在 factory 顶层冻结。真机实证：宿主初始 HTML
    // 是 <html lang="en">，i18n 启动后才改写为真实语言（如 zh-CN）——顶层冻结会
    // 把中文环境锁死在英文面。每处取词现场读 <html lang>；未知/缺空前缀保守归
    // zh（缺键再逐条回落 zh 词典）。
    var LANG_PREFIXES = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'it', 'ru', 'es'];
    function currentLang() {
      try {
        var docLang = String((typeof document !== 'undefined' && document.documentElement.lang) || '').toLowerCase();
        for (var i = 0; i < LANG_PREFIXES.length; i += 1) {
          if (docLang.indexOf(LANG_PREFIXES[i]) === 0) return LANG_PREFIXES[i];
        }
      } catch (noDoc) { /* SSR/老宿主 */ }
      return 'zh';
    }
    // 宿主词典层（apply 时捕获）：宿主若提供逐键翻译则优先，miss 回本地词典。
    var hostDictionary = null;
    function t(key) {
      if (hostDictionary !== null && hostDictionary[key] !== undefined) return String(hostDictionary[key]);
      var dict = LOCALES[currentLang()] || LOCALES.zh;
      return (dict[key] !== undefined ? dict[key] : LOCALES.zh[key]) || key;
    }
    function pickBilingual(obj) {
      if (obj === null || obj === undefined) return '';
      if (typeof obj !== 'object') return String(obj);
      if (currentLang() === 'zh') return obj.zh || obj.en || '';
      return obj.en || obj.zh || '';
    }
    function channelName(channel) {
      var key = 'channel.' + channel.id;
      if (hostDictionary !== null && hostDictionary[key] !== undefined) return String(hostDictionary[key]);
      var dict = LOCALES[currentLang()] || LOCALES.zh;
      if (dict[key] !== undefined) return dict[key];
      if (LOCALES.zh[key] !== undefined) return LOCALES.zh[key];
      return pickBilingual(channel.label) || channel.id;
    }
    function format(key, params) {
      var text = t(key);
      for (var name in params) {
        if (Object.prototype.hasOwnProperty.call(params, name)) {
          text = text.split('{' + name + '}').join(String(params[name]));
        }
      }
      return text;
    }

    // ── 管理面 HTTP（写请求带客户端标识头；回包零凭据由宿主半保证）──────────
    function getJSON(path) {
      return fetch(API_BASE + path, {
        credentials: 'same-origin',
        headers: { 'x-dsh-im-union-client': '1' },
      }).then(function (response) {
        return response.json().then(function (json) {
          return { status: response.status, json: json };
        });
      });
    }

    function postJSON(path, body) {
      return fetch(API_BASE + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-dsh-im-union-client': '1' },
        body: JSON.stringify(body || {}),
      }).then(function (response) {
        return response.json().then(function (json) {
          return { status: response.status, json: json };
        });
      });
    }

    function errorText(result) {
      return (result.json && result.json.error) || 'HTTP ' + result.status;
    }
    function messageText(error) {
      return String(error && error.message ? error.message : error);
    }
    function genAccountId(channelId) {
      return channelId + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    // ── 样式：单 <style data-plugin> 注入；颜色全部 var(--dsw-alias-*, fallback)
    // 消费链（本地 --diu 别名），暗色/浅色零分支——主题切换交给宿主令牌。──────
    var DIU_CSS = String.raw`
.diu-page, .diu-modal, .diu-modalRoot {
  --diu-text: var(--dsw-alias-label-primary, #e8eaed);
  --diu-muted: var(--dsw-alias-label-tertiary, #9aa0a6);
  --diu-faint: var(--dsw-alias-label-caption, #81858c);
  --diu-line: var(--dsw-alias-border-l2, rgba(127,127,127,.24));
  --diu-line-strong: var(--dsw-alias-border-l3, rgba(127,127,127,.34));
  --diu-card: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06));
  --diu-sunken: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.09));
  --diu-hover: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1));
  --diu-accent: var(--dsw-alias-state-business-primary, #4b7cff);
  --diu-ok: var(--dsw-alias-state-success-primary, #22c55e);
  --diu-warn: var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-warning-primary, #d97706));
  --diu-bad: var(--dsw-alias-state-error-primary, #d54941);
  --diu-shadow: var(--dsw-shadow-lv3, 0 0 1px rgba(0,0,0,.2), 0 12px 32px rgba(0,0,0,.18));
  --diu-mono: ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace;
}
.diu-page { box-sizing: border-box; width: 100%; max-width: 980px; margin: 0 auto; padding: 4px 0 40px; color: var(--diu-text); font-size: 14px; container-type: inline-size; }
.diu-page *, .diu-modalRoot * { box-sizing: border-box; }
.diu-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.diu-title { margin: 0; font-size: 22px; line-height: 30px; font-weight: 650; letter-spacing: -.3px; }
.diu-sub { margin: 6px 0 0; color: var(--diu-muted); font-size: 13px; line-height: 20px; }
.diu-headActions { display: flex; gap: 8px; flex: none; padding-top: 2px; }
.diu-iconBtn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 30px; padding: 0 10px; border: 1px solid var(--diu-line); border-radius: 8px; background: transparent; color: var(--diu-muted); font-size: 12px; font-family: inherit; cursor: pointer; transition: background .15s ease, color .15s ease, border-color .15s ease; }
.diu-iconBtn:hover { background: var(--diu-hover); color: var(--diu-text); }
.diu-iconBtn:focus-visible, .diu-btn:focus-visible, .diu-addBtn:focus-visible, .diu-platformHead:focus-visible { outline: 2px solid var(--diu-accent); outline-offset: 2px; }
.diu-stats { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.diu-stat { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; background: color-mix(in srgb, var(--diu-text) 7%, transparent); color: var(--diu-muted); font-size: 12px; line-height: 20px; }
.diu-stat strong { color: var(--diu-text); font-weight: 650; }
.diu-banner { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; padding: 9px 12px; border-radius: 10px; border: 1px solid transparent; font-size: 13px; line-height: 19px; }
.diu-banner-err { color: var(--diu-bad); border-color: color-mix(in srgb, var(--diu-bad) 38%, transparent); background: color-mix(in srgb, var(--diu-bad) 10%, transparent); }
.diu-banner-ok { color: var(--diu-ok); border-color: color-mix(in srgb, var(--diu-ok) 35%, transparent); background: color-mix(in srgb, var(--diu-ok) 9%, transparent); }
.diu-banner-info { color: var(--diu-accent); border-color: color-mix(in srgb, var(--diu-accent) 35%, transparent); background: color-mix(in srgb, var(--diu-accent) 9%, transparent); }
.diu-bannerClose { margin-left: auto; flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 0; border-radius: 6px; background: transparent; color: inherit; opacity: .7; cursor: pointer; }
.diu-bannerClose:hover { opacity: 1; background: color-mix(in srgb, currentColor 12%, transparent); }
.diu-debug { margin-top: 14px; font-size: 12px; color: var(--diu-muted); }
.diu-debug summary { cursor: pointer; user-select: none; list-style-position: inside; }
.diu-debug summary:hover { color: var(--diu-text); }
.diu-debugBody { margin-top: 8px; padding: 10px 12px; border: 1px solid var(--diu-line); border-radius: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 18px; }
.diu-debugItem { display: flex; justify-content: space-between; gap: 10px; min-width: 0; }
.diu-debugItem dt { color: var(--diu-faint); }
.diu-debugItem dd { margin: 0; color: var(--diu-text); text-align: right; overflow-wrap: anywhere; }
.diu-debugChannels { grid-column: 1 / -1; margin-top: 4px; padding-top: 8px; border-top: 1px solid var(--diu-line); display: flex; flex-wrap: wrap; gap: 6px; }
.diu-platforms { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }
.diu-platform { border: 1px solid var(--diu-line); border-radius: 12px; background: var(--diu-card); overflow: hidden; transition: border-color .15s ease; }
.diu-platform.open { border-color: var(--diu-line-strong); }
.diu-platform.isPlanned { opacity: .62; }
.diu-platformHead { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto auto; align-items: center; gap: 10px; width: 100%; min-height: 56px; padding: 8px 14px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.diu-platform:not(.open):not(.isPlanned) .diu-platformHead:hover { background: var(--diu-hover); }
.diu-platformCopy { display: flex; align-items: center; gap: 8px; min-width: 0; }
.diu-platformName { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.diu-count { color: var(--diu-faint); font-size: 12px; white-space: nowrap; }
.diu-addBtn { display: inline-flex; align-items: center; gap: 4px; min-height: 28px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--diu-line); background: transparent; color: var(--diu-text); font-size: 12px; font-family: inherit; cursor: pointer; transition: border-color .15s ease, color .15s ease, background .15s ease; }
.diu-addBtn:hover { border-color: color-mix(in srgb, var(--diu-accent) 55%, var(--diu-line)); color: var(--diu-accent); background: color-mix(in srgb, var(--diu-accent) 8%, transparent); }
.diu-addBtn:disabled { opacity: .45; cursor: not-allowed; }
.diu-caret { display: inline-flex; color: var(--diu-faint); transition: transform .16s ease; }
.diu-platform.open .diu-caret { transform: rotate(90deg); }
.diu-logo { display: grid; place-items: center; border-radius: 9px; flex: none; width: 30px; height: 30px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
.diu-logo svg { display: block; }
.diu-accountList { display: flex; flex-direction: column; gap: 8px; padding: 2px 12px 12px; }
.diu-accountEmpty { padding: 6px 2px 4px; color: var(--diu-faint); font-size: 12px; }
.diu-account { border: 1px solid var(--diu-line); border-radius: 10px; padding: 10px 12px; background: color-mix(in srgb, var(--diu-text) 3%, transparent); }
.diu-accountMain { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.diu-accountName { font-weight: 600; font-size: 13px; }
.diu-accountId { color: var(--diu-faint); font-size: 12px; font-family: var(--diu-mono); }
.diu-badges { display: flex; gap: 6px; flex-wrap: wrap; }
.diu-tag { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 999px; border: 1px solid transparent; font-size: 11px; line-height: 18px; white-space: nowrap; }
.diu-tag-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.diu-tagOk { color: var(--diu-ok); border-color: color-mix(in srgb, var(--diu-ok) 35%, transparent); background: color-mix(in srgb, var(--diu-ok) 9%, transparent); }
.diu-tagWarn { color: var(--diu-warn); border-color: color-mix(in srgb, var(--diu-warn) 35%, transparent); background: color-mix(in srgb, var(--diu-warn) 9%, transparent); }
.diu-tagBad { color: var(--diu-bad); border-color: color-mix(in srgb, var(--diu-bad) 35%, transparent); background: color-mix(in srgb, var(--diu-bad) 9%, transparent); }
.diu-tagInfo { color: var(--diu-accent); border-color: color-mix(in srgb, var(--diu-accent) 35%, transparent); background: color-mix(in srgb, var(--diu-accent) 9%, transparent); }
.diu-tagMuted { color: var(--diu-muted); border-color: var(--diu-line); background: transparent; }
.diu-accountActions { display: flex; gap: 6px; margin-left: auto; flex-wrap: wrap; }
.diu-btn { display: inline-flex; align-items: center; gap: 5px; min-height: 28px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--diu-line); background: transparent; color: var(--diu-text); font-size: 12px; font-family: inherit; cursor: pointer; transition: background .15s ease, border-color .15s ease, color .15s ease; }
.diu-btn:hover { background: var(--diu-hover); }
.diu-btn:disabled { opacity: .5; cursor: not-allowed; }
.diu-btnDanger { color: var(--diu-bad); }
.diu-btnDanger:hover { background: color-mix(in srgb, var(--diu-bad) 10%, transparent); border-color: color-mix(in srgb, var(--diu-bad) 40%, var(--diu-line)); }
.diu-btnPrimary { border-color: transparent; background: var(--diu-accent); color: #fff; }
.diu-btnPrimary:hover { background: color-mix(in srgb, var(--diu-accent) 88%, #fff); }
.diu-checkList { margin: 8px 0 0; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, var(--diu-text) 4%, transparent); font-size: 12px; display: flex; flex-direction: column; gap: 4px; }
.diu-accountPrefs { margin-top: 6px; font-size: 12px; color: var(--diu-muted); line-height: 18px; min-width: 0; overflow-wrap: anywhere; }
.diu-accountPrefsLabel { color: var(--diu-faint); margin-right: 6px; }
.diu-checkItem { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
.diu-checkName { color: var(--diu-text); font-weight: 550; }
.diu-checkHint { color: var(--diu-faint); }
.diu-allow { margin-top: 8px; }
.diu-allow > summary { cursor: pointer; user-select: none; font-size: 12px; color: var(--diu-muted); list-style-position: inside; }
.diu-allow > summary:hover { color: var(--diu-text); }
.diu-allowBody { margin-top: 6px; display: flex; flex-direction: column; gap: 6px; }
.diu-hint { font-size: 12px; color: var(--diu-faint); line-height: 18px; }
.diu-textarea { width: 100%; min-height: 56px; padding: 7px 9px; border-radius: 8px; border: 1px solid var(--diu-line); background: var(--diu-sunken); color: inherit; font: 12px/18px var(--diu-mono); resize: vertical; }
.diu-textarea:focus, .diu-input:focus { outline: none; border-color: color-mix(in srgb, var(--diu-accent) 55%, var(--diu-line)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--diu-accent) 16%, transparent); }
.diu-modalRoot { position: fixed; inset: 0; z-index: 5000; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0,0,0,.45); }
.diu-modal { width: 580px; max-width: 100%; max-height: min(86vh, 780px); display: flex; flex-direction: column; border-radius: 14px; border: 1px solid var(--diu-line-strong); background: var(--dsw-alias-bg-layer-1, #232324); box-shadow: var(--diu-shadow); color: var(--diu-text); }
.diu-modalHead { display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px; }
.diu-modalTitle { margin: 0; font-size: 16px; font-weight: 650; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diu-closeBtn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 0; border-radius: 8px; background: transparent; color: var(--diu-muted); cursor: pointer; }
.diu-closeBtn:hover { background: var(--diu-hover); color: var(--diu-text); }
.diu-modalBody { padding: 2px 16px 8px; overflow: auto; }
.diu-qrBox { display: flex; gap: 14px; align-items: flex-start; padding: 12px; border: 1px solid var(--diu-line); border-radius: 10px; background: color-mix(in srgb, var(--diu-text) 3%, transparent); margin-bottom: 14px; }
.diu-qrImg { width: 168px; height: 168px; flex: none; border-radius: 10px; background: #fff; padding: 8px; border: 1px solid var(--diu-line); }
.diu-qrMeta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.diu-qrTitle { font-weight: 600; font-size: 13px; }
.diu-qrStatus { font-size: 12px; color: var(--diu-muted); line-height: 18px; }
.diu-qrActions { display: flex; gap: 6px; flex-wrap: wrap; }
.diu-verifyRow { display: flex; gap: 6px; align-items: center; }
.diu-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; }
.diu-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.diu-fieldWide { grid-column: 1 / -1; }
.diu-label { display: flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 550; color: var(--diu-muted); }
.diu-req { color: var(--diu-bad); }
.diu-helpLink { margin-left: auto; font-size: 11px; font-weight: 400; color: var(--diu-accent); text-decoration: none; }
.diu-helpLink:hover { text-decoration: underline; }
.diu-input { height: 34px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--diu-line); background: var(--diu-sunken); color: inherit; font-size: 13px; font-family: inherit; min-width: 0; width: 100%; }
.diu-input::placeholder, .diu-textarea::placeholder { color: var(--diu-faint); }
.diu-modalNote { margin: 10px 0 0; font-size: 12px; color: var(--diu-faint); line-height: 18px; }
.diu-sessionBlock { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--diu-line); }
.diu-sessionTitle { font-weight: 600; font-size: 13px; margin-bottom: 10px; }
select.diu-input { appearance: auto; }
.diu-modalFoot { display: flex; align-items: center; gap: 8px; padding: 12px 16px 14px; border-top: 1px solid var(--diu-line); margin-top: 8px; }
.diu-footMsg { flex: 1; min-width: 0; font-size: 12px; color: var(--diu-bad); line-height: 18px; overflow-wrap: anywhere; }
.diu-footSpacer { flex: 1; }
.diu-overlayFallback { position: fixed; right: 16px; bottom: 16px; z-index: 9999; width: 380px; max-height: 62vh; overflow: auto; border: 1px solid var(--diu-line); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #232324); box-shadow: var(--diu-shadow); padding: 12px; }
@container (max-width: 640px) {
  .diu-fields { grid-template-columns: 1fr; }
  .diu-platformHead { grid-template-columns: auto minmax(0, 1fr) auto; }
  .diu-platformHead .diu-count, .diu-platformHead .diu-caret { display: none; }
  .diu-debugBody { grid-template-columns: 1fr; }
  .diu-qrBox { flex-direction: column; }
}
@media (prefers-reduced-motion: reduce) {
  .diu-caret, .diu-btn, .diu-addBtn, .diu-iconBtn { transition: none; }
}
`;
    var styleInstalled = false;
    function installStyles() {
      if (styleInstalled || typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')) { styleInstalled = true; return; }
      var style = document.createElement('style');
      style.dataset.plugin = 'dsh-im-union';
      style.dataset.pluginCss = STYLE_ID;
      style.textContent = DIU_CSS;
      document.head.appendChild(style);
      styleInstalled = true;
    }

    // ── 品牌图标：净室简化图形（色块 chip + 单色/多色 glyph），非官方素材─────
    var CHIP_STYLES = {
      weixin: { background: '#07C160' },
      feishu: { background: '#ffffff', bordered: true },
      dingtalk: { background: '#1296DB' },
      wecom: { background: '#ffffff', bordered: true },
      telegram: { background: '#229ED9' },
      qq: { background: '#12B7F5' },
      slack: { background: '#ffffff', bordered: true },
      discord: { background: '#5865F2' },
      whatsapp: { background: '#25D366' },
      matrix: { background: '#0F1115' },
      imessage: { background: 'linear-gradient(180deg,#5BF675 0%,#28D944 55%,#0FBD2C 100%)' },
      'wecom-app': { background: '#2B6DEB' },
      email: { background: '#5B7CFA' },
      'dingtalk-notify': { background: '#1296DB' },
      'qq-notify': { background: '#12B7F5' },
    };

    var GLYPHS = {
      weixin: function () {
        return [
          h('path', { fill: '#fff', fillRule: 'evenodd', d: 'M10.4 3.2c-4.7 0-8.4 3-8.4 6.8 0 2.1 1.1 3.9 2.9 5.2l-.8 3.4 3.5-1.9c.9.3 1.8.4 2.8.4h.5a6.7 6.7 0 0 1-.3-2c0-3.7 3.4-6.7 7.7-6.7h.4c-.8-3-4.2-5.2-8.3-5.2zM7.7 8.2a1.05 1.05 0 1 1 0 2.1 1.05 1.05 0 0 1 0-2.1zm5.4 0a1.05 1.05 0 1 1 0 2.1 1.05 1.05 0 0 1 0-2.1z' }),
          h('path', { fill: '#fff', fillRule: 'evenodd', d: 'M22 15.4c0-3-3-5.4-6.6-5.4s-6.6 2.4-6.6 5.4 3 5.4 6.6 5.4c.8 0 1.5-.1 2.2-.3l2.8 1.5-.7-2.6c1.4-1 2.3-2.4 2.3-4zm-8.9-1.4a.95.95 0 1 1 0 1.9.95.95 0 0 1 0-1.9zm4.6 0a.95.95 0 1 1 0 1.9.95.95 0 0 1 0-1.9z' }),
        ];
      },
      feishu: function () {
        return [
          h('path', { fill: '#00D6B9', d: 'M13.9 3.6 4.2 12.4c-.5.4-.2 1.2.4 1.2l6.1.2 4.9-8.7c.3-.5-.1-1.1-.6-1.1h-.5c-.2 0-.4.1-.6.2z' }),
          h('path', { fill: '#3370FF', d: 'M10.1 20.4l9.7-8.8c.5-.4.2-1.2-.4-1.2l-6.1-.2-4.9 8.7c-.3.5.1 1.1.6 1.1h.5c.2 0 .4-.1.6-.2z' }),
          h('circle', { cx: '16.6', cy: '16.4', r: '2.5', fill: '#00D6B9' }),
        ];
      },
      dingtalk: function () {
        return [
          h('path', { fill: '#fff', d: 'M20.8 4.3 3.6 11c-.7.3-.6 1.3.1 1.5l4.4 1.1 1.6 5c.2.6 1 .8 1.4.3l2.2-2.7 4.3 2.5c.5.3 1.1 0 1.3-.5l3-13c.1-.7-.5-1.2-1.1-.9z' }),
        ];
      },
      wecom: function () {
        return [
          h('circle', { cx: '12', cy: '5.8', r: '2.6', fill: '#FB5252' }),
          h('circle', { cx: '18.2', cy: '12', r: '2.6', fill: '#FFB43A' }),
          h('circle', { cx: '12', cy: '18.2', r: '2.6', fill: '#34C759' }),
          h('circle', { cx: '5.8', cy: '12', r: '2.6', fill: '#2B7FFF' }),
        ];
      },
      telegram: function () {
        return [
          h('path', { fill: '#fff', d: 'M20.7 4.2 3.5 10.9c-.8.3-.8 1.4 0 1.7l4.3 1.4 1.6 5c.2.7 1.1.9 1.6.3l2.2-2.5 4.2 2.4c.5.3 1.2 0 1.3-.6l2.8-13.2c.2-.8-.6-1.5-1.3-1.2z' }),
          h('path', { fill: '#229ED9', d: 'M8.6 13.6l8.9-5.6c.3-.2.6.2.3.4l-7.2 6.7-.2 2.6-1.8-4.1z' }),
        ];
      },
      qq: function () {
        return [
          h('path', { fill: '#fff', d: 'M12 2.6c-3.4 0-5.6 2.5-5.6 5.8 0 .9-.5 2-1 3.1-.6 1.4-1.3 3-1.3 4.5 0 1.5.8 2.5 1.8 2.5.6 0 1.1-.4 1.5-1 .3 1.4 1 2.8 2 3.8-1 .2-2 .8-2 1.5 0 .9 1.7 1.4 3.6 1.4h2c1.9 0 3.6-.5 3.6-1.4 0-.7-1-1.3-2-1.5 1-1 1.7-2.4 2-3.8.4.6.9 1 1.5 1 1 0 1.8-1 1.8-2.5 0-1.5-.7-3.1-1.3-4.5-.5-1.1-1-2.2-1-3.1 0-3.3-2.2-5.8-5.6-5.8z' }),
          h('ellipse', { cx: '12', cy: '14.8', rx: '3.6', ry: '4.8', fill: '#12B7F5' }),
          h('circle', { cx: '10.1', cy: '7.8', r: '1', fill: '#12B7F5' }),
          h('circle', { cx: '13.9', cy: '7.8', r: '1', fill: '#12B7F5' }),
        ];
      },
      slack: function () {
        return [
          h('rect', { x: '9.3', y: '3', width: '2.8', height: '8.4', rx: '1.4', fill: '#36C5F0' }),
          h('rect', { x: '12.7', y: '9.3', width: '8.4', height: '2.8', rx: '1.4', fill: '#2EB67D' }),
          h('rect', { x: '11.9', y: '12.7', width: '2.8', height: '8.4', rx: '1.4', fill: '#ECB22E' }),
          h('rect', { x: '2.9', y: '11.9', width: '8.4', height: '2.8', rx: '1.4', fill: '#E01E5A' }),
        ];
      },
      discord: function () {
        return [
          h('path', { fill: '#fff', fillRule: 'evenodd', d: 'M19.3 5.6A16.5 16.5 0 0 0 15.6 4l-.5 1a13.4 13.4 0 0 0-6.2 0L8.4 4a16.5 16.5 0 0 0-3.7 1.6C2.3 9.3 1.6 12.9 2 16.4A16.9 16.9 0 0 0 7 19l1-1.6c-.6-.2-1.1-.5-1.6-.8l.4-.3a12.3 12.3 0 0 0 10.4 0l.4.3c-.5.3-1 .6-1.6.8l1 1.6a16.9 16.9 0 0 0 5-2.6c.4-4.1-.7-7.7-2.7-10.8zM9.1 14.2c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2zm5.8 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2z' }),
        ];
      },
      whatsapp: function () {
        return [
          h('path', { fill: '#fff', d: 'M12 2.8a9.2 9.2 0 0 0-7.9 13.9L2.8 21l4.5-1.2A9.2 9.2 0 1 0 12 2.8z' }),
          h('path', { fill: '#25D366', d: 'M9 8.1c.3-.3.8-.3 1.1 0l1.2 1.6c.2.3.2.7 0 1l-.8 1a8.6 8.6 0 0 0 3.8 3.8l1-.8c.3-.2.7-.2 1 0l1.6 1.2c.3.3.3.8 0 1.1-1.7 1.7-4.5 1-7.2-1.7S7.3 9.8 9 8.1z' }),
        ];
      },
      matrix: function () {
        return [
          h('path', { d: 'M8.6 4.5H5.4v15h3.2', stroke: '#fff', strokeWidth: 2, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' }),
          h('path', { d: 'M15.4 4.5h3.2v15h-3.2', stroke: '#fff', strokeWidth: 2, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' }),
        ];
      },
      imessage: function () {
        return [
          h('path', { fill: '#fff', d: 'M12 3.6c-4.8 0-8.6 3-8.6 6.7 0 2.1 1.2 3.9 3.1 5.2-.1 1.1-.6 2.4-1.7 3.4 2-.1 3.6-.9 4.7-1.8.8.2 1.6.3 2.5.3 4.8 0 8.6-3 8.6-6.7S16.8 3.6 12 3.6z' }),
        ];
      },
      'wecom-app': function () {
        return [
          h('path', { fill: '#fff', fillRule: 'evenodd', d: 'M9.4 6.6V6c0-.7.6-1.3 1.3-1.3h2.6c.7 0 1.3.6 1.3 1.3v.6h2.8c1 0 1.9.9 1.9 1.9v7.6c0 1-.9 1.9-1.9 1.9H6.6c-1 0-1.9-.9-1.9-1.9V8.5c0-1 .9-1.9 1.9-1.9h2.8zm1.4 0h2.4V6c0-.1-.1-.2-.2-.2h-2c-.1 0-.2.1-.2.2v.6zm-3.6 4.2h9.6v1.5H7.2v-1.5z' }),
        ];
      },
      email: function () {
        return [
          h('path', { fill: '#fff', d: 'M5 6.5h14a1.8 1.8 0 0 1 1.8 1.8v7.4a1.8 1.8 0 0 1-1.8 1.8H5a1.8 1.8 0 0 1-1.8-1.8V8.3A1.8 1.8 0 0 1 5 6.5z' }),
          h('path', { d: 'm4.6 8.4 7.4 5 7.4-5', stroke: '#5B7CFA', strokeWidth: 1.6, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' }),
        ];
      },
      'dingtalk-notify': function () {
        return [
          h('path', { fill: '#fff', d: 'M12 3.2a5.4 5.4 0 0 0-5.4 5.4c0 3.1-.9 4.4-1.7 5.3-.4.4-.1 1.2.5 1.2h13.2c.6 0 .9-.8.5-1.2-.8-.9-1.7-2.2-1.7-5.3A5.4 5.4 0 0 0 12 3.2zm-2.2 13.6a2.2 2.2 0 0 0 4.4 0h-4.4z' }),
        ];
      },
    };
    GLYPHS['qq-notify'] = GLYPHS['dingtalk-notify'];

    function Logo(props) {
      var channelId = props.channel;
      var size = props.size || 30;
      var chip = CHIP_STYLES[channelId] || { background: 'var(--diu-hover)' };
      var style = { width: size, height: size, borderRadius: Math.round(size * 0.3), background: chip.background };
      if (chip.bordered) style.boxShadow = 'inset 0 0 0 1px var(--diu-line)';
      var draw = GLYPHS[channelId];
      var glyphSize = Math.round(size * 0.62);
      return h('span', { className: 'diu-logo', style: style, 'aria-hidden': 'true' },
        draw
          ? h('svg', { viewBox: '0 0 24 24', width: glyphSize, height: glyphSize, focusable: 'false' }, draw())
          : h('span', { style: { color: '#fff', fontSize: Math.round(size * 0.42), fontWeight: 700 } }, channelId.slice(0, 1).toUpperCase())
      );
    }

    // ── 小图标（stroke 类，currentColor）───────────────────────────────────
    function IconRefresh(props) {
      return h('svg', { viewBox: '0 0 24 24', width: props.size || 14, height: props.size || 14, 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M20 12a8 8 0 1 1-2.9-6.2', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
        h('path', { d: 'M20.5 3.5v5h-5', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      );
    }
    function IconChevron(props) {
      return h('svg', { viewBox: '0 0 24 24', width: props.size || 14, height: props.size || 14, 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'm9 6 6 6-6 6', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      );
    }
    function IconPlus(props) {
      return h('svg', { viewBox: '0 0 24 24', width: props.size || 12, height: props.size || 12, 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M12 5v14M5 12h14', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
      );
    }
    function IconClose(props) {
      return h('svg', { viewBox: '0 0 24 24', width: props.size || 14, height: props.size || 14, 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M6 6l12 12M18 6 6 18', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
      );
    }
    function IconGitHub(props) {
      return h('svg', { viewBox: '0 0 24 24', width: props.size || 14, height: props.size || 14, 'aria-hidden': 'true', focusable: 'false' },
        h('path', { fill: 'currentColor', d: 'M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.87-.01-1.7-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.36 1.12 2.94.86.09-.67.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05a9.36 9.36 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2z' }),
      );
    }

    function Tag(props) {
      var cls = 'diu-tag diu-tag' + (props.tone || 'Muted');
      return h('span', { className: cls },
        props.dot !== false ? h('span', { className: 'diu-tag-dot' }) : null,
        props.children,
      );
    }

    // 弹窗 portal：宿主提供 react-dom 则挂 body（脱离设置对话框的层叠上下文），
    // 否则退化为面板内 fixed 层——两条路都保 Esc/背板点击可关。
    function Portal(props) {
      if (ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined') {
        return ReactDOM.createPortal(props.children, document.body);
      }
      return h('div', { style: { position: 'fixed', inset: 0, zIndex: 5000 } }, props.children);
    }

    // ── 账号行：名称/内部键 + 状态徽章 + 操作（检查/编辑/暂停/两步删除）──────
    function AccountRow(props) {
      var row = props.row;
      var channel = props.channel;
      var busy = props.busy;
      var checks = props.checks || [];
      var checkTone = { passed: 'Ok', failed: 'Bad', unverified: 'Muted' };

      var pendingRemoveHook = useState(false);
      var pendingRemove = pendingRemoveHook[0];
      var setPendingRemove = pendingRemoveHook[1];
      var allowHook = useState(null);
      var allowDraft = allowHook[0];
      var setAllowDraft = allowHook[1];

      var missingSecrets = [];
      (row.secretFields || []).forEach(function (sf) {
        if (!sf.configured) missingSecrets.push(sf.key);
      });
      var badge = row.paused
        ? h(Tag, { tone: 'Muted' }, t('accounts.state.paused'))
        : row.sessionExpired === true
          ? h(Tag, { tone: 'Bad' }, t('accounts.state.expired'))
          : row.connected
            ? h(Tag, { tone: 'Ok' }, t('accounts.state.connected'))
            : h(Tag, { tone: 'Warn' }, t('accounts.state.disconnected'));
      var allowValue = allowDraft !== null ? allowDraft : (row.dmAllowlist || []).join('\n');
      // 会话偏好摘要（可发现性）：有值才显示，避免「新设置藏在弹窗里」。
      var session0 = row.session || {};
      var prefBits = [];
      if (session0.cwd) {
        var cwdParts = String(session0.cwd).split(/[\\/]/);
        prefBits.push(cwdParts[cwdParts.length - 1] || session0.cwd);
      }
      if (session0.agentPreset) prefBits.push(session0.agentPreset);
      if (session0.model) prefBits.push((session0.provider ? session0.provider + '/' : '') + session0.model + (session0.reasoningEffort ? '@' + session0.reasoningEffort : ''));
      if (session0.permission) prefBits.push(t('prefs.permission') + ':' + session0.permission);
      var exec0 = row.commandExec || {};
      if (exec0.dm === false) prefBits.push(t('exec.dm') + ':' + t('exec.off'));
      if (exec0.group === false) prefBits.push(t('exec.group') + ':' + t('exec.off'));

      var actions = [
        h('button', { key: 'check', className: 'diu-btn', disabled: busy, onClick: function () { props.onCheck(row.accountId); } },
          busy ? t('accounts.checking') : t('accounts.check')),
        h('button', { key: 'edit', className: 'diu-btn', disabled: busy, onClick: function () { props.onEdit(row); } }, t('accounts.edit')),
        h('button', {
          key: 'pause', className: 'diu-btn', disabled: busy,
          onClick: function () { props.onPause(row.accountId, !row.paused); },
        }, row.paused ? t('accounts.resume') : t('accounts.pause')),
      ];
      if (pendingRemove) {
        actions.push(
          h('button', {
            key: 'removeYes', className: 'diu-btn diu-btnDanger', disabled: busy,
            onClick: function () { setPendingRemove(false); props.onRemove(row.accountId); },
          }, t('accounts.remove.confirm')),
          h('button', { key: 'removeNo', className: 'diu-btn', disabled: busy, onClick: function () { setPendingRemove(false); } }, t('modal.cancel')),
        );
      } else {
        actions.push(
          h('button', { key: 'remove', className: 'diu-btn diu-btnDanger', disabled: busy, onClick: function () { setPendingRemove(true); } }, t('accounts.remove')),
        );
      }

      var checkRows = null;
      if (checks.length > 0) {
        checkRows = h('div', { className: 'diu-checkList' },
          h('span', { className: 'diu-hint' }, t('check.title')),
          checks.map(function (c, i) {
            return h('div', { key: (c.name || 'check') + i, className: 'diu-checkItem' },
              h('span', { className: 'diu-checkName' }, c.name || '-'),
              h(Tag, { tone: checkTone[c.status] || 'Muted' }, t('check.' + c.status) || c.status),
              c.hint ? h('span', { className: 'diu-checkHint' }, c.hint) : null,
            );
          }),
        );
      }

      var allowBlock = channel.notifyOnly === true ? null : h(
        'details',
        { className: 'diu-allow' },
        h('summary', null, t('accounts.allowlist') + '（' + (row.dmAllowlist || []).length + '）'),
        h('div', { className: 'diu-allowBody' },
          h('div', { className: 'diu-hint' }, t('accounts.allowlist.hint')),
          h('textarea', {
            className: 'diu-textarea', rows: 2, value: allowValue,
            onChange: function (event) { setAllowDraft(event.target.value); },
          }),
          h('div', null,
            h('button', {
              className: 'diu-btn', disabled: busy,
              onClick: function () {
                var ids = String(allowValue || '').split('\n').map(function (v) { return v.trim(); }).filter(function (v) { return v !== ''; });
                props.onSaveAllowlist(row.accountId, ids);
              },
            }, t('accounts.allowlist.save')),
          ),
        ),
      );

      return h('div', { className: 'diu-account' },
        h('div', { className: 'diu-accountMain' },
          h('span', { className: 'diu-accountName' }, row.alias || row.accountId),
          row.alias ? h('span', { className: 'diu-accountId' }, row.accountId) : null,
          h('span', { className: 'diu-badges' },
            badge,
            row.privateAccess === 'all' ? h(Tag, { tone: 'Info', dot: false }, t('access.all.tag')) : null,
            missingSecrets.length > 0
              ? h(Tag, { tone: 'Bad', dot: false }, format('accounts.secret.missing', { keys: missingSecrets.join(', ') }))
              : null,
          ),
          h('span', { className: 'diu-accountActions' }, actions),
        ),
        checkRows,
        prefBits.length > 0
          ? h('div', { className: 'diu-accountPrefs' },
              h('span', { className: 'diu-accountPrefsLabel' }, t('accounts.prefs')),
              prefBits.join(' · '),
            )
          : null,
        allowBlock,
      );
    }

    // ── 渠道手风琴卡：头（logo/名称/标签/账号数/添加）+ 展开账号列表 ─────────
    function PlatformCard(props) {
      var channel = props.channel;
      var accounts = props.accounts || [];
      var open = props.open === true;
      var planned = channel.implemented !== true;
      var cls = 'diu-platform' + (open ? ' open' : '') + (planned ? ' isPlanned' : '');
      var tags = [];
      if (planned) tags.push(h(Tag, { key: 'planned', tone: 'Muted', dot: false }, t('channel.tag.planned')));
      if (channel.notifyOnly === true) tags.push(h(Tag, { key: 'notify', tone: 'Info', dot: false }, t('channel.tag.notify')));
      if (channel.hostRequirement === 'macos') tags.push(h(Tag, { key: 'macos', tone: 'Warn', dot: false }, t('channel.tag.macos')));

      return h('section', { className: cls },
        h('button', {
          className: 'diu-platformHead', 'aria-expanded': open ? 'true' : 'false',
          onClick: function () { props.onToggle(channel.id); },
        },
          h(Logo, { channel: channel.id, size: 30 }),
          h('span', { className: 'diu-platformCopy' },
            h('span', { className: 'diu-platformName' }, channelName(channel)),
            tags,
          ),
          h('span', { className: 'diu-count' }, format('channel.count', { n: accounts.length })),
          h('span', {
            className: 'diu-addBtn', role: 'button', 'aria-disabled': planned ? 'true' : 'false',
            onClick: function (event) {
              event.stopPropagation();
              if (!planned) props.onAdd(channel);
            },
          },
            h(IconPlus, null), t('accounts.add'),
          ),
          h('span', { className: 'diu-caret' }, h(IconChevron, null)),
        ),
        open && !planned
          ? accounts.length === 0
            ? h('div', { className: 'diu-accountList' }, h('div', { className: 'diu-accountEmpty' }, t('channel.emptyHint')))
            : h('div', { className: 'diu-accountList' }, accounts.map(function (row) {
                return h(AccountRow, {
                  key: row.accountId, row: row, channel: channel, busy: props.busy,
                  checks: props.checks[row.accountId] || [],
                  onCheck: props.onCheck, onEdit: props.onEdit, onPause: props.onPause,
                  onRemove: props.onRemove, onSaveAllowlist: props.onSaveAllowlist,
                });
              }))
          : null,
      );
    }

    // ── 添加/编辑弹窗：微信=扫码流（先建档后取码）；其余=meta.fields 双列表单 ──
    function AccountModal(props) {
      var channel = props.channel;
      var account = props.account || null;
      var editing = account !== null;
      var isWeixin = channel.id === 'weixin';
      var fields = channel.fields || [];

      var aliasHook = useState(editing ? account.alias || '' : '');
      var alias = aliasHook[0];
      var setAlias = aliasHook[1];
      var valuesHook = useState(function () {
        var initial = {};
        for (var i = 0; i < fields.length; i += 1) {
          var f = fields[i];
          if (!f.secret && editing && account.config && typeof account.config[f.key] === 'string') {
            initial[f.key] = account.config[f.key];
          } else {
            initial[f.key] = '';
          }
        }
        return initial;
      });
      var values = valuesHook[0];
      var setValues = valuesHook[1];
      var qrHook = useState(null);
      var qr = qrHook[0];
      var setQr = qrHook[1];
      var busyHook = useState(false);
      var busy = busyHook[0];
      var setBusy = busyHook[1];
      var errHook = useState('');
      var err = errHook[0];
      var setErr = errHook[1];
      // 会话偏好（cwd/预设/模型/推理档/权限）+ 私聊准入 + 命令执行开关；模型编码 provider::model。
      var prefsHook = useState(function () {
        var s = (editing && account.session) || {};
        return {
          cwd: typeof s.cwd === 'string' ? s.cwd : '',
          agentPreset: typeof s.agentPreset === 'string' ? s.agentPreset : '',
          modelKey: typeof s.model === 'string' && s.model !== '' ? (typeof s.provider === 'string' ? s.provider : '') + '::' + s.model : '',
          reasoningEffort: typeof s.reasoningEffort === 'string' ? s.reasoningEffort : '',
          permission: typeof s.permission === 'string' ? s.permission : '',
        };
      });
      var prefs = prefsHook[0];
      var setPrefs = prefsHook[1];
      // 命令执行开关（缺键=开；插值即时生效，不依赖会话后端）。
      var execHook = useState(function () {
        var e = (editing && account.commandExec) || {};
        return { dm: e.dm !== false, group: e.group !== false };
      });
      var exec = execHook[0];
      var setExec = execHook[1];
      var accessHook = useState(editing && account.privateAccess === 'all' ? 'all' : 'approved');
      var privateAccess = accessHook[0];
      var setPrivateAccess = accessHook[1];
      var catalogHook = useState(null);
      var catalog = catalogHook[0];
      var setCatalog = catalogHook[1];

      // Esc 关闭（capture 注册避免被宿主对话框吞掉）。
      useEffect(function () {
        var handler = function (event) {
          if (event.key === 'Escape') { event.stopPropagation(); props.onClose(); }
        };
        document.addEventListener('keydown', handler, true);
        return function () { document.removeEventListener('keydown', handler, true); };
      }, [props.onClose]);

      // 偏好目录一次拉取（工作区 cwd 聚合/模型目录/预设清单）；缺位=偏好区降级提示。
      useEffect(function () {
        var alive = true;
        getJSON('/session-catalog').then(function (result) {
          if (alive && result.status === 200 && result.json && result.json.ok) setCatalog(result.json);
        }).catch(function () { /* 目录不可用：模型/预设下拉保持空 */ });
        return function () { alive = false; };
      }, []);

      // 字段值归位：secret → secrets（留空=保持），plain → record.config；
      // 会话偏好进 record.session，准入档位进 record.privateAccess。
      function collect() {
        var config = {};
        var secrets = {};
        for (var i = 0; i < fields.length; i += 1) {
          var f = fields[i];
          var v = String(values[f.key] || '').trim();
          if (v === '') continue;
          if (f.secret) secrets[f.key] = v;
          else config[f.key] = v;
        }
        var session = {};
        var cwd = String(prefs.cwd || '').trim();
        var presetId = String(prefs.agentPreset || '').trim();
        if (cwd !== '') session.cwd = cwd;
        if (presetId !== '') session.agentPreset = presetId;
        if (prefs.modelKey !== '') {
          var split = prefs.modelKey.indexOf('::');
          var provider = split > 0 ? prefs.modelKey.slice(0, split) : '';
          var model = prefs.modelKey.slice(split + 2);
          if (provider !== '') session.provider = provider;
          if (model !== '') session.model = model;
          var effort = String(prefs.reasoningEffort || '').trim();
          if (effort !== '') session.reasoningEffort = effort;
        }
        var permission = String(prefs.permission || '').trim();
        if (permission !== '') session.permission = permission;
        return {
          record: {
            accountId: editing ? account.accountId : genAccountId(channel.id),
            channel: channel.id,
            alias: String(alias || '').trim(),
            config: config,
            privateAccess: privateAccess === 'all' ? 'all' : 'approved',
            commandExec: { dm: exec.dm !== false, group: exec.group !== false },
            session: session,
          },
          secrets: secrets,
        };
      }

      function requiredMissing() {
        for (var i = 0; i < fields.length; i += 1) {
          var f = fields[i];
          if (!f.required) continue;
          if (editing && f.secret) continue; // 编辑时空=保持现有凭据
          if (String(values[f.key] || '').trim() === '') return true;
        }
        return false;
      }

      function submit() {
        var payload = collect();
        // 微信扫码账号：表单存而连——凭据由扫码流程写入，保存时必须跳过
        // 适配器构建（否则 botToken 缺失工厂即抛 → 被当校验错 400，UI 假报）。
        payload.skipConnect = isWeixin && !payload.secrets.botToken;
        setBusy(true);
        setErr('');
        postJSON('/accounts/save', payload).then(function (result) {
          setBusy(false);
          if (result.status === 200) {
            props.onSaved(payload.skipConnect ? 'accounts.saved.bindhint' : 'accounts.saved');
          } else {
            setErr(errorText(result));
          }
        }).catch(function (error) {
          setBusy(false);
          setErr(messageText(error));
        });
      }

      // 扫码前先确保记录在库（新增=先建档 skipConnect；编辑=已在库）：
      // qr/status confirmed 时按 accountId upsert，命中已有记录即保留别名/配置。
      function startQr() {
        setBusy(true);
        setErr('');
        var accountId = editing ? account.accountId : genAccountId(channel.id);
        var ensureSaved;
        if (editing) {
          ensureSaved = Promise.resolve();
        } else {
          var payload = collect();
          payload.record.accountId = accountId;
          payload.skipConnect = true;
          ensureSaved = postJSON('/accounts/save', payload).then(function (result) {
            if (result.status !== 200) throw new Error(errorText(result));
          });
        }
        ensureSaved.then(function () {
          return postJSON('/weixin/qr/start', {}).then(function (result) {
            setBusy(false);
            if (result.status === 200 && result.json && result.json.ok) {
              setQr({ qrcode: result.json.qrcode, qrDataUrl: result.json.qrDataUrl, accountId: accountId, status: 'wait' });
            } else {
              setErr(errorText(result));
            }
          });
        }).catch(function (error) {
          setBusy(false);
          setErr(messageText(error));
        });
      }

      // 状态驱动串行轮询：每次 setQr 产生新对象触发 effect 重跑下一拍；
      // 服务端每请求 hold 最长 ~35s，前端不并发叠轮（cleanup 置活旗防串台）。
      useEffect(function () {
        if (qr === null) return undefined;
        if (qr.status === 'confirmed' || qr.status === 'expired' || qr.status === 'need_verifycode' || qr.status === 'verify_code_blocked') return undefined;
        var alive = true;
        var payload = { qrcode: qr.qrcode, accountId: qr.accountId };
        if (typeof qr.verifyCode === 'string' && qr.verifyCode !== '') payload.verifyCode = qr.verifyCode;
        postJSON('/weixin/qr/status', payload).then(function (result) {
          if (!alive) return;
          if (result.status === 200 && result.json && result.json.ok) {
            var status = result.json.status;
            if (status === 'confirmed') {
              setQr(Object.assign({}, qr, { status: 'confirmed' }));
              props.onSaved('accounts.qr.confirmed');
            } else {
              setQr(Object.assign({}, qr, { status: status }));
            }
          } else if (alive) {
            setQr(Object.assign({}, qr, { status: 'expired' })); // 请求异常保守收轮：引导重新取码而非假进度
          }
        }).catch(function () {
          if (alive) setQr(Object.assign({}, qr, { status: 'expired' }));
        });
        return function () { alive = false; };
      }, [qr]);

      var qrBlock = null;
      if (isWeixin) {
        if (qr === null || qr.status === 'expired') {
          qrBlock = h('div', { className: 'diu-qrBox' },
            h('div', { className: 'diu-qrMeta' },
              h('div', { className: 'diu-qrTitle' }, t('accounts.qr.get')),
              h('div', { className: 'diu-qrStatus' }, t('accounts.qr.desc')),
              h('div', { className: 'diu-qrActions' },
                h('button', { className: 'diu-btn diu-btnPrimary', disabled: busy, onClick: startQr },
                  t(qr === null ? 'accounts.qr.get' : 'accounts.qr.refresh')),
              ),
            ),
          );
        } else if (qr.status === 'confirmed') {
          qrBlock = h('div', { className: 'diu-banner diu-banner-ok', style: { margin: '0 0 14px' } }, t('accounts.qr.confirmed'));
        } else {
          var qrMeta = [h('div', { key: 'st', className: 'diu-qrStatus' }, t('accounts.qr.' + qr.status) || qr.status)];
          if (qr.status === 'need_verifycode') {
            qrMeta.push(
              h('div', { key: 'vc', className: 'diu-verifyRow' },
                h('input', {
                  className: 'diu-input', style: { maxWidth: 140 }, value: qr.verifyCode || '',
                  onChange: function (event) { setQr(Object.assign({}, qr, { verifyCode: event.target.value })); },
                }),
                h('button', {
                  className: 'diu-btn', onClick: function () { setQr(Object.assign({}, qr, { status: 'wait' })); },
                }, t('accounts.qr.code.submit')),
              ),
            );
          }
          qrMeta.push(
            h('div', { key: 'act', className: 'diu-qrActions' },
              h('button', { className: 'diu-btn', disabled: busy, onClick: startQr }, t('accounts.qr.refresh')),
              h('button', { className: 'diu-btn', onClick: function () { setQr(null); } }, t('accounts.qr.cancel')),
            ),
          );
          qrBlock = h('div', { className: 'diu-qrBox' },
            h('img', { className: 'diu-qrImg', src: qr.qrDataUrl, width: 168, height: 168, alt: 'login qr' }),
            h('div', { className: 'diu-qrMeta' }, qrMeta),
          );
        }
      }

      var fieldNodes = fields.map(function (f) {
        var labelChildren = [
          h('span', { key: 'label' }, pickBilingual(f.label) || f.key),
          f.required ? h('span', { key: 'req', className: 'diu-req' }, '*') : null,
        ];
        if (f.helpUrl) {
          labelChildren.push(h('a', {
            key: 'help', className: 'diu-helpLink', href: f.helpUrl, target: '_blank', rel: 'noopener noreferrer',
          }, currentLang() === 'zh' ? '帮助 ↗' : 'help ↗'));
        }
        return h('div', { key: f.key, className: 'diu-field' + (f.secret ? '' : ' diu-fieldPlain') },
          h('span', { className: 'diu-label' }, labelChildren),
          h('input', {
            className: 'diu-input',
            type: f.secret ? 'password' : 'text',
            autoComplete: f.secret ? 'new-password' : 'off',
            value: values[f.key] || '',
            placeholder: editing && f.secret ? '••••••••' : '',
            onChange: function (event) {
              var next = Object.assign({}, values);
              next[f.key] = event.target.value;
              setValues(next);
            },
          }),
        );
      });

      var sessionSection = null;
      if (channel.notifyOnly !== true) {
        var backendNone = catalog !== null && catalog.backend === 'none';
        // 目录类下拉在「目录未达」或「后端未就绪」时禁用（数据源缺位如实降级），
        // 但整个设置面常显：命令执行/准入/工作区是本插件本地语义，始终可编辑。
        var catalogDown = catalog === null || backendNone;
        var providerGroups = (catalog && catalog.providers) || [];
        var presets = (catalog && catalog.presets) || [];
        var permissions = (catalog && catalog.permissions) || [];
        var workspaces = (catalog && catalog.workspaces) || [];
        var selProvider = '';
        var selModel = '';
        if (prefs.modelKey !== '') {
          var di = prefs.modelKey.indexOf('::');
          selProvider = di > 0 ? prefs.modelKey.slice(0, di) : '';
          selModel = prefs.modelKey.slice(di + 2);
        }
        var efforts = [];
        providerGroups.forEach(function (group) {
          if ((group.id || '') !== selProvider) return;
          (group.models || []).forEach(function (m) {
            if (m.id === selModel && m.reasoning && Array.isArray(m.reasoning.efforts)) efforts = m.reasoning.efforts;
          });
        });
        var modelOptions = [h('option', { key: '_default', value: '' }, t('prefs.model.default'))];
        providerGroups.forEach(function (group) {
          var groupId = group.id || '';
          modelOptions.push(
            h('optgroup', { key: groupId || group.name, label: group.name || groupId },
              (group.models || []).map(function (m) {
                return h('option', { key: m.id, value: groupId + '::' + m.id }, m.name || m.id);
              }),
            ),
          );
        });
        var permissionOptions = [h('option', { key: '_default', value: '' }, t('prefs.permission.default'))];
        permissions.forEach(function (p) {
          if (p && typeof p.id === 'string' && p.id !== '') {
            permissionOptions.push(h('option', { key: p.id, value: p.id }, p.name || p.id));
          }
        });
        var execSelect = function (key, label) {
          return h('div', { key: key, className: 'diu-field' },
            h('span', { className: 'diu-label' }, label),
            h('select', {
              className: 'diu-input', value: exec[key] === false ? 'off' : 'on',
              onChange: function (event) { setExec(Object.assign({}, exec, key === 'dm' ? { dm: event.target.value !== 'off' } : { group: event.target.value !== 'off' })); },
            },
              h('option', { value: 'on' }, t('exec.on')),
              h('option', { value: 'off' }, t('exec.off')),
            ),
          );
        };
        sessionSection = h('div', { className: 'diu-sessionBlock' },
          h('div', { className: 'diu-sessionTitle' }, t('modal.session.title')),
          backendNone ? h('div', { className: 'diu-hint' }, t('modal.session.none')) : null,
          h('div', { className: 'diu-fields' },
            h('div', { className: 'diu-field' },
              h('span', { className: 'diu-label' }, t('access.title')),
              h('select', {
                className: 'diu-input', value: privateAccess,
                onChange: function (event) { setPrivateAccess(event.target.value === 'all' ? 'all' : 'approved'); },
              },
                h('option', { value: 'approved' }, t('access.approved')),
                h('option', { value: 'all' }, t('access.all')),
              ),
            ),
            execSelect('dm', t('exec.dm')),
            execSelect('group', t('exec.group')),
            h('div', { className: 'diu-field' },
              h('span', { className: 'diu-label' }, t('prefs.preset')),
              catalog === null
                ? h('div', { className: 'diu-hint' }, t('catalog.loading'))
                : h('select', {
                    className: 'diu-input', value: prefs.agentPreset, disabled: backendNone,
                    onChange: function (event) { setPrefs(Object.assign({}, prefs, { agentPreset: event.target.value })); },
                  },
                    h('option', { value: '' }, t('prefs.preset.default')),
                    presets.map(function (p) {
                      return h('option', { key: p.id, value: p.id }, p.name || p.id);
                    }),
                  ),
            ),
            h('div', { className: 'diu-field diu-fieldWide' },
              h('span', { className: 'diu-label' }, t('prefs.workspace')),
              h('input', {
                className: 'diu-input', list: 'diu-cwd-options', value: prefs.cwd,
                placeholder: t('prefs.workspace.placeholder'),
                onChange: function (event) { setPrefs(Object.assign({}, prefs, { cwd: event.target.value })); },
              }),
              h('datalist', { id: 'diu-cwd-options' },
                workspaces.map(function (w) { return h('option', { key: w, value: w }); }),
              ),
            ),
            h('div', { className: 'diu-field' },
              h('span', { className: 'diu-label' }, t('prefs.model')),
              catalog === null
                ? h('div', { className: 'diu-hint' }, t('catalog.loading'))
                : h('select', {
                    className: 'diu-input', value: prefs.modelKey, disabled: backendNone,
                    onChange: function (event) { setPrefs(Object.assign({}, prefs, { modelKey: event.target.value, reasoningEffort: '' })); },
                  }, modelOptions),
            ),
            efforts.length > 0
              ? h('div', { className: 'diu-field' },
                  h('span', { className: 'diu-label' }, t('prefs.effort')),
                  h('select', {
                    className: 'diu-input', value: prefs.reasoningEffort,
                    onChange: function (event) { setPrefs(Object.assign({}, prefs, { reasoningEffort: event.target.value })); },
                  },
                    h('option', { value: '' }, t('prefs.effort.default')),
                    efforts.map(function (e) {
                      return h('option', { key: e.id, value: e.id }, e.name || e.id);
                    }),
                  ),
                )
              : null,
            h('div', { className: 'diu-field' },
              h('span', { className: 'diu-label' }, t('prefs.permission')),
              catalogDown
                ? h('div', { className: 'diu-hint' }, backendNone ? t('modal.session.none') : t('catalog.loading'))
                : h('select', {
                    className: 'diu-input', value: prefs.permission,
                    onChange: function (event) { setPrefs(Object.assign({}, prefs, { permission: event.target.value })); },
                  }, permissionOptions),
            ),
            h('div', { className: 'diu-fieldWide diu-hint' }, t('modal.session.hint')),
          ),
        );
      }

      var title = editing
        ? t('modal.edit.title') + '：' + (account.alias || account.accountId)
        : format('modal.add.title', { channel: channelName(channel) });

      return h(Portal, null,
        h('div', {
          className: 'diu-modalRoot',
          onMouseDown: function (event) { if (event.target === event.currentTarget) props.onClose(); },
        },
          h('div', { className: 'diu-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
            h('div', { className: 'diu-modalHead' },
              h(Logo, { channel: channel.id, size: 26 }),
              h('h3', { className: 'diu-modalTitle' }, title),
              h('button', { className: 'diu-closeBtn', onClick: props.onClose, 'aria-label': t('modal.cancel') }, h(IconClose, null)),
            ),
            h('div', { className: 'diu-modalBody' },
              qrBlock,
              h('div', { className: 'diu-fields' },
                h('div', { className: 'diu-field diu-fieldWide' },
                  h('span', { className: 'diu-label' }, t('accounts.alias')),
                  h('input', {
                    className: 'diu-input', value: alias, placeholder: t('accounts.alias.placeholder'),
                    onChange: function (event) { setAlias(event.target.value); },
                  }),
                ),
                fieldNodes,
              ),
              sessionSection,
              h('p', { className: 'diu-modalNote' },
                t('modal.autoId'),
                editing ? ' ' + t('modal.editSecretHint') : '',
              ),
            ),
            h('div', { className: 'diu-modalFoot' },
              h('span', { className: 'diu-footMsg' }, err),
              busy ? h('span', { className: 'diu-hint' }, t('modal.saving')) : null,
              h('button', { className: 'diu-btn', onClick: props.onClose }, t('modal.cancel')),
              h('button', {
                className: 'diu-btn diu-btnPrimary', disabled: busy || requiredMissing(), onClick: submit,
              }, busy ? t('modal.saving') : t('modal.save')),
            ),
          ),
        ),
      );
    }

    function PanelBody(props) {
      var state = props.state;
      var caps = state.capabilities || {};
      var channels = state.channels || [];
      var accounts = props.accounts || [];
      var byChannel = {};
      accounts.forEach(function (row) {
        if (byChannel[row.channel] === undefined) byChannel[row.channel] = [];
        byChannel[row.channel].push(row);
      });
      var online = accounts.filter(function (row) { return row.connected && !row.paused; }).length;
      var implemented = channels.filter(function (c) { return c.implemented === true; });
      // 已实现渠道在前（保持 meta 顺序），未实现垫底灰显。
      var sorted = implemented.concat(channels.filter(function (c) { return c.implemented !== true; }));

      var noticeNode = null;
      if (props.notice !== null && props.notice !== undefined) {
        noticeNode = h('div', { className: 'diu-banner diu-banner-' + (props.notice.kind || 'info') },
          h('span', { style: { flex: 1, minWidth: 0 } }, props.notice.text),
          h('button', { className: 'diu-bannerClose', onClick: props.onDismissNotice, 'aria-label': t('modal.cancel') }, h(IconClose, null)),
        );
      }

      return h('div', { className: 'diu-page' },
        h('div', { className: 'diu-head' },
          h('div', null,
            h('h2', { className: 'diu-title' }, t('settings.title')),
            h('p', { className: 'diu-sub' }, t('panel.subtitle')),
          ),
          h('div', { className: 'diu-headActions' },
            h('a', { className: 'diu-iconBtn', href: REPO_URL, target: '_blank', rel: 'noopener noreferrer', style: { textDecoration: 'none' } },
              h(IconGitHub, null), t('panel.github')),
            h('button', { className: 'diu-iconBtn', onClick: props.onRefresh }, h(IconRefresh, null), t('panel.refresh')),
          ),
        ),
        h('div', { className: 'diu-stats' },
          h('span', { className: 'diu-stat' }, t('panel.stat.channels'), h('strong', null, implemented.length + '/' + channels.length)),
          h('span', { className: 'diu-stat' }, t('panel.stat.accounts'), h('strong', null, String(accounts.length))),
          h('span', { className: 'diu-stat' }, t('panel.stat.online'), h('strong', null, String(online))),
        ),
        noticeNode,
        h('details', { className: 'diu-debug' },
          h('summary', null, t('panel.debug')),
          h('dl', { className: 'diu-debugBody' },
            h('div', { className: 'diu-debugItem' }, h('dt', null, t('panel.generation')), h('dd', null, String(caps.settingsGeneration || '-'))),
            h('div', { className: 'diu-debugItem' }, h('dt', null, t('panel.sessionBackend')), h('dd', null, String(caps.sessionBackend || '-'))),
            h('div', { className: 'diu-debugItem' }, h('dt', null, t('panel.vault')), h('dd', null, String(caps.vaultKind || '-'))),
            h('div', { className: 'diu-debugItem' }, h('dt', null, t('panel.uploads')), h('dd', null, String(caps.uploadsMode || '-'))),
            h('div', { className: 'diu-debugItem' }, h('dt', null, t('panel.deliverables')), h('dd', null, String(caps.deliverablesMode || '-'))),
            h('div', { className: 'diu-debugItem' }, h('dt', null, t('panel.connector')), h('dd', null, caps.connectorEnabled ? t('panel.on') : t('panel.off'))),
            h('div', { className: 'diu-debugChannels' },
              channels.map(function (c) {
                return h('span', { key: c.id, className: 'diu-stat' },
                  channelName(c), ' · ', c.implemented ? t('panel.implemented') : t('panel.planned'));
              }),
            ),
          ),
        ),
        h('div', { className: 'diu-platforms' },
          sorted.map(function (channel) {
            return h(PlatformCard, {
              key: channel.id,
              channel: channel,
              accounts: byChannel[channel.id] || [],
              open: props.expanded[channel.id] === true,
              busy: props.busy,
              checks: props.checks,
              onToggle: props.onToggle,
              onAdd: props.onAdd,
              onCheck: props.onCheck,
              onEdit: props.onEdit,
              onPause: props.onPause,
              onRemove: props.onRemove,
              onSaveAllowlist: props.onSaveAllowlist,
            });
          }),
        ),
        props.modal !== null && props.modal !== undefined
          ? h(AccountModal, {
              key: props.modal.key,
              channel: props.modal.channel,
              account: props.modal.account || null,
              onClose: props.onCloseModal,
              onSaved: props.onModalSaved,
            })
          : null,
      );
    }

    function UnionPanel() {
      var stateHook = useState(null);
      var state = stateHook[0];
      var setState = stateHook[1];
      var errorHook = useState(null);
      var error = errorHook[0];
      var setError = errorHook[1];
      var accountsHook = useState(null);
      var accounts = accountsHook[0];
      var setAccounts = accountsHook[1];
      var checksHook = useState({});
      var checks = checksHook[0];
      var setChecks = checksHook[1];
      var noticeHook = useState(null);
      var notice = noticeHook[0];
      var setNotice = noticeHook[1];
      var busyHook = useState(0);
      var busy = busyHook[0];
      var setBusy = busyHook[1];
      var expandedHook = useState({});
      var expanded = expandedHook[0];
      var setExpanded = expandedHook[1];
      var modalHook = useState(null);
      var modal = modalHook[0];
      var setModal = modalHook[1];
      var didInitRef = useRef(false);
      var mountedRef = useRef(true);

      useEffect(function () {
        mountedRef.current = true;
        return function () { mountedRef.current = false; };
      }, []);

      function fetchAccounts(setter) {
        return getJSON('/accounts').then(function (result) {
          if (!mountedRef.current) return;
          if (result.status === 200 && result.json && result.json.ok) {
            var rows = result.json.accounts || [];
            setter(rows);
            // 首次拿到账号后展开有账号的渠道卡（之后尊重用户手动开合）。
            if (!didInitRef.current) {
              didInitRef.current = true;
              var init = {};
              rows.forEach(function (row) { init[row.channel] = true; });
              setExpanded(init);
            }
          }
        });
      }

      useEffect(function () {
        // 状态面慢轮询 + 账号面快轮询；后台标签页暂停，回前台立即补一拍。
        var stateTimer = null;
        var accountsTimer = null;
        var tickState = function () {
          if (document.hidden) return;
          fetch(API_BASE + '/state', { credentials: 'same-origin', headers: { 'x-dsh-im-union-client': '1' } })
            .then(function (response) {
              if (!response.ok) throw new Error('HTTP ' + response.status);
              return response.json();
            })
            .then(function (data) {
              if (mountedRef.current) { setState(data); setError(null); }
            })
            .catch(function (err) {
              if (mountedRef.current) setError(messageText(err));
            });
        };
        var tickAccounts = function () {
          if (document.hidden) return;
          fetchAccounts(function (rows) { setAccounts(rows); }).catch(function () { /* 轮询失败静默，下一拍再试 */ });
        };
        tickState();
        tickAccounts();
        stateTimer = setInterval(tickState, STATE_POLL_MS);
        accountsTimer = setInterval(tickAccounts, ACCOUNTS_POLL_MS);
        var onVisible = function () {
          if (!document.hidden) { tickState(); tickAccounts(); }
        };
        document.addEventListener('visibilitychange', onVisible);
        return function () {
          mountedRef.current = false;
          clearInterval(stateTimer);
          clearInterval(accountsTimer);
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, []);

      function withBusy(task) {
        setBusy(function (n) { return n + 1; });
        return Promise.resolve(task()).finally(function () {
          setBusy(function (n) { return Math.max(0, n - 1); });
        });
      }

      function refreshAll() {
        withBusy(function () {
          var p1 = fetch(API_BASE + '/state', { credentials: 'same-origin', headers: { 'x-dsh-im-union-client': '1' } })
            .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
            .then(function (data) { setState(data); setError(null); })
            .catch(function (err) { setError(messageText(err)); });
          var p2 = fetchAccounts(function (rows) { setAccounts(rows); })
            .catch(function (err) { setNotice({ kind: 'err', text: messageText(err) }); });
          return Promise.all([p1, p2]);
        });
      }

      function doAction(path, body, doneNotice) {
        withBusy(function () {
          return postJSON(path, body).then(function (result) {
            if (result.status === 200) {
              if (doneNotice) setNotice({ kind: 'ok', text: t(doneNotice) });
              return fetchAccounts(function (rows) { setAccounts(rows); });
            }
            setNotice({ kind: 'err', text: errorText(result) });
          }).catch(function (err) {
            setNotice({ kind: 'err', text: messageText(err) });
          });
        });
      }

      function doCheck(accountId) {
        withBusy(function () {
          return postJSON('/accounts/check', { accountId: accountId }).then(function (result) {
            if (result.status === 200 && result.json && result.json.ok) {
              var next = Object.assign({}, checks);
              next[accountId] = result.json.checks || [];
              setChecks(next);
            } else {
              setNotice({ kind: 'err', text: errorText(result) });
            }
          }).catch(function (err) {
            setNotice({ kind: 'err', text: messageText(err) });
          });
        });
      }

      if (error !== null) {
        return h('div', { className: 'diu-page' },
          h('div', { className: 'diu-head' },
            h('div', null,
              h('h2', { className: 'diu-title' }, t('settings.title')),
              h('p', { className: 'diu-sub' }, t('panel.subtitle')),
            ),
            h('div', { className: 'diu-headActions' },
              h('button', { className: 'diu-iconBtn', onClick: refreshAll }, h(IconRefresh, null), t('panel.refresh')),
            ),
          ),
          h('div', { className: 'diu-banner diu-banner-err' }, t('panel.error') + ' (' + error + ')'),
        );
      }
      if (state === null) {
        return h('div', { className: 'diu-page' }, h('p', { className: 'diu-hint' }, t('panel.loading')));
      }

      function openAdd(channel) {
        setModal({ key: 'add-' + channel.id + '-' + Date.now(), channel: channel, account: null });
      }
      function openEdit(row) {
        var channel = null;
        (state.channels || []).forEach(function (c) { if (c.id === row.channel) channel = c; });
        if (channel === null) return;
        setModal({ key: 'edit-' + row.accountId + '-' + Date.now(), channel: channel, account: row });
      }
      function closeModal() { setModal(null); }
      function onModalSaved(noticeKey) {
        setModal(null);
        setNotice({ kind: 'ok', text: t(noticeKey) });
        fetchAccounts(function (rows) { setAccounts(rows); }).catch(function () { /* 关弹窗后刷新失败留给轮询 */ });
      }

      return h(PanelBody, {
        state: state,
        accounts: accounts || [],
        checks: checks,
        notice: notice,
        busy: busy > 0,
        expanded: expanded,
        modal: modal,
        onRefresh: refreshAll,
        onDismissNotice: function () { setNotice(null); },
        onToggle: function (channelId) {
          setExpanded(function (prev) {
            var next = Object.assign({}, prev);
            next[channelId] = !prev[channelId];
            return next;
          });
        },
        onAdd: openAdd,
        onEdit: openEdit,
        onCloseModal: closeModal,
        onModalSaved: onModalSaved,
        onCheck: doCheck,
        onPause: function (accountId, paused) {
          doAction('/accounts/pause', { accountId: accountId, paused: paused }, paused ? 'accounts.saved' : 'accounts.saved');
        },
        onRemove: function (accountId) {
          doAction('/accounts/remove', { accountId: accountId }, 'accounts.removed');
        },
        onSaveAllowlist: function (accountId, userIds) {
          doAction('/accounts/allowlist', { accountId: accountId, userIds: userIds }, 'accounts.saved');
        },
      });
    }

    // gen1 兜底：宿主没有设置页时挂一个最小浮窗（可关闭）。
    function overlayFallback() {
      try {
        if (typeof document === 'undefined') return;
        if (document.getElementById('dsh-im-union-overlay')) return;
        installStyles();
        var host = document.createElement('div');
        host.id = 'dsh-im-union-overlay';
        host.className = 'diu-overlayFallback';
        document.body.appendChild(host);
        var closeBar = document.createElement('button');
        closeBar.textContent = '×';
        closeBar.style.cssText = 'position:absolute;top:6px;right:8px;border:0;background:transparent;font-size:16px;cursor:pointer;opacity:.6';
        closeBar.addEventListener('click', function () { host.remove(); });
        host.style.position = 'fixed';
        host.appendChild(closeBar);
        var mount = document.createElement('div');
        host.appendChild(mount);
        if (window.ReactDOM && typeof window.ReactDOM.createRoot === 'function') {
          window.ReactDOM.createRoot(mount).render(h(UnionPanel));
        } else if (window.ReactDOM && typeof window.ReactDOM.render === 'function') {
          window.ReactDOM.render(h(UnionPanel), mount);
        }
      } catch (error) {
        console.warn('[dsh-im-union] 浮窗兜底失败：', error);
      }
    }

    var inject = ['slots', 'locale'];

    function apply(ctx) {
      console.info('[dsh-im-union] apply invoked, slots:', typeof ctx && ctx.slots ? Object.keys(ctx.slots).join(',') : 'none')
      installStyles();
      // apply 期顶层注册——不许关进任何回调。
      try {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.locale.register('im-union', LOCALES);
          if (ctx.locale.dictionary) {
            // 宿主词典作为最高优先查找层（逐键翻译，miss 回本地词典）；
            // 语言判定不走它——走 currentLang() 懒解析（见 LANG_PREFIXES 注释）。
            hostDictionary = ctx.locale.dictionary;
          }
        }
      } catch (error) {
        console.warn('[dsh-im-union] 语言包注册失败（回落内置词典）：', error);
      }

      var registered = false;
      // 契约实读（dsh-session-guard 同宿主先例，src/client/index.ts:147/159）：
      // inject(slotName, factory) 二参必须是工厂，工厂内调 register(desc, Component)；
      // 裸传对象会被宿主当工厂取 .call → `e.execute.call is not a function`。
      // 三形依序：①settings.section 独立顶层项（IM 面板信息密度大，不挤家族票位；
      //   顶层节 desc 形实读 guard 先例 index.ts:223-240：label 为惰性函数、带 priority）
      //           ②overlayFallback 兜底。
      try {
        if (typeof ctx.slots.inject === 'function' && typeof ctx.slots.register === 'function') {
          ctx.slots.inject('settings.section', function () {
            console.info('[dsh-im-union] settings.section factory fired')
            return ctx.slots.register({
              name: 'settings.section',
              id: 'dsh-im-union',
              order: 42,
              priority: 5,
              label: function () {
                return t('settings.title')
              },
              inject: function () {
                return {};
              },
            }, UnionPanel)
          })
          registered = true
          console.info('[dsh-im-union] settings.section 独立顶层项已声明')
          // bundle 详情页配置卡（Dsh 0.2.0：Plugins 详情页不自动渲染，须 key=包名 注册）。
          try {
            ctx.slots.inject('plugins.bundle.config', function () {
              return ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: 'dsh-im-union',
                  inject: function () {
                    return {};
                  },
                },
                UnionPanel,
              )
            })
          } catch (error) {
            console.warn('[dsh-im-union] plugins.bundle.config 席位不可用：', error)
          }
        } else {
          console.warn('[dsh-im-union] ctx.slots 无 inject/register 面（老线或壳缺）：', typeof ctx.slots)
        }
      } catch (error) {
        console.warn('[dsh-im-union] 槽位注册失败：', error)
      }
      if (!registered) {
        // gen1 或槽位面异常 → 浮窗兜底，保证至少有一条可视管理入口。
        overlayFallback();
      }
    }

    exports.name = 'dsh-im-union-client';
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
