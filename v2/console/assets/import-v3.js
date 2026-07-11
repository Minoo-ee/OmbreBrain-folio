// import-v3.jsx — Ombre Brain 导入区 v3 (Claude Design)
// 包在 IIFE 里隔离 hook 别名,避免跟其他 text/babel 脚本作用域冲突;
// 三个组件最终通过 window.ImportDropZone / ImportPasteSheet / ImportProgressBanner 暴露。

(function () {
  const { useState, useEffect, useMemo, useRef } = React;

  // ─── utilities ────────────────────────────────────────────────────────────
  function _formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }
  function _formatDuration(ms) {
    if (ms < 0 || !Number.isFinite(ms)) return '—';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m === 0) return `${r}s`;
    return `${m}m${String(r).padStart(2, '0')}s`;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 1. ImportDropZone
  function ImportDropZone({
    isOver = false,
    draggedFiles = null,
    tryMode = false,
    onTryModeChange = () => {},
    importMode = 'large',  // 'large' (默认, 宁缺勿滥) | 'small' (补漏, 必出 1 条)
    onImportModeChange = () => {},
    onPickFiles = () => {},
    onPasteToggle = () => {},
  }) {
    const totalSize = useMemo(() => {
      if (!draggedFiles || !draggedFiles.length) return 0;
      return draggedFiles.reduce((a, f) => a + (f.size || 0), 0);
    }, [draggedFiles]);

    return (
      <div
        className={`ob-import-drop ${isOver ? 'is-over' : ''}`}
        onClick={onPickFiles}
        role="button"
        tabIndex={0}
      >
        <div className="ob-import-drop-glyph">↓</div>

        <div className="ob-import-drop-body">
          <div className="ob-import-drop-headline">
            <span>
              <span className="ob-import-drop-headline-em">拖拽文件</span>到此处或点击
            </span>
            <span className="ob-import-drop-headline-sep">——</span>
            <span className="ob-import-drop-headline-aux">自动解析</span>
          </div>
          <div className="ob-import-drop-formats">
            <span>Claude JSON</span>
            <span>ChatGPT ZIP</span>
            <span>DeepSeek</span>
            <span>Markdown</span>
            <span>TXT</span>
            <span className="or">
              or&nbsp;
              <a
                className="or-link"
                onClick={(e) => { e.stopPropagation(); onPasteToggle(); }}
              >粘贴原文</a>
              &nbsp;→
            </span>
          </div>
        </div>

        <div className="ob-import-drop-controls" onClick={(e) => e.stopPropagation()}>
          <label className={`ob-import-checkbox ${tryMode ? 'is-on' : ''}`}>
            <span className="ob-import-checkbox-box" aria-hidden="true"></span>
            <input
              type="checkbox"
              checked={tryMode}
              onChange={(e) => onTryModeChange(e.target.checked)}
              style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
            />
            试跑模式
          </label>
          {/* 小分量(补漏)模式 — 默认 unchecked = 大分量(宁缺勿滥, 主流批量导入);
              checked = 小分量(必出 1 条, 用户主动补漏一段时勾上) */}
          <label
            className={`ob-import-checkbox ${importMode === 'small' ? 'is-on' : ''}`}
            title="默认大分量(宁缺勿滥, 适合大批量); 勾选切到小分量(必出 1 条, 补漏用)"
          >
            <span className="ob-import-checkbox-box" aria-hidden="true"></span>
            <input
              type="checkbox"
              checked={importMode === 'small'}
              onChange={(e) => onImportModeChange(e.target.checked ? 'small' : 'large')}
              style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
            />
            小分量(补漏)
          </label>
        </div>

        <div className="ob-import-drop-preview">
          <div className="ob-import-drop-preview-inner">
            <div className="ob-import-drop-preview-content">
              {draggedFiles && draggedFiles.length > 0 ? (
                <>
                  <span>已检测到: <b>{draggedFiles.length}</b> 个文件 · 总 <b>{_formatBytes(totalSize)}</b></span>
                  <span className="ob-import-drop-preview-files">
                    {draggedFiles.slice(0, 4).map((f, i) => (
                      <span key={i} className="ob-import-drop-preview-file">
                        <span className="ob-import-drop-preview-file-name">{f.name}</span>
                        <span className="ob-import-drop-preview-file-size">{_formatBytes(f.size)}</span>
                      </span>
                    ))}
                    {draggedFiles.length > 4 && (
                      <span className="ob-import-drop-preview-file" style={{ opacity: 0.6 }}>
                        +{draggedFiles.length - 4} 更多
                      </span>
                    )}
                  </span>
                </>
              ) : (
                <span style={{ color: 'var(--ink-3)', fontStyle: 'italic', fontFamily: 'var(--serif)' }}>
                  松手即开始解析 …
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 2. ImportPasteSheet
  function ImportPasteSheet({
    open = false,
    value = '',
    filename = '',
    onChange = () => {},
    onFilenameChange = () => {},
    onClose = () => {},
    onSubmit = () => {},
    onClear = () => {},
    onOpen = () => {},
  }) {
    const charCount = value.length;
    const estChunks = charCount === 0 ? 0 : Math.max(1, Math.round(charCount / 500));
    const MAX_CHARS_HINT = 80000;
    const fillPct = Math.min(100, (charCount / MAX_CHARS_HINT) * 100);

    if (!open) {
      return (
        <div className="ob-import-paste is-collapsed" onClick={onOpen} role="button" tabIndex={0}>
          <div className="ob-import-paste-collapsed-icon">¶</div>
          <div className="ob-import-paste-collapsed-label">粘贴原文</div>
          <div className="ob-import-paste-collapsed-hint">任意对话片段 / Markdown / 笔记</div>
          <div className="ob-import-paste-collapsed-arrow">↗</div>
        </div>
      );
    }

    return (
      <div className="ob-import-paste">
        <div className="ob-import-paste-hd">
          <div
            className="ob-import-paste-titlebox"
            onClick={onClose}
            role="button"
            tabIndex={0}
            title="再次点击收起"
            style={{ cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: 10, flex: 1 }}
          >
            <div className="ob-import-paste-title">粘贴原文</div>
            <div className="ob-import-paste-title-sub">任意对话片段 / Markdown / 笔记</div>
          </div>
          <div className="ob-import-paste-filename">
            <input
              type="text"
              placeholder="文件名(可选)"
              value={filename}
              onChange={(e) => onFilenameChange(e.target.value)}
            />
          </div>
        </div>
        <div className="ob-import-paste-body">
          <textarea
            className="ob-import-paste-textarea"
            placeholder={'例如:\n- 我: ...\n- Claude: ...\n直接粘进来,后续会被拆成多条记忆。'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={6}
          />
        </div>
        <div className="ob-import-paste-meter">
          {charCount === 0 ? (
            <span className="ob-import-paste-meter-empty">空白 — 粘贴文本后会实时估算 chunk 数</span>
          ) : (
            <>
              <span><b>{charCount.toLocaleString()}</b> 字</span>
              <span style={{ color: 'var(--ink-4)' }}>·</span>
              <span>约 <b className="em">{estChunks}</b> chunk</span>
              <div className="ob-import-paste-meter-bar" aria-hidden="true">
                <div className="ob-import-paste-meter-fill" style={{ width: `${fillPct}%` }} />
              </div>
            </>
          )}
        </div>
        <div className="ob-import-paste-foot">
          <button className="ob-import-paste-btn" onClick={onClear} disabled={charCount === 0}>
            清空
          </button>
          <button
            className="ob-import-paste-btn is-primary"
            onClick={() => onSubmit(value)}
            disabled={charCount === 0}
          >
            开始解析
          </button>
        </div>
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 3. ImportProgressBanner
  function _useCountUp(target, durationMs = 1100, enabled = true) {
    const [v, setV] = useState(enabled ? 0 : target);
    const startRef = useRef(null);
    const rafRef = useRef(null);
    useEffect(() => {
      if (!enabled) { setV(target); return; }
      cancelAnimationFrame(rafRef.current);
      startRef.current = null;
      const tick = (t) => {
        if (startRef.current == null) startRef.current = t;
        const p = Math.min(1, (t - startRef.current) / durationMs);
        const eased = 1 - Math.pow(1 - p, 3);
        setV(Math.round(target * eased));
        if (p < 1) rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(rafRef.current);
    }, [target, durationMs, enabled]);
    return v;
  }

  function ImportProgressBanner({
    state,
    onPause = () => {},
    onResume = () => {},
    onCancel = () => {},
    onDismiss = () => {},
    onRetry = () => {},
    onCopyLLM = () => {},
  }) {
    const {
      status, total_chunks, processed,
      memories_created, memories_merged, memories_raw,
      errors = [], started_at,
      recent_extracted = [],
      last_llm_output, last_llm_parsed_ok = true,
      total_cost_usd = 0,
    } = state;

    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
      if (status !== 'running') return;
      const id = setInterval(() => setNow(Date.now()), 500);
      return () => clearInterval(id);
    }, [status]);

    const startedMs = useMemo(() => {
      if (!started_at) return null;
      const t = new Date(started_at).getTime();
      return Number.isFinite(t) ? t : null;
    }, [started_at]);
    const elapsedMs = startedMs ? Math.max(0, now - startedMs) : 0;
    const remainingMs = (() => {
      if (!startedMs || processed <= 0 || total_chunks <= 0) return null;
      const perChunk = elapsedMs / processed;
      return perChunk * (total_chunks - processed);
    })();

    const pct = total_chunks > 0 ? Math.round((processed / total_chunks) * 100) : 0;

    const [collapsedSummary, setCollapsedSummary] = useState(false);
    useEffect(() => {
      setCollapsedSummary(false);
      if (status !== 'completed') return;
      const id = setTimeout(() => setCollapsedSummary(true), 1400);
      return () => clearTimeout(id);
    }, [status, memories_created]);

    _useCountUp(memories_created || 0, 1100, status === 'completed' && !collapsedSummary);
    _useCountUp(memories_merged  || 0,  900, status === 'completed' && !collapsedSummary);
    _useCountUp(memories_raw     || 0,  900, status === 'completed' && !collapsedSummary);

    const segments = useMemo(() => {
      const N = Math.max(1, Math.min(total_chunks || 0, 200));
      const realProcessed = (processed / Math.max(1, total_chunks)) * N;
      return Array.from({ length: N }, (_, i) => {
        if (status === 'completed') return 'done';
        if (i < Math.floor(realProcessed)) return 'done';
        if (i === Math.floor(realProcessed) && status === 'running') return 'current';
        if (i === Math.floor(realProcessed) && status === 'error' && i < N) return 'error';
        return 'pending';
      });
    }, [total_chunks, processed, status]);

    const isParseFail = status === 'error' && last_llm_parsed_ok === false;

    if (status === 'completed' && collapsedSummary) {
      return (
        <div className="ob-import-prog is-completed is-collapsed-summary">
          <div className="ob-import-prog-summary">
            <span>今日已导入</span>
            <span className="ob-import-prog-summary-num">{memories_created}</span>
            <span>条记忆</span>
            <span className="ob-import-prog-summary-tally">
              · <b>{total_chunks}</b> 块 · 合并 <b>{memories_merged}</b> · 原文 <b>{memories_raw || 0}</b>
              {' · '}用时 {_formatDuration(elapsedMs)}
              {total_cost_usd > 0 && <> · 花费 <b>${total_cost_usd.toFixed(4)}</b> (≈¥{(total_cost_usd * 7.2).toFixed(2)})</>}
            </span>
            <button
              className="ob-import-prog-close"
              onClick={onDismiss}
              aria-label="关闭"
              style={{ marginLeft: 'auto' }}
            >×</button>
          </div>
        </div>
      );
    }

    const statusLabel = (
      status === 'running'   ? '解析中' :
      status === 'paused'    ? '已暂停' :
      status === 'completed' ? '解析完成' :
      status === 'error'     ? (isParseFail ? '解析失败' : '出错了') : '待开始'
    );

    return (
      <div className={`ob-import-prog is-${status}`}>
        <div className="ob-import-prog-hd">
          <div className="ob-import-prog-status">{statusLabel}</div>

          <div className="ob-import-prog-meta">
            <span className="ob-import-prog-meta-cell">
              <span className="ob-import-prog-meta-cell-v em">{processed}/{total_chunks}</span>
              <span className="ob-import-prog-meta-cell-aux">块</span>
            </span>
            <span className="ob-import-prog-meta-cell">
              <span className="ob-import-prog-meta-cell-v em">{pct}%</span>
            </span>
            <span className="ob-import-prog-meta-cell">
              <span className="ob-import-prog-meta-cell-k">新建</span>
              <span className="ob-import-prog-meta-cell-v">{memories_created}</span>
            </span>
            <span className="ob-import-prog-meta-cell">
              <span className="ob-import-prog-meta-cell-k">合并</span>
              <span className="ob-import-prog-meta-cell-v">{memories_merged}</span>
            </span>
            {(status === 'running' || status === 'paused') && (
              <span className="ob-import-prog-meta-cell">
                <span className="ob-import-prog-meta-cell-k">已跑</span>
                <span className="ob-import-prog-meta-cell-v">{_formatDuration(elapsedMs)}</span>
                {remainingMs != null && (
                  <span className="ob-import-prog-meta-cell-aux">
                    · 约还剩 {_formatDuration(remainingMs)}
                  </span>
                )}
              </span>
            )}
            {status === 'completed' && (
              <span className="ob-import-prog-meta-cell">
                <span className="ob-import-prog-meta-cell-k">用时</span>
                <span className="ob-import-prog-meta-cell-v">{_formatDuration(elapsedMs)}</span>
              </span>
            )}
            {total_cost_usd > 0 && (
              <span className="ob-import-prog-meta-cell">
                <span className="ob-import-prog-meta-cell-k">花费</span>
                <span className="ob-import-prog-meta-cell-v em">${total_cost_usd.toFixed(4)}</span>
                <span className="ob-import-prog-meta-cell-aux">≈ ¥{(total_cost_usd * 7.2).toFixed(2)}</span>
              </span>
            )}
          </div>

          <div className="ob-import-prog-actions">
            {status === 'running' && (
              <button className="ob-import-prog-act" onClick={onPause}>‖ 暂停</button>
            )}
            {status === 'paused' && (
              <button className="ob-import-prog-act" onClick={onResume}>▶ 继续</button>
            )}
            {status === 'error' && !isParseFail && (
              <button className="ob-import-prog-act" onClick={onRetry}>↻ 重试</button>
            )}
          </div>
          <button className="ob-import-prog-close" onClick={onDismiss} aria-label="关闭">×</button>
        </div>

        <div className="ob-import-prog-chunks" aria-hidden="true">
          <div className="ob-import-prog-chunks-track">
            {segments.map((seg, i) => (
              <div key={i} className={`ob-import-prog-chunk ${seg}`} />
            ))}
          </div>
        </div>

        {(status === 'running' || status === 'paused' || status === 'completed') && recent_extracted.length > 0 && (
          <div className="ob-import-prog-stream">
            <div className="ob-import-prog-stream-hd">
              最近提取 · <b>{Math.min(4, recent_extracted.length)}</b> / {recent_extracted.length}
            </div>
            <div className="ob-import-prog-stream-list">
              {recent_extracted.slice(0, 4).map((m, i) => (
                <div
                  key={`${m.name}-${i}`}
                  className={`ob-import-prog-mini ${i === 0 ? 'is-fresh' : ''}`}
                  style={{ animationDelay: `${i * 60}ms` }}
                >
                  <span className="ob-import-prog-mini-marker">▸</span>
                  <span className="ob-import-prog-mini-name">{m.name}</span>
                  <span className="ob-import-prog-mini-summary">{m.summary}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {status === 'error' && (
          <div className="ob-import-prog-error">
            <div className="ob-import-prog-error-hd">
              {isParseFail ? '◆ LLM 输出无法解析' : '◆ 解析中断'}
            </div>
            <div className="ob-import-prog-error-msg">
              {errors[errors.length - 1] || (isParseFail
                ? '上一块的 LLM 返回不是合法 JSON,已暂存原文。可复制查看,或跳过该块继续。'
                : '过程中出现一处错误,已停止。可重试或跳过出错块。'
              )}
            </div>
            {isParseFail && last_llm_output && (
              <div className="ob-import-prog-error-llm">
                <div className="ob-import-prog-error-llm-tag">LLM 原文片段</div>
                {last_llm_output}
              </div>
            )}
            <div className="ob-import-prog-error-acts">
              {isParseFail ? (
                <>
                  <button className="ob-import-prog-error-act" onClick={onCopyLLM}>复制原文</button>
                  <button className="ob-import-prog-error-act is-secondary" onClick={onRetry}>跳过此块继续</button>
                </>
              ) : (
                <>
                  <button className="ob-import-prog-error-act" onClick={onRetry}>重试此块</button>
                  <button className="ob-import-prog-error-act is-secondary" onClick={onCancel}>取消导入</button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  Object.assign(window, { ImportDropZone, ImportPasteSheet, ImportProgressBanner });
})();
