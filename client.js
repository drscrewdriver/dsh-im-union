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
        'panel.channels': '渠道实现度',
        'panel.implemented': '已实现',
        'panel.planned': '规划中',
      },
      en: {
        'settings.title': 'IM Union Bridge',
        'panel.loading': 'Loading local state…',
        'panel.error': 'Management API unreachable. Restart the host and refresh.',
        'panel.generation': 'Settings generation',
        'panel.sessionBackend': 'Session backend',
        'panel.vault': 'Credential vault',
        'panel.channels': 'Channels',
        'panel.implemented': 'implemented',
        'panel.planned': 'planned',
      },
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
            );
          })
        )
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
      try {
        var section = {
          id: 'dsh-im-union.settings',
          label: t('settings.title'),
          order: 41,
          component: UnionPanel,
        };
        if (ctx.slots && typeof ctx.slots.inject === 'function') {
          // 走包装管道（裸 register 在 ≤0.1.5 壳不解）。
          ctx.slots.inject('settings.section', section);
          registered = true;
        } else if (ctx.slots && typeof ctx.slots.register === 'function') {
          ctx.slots.register('settings.section', section);
          registered = true;
        }
      } catch (error) {
        console.warn('[dsh-im-union] settings.section 槽位不可用：', error);
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
