// console-safety.jsx — GitHub backup verification and merge-only restore console

const { useState: safetyState, useEffect: safetyEffect } = React;

function SafetyPage() {
  const [status, setStatus] = safetyState(null);
  const [preview, setPreview] = safetyState(null);
  const [result, setResult] = safetyState(null);
  const [busy, setBusy] = safetyState('');
  const [error, setError] = safetyState('');

  const readJson = async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
    return data;
  };
  const refreshStatus = async () => {
    try { setStatus(await readJson(await fetch('/api/backup/status'))); }
    catch (e) { setError(e.message || String(e)); }
  };
  safetyEffect(() => { refreshStatus(); }, []);

  const runBackup = async () => {
    setBusy('backup'); setError(''); setResult(null);
    try {
      setResult(await readJson(await fetch('/api/backup', { method: 'POST' })));
      await refreshStatus();
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(''); }
  };
  const inspectRestore = async () => {
    setBusy('preview'); setError(''); setResult(null); setPreview(null);
    try {
      setPreview(await readJson(await fetch('/api/backup/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commit: false }),
      })));
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(''); }
  };
  const applyRestore = async () => {
    if (!preview || !preview.integrity_verified) return;
    if (!window.confirm(
      `将从已验证备份合并恢复 ${preview.bucket_count} 条记忆。\n` +
      `新增 ${preview.new}，覆盖 ${preview.overwrite}，不变 ${preview.unchanged}。\n\n` +
      `附件 ${preview.media_count || 0} 个（新增 ${preview.media_new || 0}，已有 ${preview.media_unchanged || 0}）。\n\n` +
      '恢复前会自动保存本地 ZIP；本地独有记忆不会删除。继续吗？'
    )) return;
    setBusy('restore'); setError(''); setResult(null);
    try {
      setResult(await readJson(await fetch('/api/backup/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commit: true, confirm: 'RESTORE' }),
      })));
      setPreview(null); await refreshStatus();
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(''); }
  };
  const badge = (ok, yes, no) => (
    <span style={{color: ok ? '#4A7C59' : '#9A615D', fontFamily:'var(--mono)', fontSize:12}}>
      {ok ? '● ' + yes : '○ ' + no}
    </span>
  );

  return (
    <main style={{padding:'0 28px 48px', maxWidth:1050, margin:'0 auto'}}>
      <ConsolePageHd title="数据安全" sub="先验证，再恢复；不删除本地独有记忆" />
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))',gap:14}}>
        <ConsoleCard label="远端备份" sub="GitHub 私有仓库">
          <div style={{display:'grid',gap:9}}>
            {status ? badge(status.backup_configured, '已配置', '未配置环境变量') : '检查中…'}
            {status ? badge(status.admin_protected, '管理员保护已开启', '缺少管理员保护') : null}
            <button className="obx-btn-primary" disabled={!!busy || !(status && status.backup_configured)} onClick={runBackup}>
              {busy === 'backup' ? '正在备份…' : '立即备份'}
            </button>
          </div>
        </ConsoleCard>
        <ConsoleCard label="验证与恢复" sub="默认只预览，不会改本地文件">
          <div style={{display:'grid',gap:9}}>
            <div style={{fontSize:12.5,color:'var(--ink-3)',lineHeight:1.7}}>恢复方式：合并覆盖同路径文件；本地独有文件保留。</div>
            <button className="obx-btn-primary" disabled={!!busy || !(status && status.backup_configured)} onClick={inspectRestore}>
              {busy === 'preview' ? '正在下载并校验…' : '检查 GitHub 备份'}
            </button>
          </div>
        </ConsoleCard>
      </div>
      {error && <div className="obx-sim-err" style={{marginTop:16}}>操作失败：{error}</div>}
      {preview && (
        <ConsoleCard label="校验通过" sub={`共 ${preview.bucket_count} 条 Markdown 记忆、${preview.media_count || 0} 个附件`} accent="#4A7C59">
          <div style={{display:'flex',gap:18,flexWrap:'wrap',fontFamily:'var(--mono)',fontSize:12.5,marginBottom:14}}>
            <span>新增 <b>{preview.new}</b></span><span>覆盖 <b>{preview.overwrite}</b></span><span>不变 <b>{preview.unchanged}</b></span>
            <span>附件新增 <b>{preview.media_new || 0}</b></span><span>附件已有 <b>{preview.media_unchanged || 0}</b></span>
          </div>
          <div style={{maxHeight:220,overflow:'auto',fontFamily:'var(--mono)',fontSize:11.5,lineHeight:1.8,color:'var(--ink-3)'}}>
            {(preview.sample || []).map(item => <div key={item.path}>{item.status.padEnd(9)} {item.path}</div>)}
          </div>
          <button className="obx-btn-primary" style={{marginTop:14}} disabled={!!busy} onClick={applyRestore}>
            {busy === 'restore' ? '正在创建本地备份并恢复…' : '合并恢复这份备份'}
          </button>
        </ConsoleCard>
      )}
      {result && (
        <ConsoleCard label="操作完成">
          <pre style={{whiteSpace:'pre-wrap',fontSize:11.5,lineHeight:1.65,color:'var(--ink-2)',margin:0}}>{JSON.stringify(result, null, 2)}</pre>
        </ConsoleCard>
      )}
      <ConsoleCard label="本地后悔药" sub="每次正式恢复前自动生成 ZIP">
        {status && status.local_safety_backups && status.local_safety_backups.length
          ? status.local_safety_backups.map(name => <div key={name} style={{fontFamily:'var(--mono)',fontSize:11.5,lineHeight:1.9}}>{name}</div>)
          : <div style={{fontSize:12.5,color:'var(--ink-3)'}}>还没有执行过正式恢复。</div>}
      </ConsoleCard>
    </main>
  );
}

window.SafetyPage = SafetyPage;
