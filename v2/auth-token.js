// ============================================================
// Ombre Brain —— 全局鉴权 token 注入 (所有 v2 页面在 <head> 最前加载)
// ------------------------------------------------------------
// OB 服务端现在要求 X-Admin-Token (除静态页 / /health 外的 /api/* + /mcp 都要门)。
// 这里同时包 window.fetch 和 XMLHttpRequest:
//   · 给同源 /api/ (及 /mcp) 请求自动带上 localStorage['ombre-admin-token'];
//   · fetch 拿到 401 时弹一次 prompt 让你输 token, 存进 localStorage 后刷新页面。
// ⚠ 必须两者都包: 主站点走 fetch, 但工作台(console)等页面用 XMLHttpRequest —— 只包 fetch
//   会让 XHR 请求漏带 token → 401 (历史 bug)。
// 必须在任何业务请求之前执行 —— 所以用普通 <script> 放在 <head> 最前。
// ============================================================
(function () {
  if (window.__obAuthPatched) return;
  window.__obAuthPatched = true;

  var KEY = 'ombre-admin-token';

  function getToken() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  // 把 token 同步到 cookie。用途: 工作台(console)等页面用 Web Worker 拉数据,
  // worker 既不经主线程的 fetch/XHR patch、也读不到 localStorage —— 但浏览器对
  // 同源请求(含 worker fetch/XHR)会自动带上 cookie。服务端 AuthGate 同时接受
  // X-Admin-Token header 或此 cookie。SameSite=Strict + 服务端 CORS 收紧 → 挡 CSRF。
  function syncCookie(token) {
    try {
      if (!token) return;
      var secure = (location.protocol === 'https:') ? '; Secure' : '';
      document.cookie = 'ombre_admin_token=' + token + '; path=/; SameSite=Strict' + secure;
    } catch (e) {}
  }
  syncCookie(getToken());  // 进页面时若已有 token, 立刻同步进 cookie

  // 同源需要鉴权的请求: /api/* 或 /mcp。兼容相对/绝对 URL、有无前导斜杠。
  // (^|/) 边界防误伤 "therapi/" 之类把 api 当子串。
  function needsToken(url) {
    if (!url || typeof url !== 'string') return false;
    return /(^|\/)(api|mcp)(\/|$|\?|#)/.test(url);
  }

  function urlOf(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
    } catch (e) {}
    return '';
  }

  // --- 1) 包 window.fetch ---
  var _fetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = urlOf(input);
    var need = needsToken(url);

    if (need) {
      var token = getToken();
      if (token) {
        init = init || {};
        var h = new Headers(init.headers || {});
        if (!h.has('X-Admin-Token')) h.set('X-Admin-Token', token);
        init.headers = h;
      }
    }

    return _fetch(input, init).then(function (res) {
      if (res && res.status === 401 && need && !window.__obAuthPrompting) {
        window.__obAuthPrompting = true;
        try {
          var entered = window.prompt(
            'Ombre 需要管理员 token (X-Admin-Token)。\n在部署平台设的 OMBRE_ADMIN_TOKEN 值:',
            ''
          );
          if (entered && entered.trim()) {
            try { localStorage.setItem(KEY, entered.trim()); } catch (e) {}
            syncCookie(entered.trim());
            location.reload();
            return res;
          }
        } catch (e) {}
        window.__obAuthPrompting = false;
      }
      return res;
    });
  };

  // --- 2) 包 XMLHttpRequest (工作台等用 XHR 的页面也要带 token) ---
  try {
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype && XHR.prototype.open && XHR.prototype.send) {
      var _open = XHR.prototype.open;
      var _send = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        try { this.__obUrl = url; } catch (e) {}
        return _open.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        try {
          if (needsToken(this.__obUrl)) {
            var t = getToken();
            if (t) {
              try { this.setRequestHeader('X-Admin-Token', t); } catch (e) {}
            }
          }
        } catch (e) {}
        return _send.apply(this, arguments);
      };
    }
  } catch (e) {}
})();
