// ==UserScript==
// @name         Claude Conversations Exporter (Ombre)
// @namespace    https://github.com/ceshihaox-dotcom/OmbreBrain-folio
// @version      0.1.0
// @description  在 claude.ai 多选对话, 导出为 Ombre 兼容的合并 JSON (拦截 Claude 内部 API, 不依赖 DOM 抓取)
// @author       rin
// @match        https://claude.ai/*
// @grant        none
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/ceshihaox-dotcom/OmbreBrain-folio/main/tools/claude-exporter.user.js
// @downloadURL  https://raw.githubusercontent.com/ceshihaox-dotcom/OmbreBrain-folio/main/tools/claude-exporter.user.js
// ==/UserScript==

/*
  ─────────────────────────────────────────────────────────────────
   工作流
  ─────────────────────────────────────────────────────────────────
   1. 进 claude.ai (任意页面, 主页或对话页都行)
   2. 右上角出现工具栏: "已选 0 条 [全选] [清空] [📥 导出]"
   3. 左侧 sidebar 每个对话条目前会自动出现 checkbox (hover 时不破坏原 UI)
   4. 勾选要导出的对话 → 点 [📥 导出]
   5. 脚本顺序调用 Claude 内部 API 抓每条对话的完整内容 (200ms 间隔防限流)
   6. 合并成单个 JSON array 自动下载
   7. 下载的文件直接拖到 Ombre 工作台导入

  ─────────────────────────────────────────────────────────────────
   输出格式
  ─────────────────────────────────────────────────────────────────
   [
     {
       "uuid": "...",
       "name": "对话标题",
       "summary": "",
       "created_at": "...",
       "chat_messages": [
         { "uuid": "...", "text": "...", "sender": "human", "created_at": "..." },
         { "uuid": "...", "text": "...", "sender": "assistant", "created_at": "..." }
       ]
     },
     ...
   ]
   这是 Anthropic 官方 export 的子集格式, Ombre import_memory.py
   _parse_claude_json() 原生支持 (顶层 array 时遍历每个 conversation).

  ─────────────────────────────────────────────────────────────────
   为什么这个比浏览器插件稳
  ─────────────────────────────────────────────────────────────────
   - 浏览器插件常用 DOM 抓取 (querySelector 网页元素), Claude 改 UI 必挂
   - 本脚本直接 fetch Claude 自己的内部 API (/api/organizations/.../chat_conversations/...)
   - API 字段稳定, response 是 JSON 结构化, 改动频率远低于 UI
   - 如果 Claude 换 API 路径, 改一行代码即可

  ─────────────────────────────────────────────────────────────────
   限制
  ─────────────────────────────────────────────────────────────────
   - sidebar checkbox 注入依赖 a[href^="/chat/"] 选择器, 如果 Claude
     改 URL 结构需要更新 SIDEBAR_LINK_SELECTOR 常量
   - 大量对话一次性导出可能撞 rate limit, 已加 200ms 延迟保守处理
*/

(function () {
  'use strict';

  // ============================================================
  // 配置 (Claude 改 API 时需要更新这里)
  // ============================================================
  const ORGS_API           = '/api/organizations';
  const CONV_API_TEMPLATE  = (orgId, convId) =>
    `/api/organizations/${orgId}/chat_conversations/${convId}?tree=True&rendering_mode=raw`;
  const SIDEBAR_LINK_SELECTOR = 'a[href^="/chat/"]';
  const FETCH_DELAY_MS = 200;
  const SCAN_INTERVAL_MS = 1500;  // SPA 路由变化后 sidebar 重渲染, 周期扫描

  // ============================================================
  // 状态
  // ============================================================
  const SELECTED = new Set();   // 选中的 conversation UUID
  let _orgUuidCache = null;
  let toolbarEl = null;
  let progressEl = null;

  // ============================================================
  // API 调用
  // ============================================================
  async function getOrgUuid() {
    if (_orgUuidCache) return _orgUuidCache;
    const r = await fetch(ORGS_API, { credentials: 'include' });
    if (!r.ok) throw new Error('GET /api/organizations failed: ' + r.status);
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('No organizations found in response');
    }
    _orgUuidCache = data[0].uuid;
    return _orgUuidCache;
  }

  async function fetchConversation(convUuid) {
    const orgId = await getOrgUuid();
    const url = CONV_API_TEMPLATE(orgId, convUuid);
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error('GET conversation ' + convUuid + ' failed: ' + r.status);
    return r.json();
  }

  // ============================================================
  // 数据转换 (Claude API → Ombre 兼容格式)
  // ============================================================
  function extractMessageText(msg) {
    // Claude API 不同版本: msg.text (string) 或 msg.content (array of {type, text})
    if (typeof msg.text === 'string' && msg.text.trim()) return msg.text;
    if (Array.isArray(msg.content)) {
      return msg.content
        .map(p => (p && typeof p === 'object' && p.type === 'text') ? (p.text || '') : '')
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }

  function normalizeConversation(apiResp) {
    const messages = (apiResp.chat_messages || [])
      .map(msg => ({
        uuid: msg.uuid || '',
        text: extractMessageText(msg),
        sender: msg.sender || 'unknown',
        created_at: msg.created_at || '',
      }))
      .filter(m => m.text && m.text.trim());

    return {
      uuid: apiResp.uuid || '',
      name: apiResp.name || '(无标题)',
      summary: apiResp.summary || '',
      created_at: apiResp.created_at || '',
      updated_at: apiResp.updated_at || '',
      chat_messages: messages,
    };
  }

  // ============================================================
  // 下载文件
  // ============================================================
  function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ============================================================
  // UI — 样式
  // ============================================================
  function injectStyles() {
    if (document.getElementById('ob-exporter-styles')) return;
    const css = `
      .ob-export-toolbar {
        position: fixed; top: 12px; right: 16px; z-index: 99999;
        background: rgba(36, 28, 56, 0.95); color: #fff;
        padding: 8px 14px; border-radius: 8px;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, sans-serif;
        box-shadow: 0 4px 14px rgba(0,0,0,0.35);
        display: flex; align-items: center; gap: 8px;
        backdrop-filter: blur(8px);
      }
      .ob-export-count {
        font-weight: 600; opacity: 0.9; min-width: 70px;
        font-variant-numeric: tabular-nums;
      }
      .ob-export-btn {
        background: #6e4f9a; border: 0; color: #fff;
        padding: 5px 11px; border-radius: 4px; cursor: pointer;
        font: inherit; transition: background .15s, opacity .15s;
      }
      .ob-export-btn:hover:not(:disabled) { background: #856bb0; }
      .ob-export-btn:disabled { opacity: 0.35; cursor: not-allowed; }
      .ob-export-btn.secondary {
        background: transparent; border: 1px solid rgba(255,255,255,0.25);
      }
      .ob-export-btn.secondary:hover:not(:disabled) {
        background: rgba(255,255,255,0.1);
      }
      .ob-export-checkbox {
        width: 14px; height: 14px; cursor: pointer;
        margin-right: 6px; flex-shrink: 0;
        accent-color: #6e4f9a;
      }
      .ob-export-progress {
        position: fixed; top: 60px; right: 16px; z-index: 99998;
        background: rgba(36, 28, 56, 0.95); color: #fff;
        padding: 10px 14px; border-radius: 8px;
        font: 12px/1.5 -apple-system, BlinkMacSystemFont, sans-serif;
        max-width: 280px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.35);
        backdrop-filter: blur(8px);
      }
    `;
    const s = document.createElement('style');
    s.id = 'ob-exporter-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ============================================================
  // UI — 顶部工具栏
  // ============================================================
  function createToolbar() {
    if (toolbarEl) return toolbarEl;
    const el = document.createElement('div');
    el.className = 'ob-export-toolbar';
    el.innerHTML = `
      <span class="ob-export-count">已选 0 条</span>
      <button class="ob-export-btn secondary" data-action="select-all">全选</button>
      <button class="ob-export-btn secondary" data-action="clear">清空</button>
      <button class="ob-export-btn" data-action="export" disabled>📥 导出</button>
    `;
    el.addEventListener('click', (e) => {
      const action = e.target.dataset && e.target.dataset.action;
      if (!action) return;
      if (action === 'select-all') selectAll();
      else if (action === 'clear') clearAll();
      else if (action === 'export') doExport();
    });
    document.body.appendChild(el);
    toolbarEl = el;
    return el;
  }

  function updateToolbar() {
    if (!toolbarEl) return;
    const cnt = SELECTED.size;
    toolbarEl.querySelector('.ob-export-count').textContent = `已选 ${cnt} 条`;
    toolbarEl.querySelector('[data-action="export"]').disabled = cnt === 0;
  }

  // ============================================================
  // UI — Sidebar 对话条目 checkbox 注入
  // ============================================================
  function injectCheckboxes() {
    const links = document.querySelectorAll(SIDEBAR_LINK_SELECTOR);
    links.forEach(link => {
      if (link.dataset.obInjected === '1') return;

      // 解析 conversation UUID — /chat/{uuid}[?...] 或 /chat/{uuid}[#...]
      const href = link.getAttribute('href') || '';
      const m = href.match(/^\/chat\/([0-9a-f-]{20,})/i);
      if (!m) return;
      const uuid = m[1];

      link.dataset.obInjected = '1';
      link.dataset.obUuid = uuid;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'ob-export-checkbox';
      cb.checked = SELECTED.has(uuid);
      cb.addEventListener('mousedown', (e) => e.stopPropagation());
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (SELECTED.has(uuid)) SELECTED.delete(uuid);
        else SELECTED.add(uuid);
        cb.checked = SELECTED.has(uuid);
        updateToolbar();
      });

      // 插到链接最前面 (link 大概率是 flex 容器, checkbox 落到最左)
      link.insertBefore(cb, link.firstChild);
    });
  }

  function selectAll() {
    document.querySelectorAll(SIDEBAR_LINK_SELECTOR).forEach(link => {
      const uuid = link.dataset.obUuid;
      if (uuid) SELECTED.add(uuid);
    });
    document.querySelectorAll('.ob-export-checkbox').forEach(cb => cb.checked = true);
    updateToolbar();
  }

  function clearAll() {
    SELECTED.clear();
    document.querySelectorAll('.ob-export-checkbox').forEach(cb => cb.checked = false);
    updateToolbar();
  }

  // ============================================================
  // UI — 进度提示
  // ============================================================
  function showProgress(html) {
    if (!progressEl) {
      progressEl = document.createElement('div');
      progressEl.className = 'ob-export-progress';
      document.body.appendChild(progressEl);
    }
    progressEl.innerHTML = html;
    progressEl.style.display = 'block';
  }

  function hideProgress() {
    if (progressEl) progressEl.style.display = 'none';
  }

  // ============================================================
  // 导出
  // ============================================================
  async function doExport() {
    if (SELECTED.size === 0) return;
    const ids = Array.from(SELECTED);
    const total = ids.length;

    const estSec = Math.ceil(total * (FETCH_DELAY_MS + 600) / 1000);
    if (!confirm(`即将导出 ${total} 条对话, 预计需要约 ${estSec} 秒.\n继续?`)) return;

    const conversations = [];
    let succeeded = 0, failed = 0;
    const errors = [];

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      showProgress(`导出中 ${i + 1}/${total}<br>成功 ${succeeded} · 失败 ${failed}`);
      try {
        const apiResp = await fetchConversation(id);
        const conv = normalizeConversation(apiResp);
        if (conv.chat_messages.length === 0) {
          errors.push(`${id.slice(0, 8)}: 0 messages (空对话?)`);
        }
        conversations.push(conv);
        succeeded++;
      } catch (e) {
        console.error('[ob-exporter] failed for', id, e);
        errors.push(`${id.slice(0, 8)}: ${e.message}`);
        failed++;
      }
      if (i < ids.length - 1) await sleep(FETCH_DELAY_MS);
    }

    if (conversations.length === 0) {
      hideProgress();
      alert(`导出失败: 0 成功 / ${failed} 失败.\n查看 console (F12) 获取详细报错.`);
      return;
    }

    const date = new Date().toISOString().slice(0, 10);
    const filename = `claude-export-${conversations.length}-conv-${date}.json`;
    downloadJson(conversations, filename);

    let msg = `✅ 已下载 ${filename}<br>成功 ${succeeded} · 失败 ${failed}`;
    if (errors.length > 0) {
      msg += `<br><br>错误:<br>` + errors.slice(0, 3).map(e => `· ${e}`).join('<br>');
      if (errors.length > 3) msg += `<br>... 共 ${errors.length} 条 (查看 console)`;
    }
    showProgress(msg);
    setTimeout(hideProgress, 8000);

    // 不清空选择, 让用户能继续操作
  }

  // ============================================================
  // 启动
  // ============================================================
  function init() {
    injectStyles();
    createToolbar();
    updateToolbar();

    // 周期性扫描 (Claude 是 SPA, 路由变化 sidebar 重渲染, MutationObserver
    // 在 React 大量重渲染下表现差, setInterval 简单稳)
    setInterval(injectCheckboxes, SCAN_INTERVAL_MS);
    injectCheckboxes();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
