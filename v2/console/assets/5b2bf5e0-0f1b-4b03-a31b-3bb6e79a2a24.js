// console-app.jsx —— 控制台主入口(路径路由) — 真实数据接入版

const { useState: cAS, useEffect: cAE, useMemo: cAM } = React;

// 路径路由:/v2/console/breath/ → 'breath' 等
// 兼容老 hash: 如果 URL 还带 #breath 等也能识别(从老书签过来)
function routeFromUrl() {
  const path = window.location.pathname.replace(/\/+$/, '');  // 去尾斜杠
  if (path.endsWith('/v2/console/breath')) return 'breath';
  if (path.endsWith('/v2/console/config')) return 'config';
  if (path.endsWith('/v2/console/import')) return 'import';
  if (path.endsWith('/v2/console/trash')) return 'trash';
  const h = window.location.hash;
  if (h === '#breath') return 'breath';
  if (h === '#config') return 'config';
  if (h === '#import') return 'import';
  if (h === '#trash') return 'trash';
  return 'breath';
}

function ConsoleApp() {
  const [t, setTweak] = useTweaks(window.TWEAK_DEFAULTS);
  const [route, setRoute] = cAS(routeFromUrl());
  const [search, setSearch] = cAS('');
  const [dark, setDark] = cAS(t.dark || false);
  // 真实数据
  const [data, setData] = cAS([]);
  const [loading, setLoading] = cAS(true);
  const [loadError, setLoadError] = cAS(null);

  cAE(() => {
    const sync = () => {
      // 老 #network 兼容:跳到独立星图
      if (window.location.hash === '#network') {
        window.location.href = '/v2/network/';
        return;
      }
      setRoute(routeFromUrl());
    };
    window.addEventListener('popstate', sync);
    window.addEventListener('pageshow', sync);
    window.addEventListener('hashchange', sync);  // 兼容老 hash 链接
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('pageshow', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);


  cAE(() => {
    if (window.OB_THEME) window.OB_THEME.setDarkMode(dark);
    else document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    setTweak('dark', dark);
  }, [dark]);

  // 回收站桶数(给 nav 角标用)
  const [trashCount, setTrashCount] = cAS(0);
  const refreshTrashCount = async () => {
    try {
      const r = await fetch('/api/trash');
      if (!r.ok) return;
      const d = await r.json();
      setTrashCount(d.count || 0);
    } catch (e) { /* 沉默 */ }
  };
  cAE(() => { refreshTrashCount(); }, []);

  // 拉真实数据
  const refresh = async () => {
    try {
      setLoadError(null);
      const rows = await window.__obFetchBuckets();
      setData(rows);
      window.MEMORY_DATA = rows;
      setLoading(false);
    } catch (e) {
      console.error('[console] load failed', e);
      setLoadError(e.message || String(e));
      setLoading(false);
    }
  };
  cAE(() => { refresh(); }, []);

  const stats = cAM(() => computeStats(data), [data]);

  return (
    <div>
      <ConsoleTopBar
        stats={stats}
        dark={dark}
        onDark={setDark}
        search={search}
        setSearch={setSearch}
      />
      <ConsoleNav active={route} trashCount={trashCount} />

      {loading && (
        <div style={{margin:'18px 28px 0',padding:'14px 18px',background:'rgba(110,79,154,0.08)',border:'1px solid rgba(110,79,154,0.2)',borderRadius:10,color:'#6e4f9a',fontSize:13}}>
          正在加载真实记忆 …
        </div>
      )}
      {loadError && (
        <div style={{margin:'18px 28px 0',padding:'14px 18px',background:'rgba(139,74,74,0.08)',border:'1px solid rgba(139,74,74,0.3)',borderRadius:10,color:'#8B4A4A',fontSize:13}}>
          加载失败:{loadError} · <a onClick={refresh} style={{cursor:'pointer',textDecoration:'underline'}}>重试</a>
        </div>
      )}

      {route === 'breath' && <BreathPage items={data} />}
      {route === 'config' && <ConfigPage />}
      {route === 'import' && <ImportWorkbench />}
      {route === 'trash' && window.TrashPage && React.createElement(window.TrashPage, { onCountChange: setTrashCount })}

      <TweaksPanel>
        <TweakSection label="控制台" />
        <TweakToggle label="暗夜模式" value={dark} onChange={setDark} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<ConsoleApp />);
