/* app.jsx —— Ombre 手机端
 * Phase 1:基础 + 记忆 tab(首页天卡 / 当天详情 / 单条全貌)接通真后端
 *           日历 / 审阅 / 设置 / 创建 暂用占位屏,下次 chunk 填
 */

const { useState, useEffect, useMemo, useCallback, useRef } = React;

// ─────────────────────────────────────────
// API
// ─────────────────────────────────────────

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  return await r.json();
}

// ─────────────────────────────────────────
// Hash routing —— 仅 hash,server.py 不用动
//   #/                 → 首页
//   #/day/2026-04-26   → 当天详情
//   #/mem/<id>         → 单条全貌
//   #/cal              → 日历
//   #/review           → 审阅
//   #/setting          → 设置(主)
//   #/setting/trash    → 回收站
//   #/setting/import   → 导入(stub)
//   #/new              → 创建新条目
// ─────────────────────────────────────────

function parseHash() {
  const raw = (window.location.hash || '').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  return parts;
}

function navigate(path) {
  const next = path.startsWith('/') ? path : '/' + path;
  window.location.hash = '#' + next;
}

function useRoute() {
  const [parts, setParts] = useState(parseHash);
  useEffect(() => {
    const h = () => setParts(parseHash());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  return parts;
}

// ─────────────────────────────────────────
// Date / format helpers
// ─────────────────────────────────────────

const MO_EN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const WK_EN = ['sun','mon','tue','wed','thu','fri','sat'];

function bucketDate(b) {
  // 优先 event_time(用户/AI 设置的实际发生时间),否则 created
  const raw = b.event_time || b.created || b.last_active || '';
  if (!raw) return null;
  const dt = new Date(raw);
  if (isNaN(dt.getTime())) return null;
  return dt;
}

function dayKeyOf(dt) {
  // 本地时区 YYYY-MM-DD
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fmtDay(dt) {
  return {
    num: String(dt.getDate()),
    mo: MO_EN[dt.getMonth()],
    wk: WK_EN[dt.getDay()],
    year: String(dt.getFullYear()),
  };
}

function fmtTime(dt) {
  const h = String(dt.getHours()).padStart(2, '0');
  const m = String(dt.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function isFeel(b) {
  // 只认 type==='feel' (工作台 toggle feel 时设的权威标记) — 对齐桌面 cells。
  // 2026-06-07 改: 删掉历史兼容的 tag 模糊匹配。type 是 feel 的唯一权威来源;
  // tag 里有 'feel' 字眼是早年兜底, 会把"只在 tag 写了 feel、没真 toggle 成 feel"的老桶误算成 feel。
  return b.type === 'feel';
}

function isNoise(b) {
  return !!(b.resolved && (b.importance || 5) === 1);
}

// 已归档: 后端用 type==='archived' 标记, 原始 /api/buckets 桶**没有**布尔 b.archived 字段。
// (电脑端 cells 是 mock 转换后才有 i.archived; 手机用原始桶 → 必须看 type) 对齐 server.py / cells。
function isArchived(b) {
  return b.type === 'archived';
}

// 命中位置: 关键词搜索时, 算 query 落在哪些字段 (对齐桌面 matched_in 指示)
// 手机搜索是本地子串匹配 (filteredBuckets), 这里同口径逐字段判一遍给出徽章
function matchedFields(b, q) {
  if (!q) return [];
  const ql = q.toLowerCase();
  const out = [];
  if ((b.name || '').toLowerCase().includes(ql)) out.push('标题');
  if ((b.summary || '').toLowerCase().includes(ql)) out.push('摘要');
  if ((b.content_preview || '').toLowerCase().includes(ql)) out.push('正文');
  const visTags = (b.tags || []).filter(t => !String(t).startsWith('__'));
  if (visTags.some(t => String(t).toLowerCase().includes(ql))) out.push('标签');
  return out;
}

function bucketTitle(b) {
  return b.name || b.id;
}

function bucketSummary(b) {
  return b.summary || b.content_preview || '';
}

// ISO 字符串 ↔ datetime-local 输入(YYYY-MM-DDTHH:MM,本地时区)
function toLocalDateTimeStr(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return '';
  const tzMs = dt.getTimezoneOffset() * 60000;
  return new Date(dt.getTime() - tzMs).toISOString().slice(0, 16);
}
function fromLocalDateTimeStr(local) {
  if (!local) return '';
  const dt = new Date(local);
  if (isNaN(dt.getTime())) return '';
  return dt.toISOString();
}

// ─────────────────────────────────────────
// 共用小组件
// ─────────────────────────────────────────

function ImpBar({ n, max = 10, height = 9, w = 2.5, gap = 1.5 }) {
  return (
    <span className="day-card-impbar" style={{ height: height + 'px', gap: gap + 'px' }}>
      {Array.from({ length: max }).map((_, i) => (
        <i key={i} style={{
          width: w + 'px',
          height: ((i + 1) / max * height + 1).toFixed(1) + 'px',
          background: i < n ? 'var(--accent)' : 'var(--bg-2)',
          borderRadius: '1px',
        }}/>
      ))}
    </span>
  );
}

function TabBar({ active }) {
  const tabs = [
    { id: 'home',    href: '/',         ic: '◐', label: '记忆' },
    { id: 'review',  href: '/review',   ic: '✓', label: '审阅' },
    { id: 'fam',     href: '/fam',      ic: '❋', label: '家族' },
    { id: 'cal',     href: '/cal',      ic: '▦', label: '日历' },
    { id: 'setting', href: '/setting',  ic: '⊙', label: '设置' },
  ];
  return (
    <div className="tabbar">
      {tabs.map(t => (
        <button
          key={t.id}
          className={'tabbar-item' + (active === t.id ? ' on' : '')}
          onClick={() => navigate(t.href)}
        >
          <span className="ic">{t.ic}</span>
          <span>{t.label}</span>
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────
// 屏 1 · 首页(天卡折叠)
// ─────────────────────────────────────────

function HomeScreen() {
  // 挂载时一次性读取持久化的过滤状态 (从 /mem 或 /day 回来时恢复)
  // 30 分钟 TTL, 跟 scroll 恢复同周期
  const [filterInit] = useState(() => readHomeFilters());

  const [buckets, setBuckets] = useState(null);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState(() => filterInit?.searchQuery ?? '');
  const [filters, setFilters] = useState(() => filterInit?.filters ?? new Set());
  const [domainFilters, setDomainFilters] = useState(() => filterInit?.domainFilters ?? []);  // 主题域多选
  const [tagFilters, setTagFilters] = useState(() => filterInit?.tagFilters ?? []);           // 标签多选 (AND)
  const [tagSheetOpen, setTagSheetOpen] = useState(false); // 标签筛选 sheet
  const [tagSearch, setTagSearch] = useState('');          // 标签搜索框
  const bodyRef = useRef(null);                            // home-body scroll 恢复用

  // 任一过滤状态变化都持久化, 让用户进出 /mem 时 filter 不丢
  useEffect(() => {
    saveHomeFilters({ filters, domainFilters, tagFilters, searchQuery });
  }, [filters, domainFilters, tagFilters, searchQuery]);
  // 跳全貌→back 回 home 的恢复: lazy useState 在 mount 时读一次 + 立即清 sessionStorage
  // 30 分钟内有效;过期就当没存
  const [moodInit] = useState(() => {
    try {
      const raw = sessionStorage.getItem(MOOD_RESUME_KEY);
      if (!raw) return { resume: null, open: false };
      const saved = JSON.parse(raw);
      sessionStorage.removeItem(MOOD_RESUME_KEY);
      const fresh = saved && (Date.now() - (saved.ts || 0)) < MOOD_RESUME_TTL_MS;
      return fresh ? { resume: saved, open: true } : { resume: null, open: false };
    } catch (_) {
      return { resume: null, open: false };
    }
  });
  const [moodOpen, setMoodOpen] = useState(moodInit.open);

  useEffect(() => {
    let cancel = false;
    api('/api/buckets')
      .then(d => { if (!cancel) setBuckets(Array.isArray(d) ? d : []); })
      .catch(e => { if (!cancel) setError(e.message); });
    return () => { cancel = true; };
  }, []);

  // 数据加载后回到上次保存的 home 滚动位置 (从 /mem/ 或 /day/ 回来)
  useEffect(() => {
    if (!buckets || !bodyRef.current) return;
    const saved = readScroll(SCROLL_KEY_HOME);
    if (saved != null) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (bodyRef.current) bodyRef.current.scrollTop = saved;
      }));
    }
  }, [buckets]);

  const goToMem = (id) => {
    if (bodyRef.current) saveScroll(SCROLL_KEY_HOME, bodyRef.current.scrollTop);
    navigate('/mem/' + encodeURIComponent(id));
  };
  const goToDay = (k) => {
    if (bodyRef.current) saveScroll(SCROLL_KEY_HOME, bodyRef.current.scrollTop);
    navigate('/day/' + k);
  };

  const toggleFilter = (key) => {
    setFilters(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // 应用 chip 筛选 + 搜索 → flat 结果集
  //   噪声: 默认隐藏; 只有 noise chip 开启时才(且只)显示噪声
  const filteredBuckets = useMemo(() => {
    if (!buckets) return [];
    // 已归档单独成档: 归档桶只在 archived chip 下出现, 其它所有视图(含"全部")排除。
    // (/api/buckets 默认 include_archive=True, 不排除会让归档桶漏进普通视图 — 对齐电脑端 cells)
    // 噪声桶 (isNoise) **计入并显示** (2026-06-07 用户定: 噪声=过期记忆不是垃圾, 垃圾直接删) — 对齐 cells active。
    let result = filters.has('archived')
      ? buckets.filter(b => isArchived(b))
      : buckets.filter(b => !isArchived(b));
    // 注: 只看 b.protected, 不再 OR b.pinned —
    // API 的 b.pinned = is_protected OR is_highlighted 兼容老语义, 这里 OR 会把"只高亮没钉决"误判
    // (用户体感: 钉决取消后桶仍在钉决列表 = 它还高亮着, 而高亮 != 钉决)
    if (filters.has('pin'))      result = result.filter(b => b.protected);
    if (filters.has('hi'))       result = result.filter(b => b.highlight);
    if (filters.has('fresh'))    result = result.filter(b => (b.importance || 5) >= 8);
    if (filters.has('feel'))     result = result.filter(b => isFeel(b));
    if (filters.has('internal')) result = result.filter(b => b.internalized || b.digested);
    if (filters.has('cold'))     result = result.filter(b => (b.score || 0) < 1.5);  // 对齐电脑端: 按衰减 score<1.5, 不是 importance<2
    // 来源过滤 — 三态多选 (OR), 缺 created_by 的老桶按 'ai' 计 (跟后端 list 端点 default 一致)
    const srcFilters = ['user', 'ai', 'import'].filter(s => filters.has('src-' + s));
    if (srcFilters.length > 0) {
      result = result.filter(b => srcFilters.includes(b.created_by || 'ai'));
    }
    if (domainFilters.length > 0) {
      result = result.filter(b => domainFilters.every(d => (b.domain || []).includes(d)));
    }
    if (tagFilters.length > 0) {
      result = result.filter(b => tagFilters.every(t => (b.tags || []).includes(t)));
    }

    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter(b => {
        const visTags = (b.tags || []).filter(t => !String(t).startsWith('__')).join(' ');
        const hay = ((b.name || '') + ' ' + (b.summary || '') + ' ' + (b.content_preview || '') + ' ' + visTags).toLowerCase();
        return hay.indexOf(q) >= 0;
      });
    }
    return result;
  }, [buckets, filters, domainFilters, tagFilters, searchQuery]);

  // 聚合 domain / tag (用 buckets 全集而非 filteredBuckets, 让用户始终看到所有可选项)
  const allDomains = useMemo(() => {
    if (!buckets) return [];
    const counts = {};
    buckets.forEach(b => {
      if (isArchived(b)) return;
      (b.domain || []).forEach(d => { if (d) counts[d] = (counts[d] || 0) + 1; });
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([d, c]) => ({ domain: d, count: c }));
  }, [buckets]);

  const allTags = useMemo(() => {
    if (!buckets) return [];
    const counts = {};
    buckets.forEach(b => {
      if (isArchived(b)) return;
      (b.tags || []).forEach(t => {
        if (t && !String(t).startsWith('__')) counts[t] = (counts[t] || 0) + 1;
      });
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, c]) => ({ tag: t, count: c }));
  }, [buckets]);

  const toggleDomain = (d) => setDomainFilters(curr => curr.includes(d) ? curr.filter(x => x !== d) : [...curr, d]);
  const toggleTag = (t) => setTagFilters(curr => curr.includes(t) ? curr.filter(x => x !== t) : [...curr, t]);

  // 默认模式:按本地日期分组
  const days = useMemo(() => {
    if (!buckets) return [];
    const grouped = new Map();
    for (const b of buckets) {
      if (isArchived(b)) continue; // 归档桶单独成档不进天卡; 噪声计入(过期记忆非垃圾)
      const dt = bucketDate(b);
      if (!dt) continue;
      const k = dayKeyOf(dt);
      if (!grouped.has(k)) grouped.set(k, { dt, items: [] });
      grouped.get(k).items.push({ b, dt });
    }
    const arr = Array.from(grouped.entries()).map(([k, { dt, items }]) => {
      items.sort((a, b) => b.dt - a.dt);  // 当日内倒序: 晚→早
      const peakImp = items.reduce((m, it) => Math.max(m, it.b.importance || 5), 0);
      const dots = new Set();
      let hasHi = false;
      for (const { b } of items) {
        if (b.highlight) { dots.add('hi'); hasHi = true; }
        if (isFeel(b)) dots.add('feel');
        if (b.created_by === 'import') dots.add('import');
        else if (b.created_by === 'user') dots.add('note');
        else dots.add('ai');  // 默认 ai (含历史缺失字段的桶)
      }
      return { key: k, dt, dayFmt: fmtDay(dt), cnt: items.length, peakImp, hi: hasHi, dots: Array.from(dots), items };
    });
    arr.sort((a, b) => b.dt - a.dt);
    return arr;
  }, [buckets]);

  const isFiltering = !!searchQuery.trim() || filters.size > 0 || domainFilters.length > 0 || tagFilters.length > 0;
  const flatResults = useMemo(() => {
    if (!isFiltering) return null;
    return [...filteredBuckets].sort((a, b) => {
      const ta = bucketDate(a), tb = bucketDate(b);
      if (!ta && !tb) return 0;
      if (!ta) return 1;
      if (!tb) return -1;
      return tb - ta;
    });
  }, [isFiltering, filteredBuckets]);

  if (error) return (
    <div className="home">
      <div className="app-error">后端错: {error}</div>
      <TabBar active="home"/>
    </div>
  );
  if (!buckets) return (
    <div className="home">
      <div className="app-loading">载入中…</div>
      <TabBar active="home"/>
    </div>
  );

  return (
    <div className="home">
      <div className="home-top">
        <div className="home-hd-row">
          <div className="home-hd-l">
            <h1 className="home-page-title">
              <span className="home-page-mark"/>
              Ombre Brain
            </h1>
            <p className="home-page-sub">按事件时间倒序 · 点天卡看当日全部</p>
          </div>
          <div className="home-page-stat">
            <b>{buckets.length}</b> 条<br/>
            <b>{days.length}</b> 天
          </div>
        </div>

        <div className="home-search">
          <span className="home-search-icon">⌕</span>
          <input
            className="home-search-text"
            type="text"
            placeholder="搜索记忆 / 标签 / 内容…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="home-search-clear" onClick={() => setSearchQuery('')} title="清空">×</button>
          )}
          <div
            className="home-search-mood"
            title="情感唤起 · 选一个心情坐标"
            role="button"
            onClick={() => setMoodOpen(true)}
          />
        </div>

        <div className="home-chips">
          <span
            className={'home-chip' + (filters.size === 0 && domainFilters.length === 0 && tagFilters.length === 0 ? ' on' : '')}
            onClick={() => { setFilters(new Set()); setDomainFilters([]); setTagFilters([]); }}
          >全部</span>
          <span
            className={'home-chip pin' + (filters.has('pin') ? ' on' : '')}
            onClick={() => toggleFilter('pin')}
          >❖ 钉决</span>
          <span
            className={'home-chip hi' + (filters.has('hi') ? ' on' : '')}
            onClick={() => toggleFilter('hi')}
          >★ 高亮</span>
          <span
            className={'home-chip' + (filters.has('fresh') ? ' on' : '')}
            onClick={() => toggleFilter('fresh')}
          >✦ 重要</span>
          <span
            className={'home-chip feel' + (filters.has('feel') ? ' on' : '')}
            onClick={() => toggleFilter('feel')}
          >♡ Feel</span>
          {/* 来源三态 chip — 多选 (OR). 替代旧的 "我写的" 单态.
              改造前 'ai' 混了导入跟 AI 主动写, 改后 import 单独成态 */}
          <span
            className={'home-chip' + (filters.has('src-import') ? ' on' : '')}
            onClick={() => toggleFilter('src-import')}
          >导入</span>
          <span
            className={'home-chip' + (filters.has('src-ai') ? ' on' : '')}
            onClick={() => toggleFilter('src-ai')}
          >AI 写入</span>
          <span
            className={'home-chip' + (filters.has('src-user') ? ' on' : '')}
            onClick={() => toggleFilter('src-user')}
          >亲手写</span>
          {/* 已消化/待消化/已归档 = 低频沉淀状态 (2026-06-07 对齐电脑端: 删噪声 chip → 噪声桶沉底自动归档; 加已归档档) */}
          <span
            className={'home-chip' + (filters.has('internal') ? ' on' : '')}
            onClick={() => toggleFilter('internal')}
          >已消化</span>
          <span
            className={'home-chip' + (filters.has('cold') ? ' on' : '')}
            onClick={() => toggleFilter('cold')}
          >待消化</span>
          <span
            className={'home-chip' + (filters.has('archived') ? ' on' : '')}
            onClick={() => toggleFilter('archived')}
            title="已归档桶 (其它视图默认不显示, 噪声沉底后也归这)"
          >已归档</span>
          <span
            className={'home-chip' + (tagFilters.length > 0 ? ' on' : '')}
            onClick={() => setTagSheetOpen(true)}
            title={`${allTags.length} 个标签可筛选`}
          >🏷 标签{tagFilters.length > 0 ? ` ·${tagFilters.length}` : ''}</span>
        </div>

        {/* 主题域筛选行 — 上游 dashboard domain filter 的 mobile 实现 */}
        {allDomains.length > 0 && (
          <div className="home-domains">
            <span className="home-domains-lab">主题域</span>
            <div className="home-domains-row">
              {allDomains.map(({ domain: d, count }) => (
                <span
                  key={d}
                  className={'home-chip domain' + (domainFilters.includes(d) ? ' on' : '')}
                  onClick={() => toggleDomain(d)}
                >{d} <span style={{ opacity: 0.55 }}>{count}</span></span>
              ))}
              {domainFilters.length > 0 && (
                <span className="home-chip clear" onClick={() => setDomainFilters([])}>清空</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 标签筛选底部抽屉 — 1000+ 标签用专门 sheet 不挤 chip 行 */}
      {tagSheetOpen && (
        <div className="tag-sheet-mask" onClick={() => setTagSheetOpen(false)}>
          <div className="tag-sheet" onClick={e => e.stopPropagation()}>
            <div className="tag-sheet-grip"/>
            <div className="tag-sheet-hd">
              <span className="tag-sheet-title">标签筛选</span>
              <span className="tag-sheet-meta">{allTags.length} 个标签 · 已选 {tagFilters.length}</span>
              <button className="tag-sheet-close" onClick={() => setTagSheetOpen(false)}>完成</button>
            </div>
            <div className="tag-sheet-search">
              <input
                value={tagSearch}
                onChange={(e) => setTagSearch(e.target.value)}
                placeholder="搜索标签…"
                autoFocus
              />
              {tagFilters.length > 0 && (
                <button className="tag-sheet-clear" onClick={() => setTagFilters([])}>清空已选</button>
              )}
            </div>
            <div className="tag-sheet-body">
              {(() => {
                const q = tagSearch.trim().toLowerCase();
                const filtered = q
                  ? allTags.filter(({ tag }) => String(tag).toLowerCase().includes(q))
                  : allTags;
                // 已选的永远顶部 + 视野内
                const selected = tagFilters.map(t => ({ tag: t, count: (allTags.find(x => x.tag === t) || {}).count || 0 }));
                const selectedSet = new Set(tagFilters);
                const rest = filtered.filter(x => !selectedSet.has(x.tag));
                const list = [...selected, ...rest].slice(0, 200);
                if (list.length === 0) {
                  return <div className="tag-sheet-empty">无匹配标签</div>;
                }
                return list.map(({ tag, count }) => (
                  <span
                    key={tag}
                    className={'tag-sheet-chip' + (tagFilters.includes(tag) ? ' on' : '')}
                    onClick={() => toggleTag(tag)}
                  >{tag} <span style={{ opacity: 0.55 }}>{count}</span></span>
                ));
              })()}
            </div>
          </div>
        </div>
      )}

      <div className="home-body" ref={bodyRef}>
        {isFiltering ? (
          <>
            <div className="filter-result-meta">
              共 <b>{flatResults.length}</b> 条
              {searchQuery.trim() && <span> · 关键词「{searchQuery.trim()}」</span>}
              {filters.size > 0 && <span> · {filters.size} 个状态</span>}
              {domainFilters.length > 0 && <span> · {domainFilters.length} 主题域</span>}
              {tagFilters.length > 0 && <span> · {tagFilters.length} 标签</span>}
              <button className="clear-all" onClick={() => { setSearchQuery(''); setFilters(new Set()); setDomainFilters([]); setTagFilters([]); }}>清空 ↺</button>
            </div>
            {flatResults.length === 0 && (
              <div style={{ color: 'var(--ink-4)', textAlign: 'center', padding: '40px 0', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em' }}>
                没有匹配的记忆
              </div>
            )}
            {flatResults.slice(0, 100).map(b => {
              const dt = bucketDate(b);
              return (
                <div
                  key={b.id}
                  className={'dd-item' + (b.highlight ? ' hi' : '')}
                  onClick={() => goToMem(b.id)}
                >
                  <span className="dd-item-time">{dt ? `${fmtDay(dt).num} ${fmtDay(dt).mo}` : '—'}</span>
                  <div className="dd-item-mid">
                    <div className="dd-item-title-row">
                      <span className="dd-item-title">{b.name || b.id}</span>
                      <span className="dd-item-tags">
                        {b.protected && <span className="dd-pip pin" title="钉决"/>}
                        {b.highlight && <span className="dd-pip hi" title="高亮"/>}
                        {(b.importance || 5) >= 8 && !b.highlight && <span className="dd-pip fresh" title="重要"/>}
                        {isFeel(b) && <span className="dd-pip feel" title="feel"/>}
                        {b.created_by === 'import' && <span className="dd-pip import"/>}
                        {b.created_by === 'ai' && <span className="dd-pip ai"/>}
                      </span>
                    </div>
                    <div className="dd-item-snip">{bucketSummary(b)}</div>
                    {searchQuery.trim() && (() => {
                      const mf = matchedFields(b, searchQuery.trim());
                      return mf.length > 0 ? (
                        <div style={{ marginTop: 3, fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.04em', color: 'var(--accent)', opacity: 0.85 }}>
                          命中 {mf.join(' / ')}
                        </div>
                      ) : null;
                    })()}
                  </div>
                  <span className="dd-item-imp">
                    {Array.from({ length: 10 }).map((_, k) => (
                      <i key={k} style={{
                        height: ((k + 1) * 1.2 + 3) + 'px',
                        background: k < (b.importance || 5) ? 'var(--accent)' : 'var(--bg-2)',
                      }}/>
                    ))}
                  </span>
                </div>
              );
            })}
            {flatResults.length > 100 && (
              <div style={{ color: 'var(--ink-4)', textAlign: 'center', padding: '20px 0', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em' }}>
                · 余 {flatResults.length - 100} 条未显示 — 缩小筛选范围 ·
              </div>
            )}
          </>
        ) : (
          <>
            {days.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--ink-4)', padding: '40px 0', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em' }}>
                没有记忆 — 先去后端导入或手动加几条
              </div>
            )}

            {days.map(d => (
              <div
                key={d.key}
                className={'day-card' + (d.hi ? ' hi' : '')}
                onClick={() => goToDay(d.key)}
              >
                <div className="day-card-hd">
                  <div className="day-card-date">
                    <div className="day-card-num">{d.dayFmt.num}</div>
                    <div className="day-card-mo">{d.dayFmt.mo}</div>
                    <div className="day-card-wk">{d.dayFmt.wk}</div>
                  </div>
                  <div className="day-card-mid">
                    <div className="day-card-stat-row">
                      <span className="day-card-cnt"><b>{d.cnt}</b> 条</span>
                      <ImpBar n={d.peakImp}/>
                      <span style={{ color: 'var(--ink-4)' }}>峰 {d.peakImp}</span>
                      <span className="day-card-dots">
                        {d.dots.map((dt, i) => <span key={i} className={'day-card-dot ' + dt}/>)}
                      </span>
                    </div>
                    <div className="day-card-preview">
                      {d.items.slice(0, 2).map(({ b, dt }, i) => (
                        <div key={i} className="day-card-preview-row">
                          <span className="day-card-preview-time">{fmtTime(dt)}</span>
                          <span className="day-card-preview-title">{bucketTitle(b)}</span>
                          {b.protected && <span className="day-card-preview-pip pin" title="钉决"/>}
                          {b.highlight && <span className="day-card-preview-pip hi" title="高亮"/>}
                          {(b.importance || 5) >= 8 && !b.highlight && <span className="day-card-preview-pip fresh" title="重要"/>}
                          {isFeel(b) && <span className="day-card-preview-pip feel" title="feel"/>}
                        </div>
                      ))}
                      {d.cnt > 2 && (
                        <div className="day-card-more">+ 还有 {d.cnt - 2} 条 →</div>
                      )}
                    </div>
                  </div>
                  <span className="day-card-arrow">›</span>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      <button className="home-fab" onClick={() => navigate('/new')} title="写新记忆">+</button>
      <TabBar active="home"/>

      {moodOpen && <MoodEvokeOverlay onClose={() => setMoodOpen(false)} resume={moodInit.resume}/>}
    </div>
  );
}

// ─────────────────────────────────────────
// 情感唤起浮层 (MoodEvokeOverlay)
// 2D pad: 横轴 valence(左消极→右积极) / 纵轴 arousal(下平静→上激动)
// 选定坐标 → POST /api/mood-evoke → 返回叙事 + 引用源
// ─────────────────────────────────────────
// 灵敏度档位 → radius (距离上限, 含象限加权)
const MOOD_RADIUS = { strict: 0.20, normal: 0.35, loose: 0.60 };
const MOOD_RESUME_KEY = 'ombre-mood-resume-v1';
const MOOD_RESUME_TTL_MS = 30 * 60 * 1000;     // 30 分钟内回来才恢复

// 屏幕级 scroll 恢复 — 跳/mem/ 后回来时滚回原位置, 对批量删除工作流很关键
// 30 分钟内有效, 否则当作新的会话不恢复
const SCROLL_KEY_HOME = 'ombre-home-scroll-v1';
const SCROLL_KEY_DAY  = (k) => 'ombre-day-scroll-v1::' + k;
const SCROLL_TTL_MS = 30 * 60 * 1000;
function saveScroll(key, top) {
  try { sessionStorage.setItem(key, JSON.stringify({ top, ts: Date.now() })); } catch (_) {}
}
function readScroll(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s.top !== 'number') return null;
    if (Date.now() - (s.ts || 0) > SCROLL_TTL_MS) return null;
    return s.top;
  } catch (_) { return null; }
}

// home 屏的过滤状态持久化 — 解决"分类下删除一条→回 home 时 filter 被重置→看起来跳回主界面"
// 跟 scroll 同样套路: 每次变化 save, 挂载时 read; 30 分钟 TTL 过期清.
// 持久化范围: filters(Set chip) + domainFilters + tagFilters + searchQuery
const HOME_FILTERS_KEY = 'ombre-home-filters-v1';
function saveHomeFilters(state) {
  try {
    sessionStorage.setItem(HOME_FILTERS_KEY, JSON.stringify({
      filters: Array.from(state.filters || []),
      domainFilters: state.domainFilters || [],
      tagFilters: state.tagFilters || [],
      searchQuery: state.searchQuery || '',
      ts: Date.now(),
    }));
  } catch (_) {}
}
function readHomeFilters() {
  try {
    const raw = sessionStorage.getItem(HOME_FILTERS_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s) return null;
    if (Date.now() - (s.ts || 0) > SCROLL_TTL_MS) return null;
    return {
      filters: new Set(Array.isArray(s.filters) ? s.filters : []),
      domainFilters: Array.isArray(s.domainFilters) ? s.domainFilters : [],
      tagFilters: Array.isArray(s.tagFilters) ? s.tagFilters : [],
      searchQuery: typeof s.searchQuery === 'string' ? s.searchQuery : '',
    };
  } catch (_) { return null; }
}

function MoodEvokeOverlay({ onClose, resume }) {
  // resume = 上次跳全貌前保存的状态; 没有就用默认
  const [v, setV] = useState(() => (resume?.v ?? 0.5));
  const [a, setA] = useState(() => (resume?.a ?? 0.4));
  const [sens, setSens] = useState(() => (resume?.sens ?? 'normal'));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(() => (resume?.result ?? null));
  const [error, setError] = useState(null);
  // 源记忆全文预览浮层: { id, name, content, loading?, error? }
  // 同一条再点关闭(toggle), 不同条切换显示
  const [preview, setPreview] = useState(null);
  const padRef = useRef(null);

  const openSource = async (src) => {
    // 同一条再点 → 关闭
    if (preview && preview.id === src.id) { setPreview(null); return; }
    setPreview({ id: src.id, name: src.name, loading: true });
    try {
      const r = await fetch('/api/bucket/' + encodeURIComponent(src.id));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      setPreview(p => p && p.id === src.id ? { ...p, loading: false, content: d.content || '', meta: d.metadata || {} } : p);
    } catch (e) {
      setPreview(p => p && p.id === src.id ? { ...p, loading: false, error: e.message } : p);
    }
  };

  // pad 拖动: pointer 事件统一处理 mouse/touch
  const handlePointer = (e) => {
    const el = padRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX ?? (e.touches && e.touches[0]?.clientX) ?? 0) - rect.left;
    const py = (e.clientY ?? (e.touches && e.touches[0]?.clientY) ?? 0) - rect.top;
    const vx = Math.max(0, Math.min(1, px / rect.width));
    // 屏幕 y 向下增大, arousal 反过来(上=高)
    const vy = Math.max(0, Math.min(1, 1 - py / rect.height));
    setV(vx);
    setA(vy);
  };

  const onPadDown = (e) => {
    e.preventDefault();
    handlePointer(e);
    const move = (ev) => handlePointer(ev);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const moodLabel = (() => {
    const hiA = a >= 0.6, loA = a <= 0.4;
    const posV = v >= 0.6, negV = v <= 0.4;
    if (posV && hiA) return '兴奋 / 欣快';
    if (posV && loA) return '平和 / 满足';
    if (negV && hiA) return '焦虑 / 愤怒';
    if (negV && loA) return '低落 / 沮丧';
    if (hiA) return '激动';
    if (loA) return '平静';
    if (posV) return '微微正向';
    if (negV) return '微微负向';
    return '中性';
  })();

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetch('/api/mood-evoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ valence: v, arousal: a, top_n: 5, radius: MOOD_RADIUS[sens] }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      setResult(d);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mood-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mood-sheet">
        <div className="mood-hd">
          <div>
            <div className="mood-hd-eyebrow">MOOD · evoke</div>
            <div className="mood-hd-ttl">情感唤起</div>
          </div>
          <button className="mood-x" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <div className="mood-pad-wrap">
          {/* 四角参照标签 */}
          <span className="mood-pad-corner tl">焦虑 / 愤怒</span>
          <span className="mood-pad-corner tr">兴奋 / 欣快</span>
          <span className="mood-pad-corner bl">低落 / 沮丧</span>
          <span className="mood-pad-corner br">平和 / 满足</span>
          {/* 轴标签 */}
          <span className="mood-pad-axis ax-v">→ 效价 valence</span>
          <span className="mood-pad-axis ax-a">↑ 唤醒 arousal</span>
          {/* pad 本体 */}
          <div
            ref={padRef}
            className="mood-pad"
            onPointerDown={onPadDown}
          >
            <div className="mood-pad-grid"/>
            <div className="mood-pad-cross-h"/>
            <div className="mood-pad-cross-v"/>
            <div
              className="mood-pad-dot"
              style={{ left: `${v * 100}%`, top: `${(1 - a) * 100}%` }}
            />
          </div>
        </div>

        <div className="mood-meta">
          <span><b>{moodLabel}</b></span>
          <span className="mood-meta-coord">v {v.toFixed(2)} · a {a.toFixed(2)}</span>
        </div>

        {/* 灵敏度: 控制后端 radius, 严=近圈才收, 宽=放大圈 */}
        <div className="mood-sens-row">
          <span className="mood-sens-lbl">灵敏度</span>
          {[
            { k: 'strict', label: '严' },
            { k: 'normal', label: '正常' },
            { k: 'loose',  label: '宽' },
          ].map(opt => (
            <button
              key={opt.k}
              className={'mood-sens-chip' + (sens === opt.k ? ' on' : '')}
              onClick={() => setSens(opt.k)}
            >{opt.label}</button>
          ))}
        </div>

        <button className="mood-submit" onClick={submit} disabled={busy}>
          {busy ? '正在唤起 …' : '让 AI 用这个心情串记忆'}
        </button>

        {error && <div className="mood-err">{error}</div>}

        {result && (
          <div className="mood-result">
            <div className="mood-result-narr">{result.narrative}</div>
            {result.relaxed && (
              <div className="mood-result-relaxed">
                ⚠ 当前灵敏度下没有匹配项, 已放宽到最近 {result.sources.length} 条
              </div>
            )}
            <div className="mood-result-srcs-hd">
              引自 {result.sources.length} 条记忆 · 距离越小越像
            </div>
            <div className="mood-result-srcs">
              {result.sources.map((s) => {
                const isOpen = preview && preview.id === s.id;
                return (
                  <div
                    key={s.id}
                    className={'mood-result-src' + (isOpen ? ' on' : '')}
                    onClick={() => openSource(s)}
                  >
                    <div className="mood-result-src-ttl">{s.name}</div>
                    <div className="mood-result-src-sum">{s.summary}</div>
                    <div className="mood-result-src-coord">
                      v {s.valence.toFixed(2)} · a {s.arousal.toFixed(2)}
                      {typeof s.distance === 'number' && (
                        <span className="mood-result-src-dist"> · dist {s.distance.toFixed(2)}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* 源记忆全文预览浮层(浮在 mood-sheet 之上) */}
      {preview && (
        <div className="mood-preview-bd" onClick={() => setPreview(null)}>
          <div className="mood-preview-card" onClick={(e) => e.stopPropagation()}>
            <div className="mood-preview-hd">
              <div className="mood-preview-ttl">{preview.name}</div>
              <button
                className="mood-preview-x"
                onClick={() => setPreview(null)}
                aria-label="关闭"
              >×</button>
            </div>
            <div className="mood-preview-body">
              {preview.loading && <div className="mood-preview-loading">载入中…</div>}
              {preview.error && <div className="mood-err" style={{ marginTop: 0 }}>{preview.error}</div>}
              {!preview.loading && !preview.error && (
                <>
                  {(preview.content || '').split(/\n\s*\n/).filter(Boolean).map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                  {!preview.content && <p style={{ color: 'var(--ink-4)' }}>(无内容)</p>}
                </>
              )}
            </div>
            <button
              className="mood-preview-jump"
              onClick={() => {
                // 跳全貌前持久化当前唤起状态; Home 重挂载会读出来自动重开
                try {
                  sessionStorage.setItem(MOOD_RESUME_KEY, JSON.stringify({
                    v, a, sens, result, ts: Date.now(),
                  }));
                } catch (_) { /* sessionStorage 不可用就忽略, 退化为非保活 */ }
                onClose();
                navigate('/mem/' + encodeURIComponent(preview.id));
              }}
              title="去单条全貌界面 · 返回时自动回到这次唤起"
            >去全貌界面 ›</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────
// 屏 2 · 当天详情
// ─────────────────────────────────────────

function DayDetailScreen({ dayKey }) {
  const [buckets, setBuckets] = useState(null);
  const [error, setError] = useState(null);
  const bodyRef = useRef(null);

  useEffect(() => {
    let cancel = false;
    api('/api/buckets')
      .then(d => { if (!cancel) setBuckets(Array.isArray(d) ? d : []); })
      .catch(e => { if (!cancel) setError(e.message); });
    return () => { cancel = true; };
  }, []);

  // 数据加载完后, 回到上次保存的 scroll 位置 (从 /mem/ 回来时)
  useEffect(() => {
    if (!buckets || !bodyRef.current) return;
    const saved = readScroll(SCROLL_KEY_DAY(dayKey));
    if (saved != null) {
      // 双 rAF 确保 DOM 实际 layout 完再 setScrollTop, 单 rAF 偶尔早一帧
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (bodyRef.current) bodyRef.current.scrollTop = saved;
      }));
    }
  }, [buckets, dayKey]);

  // 跳 /mem/ 之前存当前 scroll
  const goToMem = (id) => {
    if (bodyRef.current) saveScroll(SCROLL_KEY_DAY(dayKey), bodyRef.current.scrollTop);
    navigate('/mem/' + encodeURIComponent(id));
  };

  const dayInfo = useMemo(() => {
    if (!buckets) return null;
    const items = [];
    for (const b of buckets) {
      if (isArchived(b)) continue; // 归档单独成档; 噪声计入当天列表(过期记忆非垃圾)
      const dt = bucketDate(b);
      if (!dt) continue;
      if (dayKeyOf(dt) === dayKey) items.push({ b, dt });
    }
    items.sort((a, b) => b.dt - a.dt);  // 当日内倒序: 晚→早
    const refDt = (items[0] && items[0].dt) || new Date(dayKey + 'T12:00:00');
    return {
      items,
      dayFmt: fmtDay(refDt),
      stats: {
        total: items.length,
        feel: items.filter(({ b }) => isFeel(b)).length,
        hi: items.filter(({ b }) => b.highlight).length,
        ai: items.filter(({ b }) => b.created_by === 'ai').length,  // 当日 AI 写入条数 (移动端 stats 原样保留)
      },
    };
  }, [buckets, dayKey]);

  if (error) return (
    <div className="day-detail">
      <div className="app-error">后端错: {error}</div>
      <TabBar active="home"/>
    </div>
  );
  if (!buckets || !dayInfo) return (
    <div className="day-detail">
      <div className="app-loading">载入中…</div>
      <TabBar active="home"/>
    </div>
  );

  return (
    <div className="day-detail">
      <div className="day-detail-top">
        <div className="day-detail-back-row">
          <button className="app-back" onClick={() => navigate('/')}>‹ 记忆</button>
          <span className="app-eyebrow" style={{ marginLeft: 'auto' }}>
            <span>当天 · {dayInfo.items.length}</span>
          </span>
        </div>
        <div className="day-detail-date">
          {dayInfo.dayFmt.num}
          <span className="day-detail-date-mo">{dayInfo.dayFmt.mo} · {dayInfo.dayFmt.year}</span>
          <span className="day-detail-date-wk">{dayInfo.dayFmt.wk}</span>
        </div>
        <div className="day-detail-stats">
          <span><b>{dayInfo.stats.total}</b> 条</span>
          {dayInfo.stats.feel > 0 && <span><b>{dayInfo.stats.feel}</b> feel</span>}
          {dayInfo.stats.hi > 0 && <span><b>{dayInfo.stats.hi}</b> 重要</span>}
        </div>
      </div>

      <div className="day-detail-body" ref={bodyRef}>
        {dayInfo.items.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--ink-4)', padding: '40px 0', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em' }}>
            这天没有记忆
          </div>
        )}
        {dayInfo.items.map(({ b, dt }) => (
          <div
            key={b.id}
            className={'dd-item' + (b.highlight ? ' hi' : '')}
            onClick={() => goToMem(b.id)}
          >
            <span className="dd-item-time">{fmtTime(dt)}</span>
            <div className="dd-item-mid">
              <div className="dd-item-title-row">
                <span className="dd-item-title">{bucketTitle(b)}</span>
                <span className="dd-item-tags">
                  {b.protected && <span className="dd-pip pin" title="钉决"/>}
                  {b.highlight && <span className="dd-pip hi" title="高亮"/>}
                  {(b.importance || 5) >= 8 && !b.highlight && <span className="dd-pip fresh" title="重要"/>}
                  {isFeel(b) && <span className="dd-pip feel" title="feel"/>}
                  {b.created_by === 'import' && <span className="dd-pip import"/>}
                  {b.created_by === 'ai' && <span className="dd-pip ai"/>}
                </span>
              </div>
              <div className="dd-item-snip">{bucketSummary(b)}</div>
            </div>
            <div className="dd-item-right">
              <span className="dd-item-imp">
                {Array.from({ length: 10 }).map((_, k) => (
                  <i key={k} style={{
                    height: ((k + 1) * 1.2 + 3) + 'px',
                    background: k < (b.importance || 5) ? 'var(--accent)' : 'var(--bg-2)',
                  }}/>
                ))}
              </span>
              {typeof b.score === 'number' && (
                <span className="dd-item-score" title="decay 权重">{b.score.toFixed(2)}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <TabBar active="home"/>
    </div>
  );
}

// ─────────────────────────────────────────
// 屏 3 · 单条全貌
// ─────────────────────────────────────────

function MemFullScreen({ id }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancel = false;
    setData(null);
    setError(null);
    api('/api/bucket/' + encodeURIComponent(id))
      .then(d => { if (!cancel) setData(d); })
      .catch(e => { if (!cancel) setError(e.message); });
    return () => { cancel = true; };
  }, [id, refreshKey]);

  if (error) return (
    <div className="mem-full">
      <div className="app-error">后端错: {error}</div>
      <TabBar active="home"/>
    </div>
  );
  if (!data) return (
    <div className="mem-full">
      <div className="app-loading">载入中…</div>
      <TabBar active="home"/>
    </div>
  );

  const m = data.metadata || {};
  const dt = bucketDate({ event_time: m.event_time, created: m.created, last_active: m.last_active });
  const dayFmt = dt ? fmtDay(dt) : null;
  const time = dt ? fmtTime(dt) : '';
  const tags = (m.tags || []).filter(t => !String(t).startsWith('__')); // 隐藏 __* 内部 tag
  const feel = tags.some(t => /feel/i.test(String(t)));
  const importance = m.importance || 5;
  const content = data.content || '';
  // 把 content 拆成段落渲染(空行分段)
  const paragraphs = content.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);

  return (
    <div className="mem-full">
      <div className="mem-full-top">
        <div className="mem-full-back-row">
          <button className="app-back" onClick={() => window.history.back()}>
            ‹ {dayFmt ? `${dayFmt.num} ${dayFmt.mo}` : '返回'}
          </button>
          <span className="app-eyebrow" style={{ marginLeft: 'auto' }}>
            <span>记忆全貌</span>
          </span>
        </div>
        <div className="mem-full-meta">
          {dayFmt && <span>{dayFmt.num} {dayFmt.mo} {dayFmt.year}</span>}
          {time && <><span>·</span><span><b>{time}</b></span></>}
          <span>·</span>
          <span>{m.created_by === 'import' ? '导入' : m.created_by === 'user' ? '亲手写' : 'AI 写入'}</span>
        </div>
      </div>

      <div className="mem-full-body">
        <div className="mem-full-tags">
          {m.highlight && <span className="mem-full-tag hi">★ 高亮</span>}
          {feel && <span className="mem-full-tag feel">feel</span>}
          {isNoise(m) && <span className="mem-full-tag noise">⌀ 噪声</span>}
          {tags.map((t, i) => <span key={i} className="mem-full-tag">{t}</span>)}
        </div>

        <h1 className="mem-full-title">{m.name || data.id}</h1>

        <div className="mem-full-imp-row">
          <span>重要度</span>
          <span className="mem-full-imp-bar">
            {Array.from({ length: 10 }).map((_, i) => (
              <i key={i} style={{
                height: ((i + 1) * 0.85 + 3) + 'px',
                background: i < importance ? 'var(--accent)' : 'var(--bg-2)',
              }}/>
            ))}
          </span>
          <b style={{
            fontFamily: 'var(--serif)', fontStyle: 'italic',
            color: 'var(--accent)', fontWeight: 600, fontSize: '15px'
          }}>{importance} / 10</b>
          <span
            className="mem-full-score-inline"
            title="decay 权重 · 999 = 钉决/永久, <0.3 自动归档"
          >{(typeof data.score === 'number' ? data.score : 0).toFixed(2)}</span>
        </div>

        <div className="mem-full-text">
          {m.summary && <p className="lead">{m.summary}</p>}
          {paragraphs.map((p, i) => <p key={i}>{p}</p>)}
          {!m.summary && paragraphs.length === 0 && (
            <p style={{ color: 'var(--ink-4)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em' }}>
              (暂无内容)
            </p>
          )}
        </div>

        {/* 关联记忆等以后接通时再加 mem-full-section-hd */}
      </div>

      <div className="mem-full-action">
        <button className="mem-full-fab" onClick={() => setEditing(true)} title="编辑" style={{ cursor: 'pointer' }}>✎</button>
      </div>

      {editing && (
        <EditSheet
          bucketId={data.id}
          onClose={() => setEditing(false)}
          onSaved={() => setRefreshKey(k => k + 1)}
        />
      )}

      <TabBar active="home"/>
    </div>
  );
}

// ─────────────────────────────────────────
// EditSheet · 共用编辑底弹(MemFull / Review 都用)
//   bucketId: 要编辑的桶 ID;打开时自动 fetch 完整 metadata + content
//   onClose:  取消 / 关闭
//   onSaved:  成功保存后回调,参数是新 metadata,父组件用来 refresh 自己
// ─────────────────────────────────────────

// 显示用:把 "YYYY-MM-DDTHH:MM" 拆成"YYYY · MM · DD  HH:MM"
function formatLocalDateTimeForDisplay(local) {
  if (!local) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return local;
  return `${m[1]} · ${m[2]} · ${m[3]}    ${m[4]}:${m[5]}`;
}

function DateTimePicker({ value, onChange, onClose }) {
  // value 是本地 datetime 字符串 "YYYY-MM-DDTHH:MM",可空
  const initialDt = value ? new Date(value) : new Date();
  const safeDt = isNaN(initialDt.getTime()) ? new Date() : initialDt;

  const [year, setYear] = useState(safeDt.getFullYear());
  const [month, setMonth] = useState(safeDt.getMonth() + 1);
  const [day, setDay] = useState(safeDt.getDate());
  const [hour, setHour] = useState(safeDt.getHours());
  const [minute, setMinute] = useState(safeDt.getMinutes());

  const today = new Date();
  const todayY = today.getFullYear();
  const todayM = today.getMonth() + 1;
  const todayD = today.getDate();

  const firstDow = new Date(year, month - 1, 1).getDay();
  const lastDay = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= lastDay; d++) cells.push(d);

  const prevMonth = () => {
    let y = year, m = month - 1;
    if (m < 1) { m = 12; y -= 1; }
    setYear(y); setMonth(m);
    if (day > new Date(y, m, 0).getDate()) setDay(new Date(y, m, 0).getDate());
  };
  const nextMonth = () => {
    let y = year, m = month + 1;
    if (m > 12) { m = 1; y += 1; }
    setYear(y); setMonth(m);
    if (day > new Date(y, m, 0).getDate()) setDay(new Date(y, m, 0).getDate());
  };

  const setNow = () => {
    const n = new Date();
    setYear(n.getFullYear());
    setMonth(n.getMonth() + 1);
    setDay(n.getDate());
    setHour(n.getHours());
    setMinute(n.getMinutes());
  };

  const apply = () => {
    const yy = String(year).padStart(4, '0');
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    const hh = String(hour).padStart(2, '0');
    const mn = String(minute).padStart(2, '0');
    onChange(`${yy}-${mm}-${dd}T${hh}:${mn}`);
    onClose();
  };

  return (
    <div className="dt-picker-overlay" onClick={onClose}>
      <div className="dt-picker" onClick={e => e.stopPropagation()}>
        <div className="dt-picker-grip"/>

        <div className="dt-picker-month-row">
          <button className="dt-picker-nav" onClick={prevMonth} title="上个月">‹</button>
          <span className="dt-picker-month-label">
            {MO_EN[month - 1]}
            <span className="y">{year}</span>
          </span>
          <button className="dt-picker-nav" onClick={nextMonth} title="下个月">›</button>
        </div>

        <div className="dt-picker-weekrow">
          <span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span>
        </div>
        <div className="dt-picker-grid">
          {cells.map((c, i) => {
            const isToday = c === todayD && month === todayM && year === todayY;
            const isOn = c === day;
            const cls = 'dt-picker-cell'
              + (c === null ? ' ph' : '')
              + (isToday && !isOn ? ' today' : '')
              + (isOn ? ' on' : '');
            return (
              <button
                key={i}
                className={cls}
                onClick={() => c && setDay(c)}
                disabled={c === null}
              >{c || ''}</button>
            );
          })}
        </div>

        <div className="dt-picker-time-row">
          <span className="lbl">时间</span>
          <input
            type="number"
            inputMode="numeric"
            className="dt-picker-time-input"
            value={String(hour).padStart(2, '0')}
            onChange={e => {
              const v = parseInt(e.target.value, 10);
              if (isNaN(v)) setHour(0);
              else setHour(Math.max(0, Math.min(23, v)));
            }}
            min="0" max="23"
          />
          <span className="dt-picker-time-sep">:</span>
          <input
            type="number"
            inputMode="numeric"
            className="dt-picker-time-input"
            value={String(minute).padStart(2, '0')}
            onChange={e => {
              const v = parseInt(e.target.value, 10);
              if (isNaN(v)) setMinute(0);
              else setMinute(Math.max(0, Math.min(59, v)));
            }}
            min="0" max="59"
          />
        </div>

        <div className="dt-picker-actions">
          <button className="dt-picker-cancel" onClick={onClose}>取消</button>
          <button className="dt-picker-now" onClick={setNow}>此刻</button>
          <button className="dt-picker-done" onClick={apply}>完成</button>
        </div>
      </div>
    </div>
  );
}

function EventTimeField({ value, onChange }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="dt-trigger"
        onClick={() => setOpen(true)}
      >
        {value ? (
          <span className="dt-trigger-value">{formatLocalDateTimeForDisplay(value)}</span>
        ) : (
          <span className="dt-trigger-value empty">点击选择 · 留空用创建时间</span>
        )}
        <span className="dt-trigger-arrow" aria-hidden="true">✎</span>
      </button>
      {open && (
        <DateTimePicker
          value={value}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function FormFields({
  name, setName, summary, setSummary, content, setContent,
  imp, setImp, pin, setPin, tags, setTags, tagInput, setTagInput,
  eventTime, setEventTime,
  showSummary = true, showPin = true, contentRequired = false,
  onRedehydrate, redehydrating,    // 可选:编辑既有桶时传入,新建时不传
  noise, onToggleNoise,            // 可选:编辑既有桶时传入(噪声 toggle)
  createdBy, setCreatedBy,         // 可选:编辑既有桶时传入(来源三态 user/ai/import)
  highlight, setHighlight,         // 可选:核心准则浮现 (跟 pin/protected 是独立维度)
  internalized, setInternalized,   // 可选:已消化 (编辑时才暴露,创建新桶时不该一上来就标已消化)
}) {
  const feel = tags.some(t => /^feel/i.test(String(t)));
  const toggleFeel = () => {
    if (feel) setTags(tags.filter(t => !/^feel/i.test(String(t))));
    else setTags(tags.concat(['feel']));
  };
  const addTag = () => {
    const t = tagInput.trim();
    if (!t) return;
    if (tags.indexOf(t) >= 0) { setTagInput(''); return; }
    setTags(tags.concat([t]));
    setTagInput('');
  };
  const removeTag = (t) => setTags(tags.filter(x => x !== t));

  return (
    <>
      <div className="edit-field">
        <div className="edit-field-lbl">标题{!contentRequired && ' · 可选'}</div>
        <input
          className="edit-input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={contentRequired ? '(留空由 AI 拟定)' : '(留空则用 ID)'}
        />
      </div>

      {showSummary && (
        <div className="edit-field">
          <div className="edit-field-lbl">摘要 · 可选</div>
          <input
            className="edit-input"
            value={summary}
            onChange={e => setSummary(e.target.value)}
            placeholder="(可留空 · 无摘要时展示正文)"
          />
        </div>
      )}

      <div className="edit-field">
        <div className="edit-field-lbl">正文{contentRequired ? ' · 必填' : ''}</div>
        <textarea
          className="edit-textarea"
          value={content}
          onChange={e => setContent(e.target.value)}
          rows={contentRequired ? 8 : 6}
          placeholder={contentRequired ? '想记什么 …' : ''}
        />
      </div>

      {setEventTime && (
        <div className="edit-field">
          <div className="edit-field-lbl">事件时间 · 可选</div>
          <EventTimeField value={eventTime} onChange={setEventTime}/>
        </div>
      )}

      <div className="edit-field">
        <div className="edit-field-lbl">重要度 · importance</div>
        <div className="edit-imp">
          <div className="edit-imp-track">
            {Array.from({ length: 10 }).map((_, i) => (
              <i key={i} className={i < imp ? 'on' : ''} onClick={() => setImp(i + 1)}/>
            ))}
          </div>
          <span className="edit-imp-num">{imp}</span>
        </div>
      </div>

      {setCreatedBy && (
        <div className="edit-field">
          <div className="edit-field-lbl">来源</div>
          <div className="edit-toggle-row">
            {[
              { val: 'user', label: '亲手写' },
              { val: 'ai', label: 'AI 写入' },
              { val: 'import', label: '导入' },
            ].map(opt => (
              <button
                key={opt.val}
                type="button"
                className={'edit-toggle ' + (createdBy === opt.val ? 'on' : '')}
                onClick={() => setCreatedBy(opt.val)}
              >
                <span>{opt.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="edit-field">
        <div className="edit-field-lbl">动态属性</div>
        <div className="edit-toggle-row">
          <button className={'edit-toggle feel ' + (feel ? 'on' : '')} onClick={toggleFeel}>
            <span className="ic">♡</span><span>feel</span>
          </button>
          {showPin && (
            <button className={'edit-toggle pin ' + (pin ? 'on' : '')} onClick={() => setPin(!pin)}>
              <span className="ic">⚲</span><span>钉决</span>
            </button>
          )}
          {setHighlight && (
            <button
              className={'edit-toggle hi ' + (highlight ? 'on' : '')}
              onClick={() => setHighlight(!highlight)}
              title="高亮 = 作为核心准则浮现 (跟钉决独立, 钉决只防衰减不优先浮现)"
            >
              <span className="ic">★</span><span>高亮</span>
            </button>
          )}
          {setInternalized && (
            <button
              className={'edit-toggle internal ' + (internalized ? 'on' : '')}
              onClick={() => setInternalized(!internalized)}
              title="已消化 = 这条已经成为本能,从浮现中隐藏"
            >
              <span className="ic">◐</span><span>已消化</span>
            </button>
          )}
          {onToggleNoise && (
            <button
              className={'edit-toggle noise ' + (noise ? 'on' : '')}
              onClick={onToggleNoise}
              title="标噪声 = 加速衰减(×0.05),从默认列表 / 检索 / AI 浮现里隐藏"
            >
              <span className="ic">⌀</span><span>噪声</span>
            </button>
          )}
          {onRedehydrate && (
            <button
              className="edit-toggle action redehydrate"
              onClick={onRedehydrate}
              disabled={redehydrating}
              title="LLM 重新生成标题/摘要/tags(原内容不变)"
            >
              <span className="ic">↻</span><span>{redehydrating ? '处理中…' : '重新脱水'}</span>
            </button>
          )}
        </div>
      </div>

      <div className="edit-field">
        <div className="edit-field-lbl">标签</div>
        <div className="edit-tags-input">
          {tags.filter(t => !String(t).startsWith('__')).map((t, i) => (
            <span key={i} className="edit-tag-chip">
              {t}<span className="x" onClick={() => removeTag(t)}>×</span>
            </span>
          ))}
          <input
            className="edit-tag-input"
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
            onBlur={() => addTag()}
            placeholder="+ 加标签(点输入框外自动加)"
          />
        </div>
      </div>
    </>
  );
}

function EditSheet({ bucketId, onClose, onSaved, onDeleted }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [content, setContent] = useState('');
  const [imp, setImp] = useState(5);
  const [pin, setPin] = useState(false);
  const [highlight, setHighlight] = useState(false);
  const [internalized, setInternalized] = useState(false);
  const [noise, setNoise] = useState(false);
  const [tags, setTags] = useState([]);
  const [tagInput, setTagInput] = useState('');
  const [eventTime, setEventTime] = useState('');
  const [saving, setSaving] = useState(false);
  const [redehydrating, setRedehydrating] = useState(false);
  // 重新脱水弹窗
  const [redehyOpen, setRedehyOpen] = useState(false);
  // 是否有可重写正文用的原文 (raw_source)
  const [hasRawSource, setHasRawSource] = useState(false);
  // 来源 — user / ai / import 三态
  const [createdBy, setCreatedBy] = useState('ai');
  // 记下加载时的 noise 初值, save 时若没变就完全不动 resolved 字段
  // (resolved 不止是噪声标记, 还表"已解决/未解决", 不能误覆盖)
  const originalNoiseRef = useRef(false);

  useEffect(() => {
    let cancel = false;
    api('/api/bucket/' + encodeURIComponent(bucketId))
      .then(d => {
        if (cancel) return;
        const m = d.metadata || {};
        setName(m.name || '');
        setSummary(m.summary || '');
        setContent(d.content || '');
        setImp(m.importance || 5);
        setPin(!!m.protected);
        setHighlight(!!m.highlight);
        setInternalized(!!(m.internalized || m.digested));
        const initialNoise = isNoise(m);
        setNoise(initialNoise);
        originalNoiseRef.current = initialNoise;
        setTags(m.tags || []);
        setEventTime(toLocalDateTimeStr(m.event_time || m.created || ''));
        setHasRawSource(!!(m.raw_source && String(m.raw_source).trim()));
        setCreatedBy(m.created_by || 'ai');
        setLoading(false);
      })
      .catch(e => { if (!cancel) { setError(e.message); setLoading(false); } });
    return () => { cancel = true; };
  }, [bucketId]);

  // 切噪声: 立刻 POST 持久化(对齐桌面 view-mode 噪声按钮)
  //   标=resolved+importance=1, 取消=resolved=false + importance 拉回 5
  //   置顶桶: 标噪声会自动取消置顶(后端做了, 这里同步表单状态避免后续保存又把它推回去)
  const toggleNoise = async () => {
    const newNoise = !noise;
    const prevImp = imp;
    const prevPin = pin;
    const prevHi = highlight;
    const newImp = newNoise ? 1 : (imp === 1 ? 5 : imp);
    // 乐观本地更新 — 标噪声时后端 marking_noise 路径会同时清 protected + highlight,
    // 前端必须同步, 否则保存又把 protected/highlight 推回去 (跟后端打架)
    setNoise(newNoise);
    setImp(newImp);
    if (newNoise && pin) setPin(false);
    if (newNoise && highlight) setHighlight(false);
    try {
      const r = await fetch('/api/bucket/' + encodeURIComponent(bucketId) + '/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: newNoise, importance: newImp }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || ('HTTP ' + r.status));
      }
      originalNoiseRef.current = newNoise;
    } catch (e) {
      // 回滚
      setNoise(!newNoise);
      setImp(prevImp);
      setPin(prevPin);
      setHighlight(prevHi);
      alert('噪声标记失败: ' + e.message);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: name.trim() || bucketId,
        summary: summary,
        content: content,
        importance: imp,
        tags: tags,
        protected: pin,
        highlight: highlight,
        internalized: internalized,
        event_time: fromLocalDateTimeStr(eventTime),
        created_by: createdBy,
      };
      // 噪声字段只在用户实际切换时发送, 避免误覆盖 resolved 的本意(已解决/未解决)
      if (noise !== originalNoiseRef.current) {
        body.resolved = noise;
        if (noise) body.importance = 1;
      }
      const r = await fetch('/api/bucket/' + encodeURIComponent(bucketId) + '/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      if (onSaved) onSaved(data.metadata || {});
      onClose();
    } catch (e) {
      setError(e.message || String(e));
      setSaving(false);
    }
  };

  // 重新脱水: preview / commit 两步
  const [redehyPreview, setRedehyPreview] = useState(null);  // null = options 阶段; obj = preview 阶段

  const openRedehydrate = () => {
    if (redehydrating || saving) return;
    setRedehyPreview(null);
    setRedehyOpen(true);
  };

  const closeRedehydrate = () => {
    if (redehydrating) return;
    setRedehyOpen(false);
    setRedehyPreview(null);
  };

  // 跑预览 (不写盘)
  const runRedehyPreview = async ({ regenerate_content }) => {
    if (redehydrating || saving) return;
    setRedehydrating(true);
    setError(null);
    try {
      const r = await fetch('/api/bucket/' + encodeURIComponent(bucketId) + '/redehydrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regenerate_content: !!regenerate_content }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      setRedehyPreview(d);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setRedehydrating(false);
    }
  };

  // commit: 用户在预览界面点接受 → 写入 + 回填表单
  const commitRedehy = async (finalDraft) => {
    if (redehydrating || saving) return;
    setRedehydrating(true);
    setError(null);
    try {
      const r = await fetch('/api/bucket/' + encodeURIComponent(bucketId) + '/redehydrate-commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(finalDraft),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      const m = d.metadata || {};
      setName(m.name || '');
      setSummary(m.summary || '');
      setImp(m.importance || imp);
      setPin(!!m.protected);
      setHighlight(!!m.highlight);
      setInternalized(!!(m.internalized || m.digested));
      const newNoise = isNoise(m);
      setNoise(newNoise);
      originalNoiseRef.current = newNoise;
      setTags(m.tags || []);
      if (d.content !== undefined) setContent(d.content);
      if (onSaved) onSaved(m);
      setRedehyOpen(false);
      setRedehyPreview(null);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setRedehydrating(false);
    }
  };

  const del = async () => {
    if (!window.confirm('删除「' + (name || bucketId) + '」?\n移到回收站,可在设置 → 回收站恢复。')) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/bucket/' + encodeURIComponent(bucketId) + '/delete', { method: 'POST' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      onClose();
      if (onDeleted) {
        onDeleted(bucketId);
      } else {
        // 没传 onDeleted (MemFull 等单条详情页) → 显式回 home, 不依赖 history 栈.
        // PWA 冷启动直接进 /mem 时 history 没"上一页", back() 行为不稳;
        // 显式 navigate 保证一定回到列表 + 触发 scroll 恢复, 让连续删除工作流可用.
        navigate('/');
      }
    } catch (e) {
      setError(e.message || String(e));
      setSaving(false);
    }
  };

  return (
    <div className="edit-sheet" onClick={onClose}>
      <div className="edit-sheet-panel" onClick={e => e.stopPropagation()}>
        <div className="edit-sheet-grip"/>
        <div className="edit-sheet-hd">
          <button className="cancel" onClick={onClose} disabled={saving}>取消</button>
          <span className="ttl">{loading ? '载入中…' : '编辑记忆'}</span>
          <button className="save" onClick={save} disabled={loading || saving}>
            {saving ? '保存中' : '保存'}
          </button>
        </div>

        {error && <div className="edit-error">⚠ {error}</div>}

        {loading ? (
          <div className="app-loading" style={{ height: 200 }}>载入中…</div>
        ) : (
          <>
            <FormFields
              name={name} setName={setName}
              summary={summary} setSummary={setSummary}
              content={content} setContent={setContent}
              imp={imp} setImp={setImp}
              pin={pin} setPin={setPin}
              highlight={highlight} setHighlight={setHighlight}
              internalized={internalized} setInternalized={setInternalized}
              tags={tags} setTags={setTags}
              tagInput={tagInput} setTagInput={setTagInput}
              eventTime={eventTime} setEventTime={setEventTime}
              onRedehydrate={openRedehydrate}
              redehydrating={redehydrating}
              noise={noise} onToggleNoise={toggleNoise}
              createdBy={createdBy} setCreatedBy={setCreatedBy}
            />
            <button className="edit-delete-btn" onClick={del} disabled={loading || saving}>
              ✕ 删除这条记忆
            </button>
          </>
        )}
      </div>
      <RedehydrateSheet
        open={redehyOpen}
        title={name}
        hasRawSource={hasRawSource}
        busy={redehydrating}
        preview={redehyPreview}
        onCancel={closeRedehydrate}
        onPreview={runRedehyPreview}
        onReroll={runRedehyPreview}
        onCommit={commitRedehy}
      />
    </div>
  );
}

// ─────────────────────────────────────────
// RedehydrateSheet — 手机端重新脱水抽屉 (两阶段)
// Phase 1 (options): 选项 + 「同时重新提炼正文」勾选
// Phase 2 (preview): 旧/新 上下堆叠对比 + 可编辑新值 + 重做/接受/取消
// ─────────────────────────────────────────
function RedehydrateSheet({ open, title, hasRawSource, busy, preview, onCancel, onPreview, onReroll, onCommit }) {
  const [regen, setRegen] = useState(false);
  const [draftContent, setDraftContent] = useState('');
  const [draftName, setDraftName] = useState('');
  const [draftSummary, setDraftSummary] = useState('');
  const [draftTags, setDraftTags] = useState([]);
  const [tagInput, setTagInput] = useState('');

  useEffect(() => {
    if (!open) {
      setRegen(false);
      setDraftContent(''); setDraftName(''); setDraftSummary('');
      setDraftTags([]); setTagInput('');
    }
  }, [open]);

  useEffect(() => {
    if (preview && preview.new) {
      setDraftContent(preview.new.content || '');
      setDraftName(preview.new.name || '');
      setDraftSummary(preview.new.summary || '');
      setDraftTags(Array.isArray(preview.new.tags) ? preview.new.tags : []);
    }
  }, [preview]);

  if (!open) return null;
  const isPreview = !!preview;
  const allowRegen = hasRawSource && !busy;

  const addTag = () => {
    const t = tagInput.trim();
    if (!t) return;
    if (!draftTags.includes(t)) setDraftTags([...draftTags, t]);
    setTagInput('');
  };
  const rmTag = (t) => setDraftTags(draftTags.filter(x => x !== t));

  // ─── Phase 1: 选项 ───
  if (!isPreview) {
    return (
      <div className="redehy-sheet-mask" onClick={busy ? undefined : onCancel}>
        <div className="redehy-sheet" onClick={e => e.stopPropagation()}>
          <div className="redehy-sheet-grip"/>
          <div className="redehy-sheet-hd">
            <div className="redehy-sheet-icon">↻</div>
            <div className="redehy-sheet-title">重新脱水</div>
          </div>
          <div className="redehy-sheet-target">「{title || '当前记忆'}」</div>
          <div className="redehy-sheet-desc">
            让 LLM 重新生成这条记忆的<b>标题 / 摘要 / 标签 / 情感</b>。<br/>
            预览界面会展示新旧对比, 你确认后才会写入。
          </div>

          <label className={'redehy-opt' + (hasRawSource ? '' : ' is-disabled')}>
            <input
              type="checkbox"
              checked={regen && hasRawSource}
              disabled={!allowRegen}
              onChange={e => setRegen(e.target.checked)}
            />
            <div className="redehy-opt-text">
              <div className="redehy-opt-ttl">同时重新提炼正文</div>
              <div className="redehy-opt-sub">
                {hasRawSource
                  ? '基于原文 + 主题锚点重写正文, 聚焦当前主题, 不会扩到其他主题。多耗一次 LLM 调用。'
                  : '此条无原文 (raw_source 为空), 无法重新提炼正文。'}
              </div>
            </div>
          </label>

          <div className="redehy-sheet-foot">
            <button className="redehy-btn" onClick={onCancel} disabled={busy}>取消</button>
            <button
              className="redehy-btn is-primary"
              onClick={() => onPreview({ regenerate_content: regen && hasRawSource })}
              disabled={busy}
            >
              {busy ? '生成中…' : '生成预览'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Phase 2: 预览对比 ───
  const old = preview.old || {};
  const showContentDiff = preview.regenerated_content;

  return (
    <div className="redehy-sheet-mask" onClick={busy ? undefined : onCancel}>
      <div className="redehy-sheet redehy-sheet-preview" onClick={e => e.stopPropagation()}>
        <div className="redehy-sheet-grip"/>
        <div className="redehy-sheet-hd">
          <div className="redehy-sheet-icon">↻</div>
          <div className="redehy-sheet-title">预览 · 重新脱水</div>
          {preview.cost && preview.cost.known && (
            <div className="redehy-preview-cost">
              ${preview.cost.usd.toFixed(4)} · ¥{preview.cost.cny.toFixed(2)}
            </div>
          )}
        </div>
        <div className="redehy-sheet-target">「{title || '当前记忆'}」</div>

        {showContentDiff && (
          <>
            <div className="redehy-stack-lbl redehy-stack-lbl-old">旧正文</div>
            <div className="redehy-stack-readonly">{old.content || '(空)'}</div>
            <div className="redehy-stack-lbl redehy-stack-lbl-new">新正文 · 可编辑</div>
            <textarea
              className="redehy-stack-edit"
              value={draftContent}
              onChange={e => setDraftContent(e.target.value)}
              rows={6}
              disabled={busy}
            />
          </>
        )}

        <div className="redehy-stack-lbl redehy-stack-lbl-old">旧 · 标题 / 摘要</div>
        <div className="redehy-stack-readonly redehy-stack-line">{old.name || '(空)'}</div>
        <div className="redehy-stack-readonly">{old.summary || '(空)'}</div>

        <div className="redehy-stack-lbl redehy-stack-lbl-new">新 · 标题 · 可编辑</div>
        <input
          className="redehy-stack-edit redehy-stack-edit-line"
          value={draftName}
          onChange={e => setDraftName(e.target.value)}
          disabled={busy}
        />
        <div className="redehy-stack-lbl redehy-stack-lbl-new">新 · 摘要 · 可编辑</div>
        <textarea
          className="redehy-stack-edit"
          value={draftSummary}
          onChange={e => setDraftSummary(e.target.value)}
          rows={2}
          disabled={busy}
        />

        <div className="redehy-stack-lbl redehy-stack-lbl-old">旧 · 标签</div>
        <div className="redehy-stack-tags">
          {(old.tags || []).filter(t => !String(t).startsWith('__')).map((t, i) => (
            <span key={i} className="redehy-tag-chip">{t}</span>
          ))}
          {(!old.tags || old.tags.length === 0) && <span className="redehy-stack-empty">(无)</span>}
        </div>
        <div className="redehy-stack-lbl redehy-stack-lbl-new">新 · 标签 · 可编辑</div>
        <div className="redehy-stack-tags-edit">
          {draftTags.map((t, i) => (
            <span key={i} className="redehy-tag-chip is-new">
              {t}<span className="x" onClick={() => !busy && rmTag(t)}>×</span>
            </span>
          ))}
          <input
            className="redehy-tag-input"
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
            onBlur={addTag}
            placeholder="+ 加标签"
            disabled={busy}
          />
        </div>

        <div className="redehy-sheet-foot redehy-sheet-foot-preview">
          <button className="redehy-btn" onClick={onCancel} disabled={busy}>取消</button>
          <button
            className="redehy-btn"
            onClick={() => onReroll({ regenerate_content: showContentDiff })}
            disabled={busy}
          >{busy ? '…' : '↻ 重做'}</button>
          <button
            className="redehy-btn is-primary"
            onClick={() => onCommit({
              content: showContentDiff ? draftContent : undefined,
              name: draftName,
              summary: draftSummary,
              tags: draftTags,
              domain: preview.new.domain,
              valence: preview.new.valence,
              arousal: preview.new.arousal,
            })}
            disabled={busy}
          >{busy ? '…' : '✓ 接受'}</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────
// NewScreen · 写新条目(全屏表单)
// ─────────────────────────────────────────

function NewScreen() {
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [content, setContent] = useState('');
  const [imp, setImp] = useState(5);
  const [pin, setPin] = useState(false);
  const [highlight, setHighlight] = useState(false);
  const [tags, setTags] = useState([]);
  const [tagInput, setTagInput] = useState('');
  const [eventTime, setEventTime] = useState(() => toLocalDateTimeStr(new Date().toISOString()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    if (!content.trim()) {
      setError('正文不能空');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/bucket/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || null,
          content: content,
          importance: imp,
          tags: tags,
          protected: pin,
          highlight: highlight,
          event_time: fromLocalDateTimeStr(eventTime) || undefined,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      // summary 不能直接通过 create 设(create() 不接 summary 字段),
      // 如果用户写了 summary,补一次 update
      if (summary.trim()) {
        try {
          await fetch('/api/bucket/' + encodeURIComponent(data.id) + '/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ summary: summary.trim() }),
          });
        } catch (_) { /* 忽略,用户可以以后再编辑 */ }
      }
      // 用 replace 而不是 navigate,这样后退键直接回上层(如首页),不会回到 /new
      window.location.replace('#/mem/' + encodeURIComponent(data.id));
    } catch (e) {
      setError(e.message || String(e));
      setSaving(false);
    }
  };

  return (
    <div className="new-screen">
      <div className="new-top">
        <button className="cancel" onClick={() => window.history.back()} disabled={saving}>取消</button>
        <span className="ttl">写新记忆</span>
        <button className="save" onClick={save} disabled={saving || !content.trim()}>
          {saving ? '保存中' : '保存'}
        </button>
      </div>

      <div className="new-body">
        {error && <div className="edit-error">⚠ {error}</div>}
        <FormFields
          name={name} setName={setName}
          summary={summary} setSummary={setSummary}
          content={content} setContent={setContent}
          imp={imp} setImp={setImp}
          pin={pin} setPin={setPin}
          highlight={highlight} setHighlight={setHighlight}
          tags={tags} setTags={setTags}
          tagInput={tagInput} setTagInput={setTagInput}
          eventTime={eventTime} setEventTime={setEventTime}
          contentRequired={true}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────
// 屏 4 · 日历(v1 双模式 — 用户 2026-04-29 明确按 v1 来)
// ─────────────────────────────────────────

const MO_EN_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function levelOf(n) {
  if (!n) return '';
  if (n <= 4) return 'l1';
  if (n <= 8) return 'l2';
  if (n <= 13) return 'l3';
  return 'l4';
}

function isImportTodo(b) {
  // AI 写入 + 没有 __import_refined / __import_flagged tag = 待审
  // (审阅区"原样保留" — 历史正在审的桶维持 created_by='ai' 判定; 新 import 桶
  //  审阅在工作台做, 移动端审阅区暂不接管. 后期看是否要并入 import.)
  if (b.created_by !== 'ai') return false;
  const tags = b.tags || [];
  if (tags.indexOf('__import_refined') >= 0) return false;
  if (tags.indexOf('__import_flagged') >= 0) return false;
  return true;
}

function buildMonth(year, month, dayMap, todayKey) {
  const firstDow = new Date(year, month - 1, 1).getDay();
  const lastDay = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push({ ph: true });
  let total = 0, hiCnt = 0, todoCnt = 0, peakDay = 0;
  for (let d = 1; d <= lastDay; d++) {
    const k = `${year}-${month}-${d}`;
    const items = dayMap.get(k) || [];
    let hasHi = false, hasTodo = false;
    for (const b of items) {
      if (b.highlight) hasHi = true;
      if (isImportTodo(b)) hasTodo = true;
    }
    if (items.length > peakDay) peakDay = items.length;
    total += items.length;
    if (hasHi) hiCnt += 1;
    if (hasTodo) todoCnt += 1;
    cells.push({ d, n: items.length, hi: hasHi, todo: hasTodo, today: k === todayKey });
  }
  return { year, month, cells, total, hiCnt, todoCnt, peakDay };
}

function CalCell({ c, mode, onClick }) {
  if (c.ph) return <div className="cal-cell placeholder"/>;
  let cls = 'cal-cell';
  if (c.n > 0) cls += ' has-data';
  if (mode === 'show') {
    cls += ' ' + levelOf(c.n);
    if (c.today) cls += ' today';
  } else {
    if (c.hi) cls += ' hi';
    else if (c.todo) cls += ' unread';
    else if (c.n > 0) {
      cls += ' read';
      if (c.n > 8) cls += ' dense';
      if (c.n > 13) cls += ' dense2';
    }
    if (c.today) cls += ' today';
  }
  return (
    <div className={cls} onClick={c.n > 0 && onClick ? () => onClick(c) : undefined}>
      <span className="d">{c.d}</span>
      {c.n > 0 && <span className="n">{c.n}</span>}
    </div>
  );
}

function CalMonth({ year, month, cells, total, hiCnt, todoCnt, peakDay, mode, onCellClick }) {
  return (
    <div className="cal-month">
      <div className="cal-month-hd">
        <span className="cal-month-name">{MO_EN_FULL[month - 1]}</span>
        <span className="cal-month-year">{year}</span>
        <span className="cal-month-stats">
          {mode === 'show'
            ? `${total} 条 · 峰 ${peakDay}`
            : `${total} 条 · ${hiCnt} hi · ${todoCnt} 待`}
        </span>
      </div>
      <div className="cal-weekrow">
        <span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span>
      </div>
      <div className="cal-grid">
        {cells.map((c, i) => (
          <CalCell
            key={i}
            c={c}
            mode={mode}
            onClick={c.n > 0 ? () => onCellClick(year, month, c.d) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function CalScreen() {
  const [buckets, setBuckets] = useState(null);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('show');

  useEffect(() => {
    let cancel = false;
    api('/api/buckets')
      .then(d => { if (!cancel) setBuckets(Array.isArray(d) ? d : []); })
      .catch(e => { if (!cancel) setError(e.message); });
    return () => { cancel = true; };
  }, []);

  const data = useMemo(() => {
    if (!buckets) return null;
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`;

    const dayMap = new Map();
    for (const b of buckets) {
      const dt = bucketDate(b);
      if (!dt) continue;
      const k = `${dt.getFullYear()}-${dt.getMonth()+1}-${dt.getDate()}`;
      if (!dayMap.has(k)) dayMap.set(k, []);
      dayMap.get(k).push(b);
    }

    // 当月 + 前一个月 + 再前一个月 共 3 个月,够手机滚动看
    const months = [];
    for (let i = 0; i < 3; i++) {
      let y = now.getFullYear();
      let m = now.getMonth() + 1 - i;
      while (m < 1) { m += 12; y -= 1; }
      months.push(buildMonth(y, m, dayMap, todayKey));
    }

    let totalCnt = 0, peakAll = 0, pendingDays = 0, hiTotal = 0;
    for (const [, items] of dayMap) {
      const cnt = items.length;
      totalCnt += cnt;
      if (cnt > peakAll) peakAll = cnt;
      let dayHasTodo = false, dayHasHi = false;
      for (const b of items) {
        if (b.highlight) dayHasHi = true;
        if (isImportTodo(b)) dayHasTodo = true;
      }
      if (dayHasTodo) pendingDays += 1;
      if (dayHasHi) hiTotal += 1;
    }
    const dayAvg = dayMap.size > 0 ? (totalCnt / dayMap.size).toFixed(1) : '0';

    return {
      months,
      stats: {
        days: dayMap.size,
        total: totalCnt,
        peak: peakAll,
        avg: dayAvg,
        pendingDays,
        hi: hiTotal,
      },
    };
  }, [buckets]);

  if (error) return (
    <div className="cal">
      <div className="app-error">后端错: {error}</div>
      <TabBar active="cal"/>
    </div>
  );
  if (!buckets || !data) return (
    <div className="cal">
      <div className="app-loading">载入中…</div>
      <TabBar active="cal"/>
    </div>
  );

  const yearLabel = String(new Date().getFullYear());

  return (
    <div className={'cal mode-' + mode}>
      <div className="cal-head">
        <div className="app-eyebrow">
          <span className="app-eyebrow-dot"/>
          <span>{mode === 'show' ? '日历 · index' : '日历 · review map'}</span>
        </div>
        <div className="cal-title-row">
          <h1 className="cal-title">
            {yearLabel} · {mode === 'show' ? '记忆密度' : '审阅'}
          </h1>
          <div className="cal-mode">
            <button
              className={'cal-mode-btn' + (mode === 'show' ? ' on' : '')}
              onClick={() => setMode('show')}
            >展示</button>
            <button
              className={'cal-mode-btn' + (mode === 'review' ? ' on' : '')}
              onClick={() => setMode('review')}
            >审阅</button>
          </div>
        </div>
        <div className="cal-stats">
          <span><b>{data.stats.days}</b> 天</span>
          <span><b>{data.stats.total}</b> 条</span>
          {mode === 'review' ? (
            <span><b>{data.stats.pendingDays}</b> 待审天 · <b>{data.stats.hi}</b> 重要</span>
          ) : (
            <span><b>{data.stats.peak}</b> 单日峰值 · <b>{data.stats.avg}</b> 日均</span>
          )}
        </div>
      </div>

      <div className="cal-legend">
        {mode === 'show' ? (
          <>
            <div className="cal-legend-item"><span className="cal-swatch empty"/>无</div>
            <div className="cal-legend-item"><span className="cal-swatch d1"/>1-4</div>
            <div className="cal-legend-item"><span className="cal-swatch d2"/>5-8</div>
            <div className="cal-legend-item"><span className="cal-swatch d3"/>9-13</div>
            <div className="cal-legend-item"><span className="cal-swatch d4"/>14+</div>
          </>
        ) : (
          <>
            <div className="cal-legend-item"><span className="cal-swatch read"/>已审</div>
            <div className="cal-legend-item"><span className="cal-swatch unread"/>有遗漏</div>
            <div className="cal-legend-item"><span className="cal-swatch hi"/>重要</div>
            <div className="cal-legend-item"><span className="cal-swatch empty"/>无记忆</div>
          </>
        )}
      </div>

      {mode === 'review' && data.stats.pendingDays > 0 && (
        <div className="cal-pending" onClick={() => navigate('/review')}>
          <div className="cal-pending-num">{data.stats.pendingDays}</div>
          <div className="cal-pending-body">
            <div className="cal-pending-title">{data.stats.pendingDays} 天有遗漏</div>
            <div className="cal-pending-sub">点开"审阅"tab 处理</div>
          </div>
          <div className="cal-pending-arrow">→</div>
        </div>
      )}

      {data.months.map(mo => (
        <CalMonth
          key={mo.year + '-' + mo.month}
          year={mo.year}
          month={mo.month}
          cells={mo.cells}
          total={mo.total}
          hiCnt={mo.hiCnt}
          todoCnt={mo.todoCnt}
          peakDay={mo.peakDay}
          mode={mode}
          onCellClick={(y, m, d) => {
            const k = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            navigate('/day/' + k);
          }}
        />
      ))}

      <TabBar active="cal"/>
    </div>
  );
}

// ─────────────────────────────────────────
// 屏 5 · 审阅台(只读 Phase 1 - 状态切换 / 编辑下次实装)
// ─────────────────────────────────────────

function statusOf(b) {
  const tags = b.tags || [];
  if (tags.indexOf('__import_refined') >= 0) return 'done';
  if (tags.indexOf('__import_flagged') >= 0) return 'doubt';
  return 'todo';
}

function ReviewScreen() {
  const [buckets, setBuckets] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('todo');
  const [scope, setScope] = useState('all'); // 默认全部,因为今天可能没记忆
  const [drawer, setDrawer] = useState(false);
  const [curId, setCurId] = useState(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  // 全文缓存(/api/buckets 只回 200 字预览,审阅长文要拉单条全文)
  const [fullById, setFullById] = useState({});
  // 左右滑翻页状态(放在早 return 之前,避免 hook 顺序错乱)
  const swipeRef = useRef({ x: 0, y: 0, t: 0, active: false });

  useEffect(() => {
    let cancel = false;
    api('/api/buckets')
      .then(d => {
        if (cancel) return;
        const list = Array.isArray(d) ? d : [];
        // 移动端审阅区"原样保留" — 仍然按 created_by='ai' 拉, 历史正在审的桶不消失
        // (新导入桶 created_by='import', 审阅在工作台做; 后期看是否合并到这条流)
        // 排除 resolved=True 的桶 — 桌面已标噪声/已解决/已归档的不该再回到审阅 tab
        // /api/buckets 是 include_archive=True, 不加这条会把所有 ai 来源的 archive 桶都拉回来
        const aiOnly = list.filter(b => b.created_by === 'ai' && !b.resolved);
        aiOnly.sort((a, b) => {
          const ta = new Date(a.event_time || a.created || 0).getTime();
          const tb = new Date(b.event_time || b.created || 0).getTime();
          return tb - ta;
        });
        setBuckets(aiOnly);
        if (aiOnly.length > 0) {
          const firstTodo = aiOnly.find(b => statusOf(b) === 'todo') || aiOnly[0];
          setCurId(firstTodo.id);
        }
      })
      .catch(e => { if (!cancel) setError(e.message); });
    return () => { cancel = true; };
  }, []);

  const filteredAll = useMemo(() => {
    if (!buckets) return [];
    if (scope === 'today') {
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`;
      return buckets.filter(b => {
        const dt = bucketDate(b);
        if (!dt) return false;
        return `${dt.getFullYear()}-${dt.getMonth()+1}-${dt.getDate()}` === todayKey;
      });
    }
    return buckets;
  }, [buckets, scope]);

  const queue = useMemo(() => {
    if (tab === 'all') return filteredAll;
    return filteredAll.filter(b => statusOf(b) === tab);
  }, [filteredAll, tab]);

  const counts = useMemo(() => ({
    all: filteredAll.length,
    todo: filteredAll.filter(b => statusOf(b) === 'todo').length,
    doubt: filteredAll.filter(b => statusOf(b) === 'doubt').length,
    done: filteredAll.filter(b => statusOf(b) === 'done').length,
  }), [filteredAll]);

  const cur = useMemo(() => {
    if (!buckets || !curId) return null;
    return buckets.find(b => b.id === curId) || null;
  }, [buckets, curId]);

  // 拉当前条目的全文(/api/buckets 只回 200 字预览),按 id 缓存避免重复请求
  useEffect(() => {
    if (!curId || fullById[curId] !== undefined) return;
    let cancel = false;
    api('/api/bucket/' + encodeURIComponent(curId))
      .then(d => { if (!cancel) setFullById(prev => ({ ...prev, [curId]: (d && d.content) || '' })); })
      .catch(() => { if (!cancel) setFullById(prev => ({ ...prev, [curId]: null })); });
    return () => { cancel = true; };
  }, [curId, fullById]);

  // 切 tab/scope 时,如果 cur 不在新 queue 里,自动切到新 queue 第一项
  // 故意只依赖 tab/scope,不让标记/删除等 buckets 变更打扰
  useEffect(() => {
    if (!buckets) return;
    if (queue.length === 0) {
      setCurId(null);
    } else if (!curId || !queue.find(b => b.id === curId)) {
      setCurId(queue[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, scope]);

  const curIdx = queue.findIndex(b => b.id === curId);

  if (error) return (
    <div className="review">
      <div className="app-error">后端错: {error}</div>
      <TabBar active="review"/>
    </div>
  );
  if (!buckets) return (
    <div className="review">
      <div className="app-loading">载入中…</div>
      <TabBar active="review"/>
    </div>
  );

  const curDt = cur ? bucketDate(cur) : null;

  // 操作完成后,在「旧 queue」基础上挑下一个 cur
  // 规则:queue[(oldIdx + 1) % queue.length],wrap;若 queue 只有这一个就置空
  const pickNext = () => {
    if (queue.length <= 1) return null;
    const oldIdx = queue.findIndex(b => b.id === curId);
    if (oldIdx < 0) return queue[0];
    return queue[(oldIdx + 1) % queue.length];
  };

  // 左右滑翻页 — 在 rv-main 上听 touch
  const navInQueue = (dir) => {
    if (queue.length <= 1) return;
    const idx = queue.findIndex(b => b.id === curId);
    if (idx < 0) { setCurId(queue[0].id); return; }
    const ni = (idx + dir + queue.length) % queue.length;
    setCurId(queue[ni].id);
  };
  const onSwipeStart = (e) => {
    const t = e.touches[0]; if (!t) return;
    swipeRef.current = { x: t.clientX, y: t.clientY, t: Date.now(), active: true };
  };
  const onSwipeEnd = (e) => {
    const s = swipeRef.current;
    if (!s.active) return;
    swipeRef.current.active = false;
    const t = e.changedTouches[0]; if (!t) return;
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    const dt = Date.now() - s.t;
    // 阈值: 横向位移 > 60px, 横向是纵向的 1.5 倍以上, 时长 < 600ms
    if (Math.abs(dx) < 60) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dt > 600) return;
    navInQueue(dx < 0 ? 1 : -1); // 左滑→下一条, 右滑→上一条
  };

  const markStatus = async (action) => {
    if (!cur || busy) return;
    setBusy(true);
    // 已是目标状态再点 = 取消(回到待办)
    const currentStatus = statusOf(cur);
    const targetStatus = action === 'refined' ? 'done' : 'doubt';
    const isUntoggle = currentStatus === targetStatus;

    const newTags = (cur.tags || []).filter(t => t !== '__import_refined' && t !== '__import_flagged');
    if (!isUntoggle) {
      if (action === 'refined') newTags.push('__import_refined');
      if (action === 'flagged') newTags.push('__import_flagged');
    }
    const next = pickNext();
    try {
      const r = await fetch('/api/bucket/' + encodeURIComponent(cur.id) + '/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: newTags }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      setBuckets(prev => prev.map(b => b.id === cur.id ? { ...b, tags: newTags } : b));
      // 标记时切下一个,取消时留在原条目让用户看到状态变化
      if (!isUntoggle && next) setCurId(next.id);
    } catch (e) {
      alert('失败: ' + e.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteCur = async () => {
    if (!cur || busy) return;
    if (!window.confirm('删除「' + (cur.name || cur.id) + '」?\n移到回收站,可在设置 → 回收站恢复。')) return;
    setBusy(true);
    const oldId = cur.id;
    const next = pickNext();
    try {
      const r = await fetch('/api/bucket/' + encodeURIComponent(oldId) + '/delete', { method: 'POST' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      setBuckets(prev => prev.filter(b => b.id !== oldId));
      setCurId(next ? next.id : null);
    } catch (e) {
      alert('失败: ' + e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="review">
      <div className="review-top">
        <div className="review-eyebrow-row">
          <span className="app-eyebrow">
            <span className="app-eyebrow-dot"/>
            <span>审阅 · review</span>
          </span>
          <div className="review-scope">
            <button className={'review-scope-btn' + (scope === 'today' ? ' on' : '')} onClick={() => setScope('today')}>今天</button>
            <button className={'review-scope-btn' + (scope === 'all' ? ' on' : '')} onClick={() => setScope('all')}>全部</button>
          </div>
        </div>
        <div className="review-tabs">
          <button className={'review-tab todo' + (tab === 'todo' ? ' on' : '')} onClick={() => setTab('todo')}>
            <span className="pip"/><span>待办</span><span className="n">{counts.todo}</span>
          </button>
          <button className={'review-tab doubt' + (tab === 'doubt' ? ' on' : '')} onClick={() => setTab('doubt')}>
            <span className="pip"/><span>存疑</span><span className="n">{counts.doubt}</span>
          </button>
          <button className={'review-tab done' + (tab === 'done' ? ' on' : '')} onClick={() => setTab('done')}>
            <span className="pip"/><span>已精修</span><span className="n">{counts.done}</span>
          </button>
          <button className={'review-tab' + (tab === 'all' ? ' on' : '')} onClick={() => setTab('all')}>
            <span>全部</span><span className="n">{counts.all}</span>
          </button>
        </div>
      </div>

      <div className="review-body">
        {cur ? (
          <div
            className="rv-main"
            onTouchStart={onSwipeStart}
            onTouchEnd={onSwipeEnd}
          >
            <div className="rv-main-meta">
              {curDt && <span className="rv-main-meta-time">{fmtDay(curDt).num} {fmtDay(curDt).mo} · {fmtTime(curDt)}</span>}
              <span>·</span>
              <span>{statusOf(cur) === 'done' ? '已精修' : statusOf(cur) === 'doubt' ? '存疑' : '待办'}</span>
              <span className="rv-main-meta-pos"><b>{curIdx >= 0 ? curIdx + 1 : '—'}</b>/{queue.length}</span>
            </div>
            <div className="rv-main-tags">
              {cur.highlight && <span className="rv-main-tag hi">★ 高亮</span>}
              {(cur.tags || []).filter(t => !String(t).startsWith('__')).map((t, i) => (
                <span key={i} className={'rv-main-tag' + (/feel/i.test(String(t)) ? ' feel' : '')}>{t}</span>
              ))}
            </div>
            <h2 className="rv-main-title">{cur.name || cur.id}</h2>
            <div className="rv-main-imp-row">
              <span>重要度</span>
              <span className="rv-main-imp-bar">
                {Array.from({ length: 10 }).map((_, i) => (
                  <i key={i} style={{
                    height: ((i + 1) * 0.65 + 3.5) + 'px',
                    background: i < (cur.importance || 5) ? 'var(--accent)' : 'var(--bg-2)',
                  }}/>
                ))}
              </span>
              <b style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--accent)', fontWeight: 600, fontSize: '13px' }}>
                {cur.importance || 5} / 10
              </b>
            </div>
            <div className="rv-main-text-wrap">
              <div className="rv-main-text">
                {cur.summary && <p className="lead">{cur.summary}</p>}
                {(() => {
                  // 优先全文(单条 fetch),没拉到时回退到 200 字 preview
                  const body = fullById[cur.id] != null ? fullById[cur.id] : (cur.content_preview || '');
                  const paras = body.split(/\n\s*\n/).filter(Boolean);
                  return paras.map((p, i) => <p key={i}>{p}</p>);
                })()}
                {!cur.summary && !cur.content_preview && fullById[cur.id] == null && (
                  <p style={{ color: 'var(--ink-4)' }}>(加载中…)</p>
                )}
                {!cur.summary && !cur.content_preview && fullById[cur.id] === '' && (
                  <p style={{ color: 'var(--ink-4)' }}>(无内容)</p>
                )}
              </div>
            </div>

            {/* 状态按钮条:嵌入主卡底部,跟下面 tabbar 视觉分层 */}
            <div className="rv-actions-bar">
              <button
                className={'rv-action-btn read' + (statusOf(cur) === 'done' ? ' on' : '')}
                onClick={() => markStatus('refined')}
                disabled={busy}
                title={statusOf(cur) === 'done' ? '再点一次取消已阅' : '标记已阅'}
              >
                <span className="ic">✓</span><span>已阅</span>
              </button>
              <button
                className={'rv-action-btn doubt' + (statusOf(cur) === 'doubt' ? ' on' : '')}
                onClick={() => markStatus('flagged')}
                disabled={busy}
                title={statusOf(cur) === 'doubt' ? '再点一次取消存疑' : '标记存疑'}
              >
                <span className="ic">?</span><span>存疑</span>
              </button>
              <button
                className="rv-action-btn del"
                onClick={deleteCur}
                disabled={busy}
              >
                <span className="ic">✕</span><span>删除</span>
              </button>
              <button
                className="rv-action-btn edit"
                onClick={() => setEditing(true)}
                disabled={busy}
              >
                <span className="ic">✎</span><span>编辑</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="app-loading" style={{ height: 'calc(100% - 90px - env(safe-area-inset-bottom))' }}>
            {queue.length === 0 ? '当前 tab 队列空' : '没选中条目'}
          </div>
        )}

        <div className="rv-queue-handle" onClick={() => setDrawer(true)}>
          <div className="grip"><i/><i/><i/></div>
          <div className="pos">
            {curIdx >= 0 ? (curIdx + 1) : '—'}<span style={{ opacity: 0.5 }}>/</span>{queue.length}
          </div>
        </div>

        {drawer && <div className="rv-queue-backdrop" onClick={() => setDrawer(false)} aria-hidden="true"/>}
        <div className={'rv-queue-drawer' + (drawer ? '' : ' closed')}>
          <div className="rv-queue-drawer-hd">
            <div className="rv-queue-drawer-hd-row">
              <span className="ttl">队列 · {queue.length}</span>
              <button className="x" onClick={() => setDrawer(false)}>×</button>
            </div>
          </div>
          <div className="rv-queue-list">
            {queue.length === 0 && (
              <div style={{ color: 'var(--ink-4)', textAlign: 'center', padding: '40px 0', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em' }}>
                队列空
              </div>
            )}
            {queue.map(b => {
              const st = statusOf(b);
              const dt = bucketDate(b);
              return (
                <div
                  key={b.id}
                  className={'rv-queue-item' + (b.id === curId ? ' cur' : '')}
                  onClick={() => { setCurId(b.id); setDrawer(false); }}
                >
                  <span className={'rv-queue-item-st ' + st}/>
                  <div className="rv-queue-item-mid">
                    <div className="rv-queue-item-meta">
                      {dt ? `${fmtDay(dt).num} ${fmtDay(dt).mo} · ${fmtTime(dt)}` : '—'}
                      {b.highlight && <span style={{ color: 'var(--accent)', marginLeft: 6 }}>★</span>}
                    </div>
                    <div className="rv-queue-item-title">{b.name || b.id}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {editing && cur && (
          <EditSheet
            bucketId={cur.id}
            onClose={() => setEditing(false)}
            onSaved={(newMeta) => {
              setBuckets(prev => prev.map(b =>
                b.id === cur.id ? { ...b, ...newMeta } : b
              ));
            }}
            onDeleted={(deletedId) => {
              const next = pickNext();
              setBuckets(prev => prev.filter(b => b.id !== deletedId));
              setCurId(next ? next.id : null);
            }}
          />
        )}
      </div>

      <TabBar active="review"/>
    </div>
  );
}

// ─────────────────────────────────────────
// 屏 6 · 设置(主页 + 子页 trash + import stub)
// ─────────────────────────────────────────

function SettingScreen() {
  const [trashCount, setTrashCount] = useState(null);
  const [dark, setDark] = useState(() =>
    document.documentElement.getAttribute('data-theme') === 'dark'
  );
  // 主题色 (跟桌面同套, window.OB_THEME)
  const [themeState, setThemeState] = useState(() =>
    (window.OB_THEME && window.OB_THEME.loadTheme()) || { preset: 'moonlight-purple' }
  );

  useEffect(() => {
    api('/api/trash')
      .then(d => setTrashCount((d && d.count) || 0))
      .catch(() => setTrashCount(0));
  }, []);

  const toggleDark = () => {
    const next = !dark;
    setDark(next);
    localStorage.setItem('mobile-theme', next ? 'dark' : 'light');
    // 用 OB_THEME.setDarkMode 跟桌面一致 — 暗夜走 DARK_FALLBACK,
    // 自定义色暂不参与暗夜, 避免半 themed 状态显示异常
    if (window.OB_THEME && window.OB_THEME.setDarkMode) {
      window.OB_THEME.setDarkMode(next);
    } else {
      if (next) document.documentElement.setAttribute('data-theme', 'dark');
      else document.documentElement.removeAttribute('data-theme');
    }
  };

  const choosePreset = (preset) => {
    if (!window.OB_THEME) return;
    const next = { preset: preset.id };
    // 用 applyCurrent 统一入口, 自动判断走 vars / colors 路径
    window.OB_THEME.saveTheme(next);
    if (window.OB_THEME.applyCurrent) {
      window.OB_THEME.applyCurrent(next);
    } else if (preset.colors) {
      window.OB_THEME.applyTheme(preset.colors);  // 老版本 fallback
    }
    setThemeState(next);
  };
  const PRESETS = (window.OB_THEME && window.OB_THEME.PRESETS) || [];

  return (
    <div className="setting">
      <div className="setting-top">
        <div className="app-eyebrow">
          <span className="app-eyebrow-dot"/>
          <span>设置 · setting</span>
        </div>
        <h1 className="setting-title">设置</h1>
      </div>
      <div className="setting-body">

        <div className="setting-section-hd">外观 / API</div>
        <div className="setting-list">
          <div className="setting-row" onClick={toggleDark}>
            <div className="setting-row-ic">{dark ? '☾' : '☉'}</div>
            <div className="setting-row-mid">
              <div className="setting-row-title">暗夜模式</div>
              <div className="setting-row-sub">{dark ? '已开启 · 米白纸张换深底' : '关闭 · 米白纸张'}</div>
            </div>
            <span className={'setting-row-toggle' + (dark ? ' on' : '')}>
              <span className="knob"/>
            </span>
          </div>
          {PRESETS.length > 0 && (
            <div className="setting-row setting-row-theme">
              <div className="setting-row-ic">
                <span className="setting-theme-mark"/>
              </div>
              <div className="setting-row-mid">
                <div className="setting-row-title">主题色</div>
                <div className="setting-theme-swatches">
                  {PRESETS.map(p => (
                    <button
                      key={p.id}
                      type="button"
                      aria-label={p.name}
                      title={`${p.name} — ${p.desc || ''}`}
                      className={'setting-theme-swatch' + (themeState.preset === p.id ? ' on' : '')}
                      style={{ background: p.swatch || (p.vars && p.vars['--accent']) || (p.colors && p.colors.accent) || '#888' }}
                      onClick={() => choosePreset(p)}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}
          <div className="setting-row" onClick={() => navigate('/setting/api')}>
            <div className="setting-row-ic">≡</div>
            <div className="setting-row-mid">
              <div className="setting-row-title">API 配置</div>
              <div className="setting-row-sub">切换 LLM profile / 模型</div>
            </div>
            <span className="setting-row-arrow">›</span>
          </div>
        </div>

        <div className="setting-section-hd">数据</div>
        <div className="setting-list">
          <div className="setting-row" onClick={() => navigate('/setting/import')}>
            <div className="setting-row-ic">↥</div>
            <div className="setting-row-mid">
              <div className="setting-row-title">导入</div>
              <div className="setting-row-sub">粘贴文本 / 上传文件</div>
            </div>
            <span className="setting-row-arrow">›</span>
          </div>
          <div className="setting-row" onClick={() => navigate('/setting/trash')}>
            <div className="setting-row-ic">⌫</div>
            <div className="setting-row-mid">
              <div className="setting-row-title">回收站</div>
              <div className="setting-row-sub">软删除恢复 / 永久删除</div>
            </div>
            {trashCount !== null && trashCount > 0 && (
              <span className="setting-row-badge">{trashCount}</span>
            )}
            <span className="setting-row-arrow">›</span>
          </div>
        </div>

        <div className="setting-section-hd">引擎</div>
        <div className="setting-list">
          <div className="setting-row" onClick={() => navigate('/setting/decay')}>
            <div className="setting-row-ic">∿</div>
            <div className="setting-row-mid">
              <div className="setting-row-title">调律</div>
              <div className="setting-row-sub">decay 权重 · 影响浮现/归档</div>
            </div>
            <span className="setting-row-arrow">›</span>
          </div>
          <div className="setting-row" onClick={() => navigate('/setting/scoring')}>
            <div className="setting-row-ic">⊹</div>
            <div className="setting-row-mid">
              <div className="setting-row-title">检索打分</div>
              <div className="setting-row-sub">title 命中加分 / 关键词优先 · 默认全关</div>
            </div>
            <span className="setting-row-arrow">›</span>
          </div>
        </div>
      </div>
      <TabBar active="setting"/>
    </div>
  );
}

// ─────────────────────────────────────────
// API 配置子页(/setting/api)
// ─────────────────────────────────────────

function ApiSettingScreen() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = () => {
    api('/api/config/api')
      .then(setData)
      .catch(e => setError(e.message));
  };

  useEffect(() => { load(); }, []);

  const switchTo = async (pid) => {
    setBusyId(pid);
    try {
      const r = await fetch('/api/config/api/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pid }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      load();
    } catch (e) {
      alert('切换失败: ' + e.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="trash-body">
      <div className="sub-top">
        <div className="sub-back-row">
          <button className="app-back" onClick={() => navigate('/setting')}>‹ 设置</button>
          <span className="app-eyebrow" style={{ marginLeft: 'auto' }}>
            <span>API · profile</span>
          </span>
        </div>
        <h1 className="sub-title">API 配置</h1>
        <div className="sub-meta">
          {data && data.current_effective && (
            <>当前生效:<b>{data.current_effective.model || '—'}</b></>
          )}
        </div>
      </div>
      <div className="trash-list">
        {error && <div className="app-error">后端错: {error}</div>}
        {!data && !error && <div className="app-loading">载入中…</div>}
        {data && (data.profiles || []).length === 0 && (
          <div style={{ color: 'var(--ink-4)', textAlign: 'center', padding: '40px 16px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em' }}>
            还没有 API profile · 去桌面端添加
          </div>
        )}
        {data && (data.profiles || []).map(p => {
          const isActive = p.id === data.active;
          return (
            <div key={p.id} className={'api-row' + (isActive ? ' active' : '')}>
              <div className="api-row-mid">
                <div className="api-row-name">{p.name}</div>
                <div className="api-row-meta">
                  <span><b>{p.model}</b></span>
                  {p.has_key && <span>· {p.api_key_mask}</span>}
                  <span style={{ opacity: 0.6 }}>· {p.base_url}</span>
                </div>
              </div>
              {isActive ? (
                <span className="api-row-active-badge">在用</span>
              ) : (
                <button
                  className="api-row-switch"
                  onClick={() => switchTo(p.id)}
                  disabled={busyId === p.id}
                >{busyId === p.id ? '切换中' : '切到'}</button>
              )}
            </div>
          );
        })}
        <div style={{ marginTop: 16, fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', letterSpacing: '0.08em', textAlign: 'center', padding: '0 16px', lineHeight: 1.6 }}>
          新增 / 编辑 / 删除 profile 请在桌面端配置页操作
        </div>
      </div>
      <TabBar active="setting"/>
    </div>
  );
}

// ─────────────────────────────────────────
// 调律 · 衰减权重(decay)配置子页
//   只列最常用的几个参数(桌面端有全部 10 个)
//   API: GET /api/decay-config, POST /api/decay-config (单参数), POST /api/decay-config/reset
// ─────────────────────────────────────────

const DECAY_KEYS_MOBILE = [
  'archive_threshold',
  'surface_threshold',
  'decay_lambda',
  'emotion_base',
  'highlight_boost_pct',
];

function DecayConfigScreen() {
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState(null);
  const [savingKey, setSavingKey] = useState(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    api('/api/decay-config')
      .then(d => setCfg(d))
      .catch(e => setError(e.message));
  }, []);

  const updateOne = async (key, value) => {
    if (!cfg) return;
    const old = cfg.current[key];
    setCfg(c => ({ ...c, current: { ...c.current, [key]: value } }));
    setSavingKey(key);
    try {
      const r = await fetch('/api/decay-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (d && d.current) setCfg(c => ({ ...c, current: d.current }));
    } catch (e) {
      alert('保存失败: ' + e.message);
      setCfg(c => ({ ...c, current: { ...c.current, [key]: old } }));
    } finally {
      setSavingKey(null);
    }
  };

  const resetAll = async () => {
    if (!cfg) return;
    if (!window.confirm('全部参数恢复出厂默认?')) return;
    setResetting(true);
    try {
      const r = await fetch('/api/decay-config/reset', { method: 'POST' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (d && d.current) setCfg(c => ({ ...c, current: d.current }));
    } catch (e) {
      alert('恢复失败: ' + e.message);
    } finally {
      setResetting(false);
    }
  };

  // 按白名单过滤 + 保留 schema 顺序
  const visibleSchema = useMemo(() => {
    if (!cfg || !cfg.schema) return [];
    return cfg.schema.filter(it => DECAY_KEYS_MOBILE.includes(it.key));
  }, [cfg]);

  return (
    <div className="trash-body">
      <div className="sub-top">
        <div className="sub-back-row">
          <button className="app-back" onClick={() => navigate('/setting')}>‹ 设置</button>
          <span className="app-eyebrow" style={{ marginLeft: 'auto' }}>
            <span>改完即刻生效</span>
          </span>
        </div>
        <h1 className="sub-title">调律</h1>
        <div className="sub-meta">decay 权重 · 影响 score 高低 / 浮现 / 归档</div>
      </div>

      <div className="decay-list">
        {error && <div className="app-error">后端错: {error}</div>}
        {!cfg && !error && <div className="app-loading">载入中…</div>}

        {cfg && (
          <div className="decay-reset-row">
            <button
              className="decay-reset-btn"
              onClick={resetAll}
              disabled={resetting}
            >{resetting ? '⌛ 恢复中…' : '↺ 全部恢复默认'}</button>
          </div>
        )}

        {cfg && visibleSchema.map(item => {
          const cur = cfg.current[item.key];
          const def = cfg.defaults[item.key];
          const isDefault = Math.abs((cur ?? 0) - (def ?? 0)) < 1e-6;
          const fmt = v => (item.step < 1 ? Number(v).toFixed(2) : Math.round(v));
          return (
            <div className="decay-row" key={item.key}>
              <div className="decay-row-hd">
                <span className="decay-row-lbl">{item.label}</span>
                <span className={'decay-row-val' + (isDefault ? '' : ' changed')}>
                  {fmt(cur)}
                </span>
                <button
                  className="decay-row-reset"
                  onClick={() => updateOne(item.key, def)}
                  disabled={isDefault || savingKey === item.key}
                  title={'恢复默认 ' + fmt(def)}
                >↺</button>
              </div>
              <input
                type="range"
                min={item.min}
                max={item.max}
                step={item.step}
                value={cur}
                onChange={e => updateOne(item.key, +e.target.value)}
                className="decay-row-slider"
              />
              <div className="decay-row-hint">
                <span>{item.hint}</span>
                <span>{item.min} – {item.max} · 默认 {fmt(def)}</span>
              </div>
            </div>
          );
        })}

        {cfg && (
          <div className="decay-foot">
            桌面控制台还有更多参数 · 改动写入 buckets/runtime_config.json
          </div>
        )}
      </div>

      <TabBar active="setting"/>
    </div>
  );
}

// 检索打分微调 (镜像桌面 Breath tab 的 scoring 卡): title 命中加分 / 关键词优先 / 精确匹配
// 走 /api/scoring-config, 与桌面同源。schema 里 type==='bool' 的渲染成开关, 其余滑块。
function ScoringConfigScreen() {
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState(null);
  const [savingKey, setSavingKey] = useState(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    api('/api/scoring-config')
      .then(d => setCfg(d))
      .catch(e => setError(e.message));
  }, []);

  const updateOne = async (key, value) => {
    if (!cfg) return;
    const old = cfg.current[key];
    setCfg(c => ({ ...c, current: { ...c.current, [key]: value } }));
    setSavingKey(key);
    try {
      const r = await fetch('/api/scoring-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (d && d.current) setCfg(c => ({ ...c, current: d.current }));
    } catch (e) {
      alert('保存失败: ' + e.message);
      setCfg(c => ({ ...c, current: { ...c.current, [key]: old } }));
    } finally {
      setSavingKey(null);
    }
  };

  const resetAll = async () => {
    if (!cfg) return;
    if (!window.confirm('打分微调全部关掉(回到默认零影响)?')) return;
    setResetting(true);
    try {
      const r = await fetch('/api/scoring-config/reset', { method: 'POST' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (d && d.current) setCfg(c => ({ ...c, current: d.current }));
    } catch (e) {
      alert('恢复失败: ' + e.message);
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="trash-body">
      <div className="sub-top">
        <div className="sub-back-row">
          <button className="app-back" onClick={() => navigate('/setting')}>‹ 设置</button>
          <span className="app-eyebrow" style={{ marginLeft: 'auto' }}>
            <span>改完即刻生效</span>
          </span>
        </div>
        <h1 className="sub-title">检索打分</h1>
        <div className="sub-meta">title 命中加分 / 关键词优先 / 精确匹配 · 默认全关 = 零影响</div>
      </div>

      <div className="decay-list">
        {error && <div className="app-error">后端错: {error}</div>}
        {!cfg && !error && <div className="app-loading">载入中…</div>}

        {cfg && (
          <div className="decay-reset-row">
            <button
              className="decay-reset-btn"
              onClick={resetAll}
              disabled={resetting}
            >{resetting ? '⌛ 恢复中…' : '↺ 全部关掉'}</button>
          </div>
        )}

        {cfg && cfg.schema && cfg.schema.map(item => {
          const cur = cfg.current[item.key];
          const def = cfg.defaults[item.key];
          // 开关型 (keyword_first_sort / precise_match_mode / dryrun_log 等)
          if (item.type === 'bool') {
            const on = !!cur;
            return (
              <div className="decay-row" key={item.key}>
                <div className="decay-row-hd">
                  <span className="decay-row-lbl">{item.label}</span>
                  <button
                    onClick={() => updateOne(item.key, !on)}
                    disabled={savingKey === item.key}
                    style={{
                      marginLeft: 'auto',
                      border: '1px solid var(--accent, #6e4f9a)',
                      background: on ? 'var(--accent, #6e4f9a)' : 'transparent',
                      color: on ? '#fff' : 'var(--ink-3, #999)',
                      borderRadius: 6, padding: '3px 16px', fontSize: 13,
                    }}
                  >{on ? '已开' : '关'}</button>
                </div>
                <div className="decay-row-hint"><span>{item.hint}</span></div>
              </div>
            );
          }
          // 数值型滑块
          const isDefault = Math.abs((cur ?? 0) - (def ?? 0)) < 1e-6;
          const fmt = v => (item.step < 1 ? Number(v ?? 0).toFixed(2) : Math.round(v ?? 0));
          return (
            <div className="decay-row" key={item.key}>
              <div className="decay-row-hd">
                <span className="decay-row-lbl">{item.label}</span>
                <span className={'decay-row-val' + (isDefault ? '' : ' changed')}>
                  {fmt(cur)}
                </span>
                <button
                  className="decay-row-reset"
                  onClick={() => updateOne(item.key, def)}
                  disabled={isDefault || savingKey === item.key}
                  title={'恢复默认 ' + fmt(def)}
                >↺</button>
              </div>
              <input
                type="range"
                min={item.min}
                max={item.max}
                step={item.step}
                value={cur ?? 0}
                onChange={e => updateOne(item.key, +e.target.value)}
                className="decay-row-slider"
              />
              <div className="decay-row-hint">
                <span>{item.hint}</span>
                <span>{item.min} – {item.max} · 默认 {fmt(def)}</span>
              </div>
            </div>
          );
        })}

        {cfg && (
          <div className="decay-foot">
            想边调边看效果? 桌面控制台 Breath 页有「即时模拟」· 改动写入 runtime_config.json
          </div>
        )}
      </div>

      <TabBar active="setting"/>
    </div>
  );
}

function TrashScreen() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    api('/api/trash')
      .then(d => setItems((d && d.trash) || []))
      .catch(e => setError(e.message));
  }, []);

  const restore = async (id) => {
    setBusyId(id);
    try {
      const r = await fetch('/api/bucket/' + encodeURIComponent(id) + '/restore', { method: 'POST' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      setItems(prev => prev.filter(it => it.id !== id));
    } catch (e) {
      alert('恢复失败: ' + e.message);
    } finally {
      setBusyId(null);
    }
  };

  const purge = async (id, name) => {
    if (!window.confirm('永久删除「' + (name || id) + '」?\n这条记忆不会再回来。')) return;
    setBusyId(id);
    try {
      const r = await fetch('/api/bucket/' + encodeURIComponent(id) + '/purge', { method: 'POST' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      setItems(prev => prev.filter(it => it.id !== id));
    } catch (e) {
      alert('永删失败: ' + e.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="trash-body">
      <div className="sub-top">
        <div className="sub-back-row">
          <button className="app-back" onClick={() => navigate('/setting')}>‹ 设置</button>
          <span className="app-eyebrow" style={{ marginLeft: 'auto' }}>
            <span>软删除可恢复</span>
          </span>
        </div>
        <h1 className="sub-title">回收站</h1>
        <div className="sub-meta"><b>{items ? items.length : '…'}</b> 条</div>
      </div>
      <div className="trash-list">
        {error && <div className="app-error">后端错: {error}</div>}
        {!items && !error && <div className="app-loading">载入中…</div>}
        {items && items.length === 0 && (
          <div style={{ color: 'var(--ink-4)', textAlign: 'center', padding: '40px 16px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em' }}>
            回收站空
          </div>
        )}
        {items && items.map(it => (
          <div key={it.id} className="trash-item">
            <div className="trash-item-hd">
              <span className="trash-item-title">{it.name || it.id}</span>
              {it.noise && <span className="trash-item-noise">⌀ 噪声</span>}
              {typeof it.score === 'number' && (
                <span className="trash-item-score" title="decay score">{it.score.toFixed(2)}</span>
              )}
              <span className="trash-item-when">
                {it.trashed_at ? new Date(it.trashed_at).toLocaleDateString() : '—'}
              </span>
            </div>
            <div className="trash-item-snip">
              {it.summary || it.content_preview || '(无摘要)'}
            </div>
            <div className="trash-item-acts">
              <button
                className="trash-act-btn restore"
                onClick={() => restore(it.id)}
                disabled={busyId === it.id}
              >↺ 恢复</button>
              <button
                className="trash-act-btn purge"
                onClick={() => purge(it.id, it.name)}
                disabled={busyId === it.id}
              >✕ 永久删除</button>
            </div>
          </div>
        ))}
      </div>
      <TabBar active="setting"/>
    </div>
  );
}

function ImportScreen() {
  const [mode, setMode] = useState('text'); // 'text' or 'file'
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [results, setResults] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const fileInputRef = useRef(null);

  useEffect(() => {
    let cancel = false;
    api('/api/import/results?limit=20')
      .then(d => { if (!cancel) setResults((d && d.buckets) || []); })
      .catch(() => { if (!cancel) setResults([]); });
    api('/api/import/status')
      .then(d => { if (!cancel) setStatus(d || null); })
      .catch(() => {});
    return () => { cancel = true; };
  }, [refreshKey]);

  // 处理中时每 3s 轮询(后端字段是 status === 'running',不是 is_running)
  const isRunning = status && status.status === 'running';
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => {
      api('/api/import/status')
        .then(d => {
          setStatus(d || null);
          if (d && d.status !== 'running') setRefreshKey(k => k + 1);
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [isRunning]);

  const submit = async () => {
    if (submitting || isRunning) return;
    setSubmitting(true);
    try {
      let r;
      if (mode === 'file') {
        if (!file) return;
        const fd = new FormData();
        fd.append('file', file);
        r = await fetch(`/api/import/upload?preserve_raw=1`, {
          method: 'POST',
          body: fd,
        });
      } else {
        const trimmed = text.trim();
        if (!trimmed) return;
        const fname = `mobile-${Date.now()}.txt`;
        r = await fetch(
          `/api/import/upload?filename=${encodeURIComponent(fname)}&preserve_raw=1`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: trimmed,
          }
        );
      }
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      setText('');
      setFile(null);
      // 1s 后刷新 — 让后端先把 status 切到 running
      setTimeout(() => setRefreshKey(k => k + 1), 1000);
    } catch (e) {
      alert('提交失败: ' + e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const batches = useMemo(() => {
    if (!results) return [];
    const map = new Map();
    for (const b of results) {
      const dt = bucketDate(b);
      if (!dt) continue;
      const k = dayKeyOf(dt);
      if (!map.has(k)) map.set(k, { dt, items: [] });
      map.get(k).items.push(b);
    }
    return Array.from(map.values()).sort((a, b) => b.dt - a.dt).slice(0, 10);
  }, [results]);

  // 状态可视化
  const statusKind = !status ? 'idle'
    : status.status === 'running' ? 'running'
    : status.status === 'completed' ? 'done'
    : status.status === 'error' ? 'error'
    : 'idle';
  const statusLabel = !status ? '—'
    : status.status === 'running' ? '处理中'
    : status.status === 'completed' ? '已完成'
    : status.status === 'error' ? '错误'
    : status.status === 'paused' ? '已暂停'
    : '待机';
  const total = (status && status.total_chunks) || 0;
  const processed = (status && status.processed) || 0;
  const pct = total > 0 ? Math.min(100, (processed / total) * 100) : 0;
  const showProgressCard = !!status && status.status && status.status !== 'idle';
  const recentExtracted = (status && Array.isArray(status.recent_extracted)) ? status.recent_extracted.slice(-5).reverse() : [];
  const submitDisabled = submitting || isRunning ||
    (mode === 'text' ? !text.trim() : !file);

  return (
    <div className="import-body">
      <div className="sub-top">
        <div className="sub-back-row">
          <button className="app-back" onClick={() => navigate('/setting')}>‹ 设置</button>
          <button
            className="app-back"
            style={{ marginLeft: 'auto', fontSize: 11, fontFamily: 'var(--mono)', letterSpacing: '0.06em' }}
            onClick={() => setRefreshKey(k => k + 1)}
          >↻ 刷新</button>
        </div>
        <h1 className="sub-title">导入</h1>
        <div className="sub-meta">粘贴文本 / 上传文件 → LLM 拆分 + 摘要 + 入库</div>
      </div>

      {showProgressCard && (
        <div className={'import-progress-card ' + statusKind}>
          <div className={'import-progress-status ' + statusKind}>
            <span className="pip"/>
            <b>{statusLabel}</b>
            {status.source_file && <span style={{ color: 'var(--ink-4)' }}>· {status.source_file}</span>}
          </div>
          {total > 0 && (
            <>
              <div className="import-progress-bar">
                <div className="import-progress-bar-fill" style={{ width: pct + '%' }}/>
              </div>
              <div className="import-progress-stats">
                <span>进度 <b>{processed}</b> / {total}</span>
                {typeof status.memories_created === 'number' && status.memories_created > 0 && (
                  <span>新建 <b>{status.memories_created}</b></span>
                )}
                {typeof status.memories_merged === 'number' && status.memories_merged > 0 && (
                  <span>合并 <b>{status.memories_merged}</b></span>
                )}
                {typeof status.total_cost_usd === 'number' && status.total_cost_usd > 0 && (
                  <span>开销 <b>${status.total_cost_usd.toFixed(3)}</b></span>
                )}
              </div>
            </>
          )}
          {recentExtracted.length > 0 && (
            <div className="import-progress-recent">
              <div className="import-progress-recent-hd">最近提取</div>
              {recentExtracted.map((it, i) => (
                <div key={i} className="import-progress-recent-item">
                  {it.name || it.summary || '(无标题)'}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="import-mode-tabs">
        <button
          className={'import-mode-tab' + (mode === 'text' ? ' on' : '')}
          onClick={() => setMode('text')}
          disabled={submitting || isRunning}
        >粘贴文本</button>
        <button
          className={'import-mode-tab' + (mode === 'file' ? ' on' : '')}
          onClick={() => setMode('file')}
          disabled={submitting || isRunning}
        >上传文件</button>
      </div>

      <div className="import-form">
        {mode === 'text' ? (
          <textarea
            className="import-textarea"
            placeholder="粘贴想入库的文本(聊天记录 / 笔记 / 日记 …)"
            value={text}
            onChange={e => setText(e.target.value)}
            disabled={submitting || isRunning}
          />
        ) : (
          <>
            <div
              className={'import-file-zone' + (file ? ' has-file' : '')}
              onClick={() => {
                if (submitting || isRunning) return;
                if (fileInputRef.current) fileInputRef.current.click();
              }}
            >
              <span className="ic">{file ? '✓' : '↥'}</span>
              {file ? (
                <>
                  <span className="fname">{file.name}</span>
                  <span>{(file.size / 1024).toFixed(1)} KB · 点这里换文件</span>
                </>
              ) : (
                <span>点这里选文件 · txt / json / md</span>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.json,.md,.markdown,text/*,application/json"
              onChange={e => setFile(e.target.files && e.target.files[0])}
              disabled={submitting || isRunning}
              style={{ display: 'none' }}
            />
          </>
        )}
        <div className="import-submit-row">
          <button
            className="import-submit"
            onClick={submit}
            disabled={submitDisabled}
          >
            {submitting ? '提交中 …' : isRunning ? '后台正在处理' : '→ 开始导入'}
          </button>
        </div>
      </div>

      <div className="import-batches">
        <div className="import-batch-hd">最近导入 / 写入</div>
        {!results && <div className="app-loading" style={{ height: 'auto', padding: '20px 0' }}>载入中…</div>}
        {results && batches.length === 0 && (
          <div style={{ color: 'var(--ink-4)', textAlign: 'center', padding: '20px 0', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em' }}>
            没有最近批次
          </div>
        )}
        {batches.map(b => (
          <div key={dayKeyOf(b.dt)} className="import-batch-item">
            <span className="import-batch-when">
              {fmtDay(b.dt).mo} {fmtDay(b.dt).num}
            </span>
            <span className="import-batch-cnt"><b>{b.items.length}</b> 条</span>
          </div>
        ))}
      </div>
      <TabBar active="setting"/>
    </div>
  );
}

// ─────────────────────────────────────────
// 占位屏(给 /new 等还没实装的路由用)
// ─────────────────────────────────────────

// ─────────────────────────────────────────
// 屏 · 家族(记忆家族/归纳层, 2026-07-06 P1)
// 派生索引层: 向量聚类长出的主题弧线。改名/钉住/解散/一键重建;
// 原始桶零接触, 重建时她的编辑按成员重叠继承。设计稿=记忆库优化/07。
// ─────────────────────────────────────────

// 族色: id 哈希 → 冷紫→玫瑰域色相(235-350), 亮暗两套在 CSS 里由 --fam-h 合成
function famHue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return 235 + (h % 116);
}
const famDate = (t) => {
  const s = String(t || '');
  return s.length >= 10 ? s.slice(5, 10).replace('-', '·') : '——';
};

// 时间之弦: 成员按 event_time 在 4%~96% 区间落点; 全同日则均匀铺开
function FamStrand({ members }) {
  const ts = members.map(m => new Date(m.event_time || 0).getTime()).filter(t => t > 0);
  if (ts.length < 2) return null;
  const min = Math.min(...ts), max = Math.max(...ts);
  const pos = (t) => max === min ? 50 : 4 + ((t - min) / (max - min)) * 92;
  return (
    <React.Fragment>
      <div className="fam-strand">
        <div className="rail"/>
        {members.map((m, i) => {
          const t = new Date(m.event_time || 0).getTime();
          const left = t > 0 ? pos(t) : 4 + (i / Math.max(1, members.length - 1)) * 92;
          return <div key={m.id} className="dot" style={{ left: left + '%' }}/>;
        })}
      </div>
      <div className="fam-span">
        <span>{famDate(new Date(min).toISOString())}</span>
        <span>{famDate(new Date(max).toISOString())}</span>
      </div>
    </React.Fragment>
  );
}

function FamCard({ f, onPatch }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(f.name);

  const commit = () => {
    const v = draft.trim();
    if (v && v !== f.name) onPatch(f.id, { name: v });
    setEditing(false);
  };

  return (
    <div className="fam-card" style={{ '--fam-h': famHue(f.id) }}>
      <div className="fam-name-row">
        {editing ? (
          <input
            className="fam-name-input"
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
            onBlur={commit}
          />
        ) : (
          <div className="fam-name" onClick={() => { setDraft(f.name); setEditing(true); }}>
            {f.pinned && <span className="pin">✦</span>}{f.name}
          </div>
        )}
        <span className="fam-count">{f.size} 条</span>
      </div>

      <FamStrand members={f.members || []}/>

      {f.summary && (
        <p className={'fam-summary' + (full ? ' open' : '')} onClick={() => setFull(v => !v)}>
          {f.summary}
        </p>
      )}

      {open && (
        <div className="fam-members">
          {(f.members || []).map(m => (
            <div key={m.id} className="fam-member" onClick={() => navigate('/mem/' + encodeURIComponent(m.id))}>
              <span className="d">{famDate(m.event_time)}</span>
              <span className="n">{m.name}</span>
            </div>
          ))}
        </div>
      )}

      <div className="fam-foot">
        <button className="fam-act" onClick={() => setOpen(v => !v)}>{open ? '收起' : '成员'}</button>
        <span className="fam-dotsep">·</span>
        <button className="fam-act" onClick={() => onPatch(f.id, { pinned: !f.pinned })}>{f.pinned ? '取消钉住' : '钉住'}</button>
        <span className="fam-dotsep">·</span>
        <button
          className="fam-act warn"
          onClick={() => {
            if (window.confirm('解散「' + f.name + '」?\n只是收起这个族, 记忆本体不动; 重建后保持解散。')) onPatch(f.id, { dissolved: true });
          }}
        >解散</button>
      </div>
    </div>
  );
}

function FamiliesScreen() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api('/api/families')
    .then(d => { setData(d); setError(null); })
    .catch(e => setError(e.message));
  useEffect(() => { load(); }, []);

  const rebuild = async () => {
    if (busy) return;
    if (!window.confirm('全量重建家族?\n聚类 + 起名约 1-2 分钟。你的改名/钉住/解散会按成员重叠自动继承。')) return;
    setBusy(true);
    try {
      await api('/api/families/rebuild', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      await load();
    } catch (e) { alert('重建失败: ' + e.message); }
    finally { setBusy(false); }
  };

  const patch = async (fid, fields) => {
    try {
      await api('/api/family/' + encodeURIComponent(fid), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
      });
      await load();
    } catch (e) { alert('保存失败: ' + e.message); }
  };

  const fams = ((data && data.families) || [])
    .slice()
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.size - a.size);

  return (
    <div className="fam-body">
      <div className="fam-hd">
        <h2>家族<em>{fams.length > 0 ? fams.length + ' 条弧线' : ''}</em></h2>
        <button className={'fam-rebuild' + (busy ? ' busy' : '')} onClick={rebuild} disabled={busy}>
          {busy ? '聚类中…' : '↻ 重建'}
        </button>
      </div>
      <p className="fam-sub">
        {data && data.updated_at
          ? '记忆自己长出的主题弧线 · 更新于 ' + String(data.updated_at).slice(5, 16).replace('T', ' ')
          : '记忆自己长出的主题弧线'}
      </p>
      {error && <div className="mood-err">{error}</div>}
      {data && fams.length === 0 && !error && (
        <div className="fam-empty">
          <div className="glyph">❋</div>
          <p>还没有家族。<br/>点右上「重建」, 让相似的记忆彼此相认。</p>
        </div>
      )}
      {fams.map(f => <FamCard key={f.id} f={f} onPatch={patch}/>)}
      <TabBar active="fam"/>
    </div>
  );
}

function PlaceholderScreen({ tab, ic, title, sub }) {
  return (
    <div style={{ height: '100%', position: 'relative', background: 'var(--bg)' }}>
      <div className="placeholder-screen">
        <div className="ic">{ic}</div>
        <h2>{title}</h2>
        <p>{sub}</p>
      </div>
      <TabBar active={tab}/>
    </div>
  );
}

// ─────────────────────────────────────────
// App · 路由分发
// ─────────────────────────────────────────

function App() {
  // 暗夜模式:挂载时按 localStorage 应用 data-theme
  // 用 setDarkMode 让 OB_THEME 重跑 applyCurrent, 确保暗夜走 DARK_FALLBACK
  // 而非用户存的 custom 色 (避免半 themed 异常)
  useEffect(() => {
    const saved = localStorage.getItem('mobile-theme');
    const isDark = saved === 'dark';
    if (window.OB_THEME && window.OB_THEME.setDarkMode) {
      window.OB_THEME.setDarkMode(isDark);
    } else if (isDark) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  }, []);

  // 开屏始终落到记忆首页:tab 类路由(review/cal/setting)重置到 home,
  // 深链(/mem/:id, /day/:k 等)保留. PWA 冷启动会带上次 hash, 不重置就停那儿
  useEffect(() => {
    const head = (window.location.hash || '').replace(/^#\/?/, '').split('/')[0];
    if (['review', 'cal', 'setting', 'fam'].includes(head)) {
      window.location.hash = '#/';
    }
  }, []);

  const route = useRoute();
  const [head, ...rest] = route;

  // 路由表
  switch (head) {
    case undefined:
    case '':
    case 'home':
      return <HomeScreen/>;
    case 'day':
      return <DayDetailScreen dayKey={rest[0] || ''}/>;
    case 'mem':
      return <MemFullScreen id={rest[0] || ''}/>;
    case 'review':
      return <ReviewScreen/>;
    case 'fam':
      return <FamiliesScreen/>;
    case 'cal':
      return <CalScreen/>;
    case 'setting':
      if (rest[0] === 'trash') return <TrashScreen/>;
      if (rest[0] === 'import') return <ImportScreen/>;
      if (rest[0] === 'api') return <ApiSettingScreen/>;
      if (rest[0] === 'decay') return <DecayConfigScreen/>;
      if (rest[0] === 'scoring') return <ScoringConfigScreen/>;
      return <SettingScreen/>;
    case 'new':
      return <NewScreen/>;
    default:
      return <PlaceholderScreen tab="home" ic="?" title="未知路由" sub={'#/' + route.join('/')}/>;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
