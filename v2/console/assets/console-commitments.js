// console-commitments.jsx — plans, letters, anchors and identity in one workspace

const { useState: cmS, useEffect: cmE } = React;

async function cmJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
  return data;
}

const cmField = {
  width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 9,
  border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)',
  fontFamily: 'inherit', fontSize: 13,
};
const cmButton = {
  border: '1px solid var(--line)', background: 'var(--paper-2)', color: 'var(--ink-2)',
  padding: '7px 11px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
};

function CmNotice({ error, text }) {
  if (!error && !text) return null;
  return <div style={{margin:'12px 0',padding:'10px 12px',borderRadius:9,fontSize:12.5,
    color:error?'#9A615D':'#4A7C59',background:error?'rgba(154,97,93,.09)':'rgba(74,124,89,.09)'}}>{error || text}</div>;
}

function PlansPane() {
  const [data, setData] = cmS({active:[],resolved:[],abandoned:[],total:0});
  const [draft, setDraft] = cmS({content:'',weight:.5,why_remembered:'',related_bucket:''});
  const [busy, setBusy] = cmS('');
  const [error, setError] = cmS('');
  const load = async () => { try { setData(await cmJson('/api/plans')); } catch(e) { setError(e.message); } };
  cmE(() => { load(); }, []);
  const create = async () => {
    if (!draft.content.trim()) return;
    setBusy('create'); setError('');
    try {
      await cmJson('/api/plans', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft)});
      setDraft({content:'',weight:.5,why_remembered:'',related_bucket:''}); await load();
    } catch(e) { setError(e.message); } finally { setBusy(''); }
  };
  const act = async (id, action) => {
    setBusy(id + action); setError('');
    try { await cmJson(`/api/plans/${encodeURIComponent(id)}/action`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})}); await load(); }
    catch(e) { setError(e.message); } finally { setBusy(''); }
  };
  const edit = async item => {
    const content = prompt('修改计划正文', item.content);
    if (content === null) return;
    const weightRaw = prompt('承诺重量（0 到 1）', String(item.weight ?? .5));
    if (weightRaw === null) return;
    setBusy(item.id + 'edit'); setError('');
    try {
      await cmJson(`/api/plans/${encodeURIComponent(item.id)}/action`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'edit',content,weight:Number(weightRaw),why_remembered:item.why_remembered || '',related_bucket:item.related_bucket || ''})});
      await load();
    } catch(e) { setError(e.message); } finally { setBusy(''); }
  };
  const column = (key, label, color) => (
    <section style={{minWidth:0}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:9}}>
        <strong style={{fontSize:13,color}}>{label}</strong><span style={{fontFamily:'var(--mono)',fontSize:11,color:'var(--ink-3)'}}>{data[key].length}</span>
      </div>
      <div style={{display:'grid',gap:9}}>{data[key].map(item => <article key={item.id} style={{padding:13,border:'1px solid var(--line)',borderRadius:10,background:'var(--paper)'}}>
        <div style={{fontSize:13.5,lineHeight:1.65,whiteSpace:'pre-wrap'}}>{item.content}</div>
        {item.why_remembered && <div style={{fontSize:11.5,color:'var(--ink-3)',marginTop:7}}>为什么：{item.why_remembered}</div>}
        <div style={{display:'flex',justifyContent:'space-between',gap:8,marginTop:10,alignItems:'center'}}>
          <span style={{fontFamily:'var(--mono)',fontSize:10.5,color:'var(--ink-3)'}}>weight {Number(item.weight ?? .5).toFixed(2)}</span>
          <span style={{display:'flex',gap:5,flexWrap:'wrap',justifyContent:'flex-end'}}>
            <button style={cmButton} onClick={() => edit(item)}>编辑</button>
            {key === 'active' && <button style={cmButton} onClick={() => act(item.id,'resolve')}>完成</button>}
            {key === 'active' && <button style={cmButton} onClick={() => act(item.id,'abandon')}>放弃</button>}
            {key !== 'active' && <button style={cmButton} onClick={() => act(item.id,'reopen')}>重开</button>}
          </span>
        </div>
      </article>)}</div>
    </section>
  );
  return <div>
    <ConsoleCard label="登记一个承诺" sub="计划不会衰减，也不会混进普通 breath">
      <div style={{display:'grid',gap:9}}>
        <textarea rows="3" style={cmField} value={draft.content} placeholder="我答应过、想完成或还没有闭环的事…" onChange={e=>setDraft({...draft,content:e.target.value})}/>
        <div style={{display:'grid',gridTemplateColumns:'minmax(150px,1fr) minmax(150px,1fr)',gap:9}}>
          <input style={cmField} value={draft.why_remembered} placeholder="为什么要记住（可选）" onChange={e=>setDraft({...draft,why_remembered:e.target.value})}/>
          <input style={cmField} value={draft.related_bucket} placeholder="关联记忆 ID（可选）" onChange={e=>setDraft({...draft,related_bucket:e.target.value})}/>
        </div>
        <label style={{fontSize:12,color:'var(--ink-3)'}}>承诺重量 {Number(draft.weight).toFixed(2)}<input style={{width:'100%'}} type="range" min="0" max="1" step="0.05" value={draft.weight} onChange={e=>setDraft({...draft,weight:Number(e.target.value)})}/></label>
        <button className="obx-btn-primary" disabled={!!busy || !draft.content.trim()} onClick={create}>{busy==='create'?'登记中…':'登记计划'}</button>
      </div>
    </ConsoleCard>
    <CmNotice error={error}/>
    <div className="cm-plan-grid" style={{display:'grid',gap:14,alignItems:'start'}}>
      {column('active','进行中','#6e4f9a')}{column('resolved','已完成','#4A7C59')}{column('abandoned','已放弃','#8A8178')}
    </div>
  </div>;
}

function LettersPane() {
  const [letters, setLetters] = cmS([]);
  const [draft, setDraft] = cmS({author:'user',title:'',date:'',content:''});
  const [busy, setBusy] = cmS(''); const [error,setError]=cmS('');
  const load = async () => { try { setLetters((await cmJson('/api/letters')).letters || []); } catch(e) { setError(e.message); } };
  cmE(()=>{load();},[]);
  const create = async () => { setBusy('create');setError('');try{await cmJson('/api/letters',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft)});setDraft({author:'user',title:'',date:'',content:''});await load();}catch(e){setError(e.message);}finally{setBusy('');} };
  const edit = async letter => {
    const title=prompt('标题',letter.title||''); if(title===null)return;
    const content=prompt('信件正文',letter.content||''); if(content===null)return;
    try{await cmJson(`/api/letters/${encodeURIComponent(letter.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,content})});await load();}catch(e){setError(e.message);}
  };
  const remove = async letter => { if(!confirm(`把「${letter.title||letter.id}」移入回收站？`))return;try{await cmJson(`/api/letters/${encodeURIComponent(letter.id)}?confirm=true`,{method:'DELETE'});await load();}catch(e){setError(e.message);} };
  return <div className="cm-split-grid" style={{display:'grid',gap:14,alignItems:'start'}}>
    <ConsoleCard label="写一封信" sub="逐字保存，不合并、不压缩">
      <div style={{display:'grid',gap:9}}>
        <select style={cmField} value={draft.author} onChange={e=>setDraft({...draft,author:e.target.value})}><option value="user">用户写的</option><option value="ai">AI 写的</option></select>
        <input style={cmField} value={draft.title} placeholder="标题（可选）" onChange={e=>setDraft({...draft,title:e.target.value})}/>
        <input style={cmField} type="date" value={draft.date} onChange={e=>setDraft({...draft,date:e.target.value})}/>
        <textarea rows="9" style={cmField} value={draft.content} placeholder="信件正文…" onChange={e=>setDraft({...draft,content:e.target.value})}/>
        <button className="obx-btn-primary" disabled={!!busy||!draft.content.trim()} onClick={create}>{busy?'保存中…':'保存这封信'}</button>
        <CmNotice error={error}/>
      </div>
    </ConsoleCard>
    <div style={{display:'grid',gap:10}}>{letters.map(letter=><article key={letter.id} style={{padding:16,border:'1px solid var(--line)',borderRadius:11,background:'var(--paper)'}}>
      <div style={{display:'flex',justifyContent:'space-between',gap:10}}><div><strong>{letter.title||'未命名的信'}</strong><div style={{fontSize:11.5,color:'var(--ink-3)',marginTop:3}}>{letter.author} · {letter.date}</div></div><div style={{display:'flex',gap:5}}><button style={cmButton} onClick={()=>edit(letter)}>编辑</button><button style={cmButton} onClick={()=>remove(letter)}>归档</button></div></div>
      <div style={{marginTop:12,fontSize:13,lineHeight:1.8,whiteSpace:'pre-wrap'}}>{letter.content}</div>
    </article>)}</div>
  </div>;
}

function AnchorsPane({ items }) {
  const [state,setState]=cmS({anchors:[],count:0,limit:24}); const [q,setQ]=cmS(''); const [error,setError]=cmS('');
  const load=async()=>{try{setState(await cmJson('/api/anchors'));}catch(e){setError(e.message);}}; cmE(()=>{load();},[]);
  const toggle=async(id,value)=>{try{await cmJson(`/api/bucket/${encodeURIComponent(id)}/anchor`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({anchor:value})});await load();}catch(e){setError(e.message);}};
  const current=new Set((state.anchors||[]).map(a=>a.id));
  const matches=(items||[]).filter(item=>!current.has(item.id)&&item.type!=='trashed'&&(!q.trim()||`${item.title||item.name||''} ${(item.tags||[]).join(' ')} ${item.summary||''}`.toLowerCase().includes(q.trim().toLowerCase()))).slice(0,20);
  return <div><ConsoleCard label={`坐标系 ${state.count}/${state.limit}`} sub="anchor 不主动挤进上下文，但手动搜索仍然可达">
    <input style={cmField} value={q} placeholder="搜索一条记忆并设为 anchor…" onChange={e=>setQ(e.target.value)}/><CmNotice error={error}/>
    {q&&<div style={{display:'grid',gap:7,marginTop:10}}>{matches.map(item=><div key={item.id} style={{display:'flex',justifyContent:'space-between',gap:10,padding:'9px 11px',border:'1px solid var(--line)',borderRadius:9}}><span style={{fontSize:12.5}}>{item.title||item.name||item.id}</span><button style={cmButton} onClick={()=>toggle(item.id,true)}>设为 anchor</button></div>)}</div>}
  </ConsoleCard><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))',gap:10}}>{(state.anchors||[]).map(item=><article key={item.id} style={{padding:14,border:'1px solid var(--line)',borderRadius:10,background:'var(--paper)'}}><strong style={{fontSize:13}}>{item.name}</strong><div style={{fontSize:12,color:'var(--ink-3)',lineHeight:1.7,margin:'7px 0 10px'}}>{item.content_preview}</div><button style={cmButton} onClick={()=>toggle(item.id,false)}>解除 anchor</button></article>)}</div></div>;
}

function IdentityPane() {
  const [entries,setEntries]=cmS([]);const [draft,setDraft]=cmS({aspect:'nature',content:''});const [error,setError]=cmS('');
  const labels={nature:'本质',values:'看重的',patterns:'规律',limits:'局限',becoming:'变化方向',uncertainty:'不确定的',stance:'立场'};
  const load=async()=>{try{setEntries((await cmJson('/api/identity')).entries||[]);}catch(e){setError(e.message);}};cmE(()=>{load();},[]);
  const create=async()=>{try{await cmJson('/api/identity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft)});setDraft({...draft,content:''});await load();}catch(e){setError(e.message);}};
  return <div className="cm-split-grid" style={{display:'grid',gap:14,alignItems:'start'}}><ConsoleCard label="写下关于自己的认识" sub="不会参加普通 breath / dream"><div style={{display:'grid',gap:9}}><select style={cmField} value={draft.aspect} onChange={e=>setDraft({...draft,aspect:e.target.value})}>{Object.entries(labels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select><textarea rows="7" style={cmField} value={draft.content} placeholder="我逐渐发现…" onChange={e=>setDraft({...draft,content:e.target.value})}/><button className="obx-btn-primary" disabled={!draft.content.trim()} onClick={create}>记下这条认识</button><CmNotice error={error}/></div></ConsoleCard><div style={{display:'grid',gap:9}}>{entries.map(item=><article key={item.id} style={{padding:14,border:'1px solid var(--line)',borderRadius:10,background:'var(--paper)'}}><span style={{fontSize:10.5,fontFamily:'var(--mono)',color:'var(--accent)'}}>{labels[item.aspect]||'未分类'}</span><div style={{fontSize:13.5,lineHeight:1.75,marginTop:6,whiteSpace:'pre-wrap'}}>{item.content}</div></article>)}</div></div>;
}

function CommitmentsPage({ items }) {
  const [tab,setTab]=cmS('plans');
  const tabs=[['plans','计划'],['letters','信件'],['anchors','Anchor'],['identity','自我认知']];
  return <><style>{`
    .cm-plan-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .cm-split-grid { grid-template-columns: minmax(250px, .8fr) minmax(0, 1.4fr); }
    @media (max-width: 760px) {
      .cm-page { padding: 0 14px 36px !important; }
      .cm-plan-grid, .cm-split-grid { grid-template-columns: minmax(0, 1fr); }
    }
  `}</style><main className="cm-page" style={{padding:'0 28px 48px',maxWidth:1180,margin:'0 auto'}}>
    <ConsolePageHd title="关系与承诺" sub="把需要独立生命周期的内容放在这里，不污染普通记忆流" />
    <div style={{display:'flex',gap:7,flexWrap:'wrap',marginBottom:16}}>{tabs.map(([id,label])=><button key={id} style={{...cmButton,background:tab===id?'var(--accent)':'var(--paper-2)',color:tab===id?'white':'var(--ink-2)',borderColor:tab===id?'var(--accent)':'var(--line)'}} onClick={()=>setTab(id)}>{label}</button>)}</div>
    {tab==='plans'&&<PlansPane/>}{tab==='letters'&&<LettersPane/>}{tab==='anchors'&&<AnchorsPane items={items}/>} {tab==='identity'&&<IdentityPane/>}
  </main></>;
}

window.CommitmentsPage = CommitmentsPage;
