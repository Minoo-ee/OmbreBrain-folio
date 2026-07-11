// console-trash.jsx —— 回收站页面:列出软删除的桶,支持恢复/永久删除
// 2026-06-10 顶部加「最近写入清理」: 按写入时间(created)新→旧分组, 勾选批量移入回收站。
// 场景: 批量写入(记忆写入工作台/导入)后不满意, 把整批撤掉重来 — 之前只能一条条点。

const { useState: ctS, useEffect: ctE, useMemo: ctM } = React;

// ============ 最近写入清理 ============
const CLEANUP_WINDOWS = [
  { key: '24h', label: '近 24 小时', ms: 24 * 3600 * 1000 },
  { key: '3d', label: '近 3 天', ms: 3 * 86400000 },
  { key: '7d', label: '近 7 天', ms: 7 * 86400000 },
  { key: 'all', label: '全部', ms: null },
];
const CLEANUP_SOURCES = [
  { key: 'all', label: '全部来源' },
  { key: 'ai', label: 'AI 写入' },
  { key: 'import', label: '导入' },
  { key: 'user', label: '亲手写' },
];

function CleanupSection({ onTrashChanged }) {
  const [open, setOpen] = ctS(false);
  const [rows, setRows] = ctS(null);      // null = 还没拉过
  const [loading, setLoading] = ctS(false);
  const [err, setErr] = ctS(null);
  const [sel, setSel] = ctS({});           // id → true
  const [src, setSrc] = ctS('all');
  const [win, setWin] = ctS('24h');
  const [deleting, setDeleting] = ctS(false);
  const [progress, setProgress] = ctS('');

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch('/api/buckets', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      setRows(Array.isArray(d) ? d : (d.buckets || []));
    } catch (e) {
      setErr(e.message || String(e));
    } finally { setLoading(false); }
  };

  // 过滤 + 按写入时间新→旧 + 按写入日分组
  const groups = ctM(() => {
    if (!rows) return [];
    const w = CLEANUP_WINDOWS.find(x => x.key === win);
    const cutoff = w && w.ms ? Date.now() - w.ms : null;
    const list = rows.filter(b => {
      if (src !== 'all' && (b.created_by || 'ai') !== src) return false;
      if (cutoff) {
        const t = Date.parse(b.created || '');
        if (!t || t < cutoff) return false;
      }
      return true;
    });
    list.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
    const byDay = [];
    let cur = null;
    for (const b of list) {
      const lt = window.__obIsoToLocal ? window.__obIsoToLocal(b.created || '') : { date: String(b.created || '').slice(0, 10), time: '' };
      const day = lt.date || '(无写入时间)';
      if (!cur || cur.day !== day) { cur = { day, items: [] }; byDay.push(cur); }
      cur.items.push({ b, time: lt.time });
    }
    return byDay;
  }, [rows, src, win]);

  const visibleIds = ctM(() => groups.flatMap(g => g.items.map(x => x.b.id)), [groups]);
  const selCount = visibleIds.filter(id => sel[id]).length;
  const toggleIds = (ids, on) => setSel(prev => {
    const next = { ...prev };
    for (const id of ids) { if (on) next[id] = true; else delete next[id]; }
    return next;
  });

  const batchDelete = async () => {
    const ids = visibleIds.filter(id => sel[id]);
    if (!ids.length || deleting) return;
    if (!window.confirm(`把选中的 ${ids.length} 条移入回收站?\n\n(可在下方回收站恢复或永久清空)`)) return;
    setDeleting(true);
    let failed = 0;
    for (let i = 0; i < ids.length; i++) {
      setProgress(`${i + 1}/${ids.length}`);
      try {
        const r = await fetch(`/api/bucket/${encodeURIComponent(ids[i])}/delete`, { method: 'POST' });
        if (!r.ok) failed++;
      } catch (e) { failed++; }
    }
    setDeleting(false); setProgress('');
    setSel({});
    await load();
    if (onTrashChanged) onTrashChanged();
    if (failed) alert(`完成, 但 ${failed} 条失败 (其余已入回收站)`);
  };

  const srcLabel = (b) => {
    const k = b.created_by || 'ai';
    return k === 'user' ? '亲手写' : k === 'import' ? '导入' : 'AI 写入';
  };

  return (
    <ConsoleCard
      label="最近写入清理"
      sub="按写入时间 新→旧 分组 · 勾选批量移入回收站 (可恢复) · 给「整批写错了想撤掉重来」用"
    >
      {!open ? (
        <button
          className="oc-btn oc-btn-ghost"
          style={{ fontSize: 12 }}
          onClick={() => { setOpen(true); if (rows === null) load(); }}
        >▾ 展开</button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* 工具条 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
            <select value={win} onChange={e => setWin(e.target.value)} style={{ fontSize: 12, padding: '3px 6px', borderRadius: 6, border: '0.5px solid var(--line-2)', background: 'var(--paper)', color: 'var(--ink)' }}>
              {CLEANUP_WINDOWS.map(w => <option key={w.key} value={w.key}>{w.label}</option>)}
            </select>
            <select value={src} onChange={e => setSrc(e.target.value)} style={{ fontSize: 12, padding: '3px 6px', borderRadius: 6, border: '0.5px solid var(--line-2)', background: 'var(--paper)', color: 'var(--ink)' }}>
              {CLEANUP_SOURCES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <button className="oc-btn oc-btn-ghost" style={{ fontSize: 11 }} onClick={load} disabled={loading}>{loading ? '⌛' : '↻ 刷新'}</button>
            <span style={{ color: 'var(--ink-4)', fontFamily: 'var(--mono)', fontSize: 11 }}>
              {visibleIds.length} 条{selCount > 0 && <> · 已选 <b>{selCount}</b></>}
            </span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button className="oc-btn oc-btn-ghost" style={{ fontSize: 11 }} onClick={() => toggleIds(visibleIds, true)} disabled={!visibleIds.length}>全选</button>
              <button className="oc-btn oc-btn-ghost" style={{ fontSize: 11 }} onClick={() => setSel({})} disabled={!selCount}>清空选择</button>
              <button
                className="oc-btn oc-btn-ghost"
                style={{ fontSize: 11, color: '#8B4A4A', borderColor: '#8B4A4A' }}
                onClick={batchDelete}
                disabled={!selCount || deleting}
              >{deleting ? `⌛ ${progress}` : `🗑 移入回收站 (${selCount})`}</button>
              <button className="oc-btn oc-btn-ghost" style={{ fontSize: 11 }} onClick={() => setOpen(false)}>▴ 收起</button>
            </span>
          </div>

          {err && (
            <div style={{ color: '#8B4A4A', fontSize: 12 }}>
              加载失败: {err} · <a onClick={load} style={{ cursor: 'pointer', textDecoration: 'underline' }}>重试</a>
            </div>
          )}
          {rows !== null && !loading && !err && groups.length === 0 && (
            <div style={{ color: 'var(--ink-4)', fontSize: 12, fontStyle: 'italic' }}>这个时间窗/来源下没有记忆。</div>
          )}

          {/* 分组列表 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 520, overflowY: 'auto' }}>
            {groups.map(g => {
              const gIds = g.items.map(x => x.b.id);
              const gSelCount = gIds.filter(id => sel[id]).length;
              return (
                <div key={g.day}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0 6px', borderBottom: '0.5px solid var(--line-2)', marginBottom: 6 }}>
                    <input
                      type="checkbox"
                      checked={gSelCount === gIds.length && gIds.length > 0}
                      onChange={e => toggleIds(gIds, e.target.checked)}
                      title="全选这一天"
                    />
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', fontWeight: 600 }}>{g.day}</span>
                    <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>{g.items.length} 条{gSelCount > 0 && ` · 选 ${gSelCount}`}</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {g.items.map(({ b, time }) => (
                      <label
                        key={b.id}
                        style={{
                          display: 'grid', gridTemplateColumns: 'auto auto 1fr auto', gap: 8, alignItems: 'baseline',
                          padding: '6px 8px', borderRadius: 6, cursor: 'pointer',
                          background: sel[b.id] ? 'rgba(139,74,74,0.07)' : 'var(--paper)',
                          border: '0.5px solid ' + (sel[b.id] ? 'rgba(139,74,74,0.35)' : 'var(--line-2)'),
                        }}
                      >
                        <input type="checkbox" checked={!!sel[b.id]} onChange={e => toggleIds([b.id], e.target.checked)} />
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)' }}>{time || '--:--'}</span>
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>
                          <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink)' }}>{b.name || b.id}</span>
                          {b.content_preview && <span style={{ color: 'var(--ink-4)', marginLeft: 8, fontSize: 11.5 }}>{b.content_preview.slice(0, 60)}</span>}
                        </span>
                        <span style={{ fontSize: 10, color: 'var(--ink-4)', fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>
                          {b.type === 'feel' && '🫧 '}
                          {b.protected && '📌 '}
                          {srcLabel(b)} · imp {b.importance || 5}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </ConsoleCard>
  );
}

function TrashPage({ onCountChange }) {
  const [items, setItems] = ctS([]);
  const [loading, setLoading] = ctS(true);
  const [err, setErr] = ctS(null);
  const [busy, setBusy] = ctS({});  // id → 'restoring' | 'purging'

  const fetchTrash = async () => {
    try {
      setErr(null);
      const r = await fetch('/api/trash');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      setItems(d.trash || []);
      setLoading(false);
      if (onCountChange) onCountChange((d.trash || []).length);
    } catch (e) {
      setErr(e.message || String(e));
      setLoading(false);
    }
  };

  ctE(() => { fetchTrash(); }, []);

  const restore = async (id, name) => {
    setBusy(b => ({ ...b, [id]: 'restoring' }));
    try {
      const r = await fetch(`/api/bucket/${encodeURIComponent(id)}/restore`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      // 乐观抹除
      setItems(prev => {
        const next = prev.filter(x => x.id !== id);
        if (onCountChange) onCountChange(next.length);
        return next;
      });
    } catch (e) {
      alert(`恢复「${name}」失败: ${e.message}`);
    } finally {
      setBusy(b => { const c = { ...b }; delete c[id]; return c; });
    }
  };

  const purge = async (id, name) => {
    // 二次确认:输入"删除"两字
    const typed = window.prompt(`永久删除「${name}」?\n\n这次无法恢复。请输入"删除"两字确认:`);
    if (typed !== '删除') {
      if (typed !== null) alert('未输入"删除",已取消');
      return;
    }
    setBusy(b => ({ ...b, [id]: 'purging' }));
    try {
      const r = await fetch(`/api/bucket/${encodeURIComponent(id)}/purge`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      setItems(prev => {
        const next = prev.filter(x => x.id !== id);
        if (onCountChange) onCountChange(next.length);
        return next;
      });
    } catch (e) {
      alert(`永久删除「${name}」失败: ${e.message}`);
    } finally {
      setBusy(b => { const c = { ...b }; delete c[id]; return c; });
    }
  };

  const restoreAll = async () => {
    if (!items.length) return;
    if (!window.confirm(`恢复全部 ${items.length} 条?`)) return;
    let failed = 0;
    for (const it of items) {
      try {
        const r = await fetch(`/api/bucket/${encodeURIComponent(it.id)}/restore`, { method: 'POST' });
        if (!r.ok) failed++;
      } catch (e) { failed++; }
    }
    await fetchTrash();
    if (failed) alert(`全部恢复:${failed} 条失败(其余已恢复)。`);
  };

  const purgeAll = async () => {
    if (!items.length) return;
    const typed = window.prompt(`永久清空回收站(${items.length} 条)?\n\n所有桶将物理删除,无法恢复。请输入"全部删除"四字确认:`);
    if (typed !== '全部删除') {
      if (typed !== null) alert('未输入"全部删除",已取消');
      return;
    }
    // 一次请求服务端删全部 — 避免逐条几百次往返导致"每次只删一点"
    setBusy(b => ({ ...b, __all__: 'purging' }));
    try {
      const r = await fetch('/api/trash/empty', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      await fetchTrash();
    } catch (e) {
      alert('清空回收站失败: ' + e.message);
      await fetchTrash();
    } finally {
      setBusy(b => { const c = { ...b }; delete c.__all__; return c; });
    }
  };

  const formatTrashedAt = (s) => {
    if (!s) return '';
    if (window.__obIsoToLocal) {
      const lt = window.__obIsoToLocal(s);
      return `${lt.date} ${lt.time}`;
    }
    return String(s).slice(0, 16).replace('T', ' ');
  };

  return (
    <main className="oc-main">
      <ConsolePageHd
        title="回收站"
        sub={<>软删除的记忆暂存于此 · <b>{items.length}</b> 条 · 可恢复或永久删除</>}
        rightSlot={
          items.length > 0 && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="oc-btn oc-btn-ghost" onClick={restoreAll} disabled={!!busy.__all__} style={{ fontSize: 11 }}>↻ 全部恢复</button>
              <button className="oc-btn oc-btn-ghost" onClick={purgeAll} disabled={!!busy.__all__} style={{ fontSize: 11, color: '#8B4A4A' }}>{busy.__all__ ? '⌛ 清空中…' : '✕ 永久清空'}</button>
            </div>
          )
        }
      />

      {/* 最近写入清理 — 批量撤掉写坏的一批 (软删, 落进下方回收站) */}
      <CleanupSection onTrashChanged={fetchTrash} />

      {loading && <div style={{ padding: 40, textAlign: 'center', color: 'var(--ink-3)' }}>加载中…</div>}
      {err && (
        <div style={{ padding: 14, color: '#8B4A4A', fontSize: 13 }}>
          加载失败: {err} · <a onClick={fetchTrash} style={{ cursor: 'pointer', textDecoration: 'underline' }}>重试</a>
        </div>
      )}
      {!loading && !err && items.length === 0 && (
        <ConsoleCard label="空" sub="回收站是空的">
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--ink-4)', fontStyle: 'italic', fontSize: 13, fontFamily: 'var(--serif)' }}>
            没有被删除的记忆 · 所有删除操作会先进这里
          </div>
        </ConsoleCard>
      )}

      {!loading && !err && items.length > 0 && (
        <ConsoleCard>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {items.map(it => {
              const b = busy[it.id];
              const trashedDisplay = formatTrashedAt(it.trashed_at);
              const summaryText = it.summary || it.content_preview || '(无摘要)';
              return (
                <div
                  key={it.id}
                  style={{
                    padding: '12px 14px',
                    background: 'var(--paper)',
                    border: '0.5px solid var(--line-2)',
                    borderRadius: 8,
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    gap: 12,
                    alignItems: 'center',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <div style={{ fontFamily: 'var(--serif)', fontSize: 14, fontStyle: 'italic', color: 'var(--ink)', fontWeight: 500 }}>
                        {it.name || it.id}
                      </div>
                      {it.noise && (
                        <span style={{
                          fontSize: 9.5, padding: '1px 7px', borderRadius: 999,
                          border: '0.5px solid var(--ink-4)', color: 'var(--ink-4)',
                          fontFamily: 'var(--mono)', letterSpacing: '0.05em',
                          textTransform: 'uppercase',
                        }} title="标记为噪声后被自动归档">⌀ 噪声</span>
                      )}
                      {typeof it.score === 'number' && (
                        <span style={{
                          fontFamily: 'var(--serif)', fontStyle: 'italic',
                          fontSize: 12, color: 'var(--ink-4)',
                          marginLeft: 'auto',
                        }} title="decay 权重(归档时的最终值)">
                          {it.score.toFixed(2)}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 4, lineHeight: 1.6, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                      {summaryText}
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)', marginTop: 5, letterSpacing: '0.02em' }}>
                      {trashedDisplay && <>删除于 {trashedDisplay} · </>}
                      原 type: {it.original_type || 'dynamic'}
                      {(it.tags || []).filter(t => !String(t).startsWith('__')).length > 0 && (
                        <> · {(it.tags || []).filter(t => !String(t).startsWith('__')).slice(0, 4).join(' · ')}</>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    <button
                      className="oc-btn oc-btn-ghost"
                      onClick={() => restore(it.id, it.name)}
                      disabled={!!b}
                      style={{ fontSize: 11, padding: '4px 11px', color: 'var(--accent)', borderColor: 'var(--accent)' }}
                      title="恢复到原 type 目录"
                    >{b === 'restoring' ? '⌛' : '↻ 恢复'}</button>
                    <button
                      className="oc-btn oc-btn-ghost"
                      onClick={() => purge(it.id, it.name)}
                      disabled={!!b}
                      style={{ fontSize: 11, padding: '4px 11px', color: '#8B4A4A' }}
                      title="物理删除,不可恢复(需输入'删除'确认)"
                    >{b === 'purging' ? '⌛' : '✕ 永久删除'}</button>
                  </div>
                </div>
              );
            })}
          </div>
        </ConsoleCard>
      )}
    </main>
  );
}

window.TrashPage = TrashPage;
