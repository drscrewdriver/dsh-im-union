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
    var createElement = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;

    var API_BASE = '/api/dsh-im-union';

    // ── 语言词典（zh 真理源；9 语完整词典随 M1 展示面扩展，运行时字典与
    // locale/*.json 元数据两处分层，此处只放 client 侧 UI 文案）─────────────
    var LOCALES = {
      zh: {
        'settings.title': 'IM 联合桥',
        'panel.loading': '正在读取本机状态…',
        'panel.error': '无法连接管理接口，请重启 Host 后刷新。',
        'panel.generation': '设置面代际',
        'panel.sessionBackend': '会话后端',
        'panel.vault': '凭据存储',
        'panel.debug': '运行时诊断',
        'panel.channels': '渠道实现度',
        'panel.implemented': '已实现',
        'panel.planned': '规划中',
        'accounts.title': '账号管理',
        'accounts.empty': '暂无账号，在下方添加。',
        'accounts.add': '添加账号',
        'accounts.qr.get': '获取登录二维码',
        'accounts.qr.refresh': '重新获取二维码',
        'accounts.qr.cancel': '取消扫码',
        'accounts.qr.needid': '请先填写账号 ID 再获取二维码',
        'accounts.qr.wait': '等待扫码…（用微信扫上方二维码）',
        'accounts.qr.scaned': '已扫码，请在手机上确认授权',
        'accounts.qr.expired': '二维码已过期，请重新获取',
        'accounts.qr.need_verifycode': '请输入手机上显示的验证码',
        'accounts.qr.verify_code_blocked': '验证码错误次数过多，请重新获取二维码',
        'accounts.qr.binded_redirect': '该 Bot 已绑定其它实例',
        'accounts.qr.scaned_but_redirect': '已扫码，正在重定向等待确认',
        'accounts.qr.code.submit': '提交验证码',
        'accounts.qr.confirmed': '扫码绑定完成，凭据已保存并连接',
        'accounts.saved.bindhint': '已保存（未连接）：请用「获取登录二维码」完成扫码授权后自动连接',
        'accounts.save': '保存',
        'accounts.cancel': '取消',
        'accounts.check': '检查连接',
        'accounts.pause': '暂停',
        'accounts.resume': '恢复',
        'accounts.remove': '删除',
        'accounts.confirm.remove': '删除该账号？其凭据将一并清除。',
        'accounts.saved': '已保存',
        'accounts.removed': '已删除',
        'accounts.channel': '渠道',
        'accounts.accountId': '账号 ID（字母数字_-，1-64 位）',
        'accounts.alias': '别名（可选）',
        'accounts.state.connected': '已连接',
        'accounts.state.disconnected': '未连接',
        'accounts.state.paused': '已暂停',
        'accounts.secret.yes': '凭据已配置',
        'accounts.secret.no': '凭据缺失',
        'accounts.allowlist': '私聊白名单（每行一个用户 ID，空=拒绝所有私聊）',
        'accounts.allowlist.save': '保存白名单',
        'check.passed': '通过',
        'check.failed': '失败',
        'check.unverified': '未验证',
      },
      en: {
        'settings.title': 'IM Union Bridge',
        'panel.loading': 'Loading local state…',
        'panel.error': 'Management API unreachable. Restart the host and refresh.',
        'panel.generation': 'Settings generation',
        'panel.sessionBackend': 'Session backend',
        'panel.vault': 'Credential vault',
        'panel.debug': 'Runtime diagnostics',
        'panel.channels': 'Channels',
        'panel.implemented': 'implemented',
        'panel.planned': 'planned',
        'accounts.title': 'Accounts',
        'accounts.empty': 'No accounts yet. Add one below.',
        'accounts.add': 'Add account',
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
        'accounts.saved.bindhint': 'Saved (disconnected): use "Get login QR code" to bind, it connects automatically',
        'accounts.save': 'Save',
        'accounts.cancel': 'Cancel',
        'accounts.check': 'Check connection',
        'accounts.pause': 'Pause',
        'accounts.resume': 'Resume',
        'accounts.remove': 'Remove',
        'accounts.confirm.remove': 'Remove this account? Its credentials will be cleared too.',
        'accounts.saved': 'Saved',
        'accounts.removed': 'Removed',
        'accounts.channel': 'Channel',
        'accounts.accountId': 'Account ID (letters/digits/_-, 1-64)',
        'accounts.alias': 'Alias (optional)',
        'accounts.state.connected': 'Connected',
        'accounts.state.disconnected': 'Disconnected',
        'accounts.state.paused': 'Paused',
        'accounts.secret.yes': 'credential set',
        'accounts.secret.no': 'credential missing',
        'accounts.allowlist': 'DM allowlist (one user ID per line; empty = reject all)',
        'accounts.allowlist.save': 'Save allowlist',
        'check.passed': 'passed',
        'check.failed': 'failed',
        'check.unverified': 'unverified',
      },
      ja: { 'settings.title': 'IM Union', 'accounts.title': 'アカウント', 'accounts.add': '追加', 'accounts.save': '保存', 'accounts.cancel': '取消', 'accounts.check': '接続確認', 'accounts.pause': '一時停止', 'accounts.resume': '再開', 'accounts.remove': '削除', 'accounts.state.connected': '接続済', 'accounts.state.disconnected': '未接続', 'accounts.state.paused': '停止中', 'check.passed': '成功', 'check.failed': '失敗', 'check.unverified': '未検証' },
      ko: { 'settings.title': 'IM Union', 'accounts.title': '계정', 'accounts.add': '추가', 'accounts.save': '저장', 'accounts.cancel': '취소', 'accounts.check': '연결 확인', 'accounts.pause': '일시정지', 'accounts.resume': '재개', 'accounts.remove': '삭제', 'accounts.state.connected': '연결됨', 'accounts.state.disconnected': '미연결', 'accounts.state.paused': '정지됨', 'check.passed': '통과', 'check.failed': '실패', 'check.unverified': '미검증' },
      fr: { 'settings.title': 'IM Union', 'accounts.title': 'Comptes', 'accounts.add': 'Ajouter', 'accounts.save': 'Enregistrer', 'accounts.cancel': 'Annuler', 'accounts.check': 'Vérifier', 'accounts.pause': 'Suspendre', 'accounts.resume': 'Reprendre', 'accounts.remove': 'Supprimer', 'accounts.state.connected': 'Connecté', 'accounts.state.disconnected': 'Déconnecté', 'accounts.state.paused': 'Suspendu', 'check.passed': 'réussi', 'check.failed': 'échoué', 'check.unverified': 'non vérifié' },
      de: { 'settings.title': 'IM Union', 'accounts.title': 'Konten', 'accounts.add': 'Hinzufügen', 'accounts.save': 'Speichern', 'accounts.cancel': 'Abbrechen', 'accounts.check': 'Verbindung prüfen', 'accounts.pause': 'Pausieren', 'accounts.resume': 'Fortsetzen', 'accounts.remove': 'Entfernen', 'accounts.state.connected': 'Verbunden', 'accounts.state.disconnected': 'Getrennt', 'accounts.state.paused': 'Pausiert', 'check.passed': 'ok', 'check.failed': 'fehlgeschlagen', 'check.unverified': 'ungeprüft' },
      it: { 'settings.title': 'IM Union', 'accounts.title': 'Account', 'accounts.add': 'Aggiungi', 'accounts.save': 'Salva', 'accounts.cancel': 'Annulla', 'accounts.check': 'Controlla', 'accounts.pause': 'Pausa', 'accounts.resume': 'Riprendi', 'accounts.remove': 'Rimuovi', 'accounts.state.connected': 'Connesso', 'accounts.state.disconnected': 'Disconnesso', 'accounts.state.paused': 'In pausa', 'check.passed': 'ok', 'check.failed': 'fallito', 'check.unverified': 'non verificato' },
      ru: { 'settings.title': 'IM Union', 'accounts.title': 'Аккаунты', 'accounts.add': 'Добавить', 'accounts.save': 'Сохранить', 'accounts.cancel': 'Отмена', 'accounts.check': 'Проверить', 'accounts.pause': 'Пауза', 'accounts.resume': 'Возобновить', 'accounts.remove': 'Удалить', 'accounts.state.connected': 'Подключено', 'accounts.state.disconnected': 'Отключено', 'accounts.state.paused': 'Пауза', 'check.passed': 'успех', 'check.failed': 'ошибка', 'check.unverified': 'не проверено' },
      es: { 'settings.title': 'IM Union', 'accounts.title': 'Cuentas', 'accounts.add': 'Añadir', 'accounts.save': 'Guardar', 'accounts.cancel': 'Cancelar', 'accounts.check': 'Comprobar', 'accounts.pause': 'Pausar', 'accounts.resume': 'Reanudar', 'accounts.remove': 'Eliminar', 'accounts.state.connected': 'Conectado', 'accounts.state.disconnected': 'Desconectado', 'accounts.state.paused': 'Pausado', 'check.passed': 'correcto', 'check.failed': 'fallido', 'check.unverified': 'sin verificar' },
    };
    var dictionary = LOCALES.zh;
    function t(key) {
      return (dictionary[key] !== undefined ? dictionary[key] : LOCALES.zh[key]) || key;
    }

    function fetchState(setState, setError) {
      fetch(API_BASE + '/state', {
        credentials: 'same-origin',
        headers: { 'x-dsh-im-union-client': '1' },
      })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then(function (data) {
          setState(data);
          setError(null);
        })
        .catch(function (error) {
          setError(String(error && error.message ? error.message : error));
        });
    }

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

    // 账号区（T1.8）：列表/增删改/暂停恢复/检查连接/白名单编辑。
    // secret 输入只单向提交，提交后清空；回包零值（D4）。
    function AccountsPanel(props) {
      var channels = (props.channels || []).filter(function (c) { return c.implemented; });
      var rowsHook = useState(null);
      var rows = rowsHook[0];
      var setRows = rowsHook[1];
      var noticeHook = useState('');
      var notice = noticeHook[0];
      var setNotice = noticeHook[1];
      var busyHook = useState(false);
      var busy = busyHook[0];
      var setBusy = busyHook[1];
      var checksHook = useState({});
      var checks = checksHook[0];
      var setChecks = checksHook[1];
      var addOpenHook = useState(false);
      var addOpen = addOpenHook[0];
      var setAddOpen = addOpenHook[1];
      var formHook = useState({ channel: channels.length > 0 ? channels[0].id : '', accountId: '', alias: '', secrets: {} });
      var form = formHook[0];
      var setForm = formHook[1];
      var allowHook = useState({});
      var allowDrafts = allowHook[0];
      var setAllowDrafts = allowHook[1];
      // 微信扫码绑定态（T1.2）：null | {qrcode, qrDataUrl, accountId, status, verifyCode?}
      var qrHook = useState(null);
      var qr = qrHook[0];
      var setQr = qrHook[1];

      var load = function () {
        getJSON('/accounts').then(function (result) {
          if (result.status === 200 && result.json && result.json.ok) {
            setRows(result.json.accounts || []);
          } else {
            setRows([]);
            setNotice((result.json && result.json.error) || 'HTTP ' + result.status);
          }
        }).catch(function (error) {
          setNotice(String(error && error.message ? error.message : error));
        });
      };
      useEffect(load, []);

      var withBusy = function (task) {
        setBusy(true);
        Promise.resolve(task()).finally(function () { setBusy(false); });
      };

      var selectedChannel = null;
      for (var ci = 0; ci < channels.length; ci += 1) {
        if (channels[ci].id === form.channel) selectedChannel = channels[ci];
      }

      var submitNew = function () {
        // 账号 ID 自动生成类（通知类与 email 等天然标识渠道）：内部键自动生成。
        var record = form;
        if (selectedChannel && selectedChannel.autoAccountId && form.accountId === '') {
          record = Object.assign({}, form, {
            accountId: form.channel + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          });
        }
        // 微信扫码账号：表单存而连——凭据由扫码流程写入，保存时必须跳过
        // 适配器构建（否则 botToken 缺失工厂即抛 → 被当校验错 400，UI 假报）。
        var payload = { record: record, secrets: form.secrets };
        if (form.channel === 'weixin' && (form.secrets.botToken || '') === '') payload.skipConnect = true;
        withBusy(function () {
          return postJSON('/accounts/save', payload).then(function (result) {
            if (result.status === 200) {
              setNotice(form.channel === 'weixin' && payload.skipConnect ? t('accounts.saved.bindhint') : t('accounts.saved'));
              setAddOpen(false);
              setForm({ channel: form.channel, accountId: '', alias: '', secrets: {} });
              load();
            } else {
              setNotice((result.json && result.json.error) || 'HTTP ' + result.status);
            }
          });
        });
      };

      var doAction = function (path, body, doneNotice) {
        withBusy(function () {
          return postJSON(path, body).then(function (result) {
            if (result.status === 200) {
              if (doneNotice) setNotice(doneNotice);
              load();
            } else {
              setNotice((result.json && result.json.error) || 'HTTP ' + result.status);
            }
          });
        });
      };

      var doCheck = function (accountId) {
        withBusy(function () {
          return postJSON('/accounts/check', { accountId: accountId }).then(function (result) {
            if (result.status === 200 && result.json && result.json.ok) {
              var next = Object.assign({}, checks);
              next[accountId] = result.json.checks || [];
              setChecks(next);
            } else {
              setNotice((result.json && result.json.error) || 'HTTP ' + result.status);
            }
          });
        });
      };

      var startQr = function () {
        // 扫码前先确保内部键存在（代理键全量自动生成，needid 手填时代结束）。
        var acct = form.accountId;
        if (acct === '') {
          acct = form.channel + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          setForm(Object.assign({}, form, { accountId: acct }));
        }
        withBusy(function () {
          return postJSON('/weixin/qr/start', {}).then(function (result) {
            if (result.status === 200 && result.json && result.json.ok) {
              setQr({ qrcode: result.json.qrcode, qrDataUrl: result.json.qrDataUrl, accountId: acct, status: 'wait' });
            } else {
              setNotice((result.json && result.json.error) || 'HTTP ' + result.status);
            }
          });
        });
      };

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
              setNotice(t('accounts.qr.confirmed'));
              setAddOpen(false);
              load();
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

      var body = [];
      body.push(createElement('h4', null, t('accounts.title')));
      if (notice !== '') body.push(createElement('p', { style: { color: '#a33' } }, notice));
      if (busy) body.push(createElement('p', null, '…'));
      if (rows === null) {
        body.push(createElement('p', null, t('panel.loading')));
      } else if (rows.length === 0) {
        body.push(createElement('p', null, t('accounts.empty')));
      } else {
        rows.forEach(function (row) {
          var badge = row.paused
            ? t('accounts.state.paused')
            : row.connected
              ? t('accounts.state.connected')
              : t('accounts.state.disconnected');
          var secretBadges = (row.secretFields || []).map(function (sf) {
            return createElement('span', { key: sf.key, style: { marginLeft: 6 } }, sf.key + ': ' + (sf.configured ? t('accounts.secret.yes') : t('accounts.secret.no')));
          });
          var checkRows = (checks[row.accountId] || []).map(function (c) {
            return createElement('li', { key: c.name }, c.name + ' — ' + t('check.' + c.status) + (c.hint ? '（' + c.hint + '）' : ''));
          });
          var allowValue = allowDrafts[row.accountId] !== undefined
            ? allowDrafts[row.accountId]
            : (row.dmAllowlist || []).join('\n');
          // 策略字段按 type 归位：纯出站通知类不渲染白名单编辑块（后端也已拒写）。
          var rowNotify = false;
          for (var ri = 0; ri < channels.length; ri += 1) {
            if (channels[ri].id === row.channel && channels[ri].notifyOnly === true) rowNotify = true;
          }
          body.push(
            createElement(
              'div',
              { key: row.accountId, style: { border: '1px solid #ddd', borderRadius: 8, padding: 10, marginTop: 8 } },
              createElement(
                'div',
                null,
                createElement('strong', null, row.accountId + (row.alias ? '（' + row.alias + '）' : '')),
                createElement('span', { style: { marginLeft: 8, color: '#666' } }, row.channel + ' · ' + badge),
                createElement('span', { style: { marginLeft: 8 } }, secretBadges)
              ),
              createElement(
                'div',
                { style: { marginTop: 6 } },
                createElement('button', { onClick: function () { doCheck(row.accountId); }, disabled: busy }, t('accounts.check')),
                createElement('button', {
                  style: { marginLeft: 6 },
                  disabled: busy,
                  onClick: function () { doAction('/accounts/pause', { accountId: row.accountId, paused: !row.paused }); },
                }, row.paused ? t('accounts.resume') : t('accounts.pause')),
                createElement('button', {
                  style: { marginLeft: 6 },
                  disabled: busy,
                  onClick: function () {
                    if (window.confirm(t('accounts.confirm.remove'))) {
                      doAction('/accounts/remove', { accountId: row.accountId }, t('accounts.removed'));
                    }
                  },
                }, t('accounts.remove'))
              ),
              checkRows.length > 0 ? createElement('ul', null, checkRows) : null,
              rowNotify
                ? null
                : createElement('div', { style: { marginTop: 6 } }, t('accounts.allowlist')),
              rowNotify
                ? null
                : createElement('textarea', {
                    rows: 2,
                    style: { width: '100%', marginTop: 2 },
                    value: allowValue,
                    onChange: function (event) {
                      var next = Object.assign({}, allowDrafts);
                      next[row.accountId] = event.target.value;
                      setAllowDrafts(next);
                    },
                  }),
              rowNotify
                ? null
                : createElement('button', {
                    style: { marginTop: 4 },
                    disabled: busy,
                    onClick: function () {
                      var ids = String(allowValue || '')
                        .split('\n')
                        .map(function (v) { return v.trim(); })
                        .filter(function (v) { return v !== ''; });
                      doAction('/accounts/allowlist', { accountId: row.accountId, userIds: ids }, t('accounts.saved'));
                    },
                  }, t('accounts.allowlist.save'))
            )
          );
        });
      }

      if (!addOpen) {
        body.push(
          createElement('button', { style: { marginTop: 10 }, onClick: function () { setAddOpen(true); } }, t('accounts.add'))
        );
      } else {
        var fieldInputs = [];
        ((selectedChannel && selectedChannel.fields) || []).forEach(function (field) {
          fieldInputs.push(
            createElement(
              'label',
              { key: field.key, style: { display: 'block', marginTop: 6 } },
              (field.label && (field.label.zh || field.label.en)) || field.key,
              createElement('input', {
                type: field.secret ? 'password' : 'text',
                value: form.secrets[field.key] || '',
                style: { marginLeft: 8 },
                onChange: function (event) {
                  var secrets = Object.assign({}, form.secrets);
                  secrets[field.key] = event.target.value;
                  setForm(Object.assign({}, form, { secrets: secrets }));
                },
              })
            )
          );
        });
        var qrBlock = null;
        if (form.channel === 'weixin') {
          if (qr === null || qr.status === 'expired') {
            qrBlock = createElement(
              'div',
              { key: 'qr-idle', style: { marginTop: 8 } },
              createElement('button', { onClick: startQr, disabled: busy }, t(qr === null ? 'accounts.qr.get' : 'accounts.qr.refresh'))
            );
          } else if (qr.status === 'confirmed') {
            qrBlock = createElement('p', { key: 'qr-done', style: { color: '#2a6' } }, t('accounts.qr.confirmed'));
          } else {
            var qrChildren = [
              createElement('img', { key: 'img', src: qr.qrDataUrl, width: 200, height: 200, alt: 'login qr', style: { display: 'block' } }),
              createElement('p', { key: 'st', style: { marginTop: 4 } }, t('accounts.qr.' + qr.status)),
            ];
            if (qr.status === 'need_verifycode') {
              qrChildren.push(
                createElement(
                  'div',
                  { key: 'vc' },
                  createElement('input', {
                    value: qr.verifyCode || '',
                    onChange: function (event) { setQr(Object.assign({}, qr, { verifyCode: event.target.value })); },
                  }),
                  createElement(
                    'button',
                    { style: { marginLeft: 6 }, onClick: function () { setQr(Object.assign({}, qr, { status: 'wait' })); } },
                    t('accounts.qr.code.submit')
                  )
                )
              );
            }
            qrChildren.push(
              createElement(
                'button',
                { key: 'cancel', style: { marginTop: 4 }, onClick: function () { setQr(null); } },
                t('accounts.qr.cancel')
              )
            );
            qrBlock = createElement('div', { key: 'qr-live', style: { marginTop: 8, padding: 8, border: '1px solid #ddd', borderRadius: 8 } }, qrChildren);
          }
        }
        body.push(
          createElement(
            'div',
            { key: 'add-form', style: { border: '1px dashed #bbb', borderRadius: 8, padding: 10, marginTop: 10 } },
            createElement(
              'label',
              null,
              t('accounts.channel'),
              createElement(
                'select',
                {
                  style: { marginLeft: 8 },
                  value: form.channel,
                  onChange: function (event) {
                    setForm(Object.assign({}, form, { channel: event.target.value, secrets: {} }));
                  },
                },
                channels.map(function (channel) {
                  return createElement('option', { key: channel.id, value: channel.id }, (channel.label && (channel.label.zh || channel.label.en)) || channel.id);
                })
              )
            ),
            // 账号 ID 自动生成类：隐藏输入框（提交时自动生成内部键）。
            selectedChannel && selectedChannel.autoAccountId
              ? null
              : createElement(
                  'label',
                  { style: { display: 'block', marginTop: 6 } },
                  t('accounts.accountId'),
                  createElement('input', {
                    value: form.accountId,
                    style: { marginLeft: 8 },
                    onChange: function (event) { setForm(Object.assign({}, form, { accountId: event.target.value })); },
                  })
                ),
            createElement(
              'label',
              { style: { display: 'block', marginTop: 6 } },
              t('accounts.alias'),
              createElement('input', {
                value: form.alias,
                style: { marginLeft: 8 },
                onChange: function (event) { setForm(Object.assign({}, form, { alias: event.target.value })); },
              })
            ),
            fieldInputs,
            qrBlock,
            createElement(
              'div',
              { style: { marginTop: 8 } },
              createElement('button', { onClick: submitNew, disabled: busy || form.channel === '' || (!(selectedChannel && selectedChannel.autoAccountId) && form.accountId === '') }, t('accounts.save')),
              createElement(
                'button',
                { style: { marginLeft: 6 }, onClick: function () { setAddOpen(false); } },
                t('accounts.cancel')
              )
            )
          )
        );
      }
      return createElement('div', { style: { marginTop: 12 } }, body);
    }

    function UnionPanel() {
      var stateHook = useState(null);
      var state = stateHook[0];
      var setState = stateHook[1];
      var errorHook = useState(null);
      var error = errorHook[0];
      var setError = errorHook[1];
      useEffect(function () {
        fetchState(setState, setError);
        var timer = setInterval(function () { fetchState(setState, setError); }, 30000);
        return function () { clearInterval(timer); };
      }, []);
      if (error !== null) {
        return createElement('div', { style: { padding: 12 } }, t('panel.error') + ' (' + error + ')');
      }
      if (state === null) {
        return createElement('div', { style: { padding: 12 } }, t('panel.loading'));
      }
      var caps = state.capabilities || {};
      var channels = state.channels || [];
      var done = channels.filter(function (channel) { return channel.implemented; }).length;
      return createElement(
        'div',
        { style: { padding: 16, maxWidth: 720 } },
        createElement('h3', null, t('settings.title')),
        // 调试内容（代际/后端/凭据/渠道实现度清单）收进默认折叠的诊断块，
        // 面板首屏只剩账号管理；排障时展开即可，不另设开关。
        createElement(
          'details',
          { style: { margin: '8px 0', fontSize: 12, color: 'inherit', opacity: 0.75 } },
          createElement('summary', null, t('panel.debug')),
          createElement('p', null, t('panel.generation') + ': ' + String(caps.settingsGeneration || '-')),
          createElement('p', null, t('panel.sessionBackend') + ': ' + String(caps.sessionBackend || '-')),
          createElement('p', null, t('panel.vault') + ': ' + String(caps.vaultKind || '-')),
          createElement(
            'p',
            null,
            t('panel.channels') + ': ' + done + '/' + channels.length + ' ' + t('panel.implemented')
          ),
          createElement(
            'ul',
            null,
            channels.map(function (channel) {
              return createElement(
                'li',
                { key: channel.id },
                (channel.label && (channel.label.zh || channel.label.en)) +
                  ' — ' +
                  (channel.implemented ? t('panel.implemented') : t('panel.planned'))
              )
            })
          )
        ),
        createElement(AccountsPanel, { channels: channels })
      );
    }

    // gen1 兜底：宿主没有设置页时挂一个最小浮窗（可关闭）。
    function overlayFallback() {
      try {
        if (typeof document === 'undefined') return;
        if (document.getElementById('dsh-im-union-overlay')) return;
        var host = document.createElement('div');
        host.id = 'dsh-im-union-overlay';
        host.style.cssText =
          'position:fixed;right:16px;bottom:16px;z-index:9999;background:#fff;border:1px solid #ccc;border-radius:8px;max-height:60vh;overflow:auto;width:360px';
        document.body.appendChild(host);
        if (window.ReactDOM && typeof window.ReactDOM.createRoot === 'function') {
          window.ReactDOM.createRoot(host).render(createElement(UnionPanel));
        } else if (window.ReactDOM && typeof window.ReactDOM.render === 'function') {
          window.ReactDOM.render(createElement(UnionPanel), host);
        }
      } catch (error) {
        console.warn('[dsh-im-union] 浮窗兜底失败：', error);
      }
    }

    var inject = ['slots', 'locale'];

    function apply(ctx) {
      console.info('[dsh-im-union] apply invoked, slots:', typeof ctx && ctx.slots ? Object.keys(ctx.slots).join(',') : 'none')
      // apply 期顶层注册——不许关进任何回调。
      try {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.locale.register('im-union', LOCALES);
          dictionary = ctx.locale.dictionary ? ctx.locale.dictionary : dictionary;
        }
      } catch (error) {
        console.warn('[dsh-im-union] 语言包注册失败（回落 zh）：', error);
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
