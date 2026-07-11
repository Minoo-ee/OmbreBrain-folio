// app-v2.jsx —— v2 增强版顶层组合

const { useState: uSA, useEffect: uEA, useMemo: uMA, useRef: uRA } = React;

const TODAY = (() => {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();
const NOW = '23:30';

function TopBarV2({ dark, onDark, compact, data }) {
  const stats = data || [];
  return (
    <div className="ob-topbar">
      <div className="ob-brand">
        <span className="ob-brand-mark" />
        <span className="ob-brand-name">Ombre Brain</span>
        {!compact && (
          <div className="ob-brand-stats">
            <span><b>{stats.length}</b> 格</span>
            <span><b>{stats.filter(i=>i.protected).length}</b> 钉决</span>
            <span><b>{stats.filter(i=>i.feel).length}</b> feel</span>
            <span><b>{stats.filter(i=>i.importance>=8||i.highlight).length}</b> 重要</span>
          </div>
        )}
      </div>
      <div className="ob-topbar-actions">
        {window.ThemeToggle && <window.ThemeToggle />}
        <DarkToggle dark={dark} onChange={onDark} />
      </div>
    </div>
  );
}

function NavBarV2({ active = 'timeline' }) {
  return (
    <nav className="ob-nav">
      <a href="/v2/cells/" className={active === 'cells' ? 'on' : ''}>记忆格</a>
      <a href="/v2/" className={active === 'timeline' ? 'on' : ''}>时间线</a>
      <a href="/v2/network/" className={active === 'network' ? 'on' : ''}>记忆星图</a>
      <a href="/v2/console/import/">导入</a>
      <a href="/v2/console/breath/">Breath 模拟</a>
      <a href="/v2/console/config/">配置</a>
      <a href="/v2/console/trash/">回收站</a>
    </nav>
  );
}

function AppV2() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [data, setData] = uSA(MEMORY_DATA);
  const [query, setQuery] = uSA('');
  const [filters, setFilters] = uSA({ highlightOnly: false, impHighOnly: false, feelOnly: false, protectedOnly: false, sourceFilter: null });
  const [openDay, setOpenDay] = uSA(null);
  const [openItem, setOpenItem] = uSA(null);
  const [writeOpen, setWriteOpen] = uSA(false);
  const [dark, setDark] = uSA(t.dark || false);
  const [shortcutsHint, setShortcutsHint] = uSA(false);

  // 应用暗色
  uEA(() => {
    if (window.OB_THEME) window.OB_THEME.setDarkMode(dark);
    else document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }, [dark]);

  // 提示快捷键 3 秒
  uEA(() => {
    const tm = setTimeout(() => setShortcutsHint(true), 1200);
    const tm2 = setTimeout(() => setShortcutsHint(false), 5800);
    return () => { clearTimeout(tm); clearTimeout(tm2); };
  }, []);

  const sortedAll = uMA(() =>
    [...data].sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)),
    [data]
  );

  // 全局快捷键
  uEA(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const isInput = tag === 'input' || tag === 'textarea';

      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        setOpenItem(null); setOpenDay(null);
        setWriteOpen(true);
        return;
      }
      if (writeOpen) return; // 写入时其他快捷键失效

      if (e.key === '/' && !isInput) {
        e.preventDefault();
        const inp = document.querySelector('.ob-toolbar-search input');
        if (inp) inp.focus();
        return;
      }
      if (isInput) return;

      if (e.key === 'i' || e.key === 'I') {
        setFilters(f => ({ ...f, highlightOnly: !f.highlightOnly }));
      } else if (e.key === 'f' || e.key === 'F') {
        setFilters(f => ({ ...f, feelOnly: !f.feelOnly }));
      } else if (e.key === 'd' || e.key === 'D') {
        setDark(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [writeOpen]);

  const handleNavigate = (delta) => {
    if (!openItem) return;
    const idx = sortedAll.findIndex(i => i.id === openItem.id);
    const next = idx + delta;
    if (next >= 0 && next < sortedAll.length) {
      setOpenItem(sortedAll[next]);
    }
  };

  const dayItems = openDay ? data.filter(it => it.date === openDay) : [];
  const todayItems = data.filter(it => it.date === TODAY);
  const lastWriteDate = sortedAll[0]?.date;

  const handleSave = (entry) => {
    const id = 'm' + (data.length + 100);
    const newItem = {
      id,
      date: entry.date, time: entry.time,
      title: entry.title,
      summary: entry.summary || entry.title,
      tags: entry.tags,
      importance: entry.importance,
      protected: entry.protected,
      feel: entry.feel,
      body: '',
      artifacts: []
    };
    setData(prev => [newItem, ...prev]);
    setWriteOpen(false);
    // 自动滚到顶部
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const jumpToToday = () => {
    const el = document.querySelector(`[data-screen-label="day-${TODAY}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const jumpToItem = (it) => {
    const el = document.querySelector(`[data-screen-label="day-${it.date}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className={`ob-shape-${t.nodeShape || 'circle'}`}>
      <TopBarV2 dark={dark} onDark={(v) => { setDark(v); setTweak('dark', v); }} />
      <NavBarV2 />
      <main className="ob-page">
        <header className="ob-page-hd">
          <div>
            <h1 className="ob-page-title">{t.headline}</h1>
            <p className="ob-page-sub">{t.subline}</p>
          </div>
          <div className="ob-page-side">
            <div className="ob-page-counter">
              <b>{data.length}</b> 条记忆 · <b>{new Set(data.map(i => i.date)).size}</b> 个时间节点
            </div>
            <button className="ob-add-btn" onClick={() => setWriteOpen(true)}>+ 添加事件</button>
          </div>
        </header>

        <TodayBar
          todayItems={todayItems}
          allItems={data}
          lastWriteDate={lastWriteDate}
          todayDate={TODAY}
          onWrite={() => setWriteOpen(true)}
          onJumpToday={jumpToToday}
        />

        <div className="ob-toolbar">
          <div className="ob-toolbar-search">
            <span style={{ opacity: 0.5 }}>⌕</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索关键词、人物、地点……  按 / 快速聚焦"
            />
          </div>
          <FilterChipV2
            active={!filters.highlightOnly && !filters.impHighOnly && !filters.feelOnly && !filters.protectedOnly && !filters.sourceFilter}
            onClick={() => setFilters({ highlightOnly: false, impHighOnly: false, feelOnly: false, protectedOnly: false, sourceFilter: null })}
          >全部</FilterChipV2>
          <FilterChipV2 tone="pin" active={filters.protectedOnly}
            onClick={() => setFilters(f => ({ ...f, protectedOnly: !f.protectedOnly }))}
          >❖ 钉决</FilterChipV2>
          <FilterChipV2 tone="highlight" active={filters.highlightOnly}
            onClick={() => setFilters(f => ({ ...f, highlightOnly: !f.highlightOnly }))}
          >★ 高亮</FilterChipV2>
          <FilterChipV2 tone="fresh" active={filters.impHighOnly}
            onClick={() => setFilters(f => ({ ...f, impHighOnly: !f.impHighOnly }))}
          >✦ 重要度高</FilterChipV2>
          <FilterChipV2 tone="feel" active={filters.feelOnly}
            onClick={() => setFilters(f => ({ ...f, feelOnly: !f.feelOnly }))}
          >♡ Feel</FilterChipV2>
          {/* 来源 — 三态单选 (再点取消). 历史 'ai' 桶混了 import 跟 AI 主动写,
              改完代码后新数据就分开了, 老的可在 modal 里手动改 */}
          <FilterChipV2 active={filters.sourceFilter === 'import'}
            onClick={() => setFilters(f => ({ ...f, sourceFilter: f.sourceFilter === 'import' ? null : 'import' }))}
          >导入</FilterChipV2>
          <FilterChipV2 active={filters.sourceFilter === 'ai'}
            onClick={() => setFilters(f => ({ ...f, sourceFilter: f.sourceFilter === 'ai' ? null : 'ai' }))}
          >AI 写入</FilterChipV2>
          <FilterChipV2 active={filters.sourceFilter === 'user'}
            onClick={() => setFilters(f => ({ ...f, sourceFilter: f.sourceFilter === 'user' ? null : 'user' }))}
          >亲手写</FilterChipV2>
        </div>

        <TimelineV2
          items={data}
          query={query}
          filters={filters}
          density={t.density}
          todayDate={TODAY}
          onOpenItem={(it) => setOpenItem(it)}
          onOpenDay={(d) => setOpenDay(d)}
        />
      </main>

      <MiniTimeline items={data} onJump={jumpToItem} />
      <Fab />

      {shortcutsHint && (
        <div className="ob-shortcuts-hint">
          <span><b>/</b>搜索</span>
          <span><b>I</b>重要</span>
          <span><b>F</b>feel</span>
          <span><b>D</b>暗色</span>
          <span><b>⌘N</b>写入</span>
        </div>
      )}

      {openDay && !openItem && (
        <DayDetail
          date={openDay}
          items={dayItems}
          accent={t.accent}
          onClose={() => setOpenDay(null)}
          onOpenItem={(it) => setOpenItem(it)}
        />
      )}

      {openItem && (
        <ItemModal
          item={openItem}
          allItems={data}
          onClose={() => setOpenItem(null)}
          onNavigate={handleNavigate}
          onOpenItem={(it) => setOpenItem(it)}
          onUpdate={(id, patch) => {
            setData(prev => prev.map(x => x.id === id ? { ...x, ...patch } : x));
            setOpenItem(prev => prev && prev.id === id ? { ...prev, ...patch } : prev);
          }}
        />
      )}

      <WriteDrawer
        open={writeOpen}
        onClose={() => setWriteOpen(false)}
        onSave={handleSave}
        defaultDate={TODAY}
        defaultTime={NOW}
      />

      <TweaksPanel>
        <TweakSection label="主题" />
        <TweakToggle label="暗夜模式 (D)" value={dark} onChange={(v) => setDark(v)} />
        <TweakColor label="强调色（紫）" value={t.accent}
          onChange={(v) => { setTweak('accent', v); document.documentElement.style.setProperty('--accent', v); }} />
        <TweakColor label="情感色（粉）" value={t.feelColor}
          onChange={(v) => { setTweak('feelColor', v); document.documentElement.style.setProperty('--rose', v); document.documentElement.style.setProperty('--rose-deep', v); }} />

        <TweakSection label="时间线" />
        <TweakRadio label="密度" value={t.density}
          options={['compact', 'regular', 'comfy']}
          onChange={(v) => setTweak('density', v)} />
        <TweakRadio label="节点形状" value={t.nodeShape}
          options={['circle', 'square', 'diamond']}
          onChange={(v) => setTweak('nodeShape', v)} />

        <TweakSection label="演示" />
        <TweakButton label="打开写入抽屉 (⌘N)" onClick={() => setWriteOpen(true)}>打开</TweakButton>
        <TweakButton label="打开单条详情" onClick={() => setOpenItem(data.find(i => i.id === 'm11'))}>预览</TweakButton>
        <TweakButton label="打开当日详情" onClick={() => { setOpenItem(null); setOpenDay('2026-04-26'); }}>预览</TweakButton>
      </TweaksPanel>
    </div>
  );
}

if (!window.__OB_NO_AUTO_RENDER) {
  ReactDOM.createRoot(document.getElementById('root')).render(<AppV2 />);
}
