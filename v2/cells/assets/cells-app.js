// cells-app.jsx —— 记忆格页面顶层

const { useState: cAS, useEffect: cAE, useMemo: cAM, useRef: cAR } = React;

function CellsApp() {
  const [t, setTweak] = useTweaks(window.TWEAK_DEFAULTS);
  const [data, setData] = cAS([]);
  const [loading, setLoading] = cAS(true);
  const [loadError, setLoadError] = cAS(null);
  const [openItem, setOpenItem] = cAS(null);
  const [dark, setDark] = cAS(t.dark || false);
  const [writeOpen, setWriteOpen] = cAS(false);
  const [writeTags, setWriteTags] = cAS([]);
  const [flashId, setFlashId] = cAS(null);

  cAE(() => {
    if (window.OB_THEME) window.OB_THEME.setDarkMode(dark);
    else document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }, [dark]);

  // 拉真实数据
  const refresh = async () => {
    try {
      setLoadError(null);
      const rows = await window.__obFetchBuckets();
      setData(rows);
      setLoading(false);
    } catch (e) {
      console.error('[ombre v2 cells] load failed', e);
      setLoadError(e.message || String(e));
      setLoading(false);
    }
  };
  cAE(() => { refresh(); }, []);

  const sortedAll = cAM(() =>
    [...data].sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)),
    [data]
  );

  const handleNavigate = (delta) => {
    if (!openItem) return;
    const idx = sortedAll.findIndex(i => i.id === openItem.id);
    const next = idx + delta;
    if (next >= 0 && next < sortedAll.length) {
      setOpenItem(sortedAll[next]);
    }
  };

  // 更新单条记忆(可处理删除、标记等) — 接真实 API
  const handleUpdate = async (id, patch) => {
    if (patch.__delete) {
      // 真实删除走 /api/bucket/:id/delete
      try {
        const r = await fetch('/api/bucket/' + encodeURIComponent(id) + '/delete', { method: 'POST' });
        if (!r.ok) throw new Error(await r.text());
        await refresh();
      } catch (e) {
        alert('删除失败: ' + e.message);
      }
      return;
    }
    // 乐观更新
    setData(prev => prev.map(x => x.id === id ? { ...x, ...patch } : x));
    setOpenItem(prev => prev && prev.id === id ? { ...prev, ...patch } : prev);
    try {
      await window.__obUpdateBucket(id, patch);
      await refresh();
    } catch (e) {
      alert('保存失败: ' + e.message + '\n(界面已回滚)');
      await refresh();
    }
  };

  // 新建
  const handleCreate = (preset) => {
    setWriteTags(preset?.tags || []);
    setWriteOpen(true);
  };

  const handleSave = async (entry) => {
    try {
      const res = await window.__obCreateBucket(entry);
      setWriteOpen(false);
      await refresh();
      const id = res?.id;
      if (id) {
        setFlashId(id);
        setTimeout(() => setFlashId(null), 1600);
        setTimeout(() => {
          const el = document.querySelector(`[data-cell-id="${id}"]`);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 200);
      }
    } catch (e) {
      alert('写入失败: ' + e.message);
    }
  };

  // 打开 modal — lazy-load 完整 body
  const openItemWithBody = async (it) => {
    if (it.body || it._bodyLoaded) { setOpenItem(it); return; }
    setOpenItem({ ...it, body: '⌛ 加载完整内容…', _loading: true });
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
      setData(prev => prev.map(x => x.id === it.id ? merged : x));
    } catch (e) {
      console.error('[ombre v2 cells] detail load failed', e);
      setOpenItem(prev => prev && prev.id === it.id ? { ...prev, body: '(加载失败)', _loading: false } : prev);
    }
  };

  // 把 flashId 传给 CellsView：通过 key 注入到全局比较麻烦，改用 ref 共享
  cAE(() => {
    window.__cellsFlashId = flashId;
    window.dispatchEvent(new CustomEvent('ob-cells-flash', { detail: flashId }));
  }, [flashId]);

  return (
    <div className={`ob-shape-${t.nodeShape || 'circle'}`}>
      <TopBarV2 dark={dark} onDark={(v) => { setDark(v); setTweak('dark', v); }} compact data={data} />
      <NavBarV2 active="cells" />
      {loading && (
        <div style={{padding:'14px 18px',margin:'16px 24px 0',background:'rgba(110,79,154,0.08)',border:'1px solid rgba(110,79,154,0.2)',borderRadius:10,color:'#6e4f9a',fontSize:13}}>
          正在加载真实记忆 …
        </div>
      )}
      {loadError && (
        <div style={{padding:'14px 18px',margin:'16px 24px 0',background:'rgba(139,74,74,0.08)',border:'1px solid rgba(139,74,74,0.3)',borderRadius:10,color:'#8B4A4A',fontSize:13}}>
          加载失败:{loadError} · <a onClick={refresh} style={{cursor:'pointer',textDecoration:'underline'}}>重试</a>
        </div>
      )}
      <CellsView
        items={data}
        todayDate={(() => {
          const d = new Date();
          const pad = n => String(n).padStart(2, '0');
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        })()}
        flashId={flashId}
        onOpenItem={(it) => openItemWithBody(it)}
        onUpdateItem={handleUpdate}
        onCreateItem={handleCreate}
      />

      {openItem && (
        <ItemModal
          item={openItem}
          allItems={data}
          onClose={() => setOpenItem(null)}
          onNavigate={handleNavigate}
          onOpenItem={(it) => openItemWithBody(it)}
          onUpdate={handleUpdate}
        />
      )}

      <WriteDrawer
        open={writeOpen}
        onClose={() => setWriteOpen(false)}
        onSave={handleSave}
        defaultDate="2026-04-26"
        defaultTime="23:30"
        defaultTags={writeTags}
      />

      <Fab />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<CellsApp />);
