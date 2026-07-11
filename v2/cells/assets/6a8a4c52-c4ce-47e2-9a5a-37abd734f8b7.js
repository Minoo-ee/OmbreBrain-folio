// timeline-v2.jsx —— v2 增强时间线
// 增强点：月份分隔符 / 卡片左竖条 / 折叠空白日 / 中轴日热度 / 搜索高亮

const { useState: useS, useMemo: useM, useEffect: useE, useRef: useR } = React;

const TAG_META_V2 = {
  // 来源类不带图标 — 文字本身够清楚
  '亲手写': { icon: '', tone: 'sage' },
  'AI 写入': { icon: '', tone: 'sage' },
  '导入': { icon: '', tone: 'sage' },
  '已消化': { icon: '◐', tone: 'sage' },
  '保护': { icon: '❖', tone: 'amber' },
  '高亮': { icon: '★', tone: 'amber' },
  'feel(柔软)': { icon: '♡', tone: 'rose' }
};

function TagV2({ name }) {
  const m = TAG_META_V2[name] || { icon: '·', tone: 'sage' };
  return (
    <span className={`ob-tag ob-tag-${m.tone}`}>
      {m.icon && <span className="ob-tag-i">{m.icon}</span>}
      <span>{name}</span>
    </span>
  );
}

function TimelineDotV2({ importance, highlight, feel }) {
  const isHi = importance >= 8 || highlight;
  const cls = ['ob-dot'];
  if (isHi) cls.push('ob-dot-hi');
  if (feel) cls.push('ob-dot-feel');
  const size = isHi ? 18 : Math.max(7, Math.min(12, 6 + importance * 0.7));
  return (
    <span className={cls.join(' ')} style={{ width: size, height: size }}>
      {isHi && <span className="ob-dot-pulse" />}
      {isHi && <span className="ob-dot-core" />}
    </span>
  );
}

function formatDateV2(d) {
  const [y, m, day] = d.split('-');
  const dt = new Date(+y, +m - 1, +day);
  const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dt.getDay()];
  return { y, m, day, wk, dt };
}

function dayDiff(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const A = new Date(ay, am - 1, ad), B = new Date(by, bm - 1, bd);
  return Math.round((A - B) / 86400000);
}

// 高亮命中
function Highlight({ text, query, kind }) {
  if (!query || !text) return text;
  const q = query.trim();
  if (!q) return text;
  const lo = text.toLowerCase();
  const ql = q.toLowerCase();
  const idx = lo.indexOf(ql);
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className={`ob-hl ob-hl-${kind || 'title'}`}>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

function FilterChipV2({ active, onClick, children, tone }) {
  return (
    <button className={`ob-chip ${active ? 'ob-chip-on' : ''} ${tone ? 'ob-chip-' + tone : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}

// 月份分隔符
function MonthDivider({ year, month, items }) {
  const monthNames = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
  const en = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const hi = items.filter(i => i.importance >= 8 || i.highlight).length;
  const feel = items.filter(i => i.feel).length;
  return (
    <div className="ob-month">
      <div className="ob-month-axis">
        <div className="ob-month-num">{month}</div>
      </div>
      <div className="ob-month-bar">
        <div className="ob-month-tit">
          <span className="ob-month-en">{en[+month - 1]} {year}</span>
          <span className="ob-month-zh">· {monthNames[+month - 1]}</span>
        </div>
        <div className="ob-month-stats">
          <span><b>{items.length}</b> 条</span>
          {hi > 0 && <span className="ob-month-hi"><b>{hi}</b> 重要</span>}
          {feel > 0 && <span className="ob-month-feel"><b>{feel}</b> feel</span>}
        </div>
      </div>
    </div>
  );
}

function GapRow({ days, fromDate, toDate, expanded, onToggle }) {
  return (
    <div className={`ob-gap ${expanded ? 'on' : ''}`} onClick={onToggle}>
      <div className="ob-gap-axis"><div className="ob-gap-line" /></div>
      <div className="ob-gap-body">
        <span className="ob-gap-dot">···</span>
        <span><em>{days}</em> 天空白</span>
        <span className="ob-gap-range">{toDate} → {fromDate}</span>
      </div>
    </div>
  );
}

// 把当日条目按时段分组：晨 (5-11) / 午 (11-17) / 晚 (17-22) / 夜 (22-5)
function getPeriod(time) {
  const h = parseInt((time || '00:00').split(':')[0], 10);
  if (h >= 5 && h < 11) return { key: 'morning', label: '晨' };
  if (h >= 11 && h < 17) return { key: 'afternoon', label: '午' };
  if (h >= 17 && h < 22) return { key: 'evening', label: '晚' };
  return { key: 'night', label: '夜' };
}

function DateModuleV2({ date, items, onOpenItem, onOpenDay, density, query, isToday }) {
  const [expanded, setExpanded] = useS(false);
  const f = formatDateV2(date);
  const hi = items.filter(i => (i.importance || 5) >= 8).length;
  const highlights = items.filter(i => i.highlight).length;
  const pins = items.filter(i => i.protected || i.pinned).length;
  const feels = items.filter(i => i.feel).length;
  const maxImp = Math.max(...items.map(i => i.importance));
  const nodeSize = Math.max(8, Math.min(20, 7 + items.length * 1.1));
  const heatLevel = maxImp >= 9 ? 'l9' : maxImp >= 8 ? 'l8' : maxImp >= 6 ? 'l6' : maxImp >= 4 ? 'l4' : 'l2';

  let cardKind = '';
  if (hi > 0) cardKind = 'ob-card-hi';
  else if (feels > 0) cardKind = 'ob-card-feel';
  const isFlagship = items.some(i => i.importance >= 9);

  // 自动密集模式：>= 7 条进入密集模式，分时段
  const isDense = items.length >= 7;
  const cardCountAttr = isDense ? 'dense' : String(Math.min(items.length, 10));

  // 当日按时间倒序（最新在最上）
  const sorted = [...items].sort((a, b) => b.time.localeCompare(a.time));

  // 显示数量：折叠时按密度规则；本地展开则全部显示
  const COLLAPSED_SHOW = isDense ? 8 : 4;
  const visible = expanded ? sorted : sorted.slice(0, COLLAPSED_SHOW);
  const hidden = sorted.length - visible.length;

  // 密集模式下分时段：仅在显示出来的子集里分段
  const renderLines = () => {
    if (!isDense) {
      return (
        <>
          {visible.map(it => (
            <LineRow key={it.id} it={it} query={query} onOpenItem={onOpenItem} dense={false} />
          ))}
          {hidden > 0 && (
            <div className="ob-line ob-line-more">+ {hidden} 条更多 ……</div>
          )}
        </>
      );
    }
    // 按时段分组（倒序：夜 / 晚 / 午 / 晨）
    const order = ['night', 'evening', 'afternoon', 'morning'];
    const labels = { morning: '晨 · MORNING', afternoon: '午 · AFTERNOON', evening: '晚 · EVENING', night: '夜 · NIGHT' };
    const grouped = {};
    for (const it of visible) {
      const p = getPeriod(it.time);
      if (!grouped[p.key]) grouped[p.key] = [];
      grouped[p.key].push(it);
    }
    return (
      <>
        {order.filter(k => grouped[k]).map(k => (
          <React.Fragment key={k}>
            <div className={`ob-card-period ${k}`}>{labels[k]} · <span style={{opacity:0.6}}>{grouped[k].length}</span></div>
            {grouped[k].map(it => (
              <LineRow key={it.id} it={it} query={query} onOpenItem={onOpenItem} dense={true} />
            ))}
          </React.Fragment>
        ))}
        {hidden > 0 && (
          <div className="ob-line ob-line-more">+ {hidden} 条更多 ……</div>
        )}
      </>
    );
  };

  return (
    <div className={`ob-module ob-density-${density} ${isFlagship ? 'ob-module-flagship' : ''}`} data-screen-label={`day-${date}`}>
      <div className="ob-axis">
        <div className="ob-axis-date">
          <div className="ob-axis-day">{f.day}</div>
          <div className="ob-axis-mo">{f.m}月</div>
          <div className="ob-axis-wk">{f.wk}</div>
        </div>
        <div
          className={`ob-axis-node ob-heat-${heatLevel} ${hi > 0 ? 'ob-axis-node-hi' : ''} ${isToday ? 'ob-axis-node-today' : ''}`}
          style={{ width: nodeSize, height: nodeSize, marginTop: -nodeSize / 2 + 6.5 }}
          title={`${items.length} 条 · 最高 importance ${maxImp}`}
        />
      </div>

      <button
        className={`ob-card ${cardKind} ${isDense ? 'ob-card-dense' : ''} ${expanded ? 'ob-card-expanded' : ''}`}
        data-count={cardCountAttr}
        onClick={() => onOpenDay(date)}
      >
        <div className="ob-card-hd">
          <div className="ob-card-meta">
            <span className="ob-card-count">{items.length} 条记忆</span>
            {pins > 0 && <span className="ob-card-pin-badge">❖ 钉决 · {pins}</span>}
            {highlights > 0 && <span className="ob-card-highlight-badge">★ 高亮 · {highlights}</span>}
            {hi > 0 && <span className="ob-card-hi-badge">✦ 重要 · {hi}</span>}
            {feels > 0 && <span className="ob-card-feel-badge">♡ feel · {feels}</span>}
            {isToday && <span className="ob-card-today-badge">今天</span>}
            {isDense && <span className="ob-card-feel-badge" style={{opacity:0.7}}>密集</span>}
          </div>
          <span className="ob-card-open">展开当日 →</span>
        </div>
        <div className="ob-card-list">
          {renderLines()}
        </div>
        {items.length > COLLAPSED_SHOW && (
          <div
            className="ob-card-fold"
            onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
            role="button"
          >
            <span className="ob-card-fold-line" />
            <span className="ob-card-fold-label">
              {expanded
                ? `↑ 收起 · 仅看前 ${COLLAPSED_SHOW} 条`
                : `↓ 在此展开剩余 ${items.length - COLLAPSED_SHOW} 条`}
            </span>
            <span className="ob-card-fold-line" />
          </div>
        )}
      </button>
    </div>
  );
}

function LineRow({ it, query, onOpenItem, dense }) {
  return (
    <div
      className={`ob-line ${it.importance >= 8 || it.highlight ? 'ob-line-hi' : ''} ${it.feel ? 'ob-line-feel' : ''}`}
      onClick={(e) => { e.stopPropagation(); onOpenItem(it); }}
    >
      <TimelineDotV2 importance={it.importance} highlight={it.highlight} feel={it.feel} />
      <span className="ob-line-time">{it.time}</span>
      <span className="ob-line-title"><Highlight text={it.title} query={query} kind="title" /></span>
      <span className="ob-line-sep">·</span>
      <span className="ob-line-sum"><Highlight text={it.summary} query={query} kind="body" /></span>
    </div>
  );
}

function TimelineV2({ items, query, filters, density, onOpenItem, onOpenDay, todayDate }) {
  const filtered = useM(() => {
    return items.filter(it => {
      if (query) {
        const q = query.toLowerCase();
        const hay = (it.title + ' ' + it.summary + ' ' + (it.body || '') + ' ' + (it.tags || []).join(' ') + ' ' + (it.artifacts || []).join(' ')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filters.protectedOnly && !it.protected) return false;
      if (filters.highlightOnly && !it.highlight) return false;
      if (filters.impHighOnly && !((it.importance || 5) >= 8)) return false;
      if (filters.feelOnly && !it.feel) return false;
      return true;
    });
  }, [items, query, filters]);

  const groups = useM(() => {
    const map = new Map();
    for (const it of filtered) {
      if (!map.has(it.date)) map.set(it.date, []);
      map.get(it.date).push(it);
    }
    return [...map.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([d, list]) => [d, list.sort((a, b) => b.time.localeCompare(a.time))]);
  }, [filtered]);

  // 折叠空白日 state
  const [expandedGaps, setExpandedGaps] = useS({});

  // 把分组按月份切分 + 探测空白
  const rendered = [];
  let lastMonth = null;
  for (let i = 0; i < groups.length; i++) {
    const [date, list] = groups[i];
    const [y, m] = date.split('-');
    const ym = `${y}-${m}`;
    if (ym !== lastMonth) {
      // 这个月在所有分组中的条目
      const monthItems = filtered.filter(it => it.date.startsWith(ym));
      rendered.push({ kind: 'month', key: 'mo-' + ym, year: y, month: m, items: monthItems });
      lastMonth = ym;
    }
    // 检测与上一日期的空白
    if (i > 0) {
      const prev = groups[i - 1][0];
      const diff = dayDiff(prev, date);
      const samePrevMonth = prev.startsWith(ym);
      if (samePrevMonth && diff > 2) {
        rendered.push({ kind: 'gap', key: 'gap-' + prev + '-' + date, days: diff - 1, fromDate: prev, toDate: date });
      }
    }
    rendered.push({ kind: 'day', key: 'day-' + date, date, list });
  }

  return (
    <div className="ob-timeline">
      {groups.length === 0 && (
        <div className="ob-empty">没有匹配的记忆。试试清空筛选。</div>
      )}
      {rendered.map(node => {
        if (node.kind === 'month') return <MonthDivider key={node.key} year={node.year} month={node.month} items={node.items} />;
        if (node.kind === 'gap') {
          const open = !!expandedGaps[node.key];
          return <GapRow key={node.key} days={node.days} fromDate={node.fromDate} toDate={node.toDate} expanded={open} onToggle={() => setExpandedGaps(s => ({ ...s, [node.key]: !s[node.key] }))} />;
        }
        return (
          <DateModuleV2
            key={node.key}
            date={node.date}
            items={node.list}
            density={density}
            query={query}
            isToday={node.date === todayDate}
            onOpenItem={onOpenItem}
            onOpenDay={onOpenDay}
          />
        );
      })}
      <div className="ob-timeline-end">
        <div className="ob-timeline-end-dot" />
        <div className="ob-timeline-end-label">时间线起点</div>
      </div>
    </div>
  );
}

window.TimelineV2 = TimelineV2;
window.TagV2 = TagV2;
window.TimelineDotV2 = TimelineDotV2;
window.formatDateV2 = formatDateV2;
window.FilterChipV2 = FilterChipV2;
window.HighlightV2 = Highlight;
