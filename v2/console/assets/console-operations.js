// console-operations.jsx — deployment, OAuth, tunnel and safe update controls

const { useState: opS, useEffect: opE } = React;

async function opJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function OpMessage({ error, message }) {
  if (!error && !message) return null;
  return <div style={{padding:'10px 12px',margin:'10px 0',borderRadius:9,fontSize:12.5,
    background:error?'rgba(154,97,93,.09)':'rgba(74,124,89,.09)',color:error?'#9A615D':'#4A7C59'}}>{error || message}</div>;
}

function OperationsPage() {
  const [state,setState]=opS(null); const [busy,setBusy]=opS('');
  const [error,setError]=opS(''); const [message,setMessage]=opS(''); const [update,setUpdate]=opS(null);
  const [form,setForm]=opS({public_base_url:'',mcp_auth_mode:'admin',tunnel_autostart:false,dream_hook_enabled:true});
  const [testDelete,setTestDelete]=opS({bucket_id:'',delete_reason:''});
  const load=async()=>{try{const d=await opJson('/api/system/status');setState(d);const o=d.onboarding||{};setForm({public_base_url:o.public_base_url||'',mcp_auth_mode:o.mcp_auth_mode||'admin',tunnel_autostart:!!o.tunnel_autostart,dream_hook_enabled:!!o.dream_hook_enabled});}catch(e){setError(e.message);}};
  opE(()=>{load();},[]);
  opE(()=>{if(!state?.tunnel?.running||state?.tunnel?.url)return;const timer=setInterval(async()=>{try{const tunnelState=await opJson('/api/tunnel');setState(cur=>({...cur,tunnel:tunnelState}));}catch(e){}},2000);return()=>clearInterval(timer);},[state?.tunnel?.running,state?.tunnel?.url]);
  const run=async(name,fn)=>{setBusy(name);setError('');setMessage('');try{const d=await fn();setMessage('操作已完成');await load();return d;}catch(e){setError(e.message);}finally{setBusy('');}};
  const save=()=>run('save',()=>opJson('/api/onboarding/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(form)}));
  const tunnel=action=>run('tunnel-'+action,()=>opJson('/api/tunnel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})}));
  const check=()=>run('check',async()=>{const d=await opJson('/api/system/update-check');setUpdate(d);return d;});
  const stage=()=>run('stage',()=>opJson('/api/system/update-stage',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}));
  const apply=()=>{if(prompt('这会用已暂存版本替换程序文件，但保留记忆、config.yaml 和 .env。输入 APPLY_STAGED_UPDATE 继续：')!=='APPLY_STAGED_UPDATE')return;run('apply',()=>opJson('/api/system/update-apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation:'APPLY_STAGED_UPDATE'})}));};
  const restart=()=>{if(prompt('服务会退出并交给 Docker/平台重启。输入 RESTART_OMBRE_BRAIN 继续：')!=='RESTART_OMBRE_BRAIN')return;run('restart',()=>opJson('/api/system/restart',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation:'RESTART_OMBRE_BRAIN'})}));};
  const hardDelete=()=>{if(!testDelete.bucket_id.trim()||!testDelete.delete_reason.trim())return;run('hard-delete',async()=>{const d=await opJson('/api/developer/hard-delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(testDelete)});setTestDelete({bucket_id:'',delete_reason:''});return d;});};
  if(!state)return <main style={{padding:28}}>正在读取运行状态…<OpMessage error={error}/></main>;
  const o=state.onboarding||{};const t=state.tunnel||{};const checks=o.checks||[];const q=state.quotas||{};
  const field={width:'100%',boxSizing:'border-box',padding:'9px 11px',border:'1px solid var(--line)',borderRadius:8,background:'var(--paper)',color:'var(--ink)'};
  const btn={padding:'8px 12px',border:'1px solid var(--line)',borderRadius:8,background:'var(--paper-2)',color:'var(--ink-2)',cursor:'pointer'};
  return <main className="op-page" style={{padding:'0 28px 48px',maxWidth:1060,margin:'0 auto'}}><style>{`@media(max-width:760px){.op-page{padding:0 14px 36px!important}.op-grid{grid-template-columns:1fr!important}}`}</style>
    <ConsolePageHd title="部署与连接" sub="OAuth、Cloudflare Tunnel、运行自检和可回滚的自更新" />
    <OpMessage error={error} message={message}/>
    <div className="op-grid" style={{display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gap:14,alignItems:'start'}}>
      <ConsoleCard label="运行自检" sub={o.ready?'核心条件已就绪':'仍有核心条件未配置'}>
        <div style={{display:'grid',gap:8}}>{checks.map(c=><div key={c.id} style={{display:'flex',gap:9,alignItems:'center',fontSize:12.5}}><span style={{color:c.ok?'#4A7C59':'#9A615D'}}>{c.ok?'●':'○'}</span><span>{c.label}{c.recommended?'（推荐）':''}</span></div>)}</div>
        <div style={{fontSize:11.5,color:'var(--ink-3)',marginTop:12}}>配额：钉选 {q.pinned?.count||0}/{q.pinned?.limit||'∞'} · 高重要度 {q.high_importance?.count||0}/{q.high_importance?.limit||'∞'}</div>
        <div style={{fontSize:11.5,color:'var(--ink-3)',marginTop:12,lineHeight:1.7}}>管理员 Token 和备份 Token 仍只从环境变量读取，不会被网页保存。</div>
      </ConsoleCard>
      <ConsoleCard label="远程 MCP 鉴权" sub="admin 保持兼容；OAuth 使用 PKCE + 刷新令牌轮换">
        <div style={{display:'grid',gap:9}}><select style={field} value={form.mcp_auth_mode} onChange={e=>setForm({...form,mcp_auth_mode:e.target.value})}><option value="admin">管理员 Token / URL Key</option><option value="oauth">OAuth 2.1（推荐给支持 OAuth 的客户端）</option></select><input style={field} value={form.public_base_url} placeholder="https://你的公开域名" onChange={e=>setForm({...form,public_base_url:e.target.value})}/><label style={{fontSize:12}}><input type="checkbox" checked={form.dream_hook_enabled} onChange={e=>setForm({...form,dream_hook_enabled:e.target.checked})}/> 保留 dream-hook 兼容入口</label><label style={{fontSize:12}}><input type="checkbox" checked={form.tunnel_autostart} onChange={e=>setForm({...form,tunnel_autostart:e.target.checked})}/> 服务启动时自动拉起 Tunnel</label><button style={btn} disabled={!!busy} onClick={save}>保存连接设置</button></div>
      </ConsoleCard>
      <ConsoleCard label="Cloudflare Quick Tunnel" sub={t.running?(t.url||'正在等待公网地址'):(t.binary_available?'已停止':'未发现 cloudflared')}>
        {t.url&&<a href={t.url} target="_blank" rel="noreferrer" style={{fontFamily:'var(--mono)',fontSize:12,wordBreak:'break-all'}}>{t.url}</a>}<div style={{display:'flex',gap:8,marginTop:12}}><button style={btn} disabled={!!busy||t.running} onClick={()=>tunnel('start')}>启动</button><button style={btn} disabled={!!busy||!t.running} onClick={()=>tunnel('stop')}>停止</button></div>{!t.binary_available&&<div style={{fontSize:11.5,color:'var(--ink-3)',marginTop:10}}>安装 cloudflared，或设置 OMBRE_CLOUDFLARED_PATH 后即可使用。</div>}
      </ConsoleCard>
      <ConsoleCard label="安全自更新" sub="默认源是你的 folio 仓库；先暂存并编译，再备份代码后应用">
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}><button style={btn} disabled={!!busy} onClick={check}>检查更新</button><button style={btn} disabled={!!busy||!o.self_update_enabled} onClick={stage}>下载并暂存</button><button style={btn} disabled={!!busy||!o.self_update_enabled||!state.staged_update?.sha256} onClick={apply}>应用暂存版本</button><button style={btn} disabled={!!busy||!o.restart_enabled} onClick={restart}>重启服务</button></div>{update&&<div style={{fontSize:11.5,color:'var(--ink-3)',marginTop:10,lineHeight:1.7}}>本地 {String(update.local_revision).slice(0,10)} · 远端 {String(update.remote_revision).slice(0,10)} · {update.update_available?'有新版本':'已对齐'}</div>}{!o.self_update_enabled&&<div style={{fontSize:11.5,color:'var(--ink-3)',marginTop:10}}>为防误覆盖，应用更新需显式设置 OMBRE_ENABLE_SELF_UPDATE=1；重启同理需 OMBRE_ENABLE_RESTART=1。</div>}
      </ConsoleCard>
      <ConsoleCard label="开发测试数据清理" sub="只允许物理删除创建时就带不可变 test provenance 的桶">
        <div style={{display:'grid',gap:8}}><input style={field} value={testDelete.bucket_id} placeholder="测试桶 ID" onChange={e=>setTestDelete({...testDelete,bucket_id:e.target.value})}/><input style={field} value={testDelete.delete_reason} maxLength="500" placeholder="删除原因（必填，会进入审计日志）" onChange={e=>setTestDelete({...testDelete,delete_reason:e.target.value})}/><button style={btn} disabled={!!busy||!testDelete.bucket_id.trim()||!testDelete.delete_reason.trim()} onClick={hardDelete}>硬删除已验证的测试桶</button></div>
      </ConsoleCard>
    </div>
  </main>;
}

window.OperationsPage=OperationsPage;
