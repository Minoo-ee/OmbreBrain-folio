// constellation-app.jsx —— 主应用：编排布局/状态/键盘

const { useState: caS, useEffect: caE, useMemo: caM, useRef: caR } = React;

function ConstellationApp() {
  const [t, setTweak] = useTweaks(window.TWEAK_DEFAULTS);
  const [data, setData] = caS([]);
  const [loading, setLoading] = caS(true);
  const [loadError, setLoadError] = caS(null);
  // 拉真实数据(由 ombre-bridge.js 提供)
  const refresh = caR ? caR(null) : null;
  const refreshFn = async () => {
    try {
      setLoadError(null);
      const rows = await window.__obFetchBuckets();
      setData(rows);
      setLoading(false);
    } catch (e) {
      console.error('[constellation] load failed', e);
      setLoadError(e.message || String(e));
      setLoading(false);
    }
  };
  caE(() => { refreshFn(); }, []);
  const [mode, setMode] = caS('constellation');  // constellation / cluster / time / type
  const [enabledTypes, setEnabledTypes] = caS(new Set(['dynamic', 'permanent', 'feel', 'archived']));
  // 额外属性筛选 (默认空 = 不过滤; 加入 'fresh' = 只看重要; 加入 'mine' = 只看我写的)
  const [extraFilters, setExtraFilters] = caS(new Set());
  const toggleExtra = (k) => setExtraFilters(s => {
    const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n;
  });
  const [tagFilters, setTagFilters] = caS(new Set());
  const [impMin, setImpMin] = caS(1);
  const [searchQuery, setSearchQueryRaw] = caS('');
  // 搜索防抖: 用户连按键时不每次都触发下游高亮重算 (250ms 收敛)
  const [debouncedQuery, setDebouncedQuery] = caS('');
  const setSearchQuery = setSearchQueryRaw;
  caE(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery), 250);
    return () => clearTimeout(id);
  }, [searchQuery]);

  const [hoverId, setHoverId] = caS(null);
  const [selectedId, setSelectedId] = caS(null);
  const [focusedId, setFocusedId] = caS(null);

  const [zoom, setZoom] = caS(1);
  const [pan, setPan] = caS({ x: 0, y: 0 });

  const [timeOpen, setTimeOpen] = caS(false);
  const [timeIdx, setTimeIdx] = caS(0);

  const containerRef = caR(null);
  const [size, setSize] = caS({ width: 1400, height: 800 });

  caE(() => {
    let timer = null;
    // 首次同步, 拿到初始尺寸不延迟
    const updateNow = () => {
      if (!containerRef.current) return;
      const r = containerRef.current.getBoundingClientRect();
      setSize({ width: r.width, height: r.height });
    };
    // resize 时 debounce 250ms, 用户拖动期间不反复重算布局
    const updateDebounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(updateNow, 250);
    };
    updateNow();
    window.addEventListener('resize', updateDebounced);
    return () => {
      window.removeEventListener('resize', updateDebounced);
      if (timer) clearTimeout(timer);
    };
  }, []);

  // 时间回放过滤：仅显示前 timeIdx+1 条（按时间）
  const sortedAsc = caM(() => [...data].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)), [data]);
  caE(() => { setTimeIdx(sortedAsc.length - 1); }, [sortedAsc.length]);

  // 可见 items：tag/imp/type/extra 过滤
  const visibleItems = caM(() => {
    let arr = data;
    if (timeOpen) {
      const allowed = new Set(sortedAsc.slice(0, timeIdx + 1).map(i => i.id));
      arr = arr.filter(i => allowed.has(i.id));
    }
    arr = arr.filter(i => i.importance >= impMin);
    if (tagFilters.size > 0) {
      arr = arr.filter(i => (i.tags || []).some(t => tagFilters.has(t)));
    }
    // enabledTypes 过滤 (4 视觉类: dynamic/permanent/feel/archived; 全开则不筛)
    if (enabledTypes.size < 4) {
      arr = arr.filter(i => enabledTypes.has(inferType(i)));
    }
    // extraFilters 是 AND 过滤 (按梯度独立切片)
    if (extraFilters.has('highlight')) {
      arr = arr.filter(i => i.highlight);
    }
    if (extraFilters.has('fresh')) {
      arr = arr.filter(i => (i.importance || 5) >= 8);
    }
    if (extraFilters.has('import')) {
      arr = arr.filter(i => i.created_by === 'import');
    }
    if (extraFilters.has('ai')) {
      arr = arr.filter(i => (i.created_by || 'ai') === 'ai');
    }
    if (extraFilters.has('mine')) {
      arr = arr.filter(i => i.created_by === 'user');
    }
    return arr;
  }, [data, timeOpen, sortedAsc, timeIdx, impMin, tagFilters, enabledTypes, extraFilters]);

  // ─────────── Web Worker 异步布局 ───────────
  // 物理计算放后台线程, 主线程不卡; worker 失败 fallback 到同步计算
  const workerRef = caR(null);
  const layoutCache = caR(new Map());      // 最近 8 个 cacheKey → { layout, links }
  const requestIdRef = caR(0);             // 防过期 worker 响应
  const pendingRequestRef = caR(null);     // 当前请求的 cacheKey (worker 回来时存进缓存用)
  const [layout, setLayout] = caS([]);
  const [links, setLinks] = caS([]);
  const [computing, setComputing] = caS(false);
  const [workerOk, setWorkerOk] = caS(true);

  // 创建 worker (只一次)
  caE(() => {
    if (typeof Worker === 'undefined') { setWorkerOk(false); return; }
    let w;
    try {
      w = new Worker('/v2/network/assets/layout-worker.js');
    } catch (e) {
      console.warn('[constellation] worker 创建失败, fallback 同步计算', e);
      setWorkerOk(false);
      return;
    }
    w.onmessage = (ev) => {
      const { layout: newLayout, links: newLinks, requestId, error } = ev.data;
      if (requestId !== requestIdRef.current) return;  // 过期响应
      if (error) {
        console.warn('[constellation] worker error:', error);
        setComputing(false);
        return;
      }
      // 缓存 (用 pendingRequestRef.current 拿到对应的 cacheKey)
      const ck = pendingRequestRef.current;
      if (ck) {
        layoutCache.current.set(ck, { layout: newLayout, links: newLinks });
        if (layoutCache.current.size > 8) {
          const firstKey = layoutCache.current.keys().next().value;
          layoutCache.current.delete(firstKey);
        }
      }
      setLayout(newLayout);
      setLinks(newLinks);
      setComputing(false);
    };
    w.onerror = (ev) => {
      console.warn('[constellation] worker fatal, fallback to sync:', ev.message);
      setWorkerOk(false);
    };
    workerRef.current = w;
    return () => { try { w.terminate(); } catch (_) {} };
  }, []);

  // 触发布局计算 (worker 异步 / 同步 fallback / 缓存命中直接返回)
  caE(() => {
    if (visibleItems.length === 0) {
      setLayout([]); setLinks([]); setComputing(false);
      return;
    }
    // 缓存键: mode + size + 排序后的 IDs
    const ids = visibleItems.map(i => i.id).sort().join(',');
    const cacheKey = mode + '|' + size.width + 'x' + size.height + '|' + ids;
    const cached = layoutCache.current.get(cacheKey);
    if (cached) {
      setLayout(cached.layout);
      setLinks(cached.links);
      setComputing(false);
      return;
    }
    requestIdRef.current++;
    pendingRequestRef.current = cacheKey;
    setComputing(true);
    if (workerOk && workerRef.current) {
      workerRef.current.postMessage({
        items: visibleItems,
        mode,
        width: size.width,
        height: size.height,
        requestId: requestIdRef.current,
      });
    } else {
      // worker 不可用 → 同步 fallback (老代码路径)
      try {
        const newLinks = buildLinks(visibleItems);
        const nodes = visibleItems.map(i => ({
          id: i.id, r: radiusOf(i), importance: i.importance,
          date: i.date, time: i.time,
          feel: i.feel, protected: i.protected, archived: i.archived, highlight: i.highlight,
        }));
        let newLayout;
        if (mode === 'time') newLayout = timeRingLayout(nodes, size.width, size.height);
        else if (mode === 'cluster' || mode === 'type') newLayout = clusterLayout(nodes, size.width, size.height);
        else newLayout = simulateLayout(nodes, newLinks, size.width, size.height);
        layoutCache.current.set(cacheKey, { layout: newLayout, links: newLinks });
        setLayout(newLayout);
        setLinks(newLinks);
        setComputing(false);
      } catch (e) {
        console.error('[constellation] 同步 fallback 失败', e);
        setComputing(false);
      }
    }
  }, [visibleItems, size, mode, workerOk]);

  // toggles
  const toggleType = (k) => setEnabledTypes(s => {
    const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n;
  });
  const toggleTag = (t) => setTagFilters(s => {
    const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n;
  });

  // 选中
  const selectedItem = selectedId ? data.find(i => i.id === selectedId) : null;

  const handleUpdate = async (id, patch) => {
    if (patch.__delete) {
      try {
        const r = await fetch('/api/bucket/' + encodeURIComponent(id) + '/delete', { method: 'POST' });
        if (!r.ok) throw new Error(await r.text());
        setSelectedId(null);
        await refreshFn();
      } catch (e) {
        alert('删除失败: ' + e.message);
      }
      return;
    }
    setData(prev => prev.map(x => x.id === id ? { ...x, ...patch } : x));
    try {
      await window.__obUpdateBucket(id, patch);
      await refreshFn();
    } catch (e) {
      alert('保存失败: ' + e.message + '\n(界面已回滚)');
      await refreshFn();
    }
  };

  const onResetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const onFocusIsland = (islands) => {
    if (islands.length === 0) return;
    setFocusedId(islands[0].id);
    setSelectedId(islands[0].id);
  };

  // 键盘
  caE(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'Escape') {
        if (selectedId) setSelectedId(null);
        else if (focusedId) setFocusedId(null);
        else if (searchQuery) setSearchQuery('');
      }
      if (e.key === '/') {
        e.preventDefault();
        document.querySelector('.cs-search input')?.focus();
      }
      if (e.key === '0') onResetView();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, focusedId, searchQuery]);

  // 用类型筛选 = enabledTypes（注意：enabledTypes 全开则不筛）
  const filteredTypes = caM(() => {
    if (enabledTypes.size === 4) return null;
    return enabledTypes;
  }, [enabledTypes]);

  // 统计顶栏
  const stats = caM(() => ({
    total: data.length,
    pinned: data.filter(i => i.protected).length,
    feel: data.filter(i => i.feel).length,
    internalized: data.filter(i => (i.tags || []).includes('已消化')).length,
  }), [data]);

  return (
    <div className="cs-root">
      {/* 顶栏：品牌 + 统计 / 搜索 / 暗夜 */}
      <header className="cs-topbar">
        <div className="cs-brand">
          <span className="cs-brand-mark" />
          <span className="cs-brand-name">Ombre Brain</span>
          <div className="cs-brand-stats">
            <span><b>{stats.total}</b> 格</span>
            <span><b>{stats.pinned}</b> 钉决</span>
            <span><b>{stats.feel}</b> feel</span>
            <span><b>{stats.internalized}</b> 已消化</span>
          </div>
        </div>
        <div className="cs-topbar-actions">
          {/* DarkToggle 暂隐, 等以后做"暗夜模式自动从主色派生"功能 (星图固定夜幕, 切换无意义) */}
        </div>
      </header>

      {/* 二级导航 tab */}
      <nav className="cs-nav">
        <a href="/v2/cells/">记忆格</a>
        <a href="/v2/">时间线</a>
        <a href="/v2/network/" className="on">记忆星图</a>
        <a href="/v2/console/import/">导入</a>
        <a href="/v2/console/breath/">Breath 模拟</a>
        <a href="/v2/console/config/">配置</a>
        <a href="/v2/console/trash/">回收站</a>
      </nav>

      {/* 页头：标题 + 副标题 + 计数 + 操作 */}
      <header className="cs-page-hd">
        <div className="cs-page-hd-l">
          <h1 className="cs-page-title">记忆星图</h1>
          <p className="cs-page-sub">
            记忆在这里自由连结，形成只属于你的星空。
          </p>
        </div>
        <div className="cs-page-hd-r">
          <div className="cs-page-counter">
            <b>{stats.total}</b> 颗星 · <b>{links.length}</b> 条连线
          </div>
        </div>
      </header>

      {/* 主区 */}
      <div className="cs-main" ref={containerRef}>
        {computing && (
          <div style={{
            position: 'absolute', top: 14, right: 14, zIndex: 50,
            padding: '6px 14px',
            background: 'rgba(20, 18, 32, 0.85)',
            color: 'rgba(255,255,255,0.85)',
            borderRadius: 999,
            font: '500 11px var(--mono, monospace)',
            letterSpacing: '0.06em',
            backdropFilter: 'blur(8px)',
            pointerEvents: 'none',
          }}>
            ◐ 排布中…
          </div>
        )}
        <StarCanvas
          items={visibleItems}
          links={links}
          layout={layout}
          width={size.width}
          height={size.height}
          selectedId={selectedId}
          focusId={focusedId}
          hoverId={hoverId}
          searchQuery={debouncedQuery}
          filteredTypes={filteredTypes}
          showLinks={t.showLinks !== false}
          showLabels={t.showLabels || 'smart'}
          linkOpacity={t.linkOpacity ?? 0.5}
          zoom={zoom}
          setZoom={setZoom}
          pan={pan}
          setPan={setPan}
          now={new Date()}
          onHover={setHoverId}
          onSelect={(id) => setSelectedId(id)}
          onBlur={() => { setSelectedId(null); }}
        />

        <LeftPanel
          items={data}
          links={links}
          layout={layout}
          mode={mode}
          setMode={setMode}
          enabledTypes={enabledTypes}
          toggleType={toggleType}
          extraFilters={extraFilters}
          toggleExtra={toggleExtra}
          tagFilters={tagFilters}
          toggleTag={toggleTag}
          impMin={impMin}
          setImpMin={setImpMin}
          searchQuery={debouncedQuery}
          onFocusIsland={onFocusIsland}
        />

        <RightDrawer
          item={selectedItem}
          items={data}
          links={links}
          onClose={() => setSelectedId(null)}
          onSelect={(id) => setSelectedId(id)}
          onUpdate={handleUpdate}
          onFocus={setFocusedId}
          focusedId={focusedId}
        />

        {focusedId && (
          <div className="cs-focus-hint">
            <span>聚焦于 <b>{(data.find(i => i.id === focusedId) || {}).title}</b> · 仅显示一跳关联</span>
            <button className="cs-focus-exit" onClick={() => setFocusedId(null)}>✕ 退出</button>
          </div>
        )}

        <BottomBar
          zoom={zoom}
          setZoom={setZoom}
          onReset={onResetView}
          focusedId={focusedId}
          onClearFocus={() => setFocusedId(null)}
          mode={mode}
          setMode={setMode}
          timeOpen={timeOpen}
          setTimeOpen={setTimeOpen}
        />

        {timeOpen && (
          <TimeBar
            items={data}
            value={timeIdx}
            onChange={setTimeIdx}
            rightOpen={!!selectedItem}
            onClose={() => setTimeOpen(false)}
          />
        )}
      </div>

      <TweaksPanel>
        <TweakSection label="星图视觉" />
        <TweakToggle label="显示连线" value={t.showLinks !== false} onChange={(v) => setTweak('showLinks', v)} />
        <TweakSlider label="连线透明度" min={0.1} max={1} step={0.05} value={t.linkOpacity ?? 0.5} onChange={(v) => setTweak('linkOpacity', v)} />
        <TweakRadio label="标签显示" options={[['smart','智能'],['all','全部'],['none','无']]} value={t.showLabels || 'smart'} onChange={(v) => setTweak('showLabels', v)} />
        <TweakSection label="配色" />
        <TweakColor label="主紫 accent" value={t.accent} onChange={(v) => { setTweak('accent', v); document.documentElement.style.setProperty('--c-accent', v); }} />
        <TweakColor label="情感粉 feel" value={t.feelColor} onChange={(v) => { setTweak('feelColor', v); document.documentElement.style.setProperty('--c-rose', v); }} />
        <TweakColor label="永久金 permanent" value={t.goldColor} onChange={(v) => { setTweak('goldColor', v); document.documentElement.style.setProperty('--c-gold', v); }} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<ConstellationApp />);
