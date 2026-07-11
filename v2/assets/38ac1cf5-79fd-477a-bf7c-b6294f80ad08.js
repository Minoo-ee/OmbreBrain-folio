// timeline.jsx —— 主时间线视图

const { useState, useMemo, useEffect, useRef } = React;

// 标签 → emoji 映射（与原界面对齐）
const TAG_META = {
  // 来源类不带图标 — 文字本身够清楚
  '亲手写': { icon: '', tone: 'sage' },
  'AI 写入': { icon: '', tone: 'sage' },
  '导入': { icon: '', tone: 'sage' },
  '已消化': { icon: '◐', tone: 'sage' },
  '保护': { icon: '❖', tone: 'amber' },
  '高亮': { icon: '★', tone: 'amber' },
  'feel(柔软)': { icon: '♡', tone: 'rose' }
};

function Tag({ name }) {
  const m = TAG_META[name] || { icon: '·', tone: 'sage' };
  return (
    <span className={`ob-tag ob-tag-${m.tone}`}>
      {m.icon && <span className="ob-tag-i">{m.icon}</span>}
      <span>{name}</span>
    </span>
  );
}

// 单个时间节点（左侧轴上的圆点 / 重要节点）
function TimelineDot({ importance, highlight, feel }) {
  const isHi = importance >= 8 || highlight;
  const cls = ['ob-dot'];
  if (isHi) cls.push('ob-dot-hi');
  if (feel) cls.push('ob-dot-feel');
  // 尺寸根据 importance 微调
  const size = isHi ? 18 : Math.max(7, Math.min(12, 6 + importance * 0.7));
  return (
    <span className={cls.join(' ')} style={{ width: size, height: size }}>
      {isHi && <span className="ob-dot-pulse" />}
      {isHi && <span className="ob-dot-core" />}
    </span>
  );
}

// 把记忆按日期分组
function groupByDate(items) {
  const map = new Map();
  for (const it of items) {
    if (!map.has(it.date)) map.set(it.date, []);
    map.get(it.date).push(it);
  }
  // 按日期降序,每组内按时间正序(早→晚, 跟当天阅读顺序一致)
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, list]) => [date, list.sort((a, b) => a.time.localeCompare(b.time))]);
}

function formatDate(d) {
  // "2026-04-26" → { day: "26", month: "04月", weekday: "周日" }
  const [y, m, day] = d.split('-');
  const dt = new Date(+y, +m - 1, +day);
  const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dt.getDay()];
  return { y, m, day, wk, dt };
}

function MemoryRow({ item, onOpen }) {
  return (
    <div className="ob-row" onClick={() => onOpen(item)}>
      <div className="ob-row-time">{item.time}</div>
      <div className="ob-row-body">
        <div className="ob-row-title">
          <span>{item.title}</span>
          {item.importance >= 8 && <span className="ob-row-imp">★ {item.importance}</span>}
        </div>
        {item.summary && <div className="ob-row-summary">{item.summary}</div>}
        {item.tags && item.tags.length > 0 && (
          <div className="ob-row-tags">
            {item.tags.map(t => <Tag key={t} name={t} />)}
          </div>
        )}
      </div>
      <div className="ob-row-arrow">↗</div>
    </div>
  );
}

function DateModule({ date, items, onOpenItem, onOpenDay, density }) {
  const f = formatDate(date);
  const hasHi = items.some(i => i.importance >= 8 || i.highlight);
  return (
    <div className={`ob-module ob-density-${density}`}>
      {/* 中轴节点：日期标签 */}
      <div className="ob-axis">
        <div className="ob-axis-date">
          <div className="ob-axis-day">{f.day}</div>
          <div className="ob-axis-mo">{f.m}月</div>
          <div className="ob-axis-wk">{f.wk}</div>
        </div>
        <div className={`ob-axis-node ${hasHi ? 'ob-axis-node-hi' : ''}`} />
      </div>

      {/* 卡片 */}
      <button className="ob-card" onClick={() => onOpenDay(date)}>
        <div className="ob-card-hd">
          <div className="ob-card-meta">
            <span className="ob-card-count">{items.length} 条记忆</span>
            {hasHi && <span className="ob-card-hi-badge">含重要</span>}
            {items.some(i => i.feel) && <span className="ob-card-feel-badge">含 feel</span>}
          </div>
          <span className="ob-card-open">展开当日 →</span>
        </div>
        <div className="ob-card-list">
          {items.slice(0, 4).map(it => (
            <div
              key={it.id}
              className={`ob-line ${it.importance >= 8 || it.highlight ? 'ob-line-hi' : ''}`}
              onClick={(e) => { e.stopPropagation(); onOpenItem(it); }}
            >
              <TimelineDot importance={it.importance} highlight={it.highlight} feel={it.feel} />
              <span className="ob-line-time">{it.time}</span>
              <span className="ob-line-title">{it.title}</span>
              {it.summary && <span className="ob-line-sep">·</span>}
              {it.summary && <span className="ob-line-sum">{it.summary}</span>}
            </div>
          ))}
          {items.length > 4 && (
            <div className="ob-line ob-line-more">
              + {items.length - 4} 条更多 ……
            </div>
          )}
        </div>
      </button>
    </div>
  );
}

function FilterChip({ active, onClick, children, tone }) {
  return (
    <button className={`ob-chip ${active ? 'ob-chip-on' : ''} ${tone ? 'ob-chip-' + tone : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}

function Timeline({ items, query, filters, density, accent, onOpenItem, onOpenDay }) {
  const filtered = useMemo(() => {
    return items.filter(it => {
      if (query) {
        const q = query.toLowerCase();
        const hay = (it.title + ' ' + it.summary + ' ' + (it.body || '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filters.protectedOnly && !it.protected) return false;
      if (filters.noiseOnly && !it.noise) return false;
      if (filters.highlightOnly && !it.highlight) return false;
      if (filters.importantOnly && !((it.importance || 5) >= 8)) return false;
      if (filters.feelOnly && !it.feel) return false;
      return true;
    });
  }, [items, query, filters]);

  const groups = useMemo(() => groupByDate(filtered), [filtered]);

  return (
    <div className="ob-timeline" style={{ '--ob-accent': accent }}>
      {groups.length === 0 && (
        <div className="ob-empty">没有匹配的记忆。试试清空筛选。</div>
      )}
      {groups.map(([date, list]) => (
        <DateModule
          key={date}
          date={date}
          items={list}
          density={density}
          onOpenItem={onOpenItem}
          onOpenDay={onOpenDay}
        />
      ))}
      <div className="ob-timeline-end">
        <div className="ob-timeline-end-dot" />
        <div className="ob-timeline-end-label">时间线起点</div>
      </div>
    </div>
  );
}

window.Timeline = Timeline;
window.MemoryRow = MemoryRow;
window.Tag = Tag;
window.TimelineDot = TimelineDot;
window.formatDate = formatDate;
window.FilterChip = FilterChip;
