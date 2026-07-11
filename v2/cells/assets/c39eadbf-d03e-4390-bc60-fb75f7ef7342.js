// modal.jsx —— 单条记忆详情 · 查看 + 编辑双态

const { useState: muS, useEffect: muE, useRef: muR } = React;

function ItemModal({ item, allItems, onClose, onNavigate, onOpenItem, onUpdate }) {
  const [editing, setEditing] = muS(false);
  const [draft, setDraft] = muS(null);
  const [redehydrating, setRedehydrating] = muS(false);
  // 重新脱水弹窗 — Phase1 选项 → Phase2 新旧对比 (跟工作台同款体验)
  const [redehyOpen, setRedehyOpen] = muS(false);
  const [redehyPreview, setRedehyPreview] = muS(null);
  // 原文浮层:覆盖在详情 modal 上方,给完整 body 一个不被挤的阅读空间
  const [rawOpen, setRawOpen] = muS(false);
  // 原文编辑态:把 LLM 漏掉的细节手动补回来 (写 metadata.raw_source)
  // 边界提醒:写进去之后这个字段就不再是「AI 没碰过的真实片段」, 而是「你亲手摸过的完整版」
  const [editingRaw, setEditingRaw] = muS(false);
  const [rawDraft, setRawDraft] = muS('');
  const [savingRaw, setSavingRaw] = muS(false);
  // 自定义 tag 输入草稿 — 编辑态新增 tag 用 (allTagOptions 之外的)
  const [tagDraft, setTagDraft] = muS('');

  // 切换条目时退出编辑 + 关原文 + 重置 draft
  muE(() => {
    setEditing(false);
    setDraft(null);
    setRawOpen(false);
    setEditingRaw(false);
    setRawDraft('');
  }, [item?.id]);

  muE(() => {
    if (!item) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        // 优先级:重新脱水弹窗 > 原文编辑态 > 原文浮层 > 详情编辑态 > 关详情 modal
        if (redehyOpen) {
          if (!redehydrating) { setRedehyOpen(false); setRedehyPreview(null); }
          return;
        }
        if (editingRaw) { setEditingRaw(false); setRawDraft(''); return; }
        if (rawOpen) { setRawOpen(false); return; }
        if (editing) { setEditing(false); setDraft(null); return; }
        onClose();
      }
      // 重新脱水弹窗 / 原文浮层打开时,不响应 ← / → 切换条目和 ⌘+E 编辑(避免误触)
      if (redehyOpen || rawOpen) return;
      if (!editing && e.key === 'ArrowLeft') onNavigate(-1);
      if (!editing && e.key === 'ArrowRight') onNavigate(1);
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
  }, [item, onNavigate, onClose, editing, draft, rawOpen, editingRaw, redehyOpen, redehydrating]);

  // 进入原文编辑:从当前 raw_source 拉 draft (空 → 空 textarea, 首次填也走这条)
  const startEditRaw = () => {
    const cur = (item._meta && item._meta.raw_source) || '';
    setRawDraft(cur);
    setEditingRaw(true);
  };
  const cancelEditRaw = () => {
    setEditingRaw(false);
    setRawDraft('');
  };
  const saveEditRaw = async () => {
    if (!onUpdate || savingRaw) return;
    setSavingRaw(true);
    try {
      // 走父级 onUpdate → bridge __obUpdateBucket → /api/bucket/{id}/update
      // 后端 bucket_manager 会截到 8KB
      const truncated = String(rawDraft || '').slice(0, 8000);
      await onUpdate(item.id, { raw_source: truncated, __synced: true });
      // 父级 refresh 是异步的, 直接 mutate 当前 _meta 让浮层立刻反映新值
      // (refresh 后 item 引用会被替换, 这里的 mutation 自然失效, 不会脏污长期状态)
      if (item._meta) item._meta.raw_source = truncated;
      setEditingRaw(false);
      setRawDraft('');
    } catch (e) {
      alert('原文保存失败: ' + (e && e.message ? e.message : e));
    } finally {
      setSavingRaw(false);
    }
  };

  if (!item) return null;

  const startEdit = () => {
    // created_by 来源优先级: 顶层 (乐观更新后有) > _meta.created_by > 'ai' (历史默认)
    const curSource = item.created_by || (item._meta && item._meta.created_by) || 'ai';
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
      noise: !!item.noise,
      created_by: curSource,  // user / ai / import
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

  // 重新脱水: 走 RedehydrateModal 两阶段 (Phase1 选项 → Phase2 新旧对比 → 接受/重做)
  // 触发只是开 modal; 真正 fetch 在 runRedehyPreview / commitRedehy 里
  const openRedehy = () => {
    if (!item || redehydrating) return;
    setRedehyPreview(null);
    setRedehyOpen(true);
  };
  const closeRedehy = () => {
    if (redehydrating) return;
    setRedehyOpen(false);
    setRedehyPreview(null);
  };
  const runRedehyPreview = async ({ regenerate_content }) => {
    if (!item || redehydrating) return;
    setRedehydrating(true);
    try {
      const r = await fetch(`/api/bucket/${encodeURIComponent(item.id)}/redehydrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regenerate_content: !!regenerate_content }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setRedehyPreview(data);
    } catch (e) {
      alert('生成预览失败:\n' + (e.message || String(e)));
    } finally {
      setRedehydrating(false);
    }
  };
  const commitRedehy = async (finalDraft) => {
    if (!item || redehydrating) return;
    setRedehydrating(true);
    try {
      const r = await fetch(`/api/bucket/${encodeURIComponent(item.id)}/redehydrate-commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(finalDraft),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      // 同步前端 — __synced:true 让父级别再写盘, 只 mutate UI
      const updates = {
        title: finalDraft.name || item.title,
        summary: finalDraft.summary || '',
        tags: Array.isArray(finalDraft.tags) ? finalDraft.tags : (item.tags || []),
        __synced: true,
      };
      if (finalDraft.content !== undefined) updates.body = finalDraft.content;
      if (draft) setDraft(dr => ({ ...dr, ...updates }));
      if (onUpdate) onUpdate(item.id, updates);
      setRedehyOpen(false);
      setRedehyPreview(null);
    } catch (e) {
      alert('写入失败:\n' + (e.message || String(e)));
    } finally {
      setRedehydrating(false);
    }
  };

  const confirmDelete = () => {
    if (!onUpdate) return;
    if (!window.confirm(`删除「${item.title || '这条记忆'}」?\n移到回收站,可在 /v2/console/trash/ 恢复。`)) return;
    onUpdate(item.id, { __delete: true });
    setEditing(false);
    setDraft(null);
    if (onClose) onClose();
  };

  // 快速 toggle（在查看态下用）
  const toggleField = (key) => {
    if (!onUpdate) return;
    onUpdate(item.id, { [key]: !item[key] });
  };

  // 找到当前条目在全列表中的位置
  const sorted = [...allItems].sort((a, b) =>
    (b.date + b.time).localeCompare(a.date + a.time)
  );
  const idx = sorted.findIndex(i => i.id === item.id);
  const hasPrev = idx > 0;
  const hasNext = idx < sorted.length - 1;

  const f = formatDate(item.date);
  const view = editing ? draft : item;
  const isHi = view.importance >= 8 || view.highlight;
  const cells = Array.from({ length: 10 }, (_, i) => i < view.importance);

  // 注: '亲手写' / 'AI 写入' 已迁到 metadata.created_by 字段(三态 user/ai/import),
  // 不再放进 tag 候选 — 避免双轨制 (字段 + tag 同表达一件事)
  const allTagOptions = ['已消化', '保护', '重要', 'feel(柔软)', '编程', '工作', '恋爱', '创作', 'AI', '出行', '内心', '日常', '成长'];
  const allDraftTags = Array.from(new Set([...(draft?.tags || []), ...allTagOptions]));

  return (
    <div className="ob-modal-wrap" onClick={editing ? null : onClose}>
      {!editing && (
        <button
          className="ob-modal-nav ob-modal-nav-prev"
          onClick={(e) => { e.stopPropagation(); onNavigate(-1); }}
          disabled={!hasPrev}
          title="更新的一条 ←"
        >‹</button>
      )}

      <div className={`ob-modal ${editing ? 'is-editing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="ob-modal-bg" />
        <button className="ob-modal-close" onClick={editing ? cancelEdit : onClose} title={editing ? '取消编辑' : '关闭 (Esc)'}>✕</button>

        <header className="ob-modal-hd">
          <div className="ob-modal-eyebrow">
            <span className="ob-modal-eyebrow-dot" />
            <span>{editing ? '编辑中' : '记忆'} · {item.id.toUpperCase()}</span>
            <span style={{ opacity: 0.5 }}>/</span>
            <span>{idx + 1} / {sorted.length}</span>
            {!editing && (() => {
              // 来源标签 — user/ai/import 三态; 历史 ai 桶有可能其实是导入(待手动改)
              const src = item.created_by || (item._meta && item._meta.created_by) || 'ai';
              const labels = { user: '亲手写', ai: 'AI 写入', import: '导入' };
              const tip = src === 'ai' ? 'AI 主动写入(若实为导入,可在编辑态改来源)' : '';
              return (
                <>
                  <span style={{ opacity: 0.5 }}>/</span>
                  <span style={{ opacity: 0.7 }} title={tip}>{labels[src] || src}</span>
                </>
              );
            })()}
            {!editing && view.protected && <><span style={{ opacity: 0.5 }}>/</span><span style={{ color: 'var(--c-pin)' }}>❖ 钉决</span></>}
            {!editing && view.highlight && !view.protected && <><span style={{ opacity: 0.5 }}>/</span><span style={{ color: 'var(--c-highlight)' }}>★ 高亮</span></>}
            {!editing && view.feel && <><span style={{ opacity: 0.5 }}>/</span><span style={{ color: 'var(--c-feel)' }}>♡ feel</span></>}
            {!editing && view.internalized && <><span style={{ opacity: 0.5 }}>/</span><span style={{ color: 'var(--ink-3)' }}>◐ 已消化</span></>}
            {!editing && view.noise && <><span style={{ opacity: 0.5 }}>/</span><span style={{ color: 'var(--ink-4)' }}>⌀ 噪声</span></>}
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
                <span style={{ fontFamily: 'var(--mono)' }}>{item.time}</span>
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
            {/* 权重 score: 低调挂在 importance 后面, 帮助判断这条还多"活" */}
            {typeof item.score === 'number' && (
              <span style={{
                marginLeft: 10,
                fontFamily: 'var(--mono)',
                fontSize: 10,
                color: 'var(--ink-4)',
                letterSpacing: '0.06em',
              }} title="decay 权重(>5 活, <0.3 自动归档)">
                score · {item.score.toFixed(2)}
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
            <>
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
              {/* 自定义新 tag 输入 — Enter 添加, 不能跟已有 tag 重复, 不能加 __ 前缀 (隐藏 tag 系统保留) */}
              <div style={{ marginTop: 8 }}>
                <input
                  type="text"
                  className="ob-modal-edit-tag-input"
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const v = tagDraft.trim();
                      if (!v) return;
                      if (v.startsWith('__')) { setTagDraft(''); return; }  // __ 前缀是系统隐藏 tag
                      if (draft.tags.includes(v)) { setTagDraft(''); return; }
                      setDraft(d => ({ ...d, tags: [...d.tags, v] }));
                      setTagDraft('');
                    }
                  }}
                  placeholder="+ 添加自定义标签 (按 Enter)"
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    border: '1px dashed var(--ink-5, rgba(0,0,0,0.18))',
                    borderRadius: 4,
                    background: 'transparent',
                    color: 'var(--ink-2)',
                    font: 'inherit',
                    fontSize: 13,
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            </>
          ) : (
            view.tags && view.tags.length > 0 ? (
              <div className="ob-modal-tags">
                {view.tags.map(t => <Tag key={t} name={t} />)}
              </div>
            ) : <div className="ob-modal-content" style={{ opacity: 0.5, fontStyle: 'italic' }}>未标分类</div>
          )}

          {editing && (
            <>
              {/* 来源 — 三态 radio (user/ai/import). AI 写入跟导入的区分以前没有,
                  现在分开了; 历史 ai 桶可在此手动改 import */}
              <div className="ob-modal-section">来源</div>
              <div className="ob-modal-edit-flags">
                {[
                  { val: 'user', label: '亲手写' },
                  { val: 'ai', label: 'AI 写入' },
                  { val: 'import', label: '导入' },
                ].map(opt => (
                  <label
                    key={opt.val}
                    className={`ob-modal-edit-flag ${draft.created_by === opt.val ? 'on' : ''}`}
                  >
                    <input
                      type="radio"
                      name={`ob-source-${item.id}`}
                      checked={draft.created_by === opt.val}
                      onChange={() => setDraft(d => ({ ...d, created_by: opt.val }))}
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>

              <div className="ob-modal-section">状态</div>
              <div className="ob-modal-edit-flags">
                <label className={`ob-modal-edit-flag ${draft.protected ? 'on tone-pin' : ''}`}>
                  <input type="checkbox" checked={draft.protected} onChange={(e) => setDraft(d => ({ ...d, protected: e.target.checked, pinned: e.target.checked }))} />
                  <span>❖ 钉决</span>
                </label>
                {/* 钉决已含 highlight 效果, 钉决时禁用避免双标 */}
                <label
                  className={`ob-modal-edit-flag ${draft.highlight ? 'on tone-highlight' : ''} ${draft.protected ? 'is-disabled' : ''}`}
                  title={draft.protected ? '钉决已含「高亮」效果 — 取消钉决后此项才生效' : ''}
                >
                  <input
                    type="checkbox"
                    checked={draft.highlight}
                    disabled={draft.protected}
                    onChange={(e) => setDraft(d => ({ ...d, highlight: e.target.checked }))}
                  />
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
                <label className={`ob-modal-edit-flag ${draft.noise ? 'on tone-noise' : ''}`} title="软删除: 加速衰减(×0.05) + 重要度锁 1, 几天内自动归档; 取消可恢复">
                  <input
                    type="checkbox"
                    checked={!!draft.noise}
                    onChange={(e) => setDraft(d => {
                      const noise = e.target.checked;
                      return {
                        ...d,
                        noise,
                        // 标噪声 = importance 锁 1; 取消则恢复到原值或 5
                        importance: noise ? 1 : (item.importance && item.importance > 1 ? item.importance : 5),
                      };
                    })}
                  />
                  <span>⌀ 噪声</span>
                </label>
              </div>
            </>
          )}

          {!editing && item.artifacts && item.artifacts.length > 0 && (
            <>
              <div className="ob-modal-section">附件 · {item.artifacts.length}</div>
              <div className="ob-modal-arts">
                {item.artifacts.map(a => (
                  <div key={a} className="ob-modal-art">
                    <span className="ob-modal-art-i">▤</span>
                    <span>{a}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {!editing && onOpenItem && window.SiblingsRow && (
            <SiblingsRow
              items={allItems.filter(i => i.date === item.date)}
              current={item}
              onOpen={onOpenItem}
            />
          )}
          {!editing && onOpenItem && window.RelatedRow && (
            <RelatedRow all={allItems} current={item} onOpen={onOpenItem} />
          )}
        </div>

        <footer className="ob-modal-foot">
          <div className="ob-modal-meta">
            {editing ? (
              <>
                <span className="ob-modal-meta-item">⌘+↵ 保存</span>
                <span style={{ color: 'var(--ink-4)' }}>·</span>
                <span className="ob-modal-meta-item">Esc 取消</span>
              </>
            ) : (
              // 非编辑态:左下角放"查看原文"按钮(替代旧的 ⌘+E / ← → / Esc 文字提示)
              // 读 metadata.raw_source(真原文片段) — 不是 body(脱水后整理的正文,不算原文)
              // raw_source 为空时按钮可点,但浮层显示"无原文"提示 — 诚实呈现状态
              (() => {
                const rawSrc = view._meta && view._meta.raw_source;
                const hasRaw = !!(rawSrc && String(rawSrc).trim());
                return (
                  <button
                    type="button"
                    className="ob-modal-btn"
                    onClick={() => setRawOpen(true)}
                    title={hasRaw ? '查看完整原文片段' : '此条没有保存原文片段'}
                  >❡ 查看原文{!hasRaw ? ' (无)' : ''}</button>
                );
              })()
            )}
          </div>
          <div className="ob-modal-actions">
            {editing ? (
              <>
                {onUpdate && (
                  <>
                    <button className="ob-modal-btn ob-modal-btn-danger" onClick={confirmDelete} title="删除这条记忆">删除</button>
                    <span className="ob-modal-actions-sep" aria-hidden="true" />
                  </>
                )}
                <button
                  className="ob-modal-btn"
                  onClick={openRedehy}
                  disabled={redehydrating}
                  title="LLM 重新生成标题/摘要/标签/情感; 预览界面可对比新旧再决定"
                >{redehydrating ? '⌛ 提炼中…' : '↻ 重新脱水'}</button>
                <button className="ob-modal-btn" onClick={cancelEdit}>取消</button>
                <button className="ob-modal-btn ob-modal-btn-primary" onClick={saveEdit}>保存</button>
              </>
            ) : (
              <>
                <button
                  className={`ob-modal-btn ${view.noise ? 'on' : ''}`}
                  onClick={() => onUpdate && onUpdate(item.id, { noise: !view.noise })}
                  title="软删除: 加速衰减 + 重要度锁 1, 几天内自动归档"
                >⌀ {view.noise ? '已标噪声' : '噪声'}</button>
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

      {!editing && (
        <button
          className="ob-modal-nav ob-modal-nav-next"
          onClick={(e) => { e.stopPropagation(); onNavigate(1); }}
          disabled={!hasNext}
          title="更早的一条 →"
        >›</button>
      )}

      {/* 原文浮层:复用 ob-modal 视觉,叠在详情 modal 上方(z-index 250 > 200)
          关闭路径:点外部 / 左上 [← 详情] / 右上 [✕] / Esc(在 keydown handler 里)
          编辑态:点 [✎ 编辑] 切到 textarea, [保存]/[取消] 在 footer */}
      {rawOpen && (() => {
        const rawSrc = view._meta && view._meta.raw_source;
        const hasRaw = !!(rawSrc && String(rawSrc).trim());
        const RAW_MAX = 8000;  // 后端 bucket_manager 截断点 — UI 同步上限避免静默丢字
        const draftLen = (rawDraft || '').length;
        const overLimit = draftLen > RAW_MAX;
        return (
        <div
          className="ob-modal-wrap"
          style={{ zIndex: 250 }}
          onClick={() => { if (!editingRaw) setRawOpen(false); }}
        >
          <div className="ob-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ob-modal-bg" />
            <button
              className="ob-modal-close"
              onClick={() => { if (!editingRaw) setRawOpen(false); }}
              title={editingRaw ? '请先保存或取消编辑' : '关闭原文 (Esc)'}
              disabled={editingRaw}
              style={editingRaw ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
            >✕</button>
            <header className="ob-modal-hd">
              <div className="ob-modal-eyebrow">
                <button
                  type="button"
                  onClick={() => { if (!editingRaw) setRawOpen(false); }}
                  title={editingRaw ? '请先保存或取消编辑' : '返回详情 (Esc)'}
                  disabled={editingRaw}
                  style={{
                    background: 'transparent', border: 0, padding: '2px 6px',
                    color: editingRaw ? 'var(--ink-4)' : 'var(--ink-3)',
                    font: 'inherit', cursor: editingRaw ? 'not-allowed' : 'pointer',
                    borderRadius: 4, opacity: editingRaw ? 0.5 : 1,
                  }}
                  onMouseEnter={(e) => { if (!editingRaw) e.currentTarget.style.color = 'var(--accent)'; }}
                  onMouseLeave={(e) => { if (!editingRaw) e.currentTarget.style.color = 'var(--ink-3)'; }}
                >← 详情</button>
                <span style={{ opacity: 0.5 }}>/</span>
                <span>原文 · {item.id.toUpperCase()}{editingRaw ? ' · 编辑中' : ''}</span>
              </div>
              <h2 className="ob-modal-title">{view.title}</h2>
            </header>
            <div className="ob-modal-body">
              {editingRaw ? (
                <textarea
                  value={rawDraft}
                  onChange={(e) => setRawDraft(e.target.value)}
                  autoFocus
                  placeholder={hasRaw
                    ? '直接修改 / 补充原文片段。保留说话人前缀(如「用户:」「AI:」)能让后续重新脱水时锚点更准。'
                    : '此条目前没有原文。在这里粘贴或手写补全 — 这段内容会喂给以后的「↻ 重新脱水」当输入。'}
                  style={{
                    width: '100%',
                    minHeight: 'calc(60vh - 120px)',
                    background: 'var(--paper-2, rgba(0,0,0,0.02))',
                    border: '1px solid var(--ink-5, rgba(0,0,0,0.12))',
                    borderRadius: 6,
                    padding: '14px 16px',
                    font: 'inherit',
                    lineHeight: 1.75,
                    color: 'var(--ink-1)',
                    resize: 'vertical',
                    whiteSpace: 'pre-wrap',
                    boxSizing: 'border-box',
                  }}
                />
              ) : hasRaw ? (
                <div
                  className="ob-modal-content"
                  style={{ whiteSpace: 'pre-wrap', lineHeight: 1.75 }}
                >{rawSrc}</div>
              ) : (
                <div
                  className="ob-modal-content"
                  style={{ opacity: 0.55, fontStyle: 'italic', lineHeight: 1.7 }}
                >
                  此条没有保存原文片段。可能是早期导入(还没引入 source_excerpt 机制),
                  或导入时 LLM 没输出此字段。
                  <br /><br />
                  <span style={{ fontSize: 13, opacity: 0.7 }}>
                    （注:此处显示的是「原文」—— 即导入时 LLM 摘自对话的精准片段。整理后的脱水正文请回到详情界面查看。）
                    <br />
                    点下方 [✎ 编辑] 可以手动补一段进来。
                  </span>
                </div>
              )}
            </div>
            {/* footer:非编辑态 [✎ 编辑] / 编辑态 字数 + [取消][保存] */}
            <footer className="ob-modal-foot">
              <div className="ob-modal-meta">
                {editingRaw ? (
                  <span
                    className="ob-modal-meta-item"
                    style={{ color: overLimit ? 'var(--danger, #b94545)' : 'var(--ink-3)' }}
                    title={overLimit ? '超过 8KB 上限,保存时会被截断' : ''}
                  >{draftLen} / {RAW_MAX}{overLimit ? ' · 会截断' : ''}</span>
                ) : (
                  <span className="ob-modal-meta-item" style={{ opacity: 0.6 }}>
                    {hasRaw ? '原文片段 (可编辑补全)' : '空原文'}
                  </span>
                )}
              </div>
              <div className="ob-modal-actions">
                {editingRaw ? (
                  <>
                    <button className="ob-modal-btn" onClick={cancelEditRaw} disabled={savingRaw}>取消</button>
                    <button
                      className="ob-modal-btn ob-modal-btn-primary"
                      onClick={saveEditRaw}
                      disabled={savingRaw}
                      title="保存到 metadata.raw_source — 以后「↻ 重新脱水」会拿到这份新内容"
                    >{savingRaw ? '⌛ 保存中…' : '保存'}</button>
                  </>
                ) : onUpdate ? (
                  <button
                    className="ob-modal-btn ob-modal-btn-primary"
                    onClick={startEditRaw}
                    title="手动补全或修订原文片段"
                  >✎ 编辑</button>
                ) : null}
              </div>
            </footer>
          </div>
        </div>
        );
      })()}

      {/* 重新脱水弹窗 — 跟工作台同款体验 (Phase1 选项 → Phase2 新旧对比) */}
      {window.RedehydrateModal && React.createElement(window.RedehydrateModal, {
        open: redehyOpen,
        item: { id: item.id, title: item.title, rawSource: (item._meta && item._meta.raw_source) || '' },
        busy: redehydrating,
        preview: redehyPreview,
        onCancel: closeRedehy,
        onPreview: runRedehyPreview,
        onReroll: runRedehyPreview,
        onCommit: commitRedehy,
      })}
    </div>
  );
}

window.ItemModal = ItemModal;
