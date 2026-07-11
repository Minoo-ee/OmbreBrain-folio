// constellation-panels.jsx —— 左浮筛选/图例 + 右抽屉详情 + 底栏工具

const { useState: cpS, useMemo: cpM } = React;

// 跟 buildLinks 的 AUTO_TAGS 同步 — 桥接层自动注入的状态标签, 不算主题标签
const _CS_AUTO_TAGS = new Set([
  '亲手写', 'AI 写入', '已消化', '保护', '重要', 'feel(柔软)',
]);
function _csIsTopical(t) {
  if (!t) return false;
  const s = String(t);
  if (s.startsWith('__')) return false;
  if (_CS_AUTO_TAGS.has(s)) return false;
  return true;
}

// ── 左浮面板 ──
function LeftPanel({
  items, links, layout,
  mode, setMode,
  enabledTypes, toggleType,
  extraFilters, toggleExtra,   // 新: Set<'fresh' | 'mine'>
  tagFilters, toggleTag,
  impMin, setImpMin,
  searchQuery,
  onFocusIsland,
}) {
  // 类型分布 (4 视觉类)
  const typeCounts = cpM(() => {
    const c = { dynamic: 0, permanent: 0, feel: 0, archived: 0 };
    items.forEach(it => c[inferType(it)]++);
    return c;
  }, [items]);

  // 额外过滤项的统计
  const extraCounts = cpM(() => ({
    highlight: items.filter(i => i.highlight).length,
    fresh: items.filter(i => (i.importance || 5) >= 8).length,
    mine: items.filter(i => i.created_by === 'user').length,
    import: items.filter(i => i.created_by === 'import').length,
    ai: items.filter(i => (i.created_by || 'ai') === 'ai').length,
  }), [items]);

  // 全部 tag (排除 AUTO_TAGS / __* + 按出现频次排序 + 含 count)
  const sortedTags = cpM(() => {
    const counts = new Map();
    items.forEach(it => {
      (it.tags || []).forEach(t => {
        if (!_csIsTopical(t)) return;
        counts.set(t, (counts.get(t) || 0) + 1);
      });
    });
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count }));
  }, [items]);

  const [tagsExpanded, setTagsExpanded] = cpS(false);
  const [tagSearch, setTagSearch] = cpS('');
  const TAG_TOP_N = 30;

  // 标签搜索 + top N + 已选保留
  const visibleTags = cpM(() => {
    const q = tagSearch.trim().toLowerCase();
    let pool = sortedTags;
    if (q) {
      pool = sortedTags.filter(({ tag }) => String(tag).toLowerCase().includes(q));
    }
    const limit = (q || tagsExpanded) ? pool.length : Math.min(TAG_TOP_N, pool.length);
    const sliced = pool.slice(0, limit);
    // 已选 tag 即使不在 top N / 搜索结果里也保留
    const shownIds = new Set(sliced.map(x => x.tag));
    const extras = Array.from(tagFilters)
      .filter(t => !shownIds.has(t))
      .map(t => ({ tag: t, count: (sortedTags.find(x => x.tag === t) || {}).count || 0 }));
    return [...extras, ...sliced];
  }, [sortedTags, tagSearch, tagsExpanded, tagFilters]);

  return (
    <aside className="cs-left">
      <div className="cs-section">
        <div className="cs-section-hd"><span>记忆类型 · 点选筛选</span><b>记忆 ({items.length})</b></div>
        <div className="cs-legend">
          {/* 原 4 视觉类 (mutually exclusive) */}
          {[
            ['dynamic',   'dynamic',   '日常动态'],
            ['permanent', 'permanent', '钉决'],
            ['feel',      'feel',      '情感 · feel'],
          ].map(([k, en, name]) => (
            <div
              key={k}
              className={`cs-legend-row ${enabledTypes.has(k) ? '' : 'off'}`}
              onClick={() => toggleType(k)}
            >
              <span className={`cs-legend-dot ${k}`}/>
              <span className="cs-legend-name">{name}<em>{en}</em></span>
              <span className="cs-legend-count">{typeCounts[k] || 0}</span>
            </div>
          ))}
          {/* 新增属性筛选 — 默认不勾, 勾后只显示符合的记忆 (按梯度: 高亮 > 重要度高 > 来源) */}
          {[
            ['highlight', 'highlight', '高亮',    'highlight = true'],
            ['fresh',     'fresh',     '重要',    'importance ≥ 8'],
            ['import',    'import',    '导入',    'created_by = import'],
            ['ai',        'ai',        'AI 写入', 'created_by = ai'],
            ['mine',      'mine',      '我写的',  'created_by = user'],
          ].map(([k, en, name, hint]) => (
            <div
              key={k}
              className={`cs-legend-row extra ${extraFilters.has(k) ? 'on' : ''}`}
              onClick={() => toggleExtra(k)}
              title={hint}
            >
              <span className={`cs-legend-dot ${k}`}/>
              <span className="cs-legend-name">{name}<em>{en}</em></span>
              <span className="cs-legend-count">{extraCounts[k] || 0}</span>
            </div>
          ))}
          {/* archived 视觉类 → "已消化" */}
          <div
            className={`cs-legend-row ${enabledTypes.has('archived') ? '' : 'off'}`}
            onClick={() => toggleType('archived')}
          >
            <span className="cs-legend-dot archived"/>
            <span className="cs-legend-name">已消化<em>internalized</em></span>
            <span className="cs-legend-count">{typeCounts.archived || 0}</span>
          </div>
        </div>
      </div>

      <div className="cs-section">
        <div className="cs-section-hd"><span>importance 阈值</span><b>≥ {impMin}</b></div>
        <div className="cs-imp-slider">
          <input type="range" min="1" max="10" value={impMin} onChange={(e) => setImpMin(parseInt(e.target.value, 10))}/>
          <b>{impMin}</b>
        </div>
      </div>

      {sortedTags.length > 0 && (
        <div className="cs-section">
          <div className="cs-section-hd">
            <span>标签 · 点选筛选</span>
            <b>{tagFilters.size > 0 ? `${tagFilters.size}/` : ''}{sortedTags.length}</b>
          </div>
          <div className="cs-tag-search">
            <input
              type="text"
              value={tagSearch}
              onChange={(e) => setTagSearch(e.target.value)}
              placeholder={`搜 ${sortedTags.length} 个标签…`}
            />
            {tagSearch && (
              <button className="cs-tag-search-clear" onClick={() => setTagSearch('')}>×</button>
            )}
          </div>
          <div className="cs-tag-filters">
            {visibleTags.map(({ tag, count }) => (
              <button
                key={tag}
                className={`cs-tag-chip ${tagFilters.has(tag) ? 'on' : ''}`}
                onClick={() => toggleTag(tag)}
                title={`${count} 条记忆`}
              >{tag} <span className="cs-tag-count">{count}</span></button>
            ))}
            {!tagSearch && sortedTags.length > TAG_TOP_N && (
              <button
                className="cs-tag-more"
                onClick={() => setTagsExpanded(v => !v)}
              >{tagsExpanded ? '收起' : `+${sortedTags.length - TAG_TOP_N} 全部`}</button>
            )}
            {tagSearch && visibleTags.length === 0 && (
              <span className="cs-tag-empty">无匹配标签</span>
            )}
            {tagFilters.size > 0 && (
              <button
                className="cs-tag-more clear"
                onClick={() => Array.from(tagFilters).forEach(t => toggleTag(t))}
              >清空 {tagFilters.size}</button>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
window.LeftPanel = LeftPanel;

// ── 右抽屉详情 ──
function RightDrawer({ item, items, links, onClose, onSelect, onUpdate, onFocus, focusedId }) {
  if (!item) return null;
  const type = inferType(item);
  const vis = TYPE_VIS[type];
  const cells = Array.from({ length: 10 }, (_, i) => i < item.importance);

  // 关联
  const related = cpM(() => {
    if (!item) return [];
    const out = [];
    links.forEach(l => {
      if (l.source === item.id) out.push({ id: l.target, w: l.weight, shared: l.shared });
      if (l.target === item.id) out.push({ id: l.source, w: l.weight, shared: l.shared });
    });
    return out.sort((a, b) => b.w - a.w).slice(0, 5)
      .map(r => ({ ...r, item: items.find(i => i.id === r.id) }))
      .filter(r => r.item);
  }, [item, links, items]);

  return (
    <aside className={`cs-right ${item ? 'open' : ''}`}>
      <div className="cs-right-hd">
        <div className="cs-right-eyebrow">
          <span className="dot" style={{ background: vis.fill }}/>
          <span>{type}</span>
          <span style={{ opacity: 0.5 }}>·</span>
          <span>{item.id.toUpperCase()}</span>
          {item.highlight && <><span style={{ opacity: 0.5 }}>·</span><span style={{ color: 'var(--c-gold)' }}>★ 高亮</span></>}
          {item.protected && <><span style={{ opacity: 0.5 }}>·</span><span>❖ 保护</span></>}
          <button className="cs-right-close" onClick={onClose}>✕</button>
        </div>
        <h2 className="cs-right-title">{item.title}</h2>
        <div className="cs-right-sub">
          <span>{item.date}</span>
          <span className="sep">·</span>
          <span>{item.time}</span>
          <span className="sep">·</span>
          <span>imp {item.importance}</span>
        </div>
      </div>

      <div className="cs-right-body">
        {item.summary && (
          <div>
            <div className="cs-right-section">摘要</div>
            <p className="cs-right-summary" style={{ marginTop: 14 }}>{item.summary}</p>
          </div>
        )}

        {item.body && (
          <div>
            <div className="cs-right-section">正文</div>
            <div className="cs-right-content" style={{ marginTop: 14 }}>{item.body}</div>
          </div>
        )}

        <div>
          <div className="cs-right-section">元数据</div>
          <div className="cs-right-meta-grid" style={{ marginTop: 14 }}>
            <div className="cs-right-meta-cell">
              <span className="lbl">importance</span>
              <span className="val">
                <div className="cs-right-imp-track">
                  {cells.map((on, i) => (
                    <span key={i} className={`cs-right-imp-cell ${on ? 'on' : ''} ${on && i >= 7 ? 'hi' : ''}`}/>
                  ))}
                </div>
              </span>
            </div>
            {typeof item.score === 'number' && (
              <div className="cs-right-meta-cell">
                <span className="lbl">权重 score</span>
                <span className="val" style={{ fontFamily: 'var(--mono)' }}>
                  {item.score.toFixed(2)}
                </span>
              </div>
            )}
            <div className="cs-right-meta-cell">
              <span className="lbl">类型</span>
              <span className="val" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: vis.fill, display: 'inline-block' }}/>
                {type}
              </span>
            </div>
            <div className="cs-right-meta-cell">
              <span className="lbl">创建</span>
              <span className="val">{item.date} {item.time}</span>
            </div>
            <div className="cs-right-meta-cell">
              <span className="lbl">状态</span>
              <span className="val">
                {item.feel ? '♡ feel ' : ''}
                {item.protected ? '❖ 永久 ' : ''}
                {item.highlight ? '★ 高亮 ' : ''}
                {!item.feel && !item.protected && !item.highlight ? '常规' : ''}
              </span>
            </div>
          </div>
        </div>

        {item.tags && item.tags.length > 0 && (
          <div>
            <div className="cs-right-section">标签</div>
            <div className="cs-right-tags" style={{ marginTop: 12 }}>
              {item.tags.map(t => <span key={t} className="cs-right-tag">{t}</span>)}
            </div>
          </div>
        )}

        {related.length > 0 && (
          <div>
            <div className="cs-right-section">关联记忆 · {related.length}</div>
            <div className="cs-right-related-list" style={{ marginTop: 12 }}>
              {related.map(r => (
                <div key={r.id} className="cs-right-related" onClick={() => onSelect(r.id)}>
                  <div className="cs-right-related-eyebrow">
                    <span className="cs-right-related-dot" style={{ background: TYPE_VIS[inferType(r.item)].fill }}/>
                    <span>{inferType(r.item)}</span>
                    <span style={{ opacity: 0.5 }}>·</span>
                    <span>共享 {(r.shared || []).join(' / ') || '同日'}</span>
                    <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)' }}>w {r.w.toFixed(1)}</span>
                  </div>
                  <div className="cs-right-related-title">{r.item.title}</div>
                  {r.item.summary && <div className="cs-right-related-sum">{r.item.summary}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="cs-right-section">操作</div>
          <div className="cs-right-actions" style={{ marginTop: 12 }}>
            <button className={`cs-right-action ${focusedId === item.id ? 'on' : ''}`} onClick={() => onFocus(focusedId === item.id ? null : item.id)}>
              <span className="i">◎</span><span>{focusedId === item.id ? '退出聚焦' : '聚焦'}</span>
            </button>
            <button className="cs-right-action" onClick={() => onUpdate(item.id, { protected: !item.protected })}>
              <span className="i">❖</span><span>{item.protected ? '取消保护' : '保护'}</span>
            </button>
            <button className="cs-right-action" onClick={() => onUpdate(item.id, { archived: !item.archived })}>
              <span className="i">▤</span><span>{item.archived ? '取消归档' : '归档'}</span>
            </button>
            <button className="cs-right-action danger" onClick={() => { if (confirm('确认删除？')) onUpdate(item.id, { __delete: true }); }}>
              <span className="i">✕</span><span>删除</span>
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
window.RightDrawer = RightDrawer;

// ── 底栏工具 ──
function BottomBar({ zoom, setZoom, onReset, focusedId, onClearFocus, mode, setMode, timeOpen, setTimeOpen }) {
  return (
    <div className="cs-bottom">
      <button className="cs-tool" onClick={() => setZoom(z => Math.max(0.3, z * 0.85))} title="缩小">
        <span className="i">−</span>
      </button>
      <span className="cs-zoom-val">{Math.round(zoom * 100)}%</span>
      <button className="cs-tool" onClick={() => setZoom(z => Math.min(3, z * 1.18))} title="放大">
        <span className="i">+</span>
      </button>
      <span className="cs-tool-sep"/>
      <button className="cs-tool" onClick={onReset} title="重置视图">
        <span className="i">⊙</span><span>重置</span>
      </button>
      {focusedId && (
        <button className="cs-tool on" onClick={onClearFocus} title="退出聚焦">
          <span className="i">◎</span><span>退出聚焦</span>
        </button>
      )}
      <span className="cs-tool-sep"/>
      <button className={`cs-tool ${timeOpen ? 'on' : ''}`} onClick={() => setTimeOpen(o => !o)} title="时间回放">
        <span className="i">↻</span><span>时间回放</span>
      </button>
    </div>
  );
}
window.BottomBar = BottomBar;

// ── 时间回放浮条 ──
function TimeBar({ items, value, onChange, rightOpen, onClose }) {
  const sorted = cpM(() => [...items].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)), [items]);
  const N = sorted.length;
  const cur = sorted[Math.min(N - 1, Math.max(0, value))];
  const first = sorted[0], last = sorted[N - 1];
  return (
    <div className={`cs-time-bar ${rightOpen ? 'right-open' : ''}`}>
      <div className="cs-time-bar-hd">
        <span>时间回放</span>
        <span><b>{value + 1}</b> / {N} · {cur ? cur.date : ''}</span>
        <button className="cs-right-close" onClick={onClose} style={{ width: 18, height: 18, fontSize: 11 }}>✕</button>
      </div>
      <input
        type="range"
        min="0"
        max={Math.max(0, N - 1)}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
      />
      <div className="cs-time-bar-foot">
        <span>{first ? first.date : ''}</span>
        <span>{last ? last.date : ''}</span>
      </div>
    </div>
  );
}
window.TimeBar = TimeBar;
