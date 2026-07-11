// console-breath.jsx —— Breath 模拟管线（接通真后端 /api/breath-debug）
// 5 阶段：① 输入 → ② 候选 → ③ 四维评分 → ④ 阈值过滤 → ⑤ 重排序

const { useState: cbS, useEffect: cbE } = React;

// 初始 token（threshold/topN 给前端 slider 当起点；权重由后端返回真实值覆盖）
const BREATH_THRESHOLD = 50;
const BREATH_TOP_N = 4;
const DEFAULT_WEIGHTS = { topic: 4, emotion: 2, time: 2.5, importance: 1 };

// ─────────────────────────────────────────────────────────────────────────
// 检索 / 浮现观测台 (Claude Design 改版 · 方案 α「实验与观察」)
// 颜色全走 var(--*) (沿用 app 月光紫主题, 不带 CD demo 自定义紫); 类名 obx- 前缀防撞
// ─────────────────────────────────────────────────────────────────────────

function obxTimeAgoLong(dateStr) {
  if (!dateStr) return '从未被想起';
  const then = new Date(dateStr);
  if (isNaN(then.getTime())) return '从未被想起';
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days <= 0) return '今天刚被想起';
  if (days === 1) return '昨天被想起';
  if (days < 7) return '最近一次 ' + days + ' 天前';
  if (days < 30) return '最近一次 ' + Math.floor(days / 7) + ' 周前';
  if (days < 90) return '最近一次 ' + Math.floor(days / 30) + ' 个月前';
  return '很久没被想起 · ' + Math.floor(days / 30) + ' 个月前';
}
function obxFmtTs(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso || '').slice(0, 16);
  const mo = d.getMonth() + 1, day = d.getDate();
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return mo + '月' + day + '日 ' + h + ':' + mi;
}

function ObxToggle({ checked, onChange }) {
  return (
    <button type="button" role="switch" aria-checked={checked}
      className={'obx-toggle' + (checked ? ' obx-toggle--on' : '')}
      onClick={() => onChange(!checked)}>
      <span className="obx-toggle-thumb" />
    </button>
  );
}

function ObxSlider({ value, min, max, step, defaultVal, onChange, label, hint }) {
  const v = (value == null ? defaultVal : value);
  const deviated = v !== defaultVal;
  const span = (max - min) || 1;
  const pct = ((v - min) / span) * 100;
  const decimals = step < 0.01 ? 3 : step < 1 ? 2 : 0;
  return (
    <div className="obx-slider-row">
      <div className="obx-slider-head">
        <span className={'obx-slider-label' + (deviated ? ' obx-slider-label--dev' : '')}>{label}</span>
        <span className="obx-slider-val" style={{ fontFamily: 'var(--mono)' }}>{Number(v).toFixed(decimals)}</span>
        {deviated && <button className="obx-slider-reset" title={'复位到默认 ' + defaultVal} onClick={() => onChange(defaultVal)}>↺</button>}
      </div>
      <div className="obx-slider-track-wrap">
        <input type="range" className="obx-slider" min={min} max={max} step={step} value={v}
          onChange={e => onChange(parseFloat(e.target.value))} style={{ '--pct': pct + '%' }} />
        <span className="obx-slider-default-mark" style={{ left: ((defaultVal - min) / span) * 100 + '%' }} title={'默认 ' + defaultVal} />
      </div>
      {hint && <p className="obx-slider-hint">{hint}</p>}
    </div>
  );
}

function ObxBadge({ children, variant }) {
  return <span className={'obx-badge' + (variant ? ' obx-badge--' + variant : '')}>{children}</span>;
}
function ObxFieldBadge({ field }) {
  return <span className={'obx-field-badge' + (field === 'title' ? ' obx-field-badge--title' : '')}>{field}</span>;
}
function ObxEmpty({ text }) {
  return <div className="obx-empty"><span>{text || '暂无数据'}</span></div>;
}
function ObxTabBar({ tabs, active, onChange }) {
  return (
    <div className="obx-tab-bar" role="tablist">
      {tabs.map(t => (
        <button key={t.key} role="tab" aria-selected={active === t.key}
          className={'obx-tab' + (active === t.key ? ' obx-tab--active' : '')}
          onClick={() => onChange(t.key)}>
          {t.label}
          {t.count != null && <span className="obx-tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// A2 · 检索调参
function ObxKnobPanel({ config, defaults, schema, onChange, onReset }) {
  const anyDeviated = schema.some(s => config[s.key] !== defaults[s.key]);
  return (
    <div className="obx-knob-panel">
      <div className="obx-knob-hd">
        <h3 className="obx-panel-title">检索调参</h3>
        {anyDeviated && <button className="obx-btn-ghost obx-btn-sm" onClick={onReset}>全部复位</button>}
      </div>
      <div className="obx-knob-list">
        {schema.map(s => {
          if (s.type === 'bool') {
            return (
              <div key={s.key} className="obx-knob-bool-row">
                <ObxToggle checked={!!config[s.key]} onChange={v => onChange(s.key, v)} />
                <div className="obx-knob-bool-info">
                  <span className={'obx-knob-bool-label' + (config[s.key] !== defaults[s.key] ? ' obx-knob-bool-label--dev' : '')}>{s.label}</span>
                  <span className="obx-knob-bool-hint">{s.hint}</span>
                </div>
              </div>
            );
          }
          return (
            <ObxSlider key={s.key} value={config[s.key]} min={s.min} max={s.max} step={s.step}
              defaultVal={defaults[s.key]} onChange={v => onChange(s.key, v)} label={s.label} hint={s.hint} />
          );
        })}
      </div>
    </div>
  );
}

// A1 · 即时模拟
function ObxSimGroup({ title, items, type }) {
  if (!items || items.length === 0) {
    return (
      <div className="obx-sim-group">
        <p className="obx-sim-group-title">{title} <span className="obx-sim-group-count">0</span></p>
        <p className="obx-sim-group-empty">无命中</p>
      </div>
    );
  }
  return (
    <div className="obx-sim-group">
      <p className="obx-sim-group-title">{title} <span className="obx-sim-group-count">{items.length}</span></p>
      <div className="obx-sim-group-list">
        {items.map((it, i) => (
          <div key={(it.id || '') + '-' + i} className="obx-sim-hit">
            <span className="obx-sim-hit-name">{it.name}</span>
            <span className="obx-sim-hit-score" style={{ fontFamily: 'var(--mono)' }}>
              {type === 'keyword' ? Number(it.score || 0).toFixed(1) : ('~' + Number(it.similarity || 0).toFixed(2))}
            </span>
            {type === 'keyword' && it.matched_in && (
              <span className="obx-sim-hit-fields">
                {it.matched_in.map(f => <ObxFieldBadge key={f} field={f} />)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
function ObxSimPanel({ results, query, onQueryChange, onSimulate, dirty, loading }) {
  const handleKey = e => { if (e.key === 'Enter' && query.trim()) onSimulate(); };
  const err = results && results.error;
  const kw = (results && results.keyword_hits) || [];
  const vec = (results && results.vector_hits) || [];
  return (
    <div className="obx-sim-panel">
      <div className="obx-sim-hd">
        <h3 className="obx-panel-title">即时模拟</h3>
        {dirty && results && !err && <span className="obx-sim-dirty">参数已变更 · 重新模拟查看效果</span>}
      </div>
      <div className="obx-sim-input-row">
        <div className="obx-sim-input-wrap">
          <svg className="obx-sim-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8.5" cy="8.5" r="5.5" /><line x1="12.5" y1="12.5" x2="17" y2="17" />
          </svg>
          <input className="obx-sim-input" type="text" placeholder="输入一句话，dry-run 看会命中哪些记忆…"
            value={query} onChange={e => onQueryChange(e.target.value)} onKeyDown={handleKey} />
        </div>
        <button className="obx-btn-primary obx-btn-sm" disabled={!query.trim() || loading} onClick={onSimulate}>
          {loading ? '…' : '模拟'}
        </button>
      </div>
      {err && <div className="obx-sim-err">出错: {String(results.error)}</div>}
      {!results && !loading && <ObxEmpty text="输入查询后点「模拟」，dry-run 不记统计" />}
      {results && !err && (
        <div className="obx-sim-results">
          <ObxSimGroup title="关键词命中" items={kw} type="keyword" />
          <ObxSimGroup title="语义召回" items={vec} type="vector" />
        </div>
      )}
    </div>
  );
}

// A3 · 记忆被想起 (controlled view, 长期相对时间)
function ObxStatRow({ item, view }) {
  const it = item;
  const isNever = (it.count || 0) === 0 && (it.surface_count || 0) === 0;
  const timeLabel = obxTimeAgoLong(it.last_hit);
  const badge = it.type === 'permanent' ? 'pinned' : it.type === 'feel' ? 'feel' : null;
  const showCounts = view === 'hot' || !isNever;
  return (
    <div className={'obx-stat-row' + (isNever ? ' obx-stat-row--never' : '')} title={it.id}>
      <div className="obx-stat-row-main">
        <span className="obx-stat-row-name">{it.name || it.id}</span>
        {badge && <ObxBadge variant={badge}>{badge === 'pinned' ? '钉' : 'feel'}</ObxBadge>}
        {it.missing && <span className="obx-stat-row-missing">已删/归档</span>}
        {showCounts && (
          <span className="obx-stat-row-counts">关键词 <em>{it.count || 0}</em> · 浮现 <em>{it.surface_count || 0}</em></span>
        )}
      </div>
      <div className="obx-stat-row-meta">
        <span className={'obx-stat-row-time' + (isNever ? ' obx-stat-row-time--never' : '')}>{timeLabel}</span>
      </div>
    </div>
  );
}
function ObxStatsPanel({ meta, items, view, onView, loading }) {
  const m = meta || {};
  const list = items || [];
  return (
    <div className="obx-stats-panel">
      <div className="obx-stats-hd">
        <div className="obx-stats-hd-left">
          <h3 className="obx-panel-title">记忆被想起</h3>
          <p className="obx-stats-sub">
            <span style={{ fontFamily: 'var(--mono)' }}>{m.total_searches ?? 0}</span> 次搜索
            {m.total_buckets != null && <React.Fragment>
              <span className="obx-dot">·</span>
              <span style={{ fontFamily: 'var(--mono)' }}>{m.hit_buckets}/{m.total_buckets}</span> 格命中
              <span className="obx-dot">·</span>
              <span style={{ fontFamily: 'var(--mono)' }}>{m.zero_buckets}</span> 格沉默
            </React.Fragment>}
          </p>
        </div>
        <ObxTabBar tabs={[
          { key: 'cold', label: '冷落', count: m.zero_buckets },
          { key: 'hot', label: '高频', count: m.hit_buckets },
        ]} active={view} onChange={onView} />
      </div>
      <div className="obx-stats-list" style={{ maxHeight: 420, overflowY: 'auto' }}>
        {loading && list.length === 0 ? (
          <ObxEmpty text="载入中…" />
        ) : list.length === 0 ? (
          <ObxEmpty text={view === 'cold' ? '没有被冷落的记忆 — 每条都被想起过' : '尚未有高频命中'} />
        ) : list.map(it => <ObxStatRow key={it.id} item={it} view={view} />)}
      </div>
      <p className="obx-stats-foot">
        {view === 'cold'
          ? '冷落视图 · 已排除钉决/永久/feel/已消化 · 累计落盘, 重启不清零'
          : '累计落盘, 重启不清零 · 切「冷落」看哪些一直没被想起'}
      </p>
    </div>
  );
}

// A4 · 最近搜索追溯
function ObxRecentPanel({ items, defaultCollapsed, onRefresh, loading }) {
  const [collapsed, setCollapsed] = React.useState(!!defaultCollapsed);
  const [expanded, setExpanded] = React.useState({});
  const toggle = i => setExpanded(p => ({ ...p, [i]: !p[i] }));
  const list = items || [];
  return (
    <div className="obx-recent-panel">
      <div className="obx-recent-bar">
        <button className="obx-recent-hd" onClick={() => setCollapsed(!collapsed)}>
          <h3 className="obx-panel-title">
            <span className={'obx-chevron' + (collapsed ? '' : ' obx-chevron--open')}>▸</span>
            最近浮现 · 检索
          </h3>
        </button>
        <span className="obx-recent-count" style={{ fontFamily: 'var(--mono)' }}>{list.length} 条</span>
        {onRefresh && <button className="obx-btn-ghost obx-btn-sm" onClick={onRefresh} disabled={loading} style={{ marginLeft: 8 }}>{loading ? '⌛' : '↻'}</button>}
      </div>
      {!collapsed && (
        list.length === 0
          ? <ObxEmpty text="还没有记录 · 空跑一次 breath 或搜一下记忆就有" />
          : (
            <div className="obx-recent-list">
              {list.map((it, i) => {
                const isSurface = it.kind === 'surface';
                return (
                  <div key={(it.ts || '') + '-' + i} className="obx-recent-item">
                    <button className="obx-recent-item-hd" onClick={() => toggle(i)}>
                      <span className="obx-recent-ts" style={{ fontFamily: 'var(--mono)' }}>{obxFmtTs(it.ts)}</span>
                      <span className={'obx-recent-kind obx-recent-kind--' + (isSurface ? 'surface' : 'search')}>{isSurface ? '浮现' : '检索'}</span>
                      <span className="obx-recent-query" style={isSurface ? { fontStyle: 'normal', fontFamily: 'var(--sans)', color: 'var(--ink-3)' } : undefined}>
                        {isSurface ? 'breath 权重池主动浮现' : '"' + it.query + '"'}
                      </span>
                      <span className="obx-recent-rc" style={{ fontFamily: 'var(--mono)' }}>{isSurface ? (it.result_count + ' 条') : ('→ ' + it.result_count + ' 条')}</span>
                      <span className={'obx-chevron obx-chevron--sm' + (expanded[i] ? ' obx-chevron--open' : '')}>▸</span>
                    </button>
                    {expanded[i] && it.top && (
                      <div className="obx-recent-detail">
                        {it.result_count > it.top.length && (
                          <div style={{ fontSize: 11, color: 'var(--ink-4)', fontFamily: 'var(--mono)', paddingBottom: 4 }}>
                            显示前 {it.top.length} · 共 {it.result_count} 条
                          </div>
                        )}
                        {it.top.map((h, j) => (
                          <div key={(h.id || '') + '-' + j} className="obx-recent-hit">
                            <span className="obx-recent-hit-name">{h.name}</span>
                            {h.protected && <ObxBadge variant="pinned">钉决</ObxBadge>}
                            {h.highlight && !h.protected && <ObxBadge variant="highlight">高亮</ObxBadge>}
                            {h.type === 'feel' && <ObxBadge variant="feel">feel</ObxBadge>}
                            {isSurface
                              ? <span className="obx-recent-hit-score" style={{ fontFamily: 'var(--mono)' }}>{Number(h.score) >= 999 ? '永久' : ('权重 ' + Number(h.score || 0).toFixed(1))}</span>
                              : <span className="obx-recent-hit-score" style={{ fontFamily: 'var(--mono)', color: h.title_hit ? 'var(--accent)' : 'var(--ink-4)' }}>{Number(h.score || 0).toFixed(1)}</span>}
                            {!isSurface && (h.matched_in || []).map(f => <ObxFieldBadge key={f} field={f} />)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
      )}
    </div>
  );
}

function BreathPage({ items }) {
  const [query, setQuery] = cbS('记忆');
  const [valence, setValence] = cbS(0.6);
  const [arousal, setArousal] = cbS(0.5);
  const [running, setRunning] = cbS(false);
  const [activeStage, setActiveStage] = cbS(0);
  const [topN, setTopN] = cbS(BREATH_TOP_N);
  const [threshold, setThreshold] = cbS(BREATH_THRESHOLD);

  // 后端 /api/breath-debug 返回的真实数据
  const [results, setResults] = cbS([]);
  const [weights, setWeights] = cbS(DEFAULT_WEIGHTS);
  const [totalCandidates, setTotalCandidates] = cbS(0);
  const [error, setError] = cbS(null);
  const [hasFetched, setHasFetched] = cbS(false);

  // 客户端二次过滤(slider 即时反馈,不发新请求)
  const passed = results.filter(r => r.normalized >= threshold);
  const finalList = passed.slice(0, topN);

  // ─── 从配置页迁来 (2026-06-07): 检索打分微调 / 即时模拟 / 被想起统计 / 最近搜索 ───
  // 都是"看检索/浮现怎么发生"的观测面, 跟上面的 breath-debug 模拟同类, 聚到 Breath tab。
  const [scoringCfg, setScoringCfg] = cbS(null);
  const [scoringSaving, setScoringSaving] = cbS(false);
  const [scoringResetting, setScoringResetting] = cbS(false);
  const [hitStats, setHitStats] = cbS(null);
  const [hitStatsLoading, setHitStatsLoading] = cbS(false);
  const [hitView, setHitView] = cbS('cold');          // 默认冷落视图 (稀疏用户最该看"哪些一直没被想起") / 'hot' 高频在前
  const [recentSearches, setRecentSearches] = cbS(null);
  const [recentLoading, setRecentLoading] = cbS(false);
  const [recentOpen, setRecentOpen] = cbS({});
  const [simQuery, setSimQuery] = cbS('');             // 即时模拟: /api/search dry-run (区别于上面 breath-debug 管线)
  const [simResult, setSimResult] = cbS(null);
  const [simLoading, setSimLoading] = cbS(false);
  const [simDirty, setSimDirty] = cbS(false);          // 调参后置脏 → 提示"重新模拟看效果"

  const fetchScoring = async () => {
    try {
      const r = await fetch('/api/scoring-config');
      if (r.ok) setScoringCfg(await r.json());
    } catch (e) { /* 沉默 */ }
  };
  const updateScoring = async (key, value) => {
    if (!scoringCfg) return;
    const old = scoringCfg.current[key];
    setScoringCfg(c => ({ ...c, current: { ...c.current, [key]: value } }));
    setSimDirty(true);
    setScoringSaving(true);
    try {
      const r = await fetch('/api/scoring-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (d && d.current) setScoringCfg(c => ({ ...c, current: d.current }));
    } catch (e) {
      alert('保存失败: ' + e.message);
      setScoringCfg(c => ({ ...c, current: { ...c.current, [key]: old } }));
    } finally {
      setScoringSaving(false);
    }
  };
  const resetScoringAll = async () => {
    if (!scoringCfg) return;
    if (!confirm('打分微调全部关掉(回到默认零影响)?')) return;
    setScoringResetting(true);
    try {
      const r = await fetch('/api/scoring-config/reset', { method: 'POST' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (d && d.current) setScoringCfg(c => ({ ...c, current: d.current }));
    } catch (e) {
      alert('恢复失败: ' + e.message);
    } finally {
      setScoringResetting(false);
    }
  };
  const fetchHitStats = async (view) => {
    const mode = view || hitView;
    setHitStatsLoading(true);
    try {
      // 冷门视图: 并入从未命中的桶(count 0) + 排除钉选/永久参考/feel/已消化 + 升序
      const qs = mode === 'cold'
        ? 'limit=300&include_zero=1&exclude_gated=1&order=asc'
        : 'limit=50&order=desc';
      const r = await fetch('/api/hit-stats?' + qs);
      if (r.ok) setHitStats(await r.json());
    } catch (e) { /* 沉默 */ }
    finally { setHitStatsLoading(false); }
  };
  const switchHitView = (view) => { setHitView(view); fetchHitStats(view); };
  const fetchRecentSearches = async () => {
    setRecentLoading(true);
    try {
      const r = await fetch('/api/recent-searches?limit=10');
      if (r.ok) setRecentSearches(await r.json());
    } catch (e) { /* 沉默 */ }
    finally { setRecentLoading(false); }
  };
  const runSimulate = async () => {
    const q = simQuery.trim();
    if (!q) return;
    setSimLoading(true);
    try {
      // simulate=true → dry-run, 不记命中统计、不进最近搜索; include_vector 顺带看语义召回
      const r = await fetch('/api/search?simulate=true&include_vector=true&limit=20&q=' + encodeURIComponent(q));
      if (r.ok) setSimResult(await r.json());
      else setSimResult({ error: 'HTTP ' + r.status });
    } catch (e) { setSimResult({ error: String(e) }); }
    finally { setSimLoading(false); setSimDirty(false); }
  };

  const fetchBreath = async () => {
    setError(null);
    try {
      const params = new URLSearchParams({
        q: query,
        valence: String(valence),
        arousal: String(arousal),
      });
      const r = await fetch(`/api/breath-debug?${params.toString()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setResults(Array.isArray(data.results) ? data.results : []);
      setWeights(data.weights || DEFAULT_WEIGHTS);
      setTotalCandidates(data.total_candidates || 0);
      setHasFetched(true);
    } catch (err) {
      setError(err && err.message ? err.message : String(err));
      setResults([]);
      setTotalCandidates(0);
      setHasFetched(true);
    }
  };

  // 阶段动画 + fetch 并行
  const runSimulation = () => {
    setRunning(true);
    setActiveStage(0);
    let s = 0;
    const tick = () => {
      s += 1;
      setActiveStage(s);
      if (s < 5) setTimeout(tick, 320);
      else setTimeout(() => { setRunning(false); }, 200);
    };
    setTimeout(tick, 200);
    fetchBreath();
  };

  // 初次挂载自动跑一次,免得空白 + 拉迁来的 scoring/统计数据
  cbE(() => { runSimulation(); fetchScoring(); fetchHitStats(); fetchRecentSearches(); }, []);

  const stages = [
    { num: 'i', label: '输入', meta: 'query / valence / arousal' },
    { num: 'ii', label: '候选', meta: `${totalCandidates} 条` },
    { num: 'iii', label: '四维评分', meta: `topic×${weights.topic} + emotion×${weights.emotion} + time×${weights.time} + imp×${weights.importance}` },
    { num: 'iv', label: '阈值过滤', meta: `≥${threshold} · ${passed.length} 通过` },
    { num: 'v', label: '降序排序', meta: `返回 top ${topN}` },
  ];

  return (
    <main className="oc-main">
      <ConsolePageHd
        title="Breath 模拟"
        sub={<>记忆唤起的 5 阶段管线可视化 —— 输入 query 与情感坐标,观察候选记忆如何被四维评分、过滤、重排。</>}
        rightSlot={<div className="ob-page-counter"><b>{totalCandidates}</b> 候选 · <b>{finalList.length}</b> 命中</div>}
      />

      {error && (
        <div style={{
          margin: '0 0 14px',
          padding: '10px 14px',
          background: 'color-mix(in oklab, #c44 6%, var(--paper))',
          border: '0.5px solid color-mix(in oklab, #c44 35%, var(--line-2))',
          borderLeft: '2px solid #c44',
          borderRadius: 8,
          display: 'flex', alignItems: 'flex-start', gap: 10,
          fontSize: 12, lineHeight: 1.6, color: 'var(--ink-2)',
        }}>
          <span style={{ color: '#c44', fontFamily: 'var(--mono)', fontSize: 11, flexShrink: 0, marginTop: 1 }}>⚠ 后端失败</span>
          <span>{error}</span>
        </div>
      )}

      {/* 管线可视化 */}
      <ConsoleCard>
        <div className="oc-breath-pipeline">
          {stages.map((s, i) => (
            <div
              key={i}
              className={`oc-breath-stage${activeStage > i ? ' active' : ''}`}
            >
              <div className="oc-breath-stage-num">stage {s.num}</div>
              <div className="oc-breath-stage-name">{s.label}</div>
              <div className="oc-breath-stage-meta">{s.meta}</div>
            </div>
          ))}
        </div>
      </ConsoleCard>

      {/* 输入控制台 */}
      <ConsoleCard label="输入" sub='按 Enter 或点"模拟 Breath"运行管线'>
        <div className="oc-breath-form">
          <div className="oc-field">
            <div className="oc-field-label">Query</div>
            <input
              className="oc-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runSimulation()}
              placeholder="输入想唤起的关键词…"
            />
          </div>
          <div className="oc-field">
            <div className="oc-field-label">Valence</div>
            <input
              type="range" min={0} max={1} step={0.05}
              value={valence}
              onChange={(e) => setValence(+e.target.value)}
              className="oc-slider"
            />
            <div className="oc-field-help">{valence.toFixed(2)} · {valence < 0.4 ? '低' : valence > 0.65 ? '正向' : '中性'}</div>
          </div>
          <div className="oc-field">
            <div className="oc-field-label">Arousal</div>
            <input
              type="range" min={0} max={1} step={0.05}
              value={arousal}
              onChange={(e) => setArousal(+e.target.value)}
              className="oc-slider"
            />
            <div className="oc-field-help">{arousal.toFixed(2)} · {arousal < 0.4 ? '平静' : arousal > 0.65 ? '激越' : '适度'}</div>
          </div>
          <button
            className="oc-btn oc-btn-primary"
            onClick={runSimulation}
            disabled={running}
          >
            {running ? '◐ 模拟中…' : '▶ 模拟 Breath'}
          </button>
        </div>
      </ConsoleCard>

      {/* 权重 + 阈值配置 */}
      <ConsoleCard label="权重配置" sub="权重展示后端真实值。阈值与 top N 在客户端二次过滤,不影响后端评分。">
        <div className="oc-weight-bar">
          <span><b>topic</b> = {weights.topic}</span>
          <span className="sep">·</span>
          <span><b>emotion</b> = {weights.emotion}</span>
          <span className="sep">·</span>
          <span><b>time</b> = {weights.time}</span>
          <span className="sep">·</span>
          <span><b>importance</b> = {weights.importance}</span>
          <span className="sep">|</span>
          <span>阈值 = <b>{threshold}</b></span>
          <span className="sep">|</span>
          <span>候选 = <b>{totalCandidates}</b></span>
          <span className="sep">→</span>
          <span>通过 <b>{passed.length}</b> 条</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginTop: 14 }}>
          <div className="oc-field-row">
            <div className="oc-field-label" style={{ marginBottom: 8 }}>命中阈值（0-100）</div>
            <input type="range" min={0} max={100} step={1} value={threshold} onChange={(e) => setThreshold(+e.target.value)} className="oc-slider" />
            <div className="oc-field-help">分数 ≥ {threshold} 才会进入排序阶段</div>
          </div>
          <div className="oc-field-row">
            <div className="oc-field-label" style={{ marginBottom: 8 }}>返回 top N</div>
            <input type="range" min={1} max={20} step={1} value={topN} onChange={(e) => setTopN(+e.target.value)} className="oc-slider" />
            <div className="oc-field-help">最终给上层的记忆条数 = {topN}</div>
          </div>
        </div>
      </ConsoleCard>

      {/* 候选条形图 */}
      <ConsoleCard
        label="候选评分"
        sub={`${results.length} 条 · ${passed.length} 过阈 · top ${topN} 入选`}
      >
        {!hasFetched ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--ink-3)', fontSize: 12 }}>
            正在拉取后端数据…
          </div>
        ) : results.length === 0 ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--ink-3)', fontSize: 12 }}>
            {error ? '后端返回错误,见上方提示' : '后端返回 0 条候选(全库可能为空,或 query 没匹配上)'}
          </div>
        ) : (
          <div className="oc-candidates">
            {results.slice(0, 18).map((s, i) => {
              const dropped = s.normalized < threshold || i >= topN;
              const sc = s.scores || {};
              return (
                <div key={s.id} className={`oc-cand${dropped ? ' dropped' : ''}`}>
                  <div className="oc-cand-rank">{String(i + 1).padStart(2, '0')}</div>
                  <div className="oc-cand-title" title={s.name}>{s.name || s.id}</div>
                  <div className="oc-cand-bars">
                    <BreathBar kind="topic" value={sc.topic || 0} weight={weights.topic} />
                    <BreathBar kind="emotion" value={sc.emotion || 0} weight={weights.emotion} />
                    <BreathBar kind="time" value={sc.time || 0} weight={weights.time} />
                    <BreathBar kind="imp" value={sc.importance || 0} weight={weights.importance} />
                  </div>
                  <div className="oc-cand-score">{(s.normalized || 0).toFixed(1)}</div>
                </div>
              );
            })}
          </div>
        )}
      </ConsoleCard>

      {/* ═══ 检索 / 浮现观测台 (Claude Design 改版 · 方案 α「实验与观察」, 2026-06-09) ═══ */}
      <div className="obx-observatory">
        {/* 实验区: 调参(A2) + 模拟(A1) 并排 — 边调边看 */}
        <section className="obx-card obx-dual-pane">
          <div className="obx-dual-left">
            {scoringCfg
              ? <ObxKnobPanel config={scoringCfg.current} defaults={scoringCfg.defaults} schema={scoringCfg.schema} onChange={updateScoring} onReset={resetScoringAll} />
              : <ObxEmpty text="载入中…" />}
          </div>
          <div className="obx-dual-divider" />
          <div className="obx-dual-right">
            <ObxSimPanel results={simResult} query={simQuery} onQueryChange={setSimQuery} onSimulate={runSimulate} dirty={simDirty} loading={simLoading} />
          </div>
        </section>

        {/* 观察区: 记忆被想起(A3) — 默认冷落视图, 长期相对时间 */}
        <section className="obx-card">
          <ObxStatsPanel meta={hitStats} items={hitStats && hitStats.items} view={hitView} onView={switchHitView} loading={hitStatsLoading} />
        </section>

        {/* 最近搜索追溯(A4) — 折叠在底部 */}
        <section className="obx-card obx-card--quiet">
          <ObxRecentPanel items={recentSearches && recentSearches.items} defaultCollapsed={true} onRefresh={fetchRecentSearches} loading={recentLoading} />
        </section>
      </div>
    </main>
  );
}

function BreathBar({ kind, value, weight }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="oc-cand-bar" title={`${kind} = ${value.toFixed(2)} (×${weight})`}>
      <div
        className={`oc-cand-bar-fill ${kind}`}
        style={{ width: `${pct}%` }}
      />
      <span className="oc-cand-bar-label">{kind}×{weight}</span>
    </div>
  );
}

window.BreathPage = BreathPage;
