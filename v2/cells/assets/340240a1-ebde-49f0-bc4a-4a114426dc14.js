// cells.jsx —— 记忆格列表 v2 · 优化版

const { useState: cuS, useMemo: cuM, useEffect: cuE, useRef: cuR } = React;

// ── helpers ──
function relTime(date, time, todayDate) {
  const d1 = new Date(todayDate + 'T23:30');
  const d2 = new Date(date + 'T' + (time || '00:00'));
  const diffH = Math.round((d1 - d2) / 36e5);
  if (diffH < 1) return '刚刚';
  if (diffH < 24) return `${diffH}h前`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 30) return `${diffD}天`;
  const diffMo = Math.floor(diffD / 30);
  if (diffMo < 12) return `${diffMo}月`;
  return `${Math.floor(diffMo / 12)}年`;
}
function isUntitled(title) {
  return /^[a-f0-9]{6,}$/i.test(title);
}
// 重要度梯度: 钉决 > 高亮 > 重要度高(>=8) > feel > 普通 > 待消化(<2)
function tier(item) {
  if (item.protected || item.pinned) return 'pin';
  if (item.highlight) return 'highlight';
  if ((item.importance || 5) >= 8) return 'fresh';
  if (item.feel) return 'feel';
  if (item.importance < 2) return 'cold';
  return 'normal';
}

// importance dot
function ImpDot({ value }) {
  const size = 4 + (value / 10) * 8;  // 4 → 12 px
  const isHi = value >= 8;
  const isCold = value < 2;
  const color = isHi ? 'var(--accent)' : isCold ? 'var(--ink-4)' : 'var(--ink-3)';
  const glow = isHi ? '0 0 6px rgba(110,79,154,0.55)' : 'none';
  return (
    <div className="ob-cell-imp">
      <div
        className="ob-cell-imp-dot"
        style={{
          width: size + 'px', height: size + 'px',
          background: color, boxShadow: glow
        }}
      />
      <div className="ob-cell-imp-num">{value.toFixed(1)}</div>
    </div>
  );
}

function MarkIcon({ item, big }) {
  const cls = big ? 'ob-card-cell-mark' : 'ob-cell-mark';
  if (item.protected || item.pinned) return <span className={`${cls} pin`} title="钉决/保护">❖</span>;
  if (item.highlight) return <span className={`${cls} highlight`} title="高亮">★</span>;
  if ((item.importance || 5) >= 8) return <span className={`${cls} fresh`} title="重要度高">✦</span>;
  if (item.feel) return <span className={`${cls} feel`} title="feel">♡</span>;
  return <span className={cls} title="日常">·</span>;
}

// ── 单条行（列表视图） ──
function CellRow({
  item, todayDate,
  selected, isKeyboard, isFlash,
  onOpen, onToggleSelect, onStartTitleEdit, isTitleEditing,
  onSaveTitle, onCancelTitle, anySelected,
}) {
  const t = tier(item);
  const untitled = isUntitled(item.title);
  const tags = item.tags || [];
  const titleInputRef = cuR(null);

  cuE(() => {
    if (isTitleEditing && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isTitleEditing]);

  const cls = [
    'ob-cell',
    `is-${t}`,
    selected && 'is-selected',
    isKeyboard && 'is-keyboard',
    isFlash && 'is-flash',
    item.internalized && 'is-internalized',
    item.noise && 'is-noise',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={cls}
      onClick={(e) => {
        if (e.target.closest('.ob-cell-pick')) return;
        if (anySelected) { onToggleSelect(item.id); return; }
        onOpen(item);
      }}
    >
      <div className="ob-cell-pick" onClick={(e) => { e.stopPropagation(); onToggleSelect(item.id); }}>
        <div className="ob-cell-pick-cb">{selected ? '✓' : ''}</div>
      </div>

      <div><MarkIcon item={item} /></div>

      <div className="ob-cell-main">
        {isTitleEditing ? (
          <input
            ref={titleInputRef}
            className="ob-cell-title-edit"
            defaultValue={untitled ? '' : item.title}
            placeholder="给这一格命名…"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { onSaveTitle(item.id, e.target.value); }
              if (e.key === 'Escape') { onCancelTitle(); }
            }}
            onBlur={(e) => onSaveTitle(item.id, e.target.value)}
          />
        ) : (
          <div
            className={`ob-cell-title ${untitled ? 'untitled' : ''}`}
            onDoubleClick={(e) => { e.stopPropagation(); onStartTitleEdit(item.id); }}
            title="双击重命名"
          >
            {untitled ? `《未命名 · 写于 ${relTime(item.date, item.time, todayDate)}》` : item.title}
          </div>
        )}
        <div className="ob-cell-meta">
          {tags.length > 0 ? (
            tags.slice(0, 3).map((tg, i) => (
              <React.Fragment key={tg}>
                {i > 0 && <span className="ob-cell-meta-dot">·</span>}
                <span className="ob-cell-meta-tag">{tg}</span>
              </React.Fragment>
            ))
          ) : null}
          {tags.length > 3 && <span className="ob-cell-meta-dot">+{tags.length - 3}</span>}
          {tags.length > 0 && <span className="ob-cell-meta-dot">·</span>}
          <span>{relTime(item.date, item.time, todayDate)}</span>
        </div>
      </div>

      {/* 权重 score 独立列, 跟原版 dashboard 一样的纯数字格式 */}
      {typeof item.score === 'number' && (
        <span className="ob-cell-score" title="decay 权重 (>5 活 / <0.3 自动归档)">
          {item.score.toFixed(2)}
        </span>
      )}

      <div className="ob-cell-sum">
        {(item.body || item.preview || '').slice(0, 80) || '（暂无内容）'}
      </div>

      <ImpDot value={item.importance} />
    </div>
  );
}

// ── 卡片视图 ──
function CardCell({ item, todayDate, selected, isFlash, onOpen, onToggleSelect, anySelected }) {
  const t = tier(item);
  const untitled = isUntitled(item.title);
  const tags = item.tags || [];

  const cls = [
    'ob-card-cell',
    `is-${t}`,
    selected && 'is-selected',
    isFlash && 'is-flash',
    item.internalized && 'is-internalized',
    item.noise && 'is-noise',
  ].filter(Boolean).join(' ');

  const impPct = (item.importance / 10) * 100;
  const isHi = item.importance >= 8;

  return (
    <article
      className={cls}
      onClick={() => { if (anySelected) onToggleSelect(item.id); else onOpen(item); }}
    >
      {!(item.protected || item.pinned || item.feel) && (
        <div className="ob-card-cell-impband" style={{ height: impPct + '%' }} />
      )}
      <div className="ob-card-cell-hd">
        <MarkIcon item={item} big />
        <span className="ob-card-cell-tags">
          {tags.length > 0 ? tags.slice(0, 2).join(' · ') : '未分类'}
        </span>
        <span className="ob-card-cell-time">{relTime(item.date, item.time, todayDate)}</span>
      </div>
      <div className={`ob-card-cell-title ${untitled ? 'untitled' : ''}`}>
        {untitled ? `《未命名 · 写于 ${relTime(item.date, item.time, todayDate)}》` : item.title}
      </div>
      <div className="ob-card-cell-sum">{(item.body || item.preview || '').slice(0, 200)}</div>
      <div className="ob-card-cell-foot">
        <span>{item.date}</span>
        {typeof item.score === 'number' && (
          <span className="ob-card-cell-score" title="decay 权重">
            {item.score.toFixed(2)}
          </span>
        )}
        <span className={`ob-card-cell-imp ${isHi ? 'hi' : ''}`}>{item.importance.toFixed(1)}</span>
      </div>
    </article>
  );
}

// ── 自定义下拉菜单 ──
function PopMenu({ label, value, options, onChange }) {
  const [open, setOpen] = cuS(false);
  const ref = cuR(null);
  cuE(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const current = options.find(o => o.value === value) || options[0];
  return (
    <div className="ob-cells-pop" ref={ref}>
      <button className="ob-cells-pop-btn" onClick={() => setOpen(o => !o)}>
        {current.label}
        <span className="ob-cells-pop-btn-arrow">▾</span>
      </button>
      {open && (
        <div className="ob-cells-pop-menu">
          {options.map(o => (
            <div
              key={o.value}
              className={`ob-cells-pop-item ${o.value === value ? 'on' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              <span className="ob-cells-pop-item-check">{o.value === value ? '✓' : ''}</span>
              <span>{o.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 主视图 ──
function CellsView({ items, todayDate, onOpenItem, onUpdateItem, onCreateItem }) {
  const [query, setQuery] = cuS('');
  // server 全字段搜索结果(覆盖完整正文 + matched_in 命中字段)
  // 客户端 hay 永远漏正文(因 /api/buckets 不下发 body),靠这个补
  const [searchHits, setSearchHits] = cuS(null);
  cuE(() => {
    const q = query.trim();
    if (!q) { setSearchHits(null); return; }
    let cancelled = false;
    const tm = setTimeout(async () => {
      try {
        const data = await window.__obSearch(q, { limit: 100 });
        if (!cancelled) setSearchHits((data.keyword_hits || []).map(h => ({ id: h.id, matched_in: h.matched_in || [] })));
      } catch (e) {
        if (!cancelled) { console.warn('[ombre cells] search failed', e); setSearchHits([]); }
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(tm); };
  }, [query]);
  const [statusFilter, setStatusFilter] = cuS('all');
  const [domainFilters, setDomainFilters] = cuS([]);  // 主题域筛选 (多选 AND)
  const [domainExpanded, setDomainExpanded] = cuS(false);  // 默认 top N, 点击展开全部
  const [tagFilters, setTagFilters] = cuS([]);
  const [tagSearch, setTagSearch] = cuS('');           // 新: tag 搜索框 (1000+ tag 时必备)
  const [tagOpen, setTagOpen] = cuS(false);            // 默认收起
  const [showAllTags, setShowAllTags] = cuS(false);
  const [view, setView] = cuS('list');
  const [sort, setSort] = cuS('imp-desc');
  const [group, setGroup] = cuS('status');
  const [collapsed, setCollapsed] = cuS({});
  const [selected, setSelected] = cuS(new Set());
  const [keyboardIdx, setKeyboardIdx] = cuS(-1);
  const [editingTitle, setEditingTitle] = cuS(null);
  const [previewItem, setPreviewItem] = cuS(null);
  const [flashId, setFlashId] = cuS(null);
  const [showKbdHint, setShowKbdHint] = cuS(false);

  // 行序 masonry: 测每张卡 scrollHeight, 写 grid-row: span N
  // 配合 cells.css 里 grid-auto-rows: 4px + row-gap: 0
  // 14 = 视觉留白 (写进 span, 让卡末尾留出空挡当 gap)
  const gridRef = cuR(null);
  cuE(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const ROW = 4, GAP = 14;
    const layout = () => {
      for (const el of grid.children) {
        const h = el.scrollHeight;
        if (!h) continue;
        const span = Math.max(1, Math.ceil((h + GAP) / ROW));
        el.style.gridRowEnd = 'span ' + span;
      }
    };
    layout();
    requestAnimationFrame(layout);
    const obs = new ResizeObserver(layout);
    for (const el of grid.children) obs.observe(el);
    window.addEventListener('resize', layout);
    return () => { obs.disconnect(); window.removeEventListener('resize', layout); };
  });

  // 显示快捷键提示
  cuE(() => {
    const t1 = setTimeout(() => setShowKbdHint(true), 800);
    const t2 = setTimeout(() => setShowKbdHint(false), 5000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  // 状态筛选 — 排序: 钉决 > 高亮 > 重要度高 > 来源(导入/AI写入/我写的) > feel > 已消化 > 待消化 > 噪声
  const statusFilters = cuM(() => {
    const active = items.filter(i => !i.archived);   // 归档桶单独成档, 不混进其它视图
    const c = (fn) => active.filter(fn).length;
    return [
      { id: 'all', label: '全部', tone: '', count: active.length },
      { id: 'pin', label: '❖ 钉决', tone: 'pin', count: c(i => i.protected || i.pinned) },
      { id: 'highlight', label: '★ 高亮', tone: 'highlight', count: c(i => i.highlight) },
      { id: 'imp_high', label: '✦ 重要度≥8', tone: 'fresh', count: c(i => (i.importance || 5) >= 8) },
      { id: 'import', label: '导入', tone: '', count: c(i => i.created_by === 'import') },
      { id: 'ai', label: 'AI 写入', tone: '', count: c(i => (i.created_by || 'ai') === 'ai') },
      { id: 'mine', label: '亲手写', tone: '', count: c(i => i.created_by === 'user') },
      { id: 'feel', label: '♡ Feel', tone: 'feel', count: c(i => i.feel) },
      { id: 'internal', label: '已消化', tone: 'noise', count: c(i => i.internalized) },
      { id: 'cold', label: '待消化', tone: 'noise', count: c(i => (i.score || 0) < 1.5 && !i.noise) },
      { id: 'archived', label: '🗄 已归档', tone: 'noise', count: items.filter(i => i.archived).length },
    ];
  }, [items]);

  // domain 筛选 (聚合所有桶的 metadata.domain)
  const allDomains = cuM(() => {
    const counts = {};
    items.forEach(i => (i.domain || []).forEach(d => { if (d) counts[d] = (counts[d] || 0) + 1; }));
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([d, c]) => ({ domain: d, count: c }));
  }, [items]);

  // tag 筛选 (高基数: 1000+ tag, top 30 + 搜索框)
  const allTags = cuM(() => {
    const counts = {};
    items.forEach(i => (i.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => ({ tag: t, count: c }));
  }, [items]);

  // 搜索匹配 + top N + 始终包含已选中的
  const visibleTags = cuM(() => {
    const q = tagSearch.trim().toLowerCase();
    let pool = allTags;
    if (q) {
      pool = allTags.filter(({ tag }) => String(tag).toLowerCase().includes(q));
    }
    const limit = showAllTags ? pool.length : Math.min(30, pool.length);
    const sliced = pool.slice(0, limit);
    // 已选中的 tag 即使不在 top 30 / 搜索结果里, 也要显示, 否则用户没法看到/取消
    const shown = new Set(sliced.map(x => x.tag));
    const extras = tagFilters
      .filter(t => !shown.has(t))
      .map(t => ({ tag: t, count: (allTags.find(x => x.tag === t) || {}).count || 0 }));
    return [...extras, ...sliced];
  }, [allTags, tagSearch, showAllTags, tagFilters]);

  // 过滤 + 排序
  const filtered = cuM(() => {
    // 已归档单独成档; 其它所有视图(含"全部")排除归档桶
    let v = statusFilter === 'archived' ? items.filter(i => i.archived) : items.filter(i => !i.archived);
    if (statusFilter !== 'all' && statusFilter !== 'archived') {
      if (statusFilter === 'pin') v = v.filter(i => i.protected || i.pinned);
      else if (statusFilter === 'highlight') v = v.filter(i => i.highlight);
      else if (statusFilter === 'imp_high') v = v.filter(i => (i.importance || 5) >= 8);
      else if (statusFilter === 'import') v = v.filter(i => i.created_by === 'import');
      else if (statusFilter === 'ai') v = v.filter(i => (i.created_by || 'ai') === 'ai');
      else if (statusFilter === 'mine') v = v.filter(i => i.created_by === 'user');
      else if (statusFilter === 'feel') v = v.filter(i => i.feel);
      else if (statusFilter === 'internal') v = v.filter(i => i.internalized);
      else if (statusFilter === 'cold') v = v.filter(i => (i.score || 0) < 1.5 && !i.noise);
    }
    if (domainFilters.length > 0) {
      v = v.filter(i => domainFilters.every(d => (i.domain || []).includes(d)));
    }
    if (tagFilters.length > 0) {
      v = v.filter(i => tagFilters.every(t => (i.tags || []).includes(t)));
    }
    if (query) {
      if (Array.isArray(searchHits)) {
        // server 已返回:严格用白名单(覆盖完整正文,且不掺向量噪声)
        const allowed = new Set(searchHits.map(h => h.id));
        v = v.filter(i => allowed.has(i.id));
      } else {
        // server 还在 loading:fallback 客户端 hay (只能搜得到 title/summary/preview/tags)
        const q = query.toLowerCase();
        v = v.filter(i =>
          (i.title + ' ' + i.summary + ' ' + (i.preview || '') + ' ' + (i.body || '') + ' ' + (i.tags || []).join(' ')).toLowerCase().includes(q)
        );
      }
    }
    v = [...v];
    if (sort === 'imp-desc') v.sort((a, b) => b.importance - a.importance);
    else if (sort === 'imp-asc') v.sort((a, b) => a.importance - b.importance);
    else if (sort === 'time-desc') v.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
    else if (sort === 'time-asc') v.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    else if (sort === 'score-desc') v.sort((a, b) => (b.score || 0) - (a.score || 0));
    else if (sort === 'score-asc')  v.sort((a, b) => (a.score || 0) - (b.score || 0));
    return v;
  }, [items, statusFilter, domainFilters, tagFilters, query, searchHits, sort]);

  // 分组
  const groups = cuM(() => {
    if (group === 'none' || view === 'grid') {
      return [{ id: 'all', label: '', icon: '', items: filtered }];
    }
    if (group === 'status') {
      // 梯度: 钉决 > 高亮 > 重要度高(≥8) > feel > 日常 > 待消化(<2) > 已消化(单分一组沉底)
      const g = {
        pin: [], highlight: [], fresh: [], feel: [], normal: [], cold: [], internalized: [],
      };
      filtered.forEach(i => {
        if (i.internalized) g.internalized.push(i);
        else if (i.protected || i.pinned) g.pin.push(i);
        else if (i.highlight) g.highlight.push(i);
        else if ((i.importance || 5) >= 8) g.fresh.push(i);
        else if (i.feel) g.feel.push(i);
        else if (i.importance < 2) g.cold.push(i);
        else g.normal.push(i);
      });
      const out = [
        { id: 'pin', label: '钉决', icon: '❖', tone: 'pin', items: g.pin },
        { id: 'highlight', label: '高亮', icon: '★', tone: 'highlight', items: g.highlight },
        { id: 'fresh', label: '重要', icon: '✦', tone: 'fresh', items: g.fresh },
        { id: 'feel', label: 'Feel', icon: '♡', tone: 'feel', items: g.feel },
        { id: 'normal', label: '日常', icon: '·', tone: '', items: g.normal },
        { id: 'cold', label: '待消化 (<2)', icon: '◌', tone: 'cold', items: g.cold },
        { id: 'internalized', label: '已消化', icon: '◐', tone: '', items: g.internalized },
      ].filter(x => x.items.length > 0);
      return out;
    }
    if (group === 'tag') {
      const buckets = {};
      filtered.forEach(i => {
        const tgs = i.tags && i.tags.length ? i.tags : ['未分类'];
        tgs.forEach(t => {
          if (!buckets[t]) buckets[t] = [];
          buckets[t].push(i);
        });
      });
      return Object.entries(buckets)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([t, its]) => ({ id: 'tag-' + t, label: t, icon: '#', tone: '', items: its }));
    }
    return [{ id: 'all', label: '', icon: '', items: filtered }];
  }, [filtered, group, view]);

  // 扁平化用于键盘导航
  const flatItems = cuM(() => {
    const out = [];
    groups.forEach(g => {
      if (collapsed[g.id]) return;
      g.items.forEach(it => out.push(it));
    });
    return out;
  }, [groups, collapsed]);

  // 切换 tag
  const toggleDomain = (d) => {
    setDomainFilters(curr => curr.includes(d) ? curr.filter(x => x !== d) : [...curr, d]);
  };
  const toggleTag = (t) => {
    setTagFilters(curr => curr.includes(t) ? curr.filter(x => x !== t) : [...curr, t]);
  };

  // 切换选择
  const toggleSelect = (id) => {
    setSelected(curr => {
      const next = new Set(curr);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const clearSelected = () => setSelected(new Set());
  const selectAll = () => setSelected(new Set(flatItems.map(i => i.id)));

  // 标题编辑
  const handleSaveTitle = (id, val) => {
    const v = (val || '').trim();
    if (v) {
      onUpdateItem && onUpdateItem(id, { title: v });
    }
    setEditingTitle(null);
  };

  // 键盘导航
  cuE(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const isInput = tag === 'input' || tag === 'textarea';
      if (isInput) return;

      if (e.key === '/') {
        e.preventDefault();
        const inp = document.querySelector('.ob-cells-search input');
        if (inp) inp.focus();
        return;
      }
      if (e.key === 'Escape') {
        if (previewItem) { setPreviewItem(null); return; }
        if (editingTitle) { setEditingTitle(null); return; }
        if (selected.size > 0) { clearSelected(); return; }
        if (tagFilters.length > 0 || domainFilters.length > 0 || statusFilter !== 'all' || query) {
          setTagFilters([]); setDomainFilters([]); setStatusFilter('all'); setQuery('');
          return;
        }
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setKeyboardIdx(i => Math.min(flatItems.length - 1, (i < 0 ? 0 : i + 1)));
        setPreviewItem(null);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setKeyboardIdx(i => Math.max(0, i - 1));
        setPreviewItem(null);
      } else if (e.key === 'Enter' && keyboardIdx >= 0) {
        e.preventDefault();
        onOpenItem(flatItems[keyboardIdx]);
      } else if (e.key === ' ' && keyboardIdx >= 0) {
        e.preventDefault();
        setPreviewItem(prev => prev?.id === flatItems[keyboardIdx].id ? null : flatItems[keyboardIdx]);
      } else if (e.key === 'x' && keyboardIdx >= 0) {
        e.preventDefault();
        toggleSelect(flatItems[keyboardIdx].id);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault();
        selectAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flatItems, keyboardIdx, previewItem, editingTitle, selected, tagFilters, statusFilter, query]);

  // 滚动键盘焦点到视野
  cuE(() => {
    if (keyboardIdx < 0) return;
    const item = flatItems[keyboardIdx];
    if (!item) return;
    const el = document.querySelector(`[data-cell-id="${item.id}"]`);
    if (el && el.scrollIntoView) {
      const rect = el.getBoundingClientRect();
      if (rect.top < 100 || rect.bottom > window.innerHeight - 60) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [keyboardIdx, flatItems]);

  // 批量操作
  const bulkAction = (action) => {
    const ids = Array.from(selected);
    if (action === 'pin') ids.forEach(id => onUpdateItem(id, { protected: true, pinned: true }));
    else if (action === 'unpin') ids.forEach(id => onUpdateItem(id, { protected: false, pinned: false }));
    else if (action === 'internal') ids.forEach(id => onUpdateItem(id, { internalized: true }));
    else if (action === 'feel') ids.forEach(id => onUpdateItem(id, { feel: true }));
    else if (action === 'noise') {
      if (confirm(`把 ${ids.length} 条标为噪声?\n会加速衰减(×0.05)+ 重要度锁 1, 几天内自动归档(可在回收站恢复)。`)) {
        ids.forEach(id => onUpdateItem(id, { noise: true }));
      }
    }
    else if (action === 'unnoise') {
      ids.forEach(id => onUpdateItem(id, { noise: false }));
    }
    else if (action === 'delete') {
      if (confirm(`真的要删除 ${ids.length} 条记忆吗？`)) {
        ids.forEach(id => onUpdateItem(id, { __delete: true }));
      }
    }
    clearSelected();
  };

  // 上下文 + 副标 — 按梯度顺序: 钉决 > 高亮 > feel
  const subParts = [];
  subParts.push(`${items.length} 格`);
  const pinN = items.filter(i => i.protected || i.pinned).length;
  if (pinN) subParts.push(`${pinN} 钉决`);
  const hiN = items.filter(i => i.highlight && !(i.protected || i.pinned)).length;
  if (hiN) subParts.push(`${hiN} 高亮`);
  const feelN = items.filter(i => i.feel).length;
  if (feelN) subParts.push(`${feelN} feel`);
  const coldN = items.filter(i => i.importance < 2).length;
  if (coldN) subParts.push(`${coldN} 待消化`);

  // 新建格按钮文案（在分类筛选时预填）
  const activeCat = tagFilters.length === 1 ? tagFilters[0] : null;
  const newBtnLabel = activeCat ? `+ 新建「${activeCat}」格` : '+ 新建格';
  const handleNew = () => {
    onCreateItem && onCreateItem({ tags: tagFilters });
  };

  return (
    <main className="ob-cells-page">
      {/* 页头 */}
      <header className="ob-cells-hd">
        <div className="ob-cells-titlebox">
          <h1>记忆格</h1>
          <div className="ob-cells-sub">
            每一格都是一个被命名的瞬间 · {subParts.map((p, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span style={{opacity: 0.5}}> · </span>}
                <b>{p}</b>
              </React.Fragment>
            ))}
          </div>
        </div>
        <div className="ob-cells-actions">
          <button className="ob-cells-add" onClick={handleNew}>{newBtnLabel}</button>
        </div>
      </header>

      {/* 工具条 */}
      <div className="ob-cells-bar">
        <div className="ob-cells-search">
          <span style={{ opacity: 0.5 }}>⌕</span>
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="搜记忆…  按 / 聚焦"
          />
          {query && <button className="ob-cells-search-clear" onClick={() => setQuery('')}>×</button>}
        </div>
        <div className="ob-cells-bar-sep" />
        <span className="ob-cells-bar-label">视图</span>
        <div className="ob-cells-view">
          <button className={`ob-cells-view-btn ${view === 'list' ? 'on' : ''}`} onClick={() => setView('list')}>≡ 列表</button>
          <button className={`ob-cells-view-btn ${view === 'grid' ? 'on' : ''}`} onClick={() => setView('grid')}>▦ 卡片</button>
        </div>
        <div className="ob-cells-bar-sep" />
        <span className="ob-cells-bar-label">分组</span>
        <PopMenu
          value={group}
          onChange={setGroup}
          options={[
            { value: 'status', label: '按状态' },
            { value: 'tag', label: '按分类' },
            { value: 'none', label: '不分组' },
          ]}
        />
        <div className="ob-cells-bar-sep" />
        <span className="ob-cells-bar-label">排序</span>
        <PopMenu
          value={sort}
          onChange={setSort}
          options={[
            { value: 'imp-desc', label: '重要度 ↓' },
            { value: 'imp-asc', label: '重要度 ↑' },
            { value: 'time-desc', label: '时间 · 新→旧' },
            { value: 'time-asc', label: '时间 · 旧→新' },
            { value: 'score-desc', label: '权重 ↓' },
            { value: 'score-asc',  label: '权重 ↑' },
          ]}
        />
      </div>

      {/* 筛选区: 状态行 + 主题域行 + 标签行 */}
      <div className="ob-cells-filters">
        <div className="ob-cells-frow">
          <span className="ob-cells-frow-lab">状态</span>
          {statusFilters.map(f => (
            <button
              key={f.id}
              className={`ob-cells-chip ${statusFilter === f.id ? 'on' : ''} ${f.tone ? 'tone-' + f.tone : ''}`}
              onClick={() => setStatusFilter(f.id)}
            >
              <span>{f.label}</span>
              <span className="ob-cells-chip-count">{f.count}</span>
            </button>
          ))}
        </div>
        {/* 第二行: 主题域 — 独占整行, chips 铺到末尾 */}
        {allDomains.length > 0 && (() => {
          const DOMAIN_TOP_N = 20;
          const selectedSet = new Set(domainFilters);
          const top = allDomains.slice(0, DOMAIN_TOP_N);
          const topIds = new Set(top.map(d => d.domain));
          const extraSelected = allDomains
            .filter(d => selectedSet.has(d.domain) && !topIds.has(d.domain));
          const visibleDomains = domainExpanded ? allDomains : [...extraSelected, ...top];
          const hiddenCount = allDomains.length - visibleDomains.length;
          return (
            <div className={`ob-cells-frow domain-frow ${domainExpanded ? 'expanded' : ''}`}>
              <span className="ob-cells-frow-lab">主题域</span>
              <div className="domain-chips-track">
                {visibleDomains.map(({ domain: dm, count }) => (
                  <button
                    key={dm}
                    className={`ob-cells-chip ${domainFilters.includes(dm) ? 'on' : ''}`}
                    onClick={() => toggleDomain(dm)}
                  >
                    <span>{dm}</span>
                    <span className="ob-cells-chip-count">{count}</span>
                  </button>
                ))}
              </div>
              {hiddenCount > 0 && !domainExpanded && (
                <button className="ob-cells-frow-more" onClick={() => setDomainExpanded(true)}>
                  +{hiddenCount} 更多
                </button>
              )}
              {domainExpanded && allDomains.length > DOMAIN_TOP_N && (
                <button className="ob-cells-frow-more" onClick={() => setDomainExpanded(false)}>
                  收起
                </button>
              )}
              {domainFilters.length > 0 && (
                <button className="ob-cells-frow-more" onClick={() => setDomainFilters([])} style={{color: 'var(--accent)'}}>
                  清空
                </button>
              )}
            </div>
          );
        })()}
        <div className="ob-cells-frow">
          <button
            className={`ob-cells-frow-toggle ${tagFilters.length > 0 ? 'has-active' : ''}`}
            onClick={() => setTagOpen(o => !o)}
          >
            <span className="ob-cells-frow-toggle-chev">{tagOpen ? '▾' : '▸'}</span>
            <span className="ob-cells-frow-lab">标签</span>
            {tagFilters.length > 0 && (
              <span className="ob-cells-frow-toggle-badge">{tagFilters.length}</span>
            )}
            {!tagOpen && (
              <span className="ob-cells-frow-toggle-meta">
                {tagFilters.length > 0
                  ? tagFilters.slice(0, 3).join(' / ') + (tagFilters.length > 3 ? ` +${tagFilters.length - 3}` : '')
                  : `${allTags.length} 个`}
              </span>
            )}
          </button>
          {tagOpen && (
            <>
              <input
                className="ob-cells-tag-search"
                value={tagSearch}
                onChange={(e) => setTagSearch(e.target.value)}
                placeholder={`搜 ${allTags.length} 个标签…`}
              />
              {tagSearch && (
                <button className="ob-cells-search-clear" onClick={() => setTagSearch('')}>×</button>
              )}
              {visibleTags.map(({ tag: tg, count }) => (
                <button
                  key={tg}
                  className={`ob-cells-chip ${tagFilters.includes(tg) ? 'on' : ''}`}
                  onClick={() => toggleTag(tg)}
                >
                  <span>{tg}</span>
                  <span className="ob-cells-chip-count">{count}</span>
                </button>
              ))}
              {!tagSearch && !showAllTags && allTags.length > 30 && (
                <button className="ob-cells-frow-more" onClick={() => setShowAllTags(true)}>
                  +{allTags.length - 30} 全部展开
                </button>
              )}
              {!tagSearch && showAllTags && allTags.length > 30 && (
                <button className="ob-cells-frow-more" onClick={() => setShowAllTags(false)}>
                  收起 (前 30)
                </button>
              )}
              {tagFilters.length > 0 && (
                <button className="ob-cells-frow-more" onClick={() => setTagFilters([])} style={{color: 'var(--accent)'}}>
                  清空筛选
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* 批量操作条 */}
      {selected.size > 0 && (
        <div className="ob-cells-bulk">
          <span className="ob-cells-bulk-count">已选 {selected.size} 条</span>
          <div className="ob-cells-bulk-sep" />
          <button className="ob-cells-bulk-btn" onClick={() => bulkAction('pin')}>❖ 钉决</button>
          <button className="ob-cells-bulk-btn" onClick={() => bulkAction('unpin')}>◯ 取消钉决</button>
          <button className="ob-cells-bulk-btn" onClick={() => bulkAction('feel')}>♡ 标 feel</button>
          <button className="ob-cells-bulk-btn" onClick={() => bulkAction('internal')}>◐ 标内化</button>
          <button className="ob-cells-bulk-btn" onClick={() => bulkAction('noise')} title="加速衰减 + importance 锁 1, 几天内归档">⌀ 标噪声</button>
          <button className="ob-cells-bulk-btn" onClick={() => bulkAction('unnoise')}>↺ 取消噪声</button>
          <button className="ob-cells-bulk-btn danger" onClick={() => bulkAction('delete')}>✕ 删除</button>
          <div className="ob-cells-bulk-spacer" />
          <button className="ob-cells-bulk-btn" onClick={selectAll}>全选当前</button>
          <button className="ob-cells-bulk-btn" onClick={clearSelected}>取消</button>
        </div>
      )}

      {/* 主体 */}
      {filtered.length === 0 ? (
        <div className="ob-cells-empty">空白页 · 没有符合条件的记忆</div>
      ) : view === 'list' ? (
        <div className="ob-cells-list">
          {groups.map(g => {
            const isCollapsed = !!collapsed[g.id];
            return (
              <React.Fragment key={g.id}>
                {g.label && (
                  <div
                    className={`ob-cells-group-hd ${isCollapsed ? 'collapsed' : ''}`}
                    onClick={() => setCollapsed(c => ({ ...c, [g.id]: !c[g.id] }))}
                  >
                    <span className="ob-cells-group-hd-arrow">▾</span>
                    <span className={`ob-cells-group-hd-icon ${g.tone || ''}`}>{g.icon}</span>
                    <span className="ob-cells-group-hd-name">{g.label}</span>
                    <span className="ob-cells-group-hd-count">{g.items.length} 条</span>
                    <span className="ob-cells-group-hd-rule" />
                  </div>
                )}
                {!isCollapsed && g.items.map(it => {
                  const idxInFlat = flatItems.findIndex(x => x.id === it.id);
                  return (
                    <div data-cell-id={it.id} key={it.id}>
                      <CellRow
                        item={it}
                        todayDate={todayDate}
                        selected={selected.has(it.id)}
                        isKeyboard={keyboardIdx === idxInFlat}
                        isFlash={flashId === it.id}
                        anySelected={selected.size > 0}
                        onOpen={onOpenItem}
                        onToggleSelect={toggleSelect}
                        onStartTitleEdit={(id) => setEditingTitle(id)}
                        isTitleEditing={editingTitle === it.id}
                        onSaveTitle={handleSaveTitle}
                        onCancelTitle={() => setEditingTitle(null)}
                      />
                    </div>
                  );
                })}
              </React.Fragment>
            );
          })}
        </div>
      ) : (
        <div className="ob-cells-grid" ref={gridRef}>
          {filtered.map(it => (
            <CardCell
              key={it.id}
              item={it}
              todayDate={todayDate}
              selected={selected.has(it.id)}
              isFlash={flashId === it.id}
              anySelected={selected.size > 0}
              onOpen={onOpenItem}
              onToggleSelect={toggleSelect}
            />
          ))}
        </div>
      )}

      {/* 空格预览 */}
      {previewItem && (
        <div className="ob-preview" onClick={(e) => e.stopPropagation()}>
          <div className="ob-preview-hd">
            <b>预览</b>
            <span>·</span>
            <span>{previewItem.date} {previewItem.time}</span>
            <span style={{marginLeft: 'auto'}}>imp {previewItem.importance.toFixed(1)}</span>
          </div>
          <div className="ob-preview-title">
            {isUntitled(previewItem.title) ? '《未命名》' : previewItem.title}
          </div>
          <div className="ob-preview-sum">{previewItem.summary || previewItem.body || '（无内容）'}</div>
          {(previewItem.tags || []).length > 0 && (
            <div className="ob-preview-meta">
              {(previewItem.tags || []).map(t => <span key={t}>#{t}</span>)}
            </div>
          )}
          <div className="ob-preview-foot">
            <kbd>Enter</kbd> 打开完整 · <kbd>Esc</kbd> 关闭 · <kbd>↑↓</kbd> 切换
          </div>
        </div>
      )}

      {/* 键盘提示 */}
      {showKbdHint && selected.size === 0 && (
        <div className="ob-cells-kbd">
          <span><b>↑↓</b> 选行</span>
          <span><b>↵</b> 打开</span>
          <span><b>␣</b> 预览</span>
          <span><b>X</b> 多选</span>
          <span><b>⌘A</b> 全选</span>
          <span><b>/</b> 搜索</span>
          <span><b>⎋</b> 重置</span>
        </div>
      )}
    </main>
  );
}

window.CellsView = CellsView;
window.__cellsHelpers = { isUntitled, relTime };
