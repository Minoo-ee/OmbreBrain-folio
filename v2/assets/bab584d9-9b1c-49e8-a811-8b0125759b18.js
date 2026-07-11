// app-v2.jsx —— v2 增强版顶层组合

const { useState: uSA, useEffect: uEA, useMemo: uMA, useRef: uRA } = React;

// 用本地时区今天的日期 — 之前写死 '2026-04-26' 永远不动,2026-04-28 起改动态
const TODAY = (() => {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();
// NOW 也曾写死 '23:30', 写入抽屉永远填错时间, 改成实时取
function getNow() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
  const [data, setData] = uSA([]);
  const [loading, setLoading] = uSA(true);
  const [loadError, setLoadError] = uSA(null);
  const [query, setQuery] = uSA('');
  // 后端全字段搜索结果(含完整正文 + matched_in 命中字段)
  // 客户端 hay 只能搜 title/summary/preview/tag(列表 endpoint 不返回 body),
  // 这里用 server search 补漏 — 命中 ids 作为白名单,matched_in 给 dot 旁标"命中:正文"用
  const [searchHits, setSearchHits] = uSA(null); // null=未搜 / [{id, matched_in}]
  const [searchLoading, setSearchLoading] = uSA(false);
  const [filters, setFilters] = uSA({ highlightOnly: false, importantOnly: false, feelOnly: false, protectedOnly: false, noiseOnly: false, sourceFilter: null });

  // query 变化 → 250ms debounce → 调 /api/search,拿全字段命中
  // 空 query → 清空 hits;非空 → setSearchHits(命中数组)
  uEA(() => {
    const q = query.trim();
    if (!q) { setSearchHits(null); setSearchLoading(false); return; }
    let cancelled = false;
    setSearchLoading(true);
    const tm = setTimeout(async () => {
      try {
        const data = await window.__obSearch(q, { limit: 80 });
        if (cancelled) return;
        const hits = (data.keyword_hits || []).map(h => ({ id: h.id, matched_in: h.matched_in || [] }));
        setSearchHits(hits);
      } catch (e) {
        if (!cancelled) { console.warn('[ombre v2] search failed', e); setSearchHits([]); }
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(tm); };
  }, [query]);
  const [domainFilters, setDomainFilters] = uSA([]);  // 主题域多选
  const [domainOpen, setDomainOpen] = uSA(false);     // 默认收起
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

  // 拉真实数据(由 ombre-bridge.js 提供 API helper)
  const refresh = async () => {
    try {
      setLoadError(null);
      const rows = await window.__obFetchBuckets();
      setData(rows);
      setLoading(false);
    } catch (e) {
      console.error('[ombre v2] load failed', e);
      setLoadError(e.message || String(e));
      setLoading(false);
    }
  };
  uEA(() => { refresh(); }, []);

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
        setFilters(f => ({ ...f, importantOnly: !f.importantOnly }));
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
      openItemWithBody(sortedAll[next]);
    }
  };

  const dayItems = openDay ? data.filter(it => it.date === openDay) : [];
  const todayItems = data.filter(it => it.date === TODAY);
  const lastWriteDate = sortedAll[0]?.date;

  // 今天聚焦模式:点"查看今天"切换 ON/OFF
  // ON: 今天的 day-block 居中 + 其他天减淡;OFF: 全部正常
  const [focusToday, setFocusToday] = uSA(false);

  // 注入动态 CSS 实现"非今天减淡"(today selector 含动态日期,纯静态 CSS 写不出来)
  uEA(() => {
    let style = document.getElementById('ob-focus-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'ob-focus-style';
      document.head.appendChild(style);
    }
    if (focusToday) {
      style.textContent = `
        [data-screen-label^="day-"] {
          opacity: 0.22;
          filter: grayscale(0.4);
          transition: opacity .35s ease, filter .35s ease;
        }
        [data-screen-label="day-${TODAY}"] {
          opacity: 1 !important;
          filter: none !important;
        }
      `;
    } else {
      style.textContent = '';
    }
    return () => { if (style) style.textContent = ''; };
  }, [focusToday]);

  const handleSave = async (entry) => {
    try {
      await window.__obCreateBucket(entry);
      setWriteOpen(false);
      await refresh();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      alert('写入失败: ' + e.message);
    }
  };

  // 打开单条 modal — 列表只有 content_preview,这里 lazy-load 完整 content 注入 body
  // 加载期间在 body 显示占位符,避免用户在 body 还没加载完就点 Edit 把空内容存回去
  const openItemWithBody = async (it) => {
    if (it.body || it._bodyLoaded) { setOpenItem(it); return; }
    const loadingItem = { ...it, body: '⌛ 加载完整内容…', _loading: true };
    setOpenItem(loadingItem);
    try {
      const detail = await window.__obFetchBucketDetail(it.id);
      const persistedSummary = detail.metadata && detail.metadata.summary;
      const merged = {
        ...it,
        body: detail.content || '',
        summary: persistedSummary || it.summary || '',
        _meta: detail.metadata,
        _bodyLoaded: true,
        _loading: false,
      };
      setOpenItem(prev => prev && prev.id === it.id ? merged : prev);
      // 同步到 data 缓存,下次再点不用重拉
      setData(prev => prev.map(x => x.id === it.id ? merged : x));
    } catch (e) {
      console.error('[ombre v2] detail load failed', e);
      setOpenItem(prev => prev && prev.id === it.id ? { ...prev, body: '(加载失败,稍后重试)', _loading: false } : prev);
    }
  };

  const jumpToToday = () => {
    // 切换聚焦模式;如果将要进入 ON,就 scroll 今天到视口中心
    setFocusToday(prev => {
      const next = !prev;
      if (next) {
        // 等下一帧让 className 先生效再 scroll,避免动画跳跃
        setTimeout(() => {
          const el = document.querySelector(`[data-screen-label="day-${TODAY}"]`);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 30);
      }
      return next;
    });
  };

  const jumpToItem = (it) => {
    const el = document.querySelector(`[data-screen-label="day-${it.date}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className={`ob-shape-${t.nodeShape || 'circle'}`}>
      <TopBarV2 dark={dark} onDark={(v) => { setDark(v); setTweak('dark', v); }} data={data} />
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

        {loading && (
          <div style={{padding:'14px 18px',margin:'0 0 16px',background:'rgba(110,79,154,0.08)',border:'1px solid rgba(110,79,154,0.2)',borderRadius:10,color:'#6e4f9a',fontSize:13}}>
            正在加载真实记忆 …
          </div>
        )}
        {loadError && (
          <div style={{padding:'14px 18px',margin:'0 0 16px',background:'rgba(139,74,74,0.08)',border:'1px solid rgba(139,74,74,0.3)',borderRadius:10,color:'#8B4A4A',fontSize:13}}>
            加载失败:{loadError} · <a onClick={refresh} style={{cursor:'pointer',textDecoration:'underline'}}>重试</a>
          </div>
        )}

        <TodayBar
          todayItems={todayItems}
          lastWriteDate={lastWriteDate}
          todayDate={TODAY}
          focusToday={focusToday}
          totalDays={(() => {
            if (!data.length) return 1;
            const earliest = data.reduce((m, i) => i.date < m ? i.date : m, data[0].date);
            return dayDiff(TODAY, earliest) + 1;
          })()}
          totalHi={data.filter(i => (i.protected || i.pinned) || i.highlight || (i.importance || 5) >= 8).length}
          totalCount={data.length}
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
            active={!filters.highlightOnly && !filters.importantOnly && !filters.feelOnly && !filters.protectedOnly && !filters.noiseOnly && !filters.sourceFilter}
            onClick={() => setFilters({ highlightOnly: false, importantOnly: false, feelOnly: false, protectedOnly: false, noiseOnly: false, sourceFilter: null })}
          >全部</FilterChipV2>
          <FilterChipV2 tone="pin" active={filters.protectedOnly}
            onClick={() => setFilters(f => ({ ...f, protectedOnly: !f.protectedOnly }))}
          >❖ 钉决</FilterChipV2>
          <FilterChipV2 tone="highlight" active={filters.highlightOnly}
            onClick={() => setFilters(f => ({ ...f, highlightOnly: !f.highlightOnly }))}
          >★ 高亮</FilterChipV2>
          <FilterChipV2 tone="fresh" active={filters.importantOnly}
            onClick={() => setFilters(f => ({ ...f, importantOnly: !f.importantOnly }))}
          >✦ 重要</FilterChipV2>
          <FilterChipV2 tone="feel" active={filters.feelOnly}
            onClick={() => setFilters(f => ({ ...f, feelOnly: !f.feelOnly }))}
          >♡ Feel</FilterChipV2>
          <FilterChipV2 tone="noise" active={filters.noiseOnly}
            onClick={() => setFilters(f => ({ ...f, noiseOnly: !f.noiseOnly }))}
          >⌀ 噪声</FilterChipV2>
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

        {/* 主题域筛选行 (默认收起, 点击展开) */}
        {(() => {
          const counts = {};
          data.forEach(b => (b.domain || []).forEach(d => { if (d) counts[d] = (counts[d] || 0) + 1; }));
          const list = Object.entries(counts).sort((a, b) => b[1] - a[1]);
          if (list.length === 0) return null;
          const hasActive = domainFilters.length > 0;
          return (
            <div className={'ob-domain-row' + (domainOpen ? ' is-open' : ' is-collapsed')}>
              <button
                className={'ob-domain-row-toggle' + (hasActive ? ' has-active' : '')}
                onClick={() => setDomainOpen(o => !o)}
              >
                <span className="ob-domain-row-chev">{domainOpen ? '▾' : '▸'}</span>
                <span className="ob-domain-row-lab">主题域</span>
                {hasActive && <span className="ob-domain-row-badge">{domainFilters.length}</span>}
                {!domainOpen && (
                  <span className="ob-domain-row-meta">
                    {hasActive ? domainFilters.join(' / ') : `${list.length} 个`}
                  </span>
                )}
              </button>
              {domainOpen && (
                <>
                  {list.map(([d, c]) => (
                    <FilterChipV2
                      key={d}
                      active={domainFilters.includes(d)}
                      onClick={() => setDomainFilters(curr => curr.includes(d) ? curr.filter(x => x !== d) : [...curr, d])}
                    >{d} <span style={{ opacity: 0.5, fontSize: '0.85em' }}>{c}</span></FilterChipV2>
                  ))}
                  {hasActive && (
                    <button className="ob-domain-row-clear" onClick={() => setDomainFilters([])}>清空</button>
                  )}
                </>
              )}
            </div>
          );
        })()}

        <TimelineV2
          items={domainFilters.length > 0 ? data.filter(b => domainFilters.every(d => (b.domain || []).includes(d))) : data}
          query={query}
          searchHits={searchHits}
          searchLoading={searchLoading}
          filters={filters}
          density={t.density}
          todayDate={TODAY}
          onOpenItem={(it) => openItemWithBody(it)}
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
          onOpenItem={(it) => openItemWithBody(it)}
        />
      )}

      {openItem && (
        <ItemModal
          item={openItem}
          allItems={data}
          onClose={() => setOpenItem(null)}
          onNavigate={handleNavigate}
          onOpenItem={(it) => openItemWithBody(it)}
          onUpdate={async (id, patch) => {
            if (patch.__delete) {
              // 乐观从列表里抹掉,关闭 modal
              setData(prev => prev.filter(x => x.id !== id));
              setOpenItem(null);
              try {
                const r = await fetch('/api/bucket/' + encodeURIComponent(id) + '/delete', { method: 'POST' });
                if (!r.ok) throw new Error(await r.text());
                await refresh();
              } catch (e) {
                alert('删除失败: ' + e.message + '\n(界面已回滚)');
                await refresh();
              }
              return;
            }
            // 先做乐观更新让 UI 立刻有反馈
            setData(prev => prev.map(x => x.id === id ? { ...x, ...patch } : x));
            setOpenItem(prev => prev && prev.id === id ? { ...prev, ...patch } : prev);
            try {
              await window.__obUpdateBucket(id, patch);
              // 刷新拿权威数据
              await refresh();
            } catch (e) {
              alert('保存失败: ' + e.message + '\n(界面已回滚)');
              await refresh();
            }
          }}
        />
      )}

      <WriteDrawer
        open={writeOpen}
        onClose={() => setWriteOpen(false)}
        onSave={handleSave}
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
