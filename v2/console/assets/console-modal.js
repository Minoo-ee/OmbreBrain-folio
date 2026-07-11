// console-modal.jsx —— 单条记忆详情 modal(从 cells/c39eadbf 复制),
// 配套 Tag + formatDate 自带,供导入工作台"全库相似 → 查看"复用。

const { useState: cmS, useEffect: cmE } = React;

const CM_TAG_META = {
  // 来源伪标签 (bridge 注入, 跟 metadata.created_by 同步显示) — 不带图标, 文字本身够清楚
  '亲手写':    { icon: '', tone: 'sage' },
  'AI 写入':   { icon: '', tone: 'sage' },
  '导入':      { icon: '', tone: 'sage' },
  '已消化':    { icon: '◐', tone: 'sage' },
  '保护':      { icon: '❖', tone: 'amber' },
  '高亮':      { icon: '★', tone: 'amber' },
  'feel(柔软)': { icon: '♡', tone: 'rose' }
};

function CmTag({ name }) {
  const m = CM_TAG_META[name] || { icon: '·', tone: 'sage' };
  return (
    <span className={`ob-tag ob-tag-${m.tone}`}>
      {m.icon && <span className="ob-tag-i">{m.icon}</span>}
      <span>{name}</span>
    </span>
  );
}

function cmFormatDate(d) {
  if (!d || typeof d !== 'string' || d.length < 10) return { y: '----', m: '--', day: '--', wk: '' };
  const [y, m, day] = d.split('-');
  const dt = new Date(+y, +m - 1, +day);
  const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dt.getDay()];
  return { y, m, day, wk, dt };
}

// 合并预览专用:可折叠的 A 原文 / B 原文 / 合并结果 三栏对比(Claude Design 出品)
function MergeComparePanel({ aName, bName, aContent, bContent, mergedContent }) {
  const [open, setOpen] = cmS(false);
  const aLen = (aContent || '').length;
  const bLen = (bContent || '').length;
  const mLen = (mergedContent || '').length;
  const segments = [
    { key: 'a', label: 'A · 原文', name: aName, len: aLen, content: aContent, role: 'a' },
    { key: 'b', label: 'B · 原文 · 目标桶', name: bName, len: bLen, content: bContent, role: 'b' },
    { key: 'm', label: '合并结果 · LLM', name: null, len: mLen, content: mergedContent, role: 'merged' },
  ];
  return (
    <div className="ob-merge-cmp-wrap">
      <button
        type="button"
        className={`ob-merge-cmp-trigger ${open ? 'is-open' : ''}`}
        onClick={() => setOpen(o => !o)}
      >
        <span className="ob-merge-cmp-caret">{open ? '▾' : '▸'}</span>
        <span className="ob-merge-cmp-trigger-label">
          {open ? '收起原文对比' : '展开原文对比'}
        </span>
        <span className="ob-merge-cmp-counts">
          A {aLen} · B {bLen} · 合并 {mLen} 字
        </span>
      </button>
      {open && (
        <div className="ob-merge-cmp-body">
          {segments.map((seg) => (
            <div key={seg.key} className={`ob-merge-cmp-seg ob-merge-cmp-seg--${seg.role}`}>
              <div className="ob-merge-cmp-bar">
                <span className="ob-merge-cmp-bar-tag">{seg.label}</span>
                {seg.name && <span className="ob-merge-cmp-bar-name">「{seg.name}」</span>}
                <span className="ob-merge-cmp-bar-spacer" />
                <span className="ob-merge-cmp-bar-len">{seg.len} 字</span>
              </div>
              <div className="ob-merge-cmp-content">
                {seg.content || <span className="ob-merge-cmp-empty">(空)</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConsoleItemModal({ item, allItems, onClose, onNavigate, onUpdate, mode, onReroll, rerollLoading, commitLoading, mergeHeader }) {
  // mode === 'merge' → 强制 editing,footer 显示"取消/↻重做/✓接受合并",隐藏导航/删除
  const isMerge = mode === 'merge';
  const buildDraft = (it) => ({
    title: it?.title || '',
    summary: it?.summary || '',
    body: it?.body || '',
    date: it?.date || '',
    time: it?.time || '',
    importance: it?.importance || 5,
    tags: [...(it?.tags || [])],
    protected: !!it?.protected,
    pinned: !!it?.pinned,
    feel: !!it?.feel,
    highlight: !!it?.highlight,
    internalized: !!it?.internalized,
  });
  const [editing, setEditing] = cmS(isMerge);
  // 首帧懒初始化:merge 模式直接把 draft 填好,避免 view=null 解引用炸白屏
  const [draft, setDraft] = cmS(() => isMerge && item ? buildDraft(item) : null);

  cmE(() => {
    if (isMerge) {
      // merge 模式:reroll 后 item 变 → 用新合并结果重置 draft
      setEditing(true);
      setDraft(buildDraft(item));
      return;
    }
    setEditing(false);
    setDraft(null);
  }, [item?.id, item?.body, isMerge]);

  cmE(() => {
    if (!item) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (isMerge) { onClose(); return; }  // merge 模式 Esc 直接关闭(取消合并)
        if (editing) { setEditing(false); setDraft(null); return; }
        onClose();
      }
      if (!editing && e.key === 'ArrowLeft' && onNavigate) onNavigate(-1);
      if (!editing && e.key === 'ArrowRight' && onNavigate) onNavigate(1);
      if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
        e.preventDefault();
        if (!editing) startEdit();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && editing) {
        e.preventDefault();
        saveEdit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, onNavigate, onClose, editing, draft, isMerge]);

  if (!item) return null;

  const startEdit = () => {
    setDraft({
      title: item.title,
      summary: item.summary || '',
      body: item.body || '',
      date: item.date || '',
      time: item.time || '',
      importance: item.importance,
      tags: [...(item.tags || [])],
      protected: !!item.protected,
      pinned: !!item.pinned,
      feel: !!item.feel,
      highlight: !!item.highlight,
      internalized: !!item.internalized,
    });
    setEditing(true);
  };

  const saveEdit = () => {
    if (!draft) return;
    if (onUpdate) onUpdate(item.id, draft);
    setEditing(false);
    setDraft(null);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft(null);
  };

  const confirmDelete = () => {
    if (!onUpdate) return;
    if (!window.confirm(`删除「${item.title || '这条记忆'}」?\n移到回收站,可在 /v2/console/trash/ 恢复。`)) return;
    onUpdate(item.id, { __delete: true });
    setEditing(false);
    setDraft(null);
    if (onClose) onClose();
  };

  const toggleField = (key) => {
    if (!onUpdate) return;
    onUpdate(item.id, { [key]: !item[key] });
  };

  const sorted = (allItems && allItems.length > 1) ? [...allItems].sort((a, b) =>
    ((b.date || '') + (b.time || '')).localeCompare((a.date || '') + (a.time || ''))
  ) : [item];
  const idx = sorted.findIndex(i => i.id === item.id);
  const hasPrev = idx > 0;
  const hasNext = idx < sorted.length - 1;

  const f = cmFormatDate(item.date || '');
  // editing 但 draft 还没建好(merge 模式首帧)→ 退到 item 防 null 解引用炸
  const view = (editing && draft) ? draft : item;
  const isHi = view.importance >= 8 || view.highlight;
  const cells = Array.from({ length: 10 }, (_, i) => i < view.importance);

  // 注: '亲手写' / 'AI 写入' / '导入' 已迁到 metadata.created_by 字段(三态),
  // 不再放进 tag 候选 — 避免双轨制 (字段 + tag 同表达一件事)
  const allTagOptions = ['已消化', '保护', '重要', 'feel(柔软)', '编程', '工作', '恋爱', '创作', 'AI', '出行', '内心', '日常', '成长'];
  const allDraftTags = Array.from(new Set([...(draft?.tags || []), ...allTagOptions]));

  return (
    <div className="ob-modal-wrap" onClick={editing ? null : onClose}>
      {!editing && onNavigate && allItems && allItems.length > 1 && (
        <button
          className="ob-modal-nav ob-modal-nav-prev"
          onClick={(e) => { e.stopPropagation(); onNavigate(-1); }}
          disabled={!hasPrev}
          title="更新的一条 ←"
        >‹</button>
      )}

      <div className={`ob-modal ${editing ? 'is-editing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="ob-modal-bg" />
        <button
          className="ob-modal-close"
          onClick={isMerge ? onClose : (editing ? cancelEdit : onClose)}
          title={isMerge ? '取消合并' : (editing ? '取消编辑' : '关闭 (Esc)')}
        >✕</button>

        <header className="ob-modal-hd">
          <div className="ob-modal-eyebrow">
            <span className="ob-modal-eyebrow-dot" style={isMerge ? { background: 'var(--accent)' } : undefined} />
            {isMerge && mergeHeader ? (
              <span>合并预览 · 「{mergeHeader.aName}」 → 「{mergeHeader.bName}」 · 接受后 A 删除</span>
            ) : (
              <>
                <span>{editing ? '编辑中' : '记忆'} · {(item.id || '').toUpperCase()}</span>
                {allItems && allItems.length > 1 && <>
                  <span style={{ opacity: 0.5 }}>/</span>
                  <span>{idx + 1} / {sorted.length}</span>
                </>}
              </>
            )}
            {!editing && view.protected && <><span style={{ opacity: 0.5 }}>/</span><span style={{ color: 'var(--c-pin)' }}>❖ 钉决</span></>}
            {!editing && view.highlight && !view.protected && <><span style={{ opacity: 0.5 }}>/</span><span style={{ color: 'var(--c-highlight)' }}>★ 高亮</span></>}
            {!editing && view.feel && <><span style={{ opacity: 0.5 }}>/</span><span style={{ color: 'var(--c-feel)' }}>♡ feel</span></>}
            {!editing && view.internalized && <><span style={{ opacity: 0.5 }}>/</span><span style={{ color: 'var(--ink-3)' }}>◐ 已消化</span></>}
          </div>

          {editing ? (
            <input
              className="ob-modal-edit-title"
              value={draft.title}
              onChange={(e) => setDraft(d => ({ ...d, title: e.target.value }))}
              placeholder="标题…"
              autoFocus
            />
          ) : (
            <h2 className="ob-modal-title">{view.title}</h2>
          )}

          <div className="ob-modal-sub">
            {editing ? (
              <>
                <input
                  type="date"
                  className="ob-modal-edit-when"
                  value={draft.date}
                  onChange={(e) => setDraft(d => ({ ...d, date: e.target.value }))}
                />
                <span className="ob-modal-sub-sep">·</span>
                <input
                  type="time"
                  className="ob-modal-edit-when"
                  value={draft.time}
                  onChange={(e) => setDraft(d => ({ ...d, time: e.target.value }))}
                />
              </>
            ) : (
              <>
                <span><b>{f.y}-{f.m}-{f.day}</b> · {f.wk}</span>
                <span className="ob-modal-sub-sep">·</span>
                <span style={{ fontFamily: 'var(--mono)' }}>{item.time || '--:--'}</span>
              </>
            )}
            <span className="ob-modal-sub-sep">·</span>
            {editing ? (
              <span className="ob-modal-imp-bar">
                <span>importance</span>
                <span className="ob-modal-imp-track ob-modal-imp-edit">
                  {cells.map((on, i) => (
                    <button
                      key={i}
                      type="button"
                      className={`ob-modal-imp-cell ${on ? 'ob-modal-imp-cell-on' : ''} ${on && i >= 7 ? 'ob-modal-imp-cell-hi' : ''}`}
                      onClick={() => setDraft(d => ({ ...d, importance: i + 1 }))}
                    />
                  ))}
                </span>
                <b style={{ color: 'var(--ink)', fontWeight: 600 }}>{draft.importance}</b>
              </span>
            ) : (
              <span className="ob-modal-imp-bar">
                <span>importance</span>
                <span className="ob-modal-imp-track">
                  {cells.map((on, i) => (
                    <span
                      key={i}
                      className={`ob-modal-imp-cell ${on ? 'ob-modal-imp-cell-on' : ''} ${on && i >= 7 ? 'ob-modal-imp-cell-hi' : ''}`}
                    />
                  ))}
                </span>
                <b style={{ color: 'var(--ink)', fontWeight: 600 }}>{view.importance}</b>
              </span>
            )}
          </div>
        </header>

        <div className="ob-modal-body">
          {editing ? (
            <textarea
              className="ob-modal-edit-summary"
              value={draft.summary}
              onChange={(e) => setDraft(d => ({ ...d, summary: e.target.value }))}
              placeholder="一句话摘要(留空则不显示)"
              rows={2}
            />
          ) : (
            view.summary && <p className="ob-modal-summary">{view.summary}</p>
          )}

          {editing ? (
            <>
              {/* 仅 merge 模式 + 有 a_content/b_content 数据时,在正文上方插原文对比折叠面板 */}
              {isMerge && mergeHeader && mergeHeader.aContent != null && (
                <MergeComparePanel
                  aName={mergeHeader.aName}
                  bName={mergeHeader.bName}
                  aContent={mergeHeader.aContent}
                  bContent={mergeHeader.bContent}
                  mergedContent={draft.body}
                />
              )}
              <div className="ob-modal-section">正文</div>
              <textarea
                className="ob-modal-edit-body"
                value={draft.body}
                onChange={(e) => setDraft(d => ({ ...d, body: e.target.value }))}
                placeholder="…慢慢写。留白也可以。"
                rows={8}
              />
            </>
          ) : (view.body && (
            <>
              <div className="ob-modal-section">正文</div>
              <div className="ob-modal-content">{view.body}</div>
            </>
          ))}

          <div className="ob-modal-section">标签</div>
          {editing ? (
            <div className="ob-modal-edit-tags">
              {allDraftTags.map(tg => (
                <button
                  key={tg}
                  type="button"
                  className={`ob-modal-edit-tag ${draft.tags.includes(tg) ? 'on' : ''}`}
                  onClick={() => setDraft(d => ({
                    ...d,
                    tags: d.tags.includes(tg) ? d.tags.filter(x => x !== tg) : [...d.tags, tg]
                  }))}
                >{tg}</button>
              ))}
            </div>
          ) : (
            view.tags && view.tags.length > 0 ? (
              <div className="ob-modal-tags">
                {view.tags.map(t => <CmTag key={t} name={t} />)}
              </div>
            ) : <div className="ob-modal-content" style={{ opacity: 0.5, fontStyle: 'italic' }}>未标分类</div>
          )}

          {editing && (
            <>
              <div className="ob-modal-section">状态</div>
              <div className="ob-modal-edit-flags">
                <label className={`ob-modal-edit-flag ${draft.protected ? 'on tone-pin' : ''}`}>
                  <input type="checkbox" checked={draft.protected} onChange={(e) => setDraft(d => ({ ...d, protected: e.target.checked, pinned: e.target.checked }))} />
                  <span>❖ 钉决</span>
                </label>
                <label
                  className={`ob-modal-edit-flag ${draft.highlight ? 'on tone-highlight' : ''} ${draft.protected ? 'is-disabled' : ''}`}
                  title={draft.protected ? '钉决已含「高亮」效果 — 取消钉决后此项才生效' : ''}
                >
                  <input
                    type="checkbox"
                    checked={draft.highlight}
                    disabled={draft.protected}
                    onChange={(e) => setDraft(d => ({ ...d, highlight: e.target.checked }))} />
                  <span>★ 高亮</span>
                </label>
                <label className={`ob-modal-edit-flag ${draft.feel ? 'on tone-feel' : ''}`}>
                  <input type="checkbox" checked={draft.feel} onChange={(e) => setDraft(d => ({ ...d, feel: e.target.checked }))} />
                  <span>♡ feel</span>
                </label>
                <label className={`ob-modal-edit-flag ${draft.internalized ? 'on' : ''}`}>
                  <input type="checkbox" checked={draft.internalized} onChange={(e) => setDraft(d => ({ ...d, internalized: e.target.checked }))} />
                  <span>◐ 已消化</span>
                </label>
              </div>
            </>
          )}
        </div>

        <footer className="ob-modal-foot">
          <div className="ob-modal-meta">
            {isMerge ? (
              <>
                <span className="ob-modal-meta-item">⌘+↵ 接受合并</span>
                <span style={{ color: 'var(--ink-4)' }}>·</span>
                <span className="ob-modal-meta-item">Esc 取消</span>
              </>
            ) : editing ? (
              <>
                <span className="ob-modal-meta-item">⌘+↵ 保存</span>
                <span style={{ color: 'var(--ink-4)' }}>·</span>
                <span className="ob-modal-meta-item">Esc 取消</span>
              </>
            ) : (
              <>
                <span className="ob-modal-meta-item">⌘+E 编辑</span>
                {onNavigate && allItems && allItems.length > 1 && <>
                  <span style={{ color: 'var(--ink-4)' }}>·</span>
                  <span className="ob-modal-meta-item">← / → 切换</span>
                </>}
                <span style={{ color: 'var(--ink-4)' }}>·</span>
                <span className="ob-modal-meta-item">Esc 关闭</span>
              </>
            )}
          </div>
          <div className="ob-modal-actions">
            {isMerge ? (
              <>
                <button
                  className="ob-modal-btn"
                  onClick={onClose}
                  disabled={rerollLoading || commitLoading}
                >取消</button>
                {onReroll && (
                  <button
                    className="ob-modal-btn"
                    onClick={onReroll}
                    disabled={rerollLoading || commitLoading}
                    title="LLM 重新生成合并结果(注意:已有手动修改会被覆盖)"
                  >{rerollLoading ? '⌛ 重做中…' : '↻ 重做'}</button>
                )}
                <button
                  className="ob-modal-btn ob-modal-btn-primary"
                  onClick={saveEdit}
                  disabled={rerollLoading || commitLoading}
                >{commitLoading ? '⌛ 提交中…' : '✓ 接受合并'}</button>
              </>
            ) : editing ? (
              <>
                {onUpdate && (
                  <>
                    <button className="ob-modal-btn ob-modal-btn-danger" onClick={confirmDelete} title="删除这条记忆">删除</button>
                    <span className="ob-modal-actions-sep" aria-hidden="true" />
                  </>
                )}
                <button className="ob-modal-btn" onClick={cancelEdit}>取消</button>
                <button className="ob-modal-btn ob-modal-btn-primary" onClick={saveEdit}>保存</button>
              </>
            ) : (
              <>
                <button
                  className={`ob-modal-btn ${view.protected ? 'on' : ''}`}
                  onClick={() => toggleField('protected')}
                >❖ {view.protected ? '已钉决' : '钉决'}</button>
                <button
                  className={`ob-modal-btn ${view.highlight ? 'on' : ''}`}
                  onClick={() => toggleField('highlight')}
                >★ {view.highlight ? '已高亮' : '高亮'}</button>
                <button className="ob-modal-btn ob-modal-btn-primary" onClick={startEdit}>编辑</button>
              </>
            )}
          </div>
        </footer>
      </div>

      {!editing && onNavigate && allItems && allItems.length > 1 && (
        <button
          className="ob-modal-nav ob-modal-nav-next"
          onClick={(e) => { e.stopPropagation(); onNavigate(1); }}
          disabled={!hasNext}
          title="更早的一条 →"
        >›</button>
      )}
    </div>
  );
}

window.ConsoleItemModal = ConsoleItemModal;
