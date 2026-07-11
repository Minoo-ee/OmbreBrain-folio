// console-config.jsx —— 配置页:profile 列表风格 + 策略参数真接通

const { useState: ccS, useEffect: ccE } = React;

const API_PRESETS = [
  { id: 'deepseek',     name: 'DeepSeek Chat',     model: 'deepseek-chat',     base_url: 'https://api.deepseek.com/v1' },
  { id: 'gemini-flash', name: 'Gemini 2.5 Flash',  model: 'gemini-2.5-flash',  base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
  { id: 'gemini-pro',   name: 'Gemini 2.5 Pro',    model: 'gemini-2.5-pro',    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
  { id: 'claude-haiku', name: 'Claude Haiku 4.5',  model: 'claude-haiku-4-5',  base_url: 'https://api.anthropic.com/v1/' },
  { id: 'claude-sonnet',name: 'Claude Sonnet 4.6', model: 'claude-sonnet-4-6', base_url: 'https://api.anthropic.com/v1/' },
  { id: 'qwen3',        name: 'Qwen3 (DashScope)', model: 'qwen-max',          base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
];

// ─────────────────────────────────────────────────────────────────────────
// 配置页策略面板 (Claude Design 改版 · 方案 β「权重双栏」, 2026-06-09)
// 颜色全走 var(--*) (app 月光紫主题, 不带 CD demo 自定义紫); cfg- 前缀
// ─────────────────────────────────────────────────────────────────────────

function CfgSlider({ value, min, max, step, defaultVal, onChange, label, hint, compact }) {
  const v = (value == null ? defaultVal : value);
  const deviated = v !== defaultVal;
  const span = (max - min) || 1;
  const pct = ((v - min) / span) * 100;
  const decimals = step < 0.01 ? 3 : step < 1 ? 2 : 0;
  return (
    <div className={'cfg-slider-row' + (compact ? ' cfg-slider-row--compact' : '')}>
      <div className="cfg-slider-head">
        <span className={'cfg-slider-label' + (deviated ? ' cfg-slider-label--dev' : '')}>{label}</span>
        <span className="cfg-slider-val">{Number(v).toFixed(decimals)}</span>
        {deviated && <button className="cfg-slider-reset" title={'复位到默认 ' + defaultVal} onClick={() => onChange(defaultVal)}>↺</button>}
      </div>
      <div className="cfg-slider-track-wrap">
        <input type="range" className="cfg-slider" min={min} max={max} step={step} value={v}
          onChange={e => onChange(parseFloat(e.target.value))} style={{ '--pct': pct + '%' }} />
        <span className="cfg-slider-default-mark" style={{ left: ((defaultVal - min) / span) * 100 + '%' }} title={'默认 ' + defaultVal} />
      </div>
      {hint && <p className="cfg-slider-hint">{hint}</p>}
      {deviated && <p className="cfg-slider-range">范围 <em>{min}</em>–<em>{max}</em> · 默认 <em>{defaultVal}</em></p>}
    </div>
  );
}

function CfgNumberInput({ value, min, max, step, onChange }) {
  return (
    <div className="cfg-number-row">
      <div className="cfg-number-ctrl">
        <button className="cfg-number-btn" disabled={value <= min} onClick={() => onChange(Math.max(min, value - (step || 1)))}>−</button>
        <span className="cfg-number-val">{value}</span>
        <button className="cfg-number-btn" disabled={value >= max} onClick={() => onChange(Math.min(max, value + (step || 1)))}>+</button>
      </div>
    </div>
  );
}

function CfgStrategyPanel({ strategy, onChange, onCommit }) {
  const t = strategy.merge_threshold;
  const threshLabel = t <= 30 ? '宽松 — 频繁合并' : t <= 60 ? '适中' : t <= 80 ? '严格 — 较少合并' : '极严格 — 几乎不合并';
  return (
    <div className="cfg-strategy">
      <div className="cfg-card-hd"><h3 className="cfg-card-title">回忆 / 合并策略</h3></div>
      <div className="cfg-param-block">
        <div className="cfg-param-head"><span className="cfg-param-name">合并阈值</span><span className="cfg-param-val">{t}</span></div>
        <div className="cfg-threshold-bar">
          <div className="cfg-threshold-labels"><span>松</span><span>严</span></div>
          <input type="range" className="cfg-slider cfg-slider--wide" min={0} max={100} step={1}
            value={t}
            onChange={e => onChange({ merge_threshold: parseInt(e.target.value) })}
            onMouseUp={e => onCommit({ merge_threshold: parseInt(e.target.value) })}
            onTouchEnd={e => onCommit({ merge_threshold: parseInt(e.target.value) })}
            style={{ '--pct': t + '%' }} />
          <p className="cfg-threshold-hint">{threshLabel}</p>
        </div>
        <p className="cfg-slider-hint">导入时相似记忆的合并严格度。0 = 几乎都合并，100 = 几乎不合并。</p>
      </div>
      <div className="cfg-param-block">
        <div className="cfg-param-head"><span className="cfg-param-name">Max Recall</span><span className="cfg-param-val">{strategy.max_recall}</span></div>
        <div className="cfg-recall-ctrl">
          <input type="range" className="cfg-slider cfg-slider--wide" min={1} max={50} step={1}
            value={strategy.max_recall}
            onChange={e => onChange({ max_recall: parseInt(e.target.value) })}
            onMouseUp={e => onCommit({ max_recall: parseInt(e.target.value) })}
            onTouchEnd={e => onCommit({ max_recall: parseInt(e.target.value) })}
            style={{ '--pct': ((strategy.max_recall - 1) / 49) * 100 + '%' }} />
          <CfgNumberInput value={strategy.max_recall} min={1} max={50} step={1} onChange={v => onCommit({ max_recall: v })} />
        </div>
        <p className="cfg-slider-hint">检索默认返回条数 & breath 工具的兜底上限。</p>
      </div>
    </div>
  );
}

function CfgDecayPanel({ config, defaults, schema, onChange, onReset, saving }) {
  const deviatedKeys = schema.filter(s => config[s.key] !== defaults[s.key]).map(s => s.key);
  const anyDeviated = deviatedKeys.length > 0;
  return (
    <div className="cfg-decay">
      <div className="cfg-card-hd">
        <h3 className="cfg-card-title">权重配置</h3>
        <span className="cfg-card-sub">衰减引擎参数 · 改完即时生效</span>
        {anyDeviated && <span className="cfg-deviated-summary"><span className="cfg-deviated-dot" />{deviatedKeys.length} 项已偏离默认</span>}
        {anyDeviated && <button className="cfg-btn-ghost" onClick={onReset} disabled={saving}>全部恢复默认</button>}
      </div>
      <div className="cfg-decay-grid cfg-decay-grid--two">
        {schema.map(s => (
          <CfgSlider key={s.key} value={config[s.key]} min={s.min} max={s.max} step={s.step}
            defaultVal={defaults[s.key]} onChange={v => onChange(s.key, v)} label={s.label} hint={s.hint} compact />
        ))}
      </div>
    </div>
  );
}

function ConfigPage() {
  const [data, setData] = ccS(null);
  const [loadErr, setLoadErr] = ccS(null);
  const [editing, setEditing] = ccS(null);            // null | { id?, name, model, base_url, api_key, _preset }
  const [testing, setTesting] = ccS({});              // pid → 'pending'|'ok'|'fail'
  const [testInfo, setTestInfo] = ccS({});            // pid → { latency_ms, sample, error }
  const [switching, setSwitching] = ccS(null);
  const [showKey, setShowKey] = ccS(false);
  const [appliedAt, setAppliedAt] = ccS('');

  // 策略参数(merge_threshold / max_recall)
  const [strategy, setStrategy] = ccS({ merge_threshold: 75, max_recall: 5 });
  const [strategySaving, setStrategySaving] = ccS(false);

  // 权重配置 (decay engine 参数)
  const [decayCfg, setDecayCfg] = ccS(null);     // { current, defaults, schema }
  const [decaySaving, setDecaySaving] = ccS(false);
  const [decayResetting, setDecayResetting] = ccS(false);

  // Prompt 配置 (LLM system prompt 编辑)
  const [promptCfg, setPromptCfg] = ccS(null);   // { current, defaults, overridden, schema }
  const [promptDraft, setPromptDraft] = ccS({}); // key → 编辑中的草稿(未保存)
  const [promptSaving, setPromptSaving] = ccS({}); // key → bool
  const [promptOpen, setPromptOpen] = ccS({});   // key → 折叠展开
  const [promptResetAllBusy, setPromptResetAllBusy] = ccS(false);

  // 注: 检索打分微调 / 即时模拟 / 被想起统计 / 最近搜索 已迁到 Breath tab (console-breath.jsx, 2026-06-07)

  const fetchAll = async () => {
    try {
      const r = await fetch('/api/config/api');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      setData(await r.json());
    } catch (e) {
      setLoadErr(e.message || String(e));
    }
  };
  const fetchStrategy = async () => {
    try {
      const r = await fetch('/api/config/strategy');
      if (r.ok) setStrategy(await r.json());
    } catch (e) { /* 沉默 */ }
  };
  const fetchDecay = async () => {
    try {
      const r = await fetch('/api/decay-config');
      if (r.ok) setDecayCfg(await r.json());
    } catch (e) { /* 沉默 */ }
  };
  const fetchPrompts = async () => {
    try {
      const r = await fetch('/api/prompts-config');
      if (r.ok) {
        const d = await r.json();
        setPromptCfg(d);
        setPromptDraft({});  // 拉到新数据 → 清掉所有草稿
      }
    } catch (e) { /* 沉默 */ }
  };
  ccE(() => { fetchAll(); fetchStrategy(); fetchDecay(); fetchPrompts(); }, []);

  // ─── Prompt 编辑相关 ───
  const isPromptOverridden = (key) => promptCfg && promptCfg.overridden && promptCfg.overridden.includes(key);
  const promptCurrent = (key) => promptDraft[key] !== undefined
    ? promptDraft[key]
    : (promptCfg ? (promptCfg.current[key] || '') : '');
  const promptIsDirty = (key) => {
    if (!promptCfg) return false;
    if (promptDraft[key] === undefined) return false;
    return promptDraft[key] !== promptCfg.current[key];
  };
  const savePrompt = async (key) => {
    if (!promptCfg) return;
    const val = promptDraft[key];
    if (val === undefined) return;
    setPromptSaving(s => ({ ...s, [key]: true }));
    try {
      const r = await fetch('/api/prompts-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: val }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      setPromptCfg(d);
      setPromptDraft(s => { const n = { ...s }; delete n[key]; return n; });
    } catch (e) {
      alert('保存失败: ' + e.message);
    } finally {
      setPromptSaving(s => ({ ...s, [key]: false }));
    }
  };
  const resetPromptOne = async (key) => {
    if (!promptCfg) return;
    if (!confirm(`恢复「${(promptCfg.schema.find(s => s.key === key) || {}).label || key}」为出厂默认?\n当前编辑/保存的版本会被清掉。`)) return;
    setPromptSaving(s => ({ ...s, [key]: true }));
    try {
      const r = await fetch('/api/prompts-config/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      setPromptCfg(d);
      setPromptDraft(s => { const n = { ...s }; delete n[key]; return n; });
    } catch (e) {
      alert('恢复失败: ' + e.message);
    } finally {
      setPromptSaving(s => ({ ...s, [key]: false }));
    }
  };
  const resetPromptAll = async () => {
    if (!promptCfg) return;
    if (!confirm('全部 prompt 恢复出厂默认?\n所有自定义版本将被清掉。')) return;
    setPromptResetAllBusy(true);
    try {
      const r = await fetch('/api/prompts-config/reset', { method: 'POST' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      setPromptCfg(d);
      setPromptDraft({});
    } catch (e) {
      alert('恢复失败: ' + e.message);
    } finally {
      setPromptResetAllBusy(false);
    }
  };
  const alignUpstream = async () => {
    if (!promptCfg) return;
    const upstreamKeys = promptCfg.upstream ? Object.keys(promptCfg.upstream) : [];
    if (upstreamKeys.length === 0) {
      alert('当前后端未提供上游 prompt 数据');
      return;
    }
    const skipped = (promptCfg.schema || []).filter(s => !upstreamKeys.includes(s.key)).map(s => s.label);
    const aligned = (promptCfg.schema || []).filter(s => upstreamKeys.includes(s.key)).map(s => s.label);
    const msg = `把以下 ${aligned.length} 个 prompt 切到原作者(P0luz/Ombre-Brain)版本:\n  · ${aligned.join('\n  · ')}\n\n` +
      (skipped.length > 0 ? `跳过(本项目独创, 上游没有):\n  · ${skipped.join('\n  · ')}\n\n` : '') +
      `这会覆盖你当前任何自定义版本(可以再用 ↺ 全部恢复默认 撤销)。继续?`;
    if (!confirm(msg)) return;
    setPromptResetAllBusy(true);
    try {
      const r = await fetch('/api/prompts-config/align-upstream', { method: 'POST' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (d.state) setPromptCfg(d.state);
      setPromptDraft({});
      alert(`已对齐上游 ${(d.aligned || []).length} 个 prompt` +
        (d.skipped && d.skipped.length ? ` · 跳过 ${d.skipped.length} 个独创 prompt` : ''));
    } catch (e) {
      alert('对齐失败: ' + e.message);
    } finally {
      setPromptResetAllBusy(false);
    }
  };
  const discardPromptDraft = (key) => {
    setPromptDraft(s => { const n = { ...s }; delete n[key]; return n; });
  };

  // 改单个权重参数: 乐观更新 + POST + 失败回滚
  const updateDecay = async (key, value) => {
    if (!decayCfg) return;
    const old = decayCfg.current[key];
    setDecayCfg(c => ({ ...c, current: { ...c.current, [key]: value } }));
    setDecaySaving(true);
    try {
      const r = await fetch('/api/decay-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (d && d.current) setDecayCfg(c => ({ ...c, current: d.current }));
    } catch (e) {
      alert('保存失败: ' + e.message);
      setDecayCfg(c => ({ ...c, current: { ...c.current, [key]: old } }));
    } finally {
      setDecaySaving(false);
    }
  };
  const resetDecayAll = async () => {
    if (!decayCfg) return;
    if (!confirm('全部参数恢复出厂默认?')) return;
    setDecayResetting(true);
    try {
      const r = await fetch('/api/decay-config/reset', { method: 'POST' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (d && d.current) setDecayCfg(c => ({ ...c, current: d.current }));
    } catch (e) {
      alert('恢复失败: ' + e.message);
    } finally {
      setDecayResetting(false);
    }
  };

  const startNew = () => { setEditing({ id: '', name: '', model: '', base_url: '', api_key: '', _preset: '' }); setShowKey(false); };
  const startEdit = (p) => { setEditing({ id: p.id, name: p.name, model: p.model, base_url: p.base_url, api_key: '', _preset: '' }); setShowKey(false); };
  const cancelEdit = () => setEditing(null);

  const applyPreset = (presetId) => {
    const preset = API_PRESETS.find(p => p.id === presetId);
    if (!preset) return;
    setEditing(s => ({ ...s, name: s.name || preset.name, model: preset.model, base_url: preset.base_url, _preset: presetId }));
  };

  const saveProfile = async () => {
    if (!editing.name || !editing.model || !editing.base_url) { alert('名称 / 模型 / Base URL 都必填'); return; }
    if (!editing.id && !editing.api_key) { alert('新建 profile 必须填 API key'); return; }
    try {
      const r = await fetch('/api/config/api/profile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editing),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      await fetchAll();
      setEditing(null);
      setAppliedAt(new Date().toLocaleString('zh-CN', { hour12: false }) + ' · 已保存');
    } catch (e) { alert('保存失败: ' + e.message); }
  };

  const deleteProfile = async (pid, name) => {
    if (!window.confirm(`删除 profile「${name}」?\n如果它是当前激活的,会回退到环境变量配置。`)) return;
    try {
      const r = await fetch(`/api/config/api/profile/${encodeURIComponent(pid)}/delete`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      await fetchAll();
    } catch (e) { alert('删除失败: ' + e.message); }
  };

  const setActive = async (pid) => {
    const p = data.profiles.find(x => x.id === pid);
    if (p && !p.has_key) { alert('该 profile 没有 API key,无法激活'); return; }
    setSwitching(pid);
    try {
      const r = await fetch('/api/config/api/active', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: pid }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      await fetchAll();
      setAppliedAt(new Date().toLocaleString('zh-CN', { hour12: false }) + ' · 已激活并生效');
    } catch (e) { alert('切换失败: ' + e.message); }
    finally { setSwitching(null); }
  };

  const clearActive = async () => {
    if (!window.confirm('回退到环境变量(env)配置?')) return;
    setSwitching('__clear__');
    try {
      await fetch('/api/config/api/active', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: null }),
      });
      await fetchAll();
      setAppliedAt(new Date().toLocaleString('zh-CN', { hour12: false }) + ' · 已回退到 env');
    } catch (e) { alert('失败: ' + e.message); }
    finally { setSwitching(null); }
  };

  const testProfile = async (pid) => {
    setTesting(t => ({ ...t, [pid]: 'pending' }));
    setTestInfo(i => ({ ...i, [pid]: null }));
    try {
      const r = await fetch('/api/config/api/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: pid }),
      });
      const d = await r.json();
      if (d.ok) {
        setTesting(t => ({ ...t, [pid]: 'ok' }));
        setTestInfo(i => ({ ...i, [pid]: { latency_ms: d.latency_ms, sample: d.sample } }));
      } else {
        setTesting(t => ({ ...t, [pid]: 'fail' }));
        setTestInfo(i => ({ ...i, [pid]: { error: d.error || '未知错误' } }));
      }
    } catch (e) {
      setTesting(t => ({ ...t, [pid]: 'fail' }));
      setTestInfo(i => ({ ...i, [pid]: { error: e.message } }));
    }
  };

  const testDraft = async () => {
    if (!editing.api_key) { alert('请先填 API key 再测试'); return; }
    setTesting(t => ({ ...t, __draft__: 'pending' }));
    setTestInfo(i => ({ ...i, __draft__: null }));
    try {
      const r = await fetch('/api/config/api/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: editing.model, base_url: editing.base_url, api_key: editing.api_key }),
      });
      const d = await r.json();
      if (d.ok) {
        setTesting(t => ({ ...t, __draft__: 'ok' }));
        setTestInfo(i => ({ ...i, __draft__: { latency_ms: d.latency_ms, sample: d.sample } }));
      } else {
        setTesting(t => ({ ...t, __draft__: 'fail' }));
        setTestInfo(i => ({ ...i, __draft__: { error: d.error || '未知错误' } }));
      }
    } catch (e) {
      setTesting(t => ({ ...t, __draft__: 'fail' }));
      setTestInfo(i => ({ ...i, __draft__: { error: e.message } }));
    }
  };

  // 策略参数提交(防抖一下)
  const saveStrategy = async (patch) => {
    setStrategy(s => ({ ...s, ...patch }));
    setStrategySaving(true);
    try {
      const r = await fetch('/api/config/strategy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      setStrategy({ merge_threshold: d.merge_threshold, max_recall: d.max_recall });
    } catch (e) {
      alert('策略保存失败: ' + e.message);
      fetchStrategy();  // 失败回滚
    } finally { setStrategySaving(false); }
  };

  if (loadErr) {
    return <main className="oc-main"><div style={{ padding: 20, color: '#8B4A4A', fontSize: 13 }}>配置加载失败: {loadErr} · <a onClick={fetchAll} style={{ cursor: 'pointer', textDecoration: 'underline' }}>重试</a></div></main>;
  }
  if (!data) {
    return <main className="oc-main"><div style={{ padding: 40, textAlign: 'center', color: 'var(--ink-3)' }}>加载配置…</div></main>;
  }

  const eff = data.current_effective || {};
  const activeProfile = data.profiles.find(p => p.id === data.active);

  return (
    <main className="oc-main">
      <ConsolePageHd
        title="配置"
        sub={<>系统运行参数 —— 脱水/打标 API、向量化模型、回忆策略。修改即时生效,持久化在 runtime_config.json。</>}
        rightSlot={
          <>
            <div className="oc-status-pill ok">{eff.api_available ? '运行中' : '未配置'}</div>
            <div className="ob-page-counter">{appliedAt || '—'}</div>
          </>
        }
      />

      {/* 当前生效 摘要 */}
      <ConsoleCard label="当前生效" sub={data.active ? `Profile · ${activeProfile?.name || data.active}` : '回退到环境变量(env)配置'}>
        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '8px 14px', alignItems: 'baseline', fontSize: 13 }}>
          <div style={{ color: 'var(--ink-4)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.06em' }}>MODEL</div>
          <div style={{ fontFamily: 'var(--mono)', color: 'var(--ink)' }}>{eff.model || '—'}</div>
          <div style={{ color: 'var(--ink-4)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.06em' }}>BASE URL</div>
          <div style={{ fontFamily: 'var(--mono)', color: 'var(--ink-2)', fontSize: 12 }}>{eff.base_url || '—'}</div>
          <div style={{ color: 'var(--ink-4)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.06em' }}>API KEY</div>
          <div style={{ fontFamily: 'var(--mono)', color: eff.api_available ? 'var(--ink-2)' : '#8B4A4A', fontSize: 12 }}>{eff.api_key_mask || '(未设置)'}</div>
        </div>
        {data.active && (
          <div style={{ marginTop: 12 }}>
            <button className="oc-btn oc-btn-ghost" onClick={clearActive} disabled={switching === '__clear__'} style={{ fontSize: 11 }}>
              {switching === '__clear__' ? '⌛ 切换中…' : '↺ 回退到环境变量配置'}
            </button>
          </div>
        )}
      </ConsoleCard>

      {/* API Profiles */}
      <ConsoleCard label="API Profiles" sub={`${data.profiles.length} 个 profile · 点左侧 ◉ 切换激活;导入用 Claude Sonnet,日常用 Gemini Flash 都很方便`}>
        {!editing && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
            <button
              className="oc-btn"
              onClick={startNew}
              style={{
                fontSize: 11, padding: '5px 12px',
                background: 'color-mix(in oklab, var(--accent) 8%, var(--paper))',
                color: 'var(--accent)',
                borderColor: 'var(--accent)',
              }}
            >+ 新建 profile</button>
          </div>
        )}

        {data.profiles.length === 0 && !editing && (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--ink-4)', fontStyle: 'italic', fontSize: 12 }}>
            还没有保存过任何 profile · 点右上角"+ 新建 profile"开始
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data.profiles.map(p => {
            const isActive = data.active === p.id;
            const t = testing[p.id];
            const ti = testInfo[p.id];
            return (
              <div
                key={p.id}
                style={{
                  padding: '12px 14px',
                  background: isActive ? 'color-mix(in oklab, var(--accent) 5%, var(--paper))' : 'var(--paper)',
                  border: '0.5px solid ' + (isActive ? 'var(--accent)' : 'var(--line-2)'),
                  borderRadius: 8,
                  display: 'grid',
                  gridTemplateColumns: '24px 1fr auto',
                  gap: 12,
                  alignItems: 'center',
                }}
              >
                <button
                  type="button"
                  onClick={() => !isActive && setActive(p.id)}
                  disabled={switching !== null || isActive}
                  title={isActive ? '当前激活' : '点击激活'}
                  style={{
                    width: 16, height: 16, borderRadius: '50%',
                    border: '1.5px solid ' + (isActive ? 'var(--accent)' : 'var(--ink-4)'),
                    background: isActive ? 'var(--accent)' : 'transparent',
                    cursor: isActive ? 'default' : 'pointer', padding: 0,
                    boxShadow: isActive ? '0 0 0 2px color-mix(in oklab, var(--accent) 18%, transparent)' : 'none',
                  }}
                />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--serif)', fontSize: 14, fontStyle: 'italic', color: 'var(--ink)', fontWeight: 500 }}>
                    {p.name}
                    {isActive && <span style={{ marginLeft: 8, fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--accent)', letterSpacing: '0.04em' }}>· 激活中</span>}
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', marginTop: 3, lineHeight: 1.6 }}>
                    {p.model} · {p.base_url} · key {p.has_key ? p.api_key_mask : <span style={{ color: '#8B4A4A' }}>未设置</span>}
                  </div>
                  {t === 'ok' && ti && (
                    <div style={{ marginTop: 4, fontSize: 10.5, color: '#5b8a5b', fontFamily: 'var(--mono)' }}>
                      ✓ 连通 · {ti.latency_ms}ms{ti.sample ? ` · "${ti.sample}"` : ''}
                    </div>
                  )}
                  {t === 'fail' && ti && (
                    <div style={{ marginTop: 4, fontSize: 10.5, color: '#8B4A4A', fontFamily: 'var(--mono)', wordBreak: 'break-word' }}>
                      ✕ 失败 · {ti.error}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="oc-btn oc-btn-ghost" onClick={() => testProfile(p.id)} disabled={t === 'pending' || !p.has_key} style={{ fontSize: 10.5, padding: '3px 9px' }} title={p.has_key ? '发送一个 ping 请求测试连通' : '没填 key 无法测试'}>
                    {t === 'pending' ? '◐ 测试中' : '◇ 测试'}
                  </button>
                  <button className="oc-btn oc-btn-ghost" onClick={() => startEdit(p)} style={{ fontSize: 10.5, padding: '3px 9px' }}>编辑</button>
                  <button className="oc-btn oc-btn-ghost" onClick={() => deleteProfile(p.id, p.name)} style={{ fontSize: 10.5, padding: '3px 9px', color: '#8B4A4A' }}>删除</button>
                </div>
              </div>
            );
          })}
        </div>

        {/* 内联编辑表单 */}
        {editing && (() => {
          const td = testing.__draft__;
          const tdi = testInfo.__draft__;
          return (
            <div style={{
              marginTop: 14, padding: '14px 16px',
              background: 'var(--paper-2)',
              border: '0.5px dashed var(--accent)',
              borderRadius: 8,
            }}>
              <div style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 14, color: 'var(--ink)', marginBottom: 10 }}>
                {editing.id ? '编辑 profile' : '新建 profile'}
              </div>
              {!editing.id && (
                <div className="oc-field">
                  <div className="oc-field-label">从模板</div>
                  <select className="oc-select" value={editing._preset || ''} onChange={(e) => applyPreset(e.target.value)}>
                    <option value="">— 选模板自动填 model + base_url —</option>
                    {API_PRESETS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              )}
              <div className="oc-field">
                <div className="oc-field-label">名称</div>
                <input className="oc-input" placeholder="比如 'Claude Sonnet 主力'" value={editing.name} onChange={(e) => setEditing(s => ({ ...s, name: e.target.value }))} />
              </div>
              <div className="oc-field">
                <div className="oc-field-label">MODEL</div>
                <input className="oc-input oc-input-mono" placeholder="claude-sonnet-4-6" value={editing.model} onChange={(e) => setEditing(s => ({ ...s, model: e.target.value }))} />
              </div>
              <div className="oc-field">
                <div className="oc-field-label">BASE URL</div>
                <input className="oc-input oc-input-mono" placeholder="https://api.anthropic.com/v1/" value={editing.base_url} onChange={(e) => setEditing(s => ({ ...s, base_url: e.target.value }))} />
              </div>
              <div className="oc-field">
                <div className="oc-field-label">API KEY</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1 }}>
                  <input className="oc-input oc-input-mono" type={showKey ? 'text' : 'password'} placeholder={editing.id ? '留空 = 不修改' : 'sk-ant-...'} value={editing.api_key} onChange={(e) => setEditing(s => ({ ...s, api_key: e.target.value }))} style={{ flex: 1 }} />
                  <button className="oc-btn oc-btn-ghost" onClick={() => setShowKey(s => !s)} style={{ fontSize: 11, padding: '5px 10px', flexShrink: 0 }}>{showKey ? '隐藏' : '显示'}</button>
                </div>
              </div>
              {td === 'ok' && tdi && (
                <div style={{ padding: '8px 12px', marginTop: 8, fontSize: 11.5, color: '#5b8a5b', fontFamily: 'var(--mono)', background: 'rgba(91,138,91,0.06)', border: '0.5px solid rgba(91,138,91,0.25)', borderRadius: 5 }}>
                  ✓ 连通成功 · {tdi.latency_ms}ms{tdi.sample ? ` · 返回: "${tdi.sample}"` : ''}
                </div>
              )}
              {td === 'fail' && tdi && (
                <div style={{ padding: '8px 12px', marginTop: 8, fontSize: 11.5, color: '#8B4A4A', fontFamily: 'var(--mono)', background: 'rgba(139,74,74,0.06)', border: '0.5px solid rgba(139,74,74,0.25)', borderRadius: 5, wordBreak: 'break-word' }}>
                  ✕ 测试失败 · {tdi.error}
                </div>
              )}
              <div className="oc-btn-row" style={{ marginTop: 12 }}>
                <button className="oc-btn oc-btn-ghost" onClick={testDraft} disabled={td === 'pending' || !editing.api_key}>
                  {td === 'pending' ? '◐ 测试中…' : '◇ 测试连接'}
                </button>
                <button className="oc-btn oc-btn-ghost" onClick={cancelEdit}>取消</button>
                <button className="oc-btn oc-btn-primary" onClick={saveProfile} style={{ marginLeft: 'auto' }}>
                  {editing.id ? '保存修改' : '创建 profile'}
                </button>
              </div>
              <div style={{ marginTop: 8, fontSize: 10.5, color: 'var(--ink-4)', fontFamily: 'var(--mono)' }}>
                {editing.id ? '保存后不会自动激活,需要点列表里的 ◉ 切换' : '创建后不会自动激活,建议先测试连接再激活'}
              </div>
            </div>
          );
        })()}
      </ConsoleCard>

      {/* 向量化 Embedding */}
      <ConsoleCard label="向量化 Embedding" sub="为每条记忆生成稠密向量,用于语义检索与相似聚合。">
        <div className="oc-field">
          <div className="oc-field-label">启用</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="oc-switch on" />
            <span style={{ fontSize: 12, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>已开启 · 新写入会自动 embed</span>
          </div>
        </div>
        <div className="oc-field">
          <div className="oc-field-label">MODEL</div>
          <input className="oc-input oc-input-mono" value="gemini-embedding-001" disabled />
        </div>
        <div className="oc-field">
          <div className="oc-field-label">维度</div>
          <input className="oc-input oc-input-mono" type="number" value={768} disabled />
        </div>
        <div className="oc-field">
          <div className="oc-field-label">批量大小</div>
          <input className="oc-input oc-input-mono" type="number" value={32} disabled />
        </div>
      </ConsoleCard>

      {/* ═══ 配置页策略面板 (Claude Design 改版 · 方案 β「权重双栏」, 2026-06-09) ═══ */}
      <div className="cfg-config">
        <section className="cfg-card">
          <CfgStrategyPanel
            strategy={strategy}
            onChange={(patch) => setStrategy(s => ({ ...s, ...patch }))}
            onCommit={saveStrategy}
          />
        </section>
        <section className="cfg-card">
          {!decayCfg
            ? <div style={{ color: 'var(--ink-4)', fontSize: 12 }}>载入中…</div>
            : <CfgDecayPanel
                config={decayCfg.current}
                defaults={decayCfg.defaults}
                schema={decayCfg.schema}
                onChange={updateDecay}
                onReset={resetDecayAll}
                saving={decaySaving || decayResetting}
              />}
        </section>
      </div>

      {/* 注: 检索打分微调 / 即时模拟 / 记忆被想起 / 最近搜索追溯 已迁到 Breath tab (2026-06-07) */}

      {/* Prompt 配置 (LLM system prompt 直接编辑) */}
      <ConsoleCard label="Prompt 配置" sub="改 LLM 系统提示词 · 改完即刻生效 · 重启后保留">
        {!promptCfg && <div style={{ color: 'var(--ink-4)', fontSize: 12 }}>载入中…</div>}
        {promptCfg && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--ink-4)', fontFamily: 'var(--mono)', flex: 1 }}>
                {promptCfg.overridden && promptCfg.overridden.length > 0
                  ? `${promptCfg.overridden.length} 个已自定义 · 其余使用出厂默认`
                  : '全部使用出厂默认'}
              </div>
              <button
                className="oc-btn oc-btn-ghost"
                onClick={alignUpstream}
                disabled={promptResetAllBusy}
                style={{ fontSize: 11, padding: '3px 12px' }}
                title="把上游 (P0luz/Ombre-Brain) 有的 prompt 全部切到上游版本"
              >{promptResetAllBusy ? '⌛' : '⇆ 对齐原作者版本'}</button>
              <button
                className="oc-btn oc-btn-ghost"
                onClick={resetPromptAll}
                disabled={promptResetAllBusy || !promptCfg.overridden || promptCfg.overridden.length === 0}
                style={{ fontSize: 11, padding: '3px 12px' }}
              >{promptResetAllBusy ? '⌛' : '↺ 全部恢复默认'}</button>
            </div>
            {promptCfg.schema.map(item => {
              const cur = promptCurrent(item.key);
              const overridden = isPromptOverridden(item.key);
              const dirty = promptIsDirty(item.key);
              const saving = !!promptSaving[item.key];
              const open = !!promptOpen[item.key];
              const charCount = (cur || '').length;
              return (
                <div key={item.key} className={'oc-prompt-row' + (overridden ? ' is-overridden' : '') + (dirty ? ' is-dirty' : '')}>
                  <div
                    className="oc-prompt-hd"
                    onClick={() => setPromptOpen(s => ({ ...s, [item.key]: !s[item.key] }))}
                  >
                    <span className="oc-prompt-chev">{open ? '▾' : '▸'}</span>
                    <span className="oc-prompt-label">{item.label}</span>
                    <code className="oc-prompt-key">{item.key}</code>
                    {overridden && <span className="oc-prompt-badge">已自定义</span>}
                    {dirty && <span className="oc-prompt-badge oc-prompt-badge-dirty">未保存</span>}
                    <span className="oc-prompt-meta">{charCount} 字</span>
                  </div>
                  {open && (
                    <div className="oc-prompt-body">
                      <div className="oc-prompt-desc">{item.desc}</div>
                      <textarea
                        className="oc-prompt-textarea"
                        rows={item.rows || 16}
                        value={cur}
                        onChange={(e) => setPromptDraft(s => ({ ...s, [item.key]: e.target.value }))}
                        spellCheck={false}
                        disabled={saving}
                      />
                      <div className="oc-prompt-foot">
                        <button
                          className="oc-btn oc-btn-ghost"
                          onClick={() => resetPromptOne(item.key)}
                          disabled={saving || (!overridden && !dirty)}
                          title={overridden ? '清掉这条覆盖, 回到出厂默认' : '当前已是出厂默认'}
                        >↺ 恢复默认</button>
                        <div style={{ flex: 1 }} />
                        {dirty && (
                          <button
                            className="oc-btn oc-btn-ghost"
                            onClick={() => discardPromptDraft(item.key)}
                            disabled={saving}
                          >放弃改动</button>
                        )}
                        <button
                          className="oc-btn oc-btn-primary"
                          onClick={() => savePrompt(item.key)}
                          disabled={saving || !dirty}
                        >{saving ? '保存中…' : '✓ 保存'}</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="oc-field-help" style={{ marginTop: 14, color: 'var(--ink-4)' }}>
              改动写入 buckets/runtime_config.json['prompts'], 重启自动加载 · 全部 prompt 都用 LLM system role 注入, 改完即刻生效
            </div>
          </>
        )}
      </ConsoleCard>

      {/* 系统信息 */}
      <ConsoleCard label="系统信息" sub="只读 · 用于诊断">
        <div className="oc-field">
          <div className="oc-field-label">Transport</div>
          <code style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)' }}>streamable-http</code>
        </div>
        <div className="oc-field">
          <div className="oc-field-label">Buckets dir</div>
          <code style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)' }}>/opt/render/project/src/buckets</code>
        </div>
        <div className="oc-field">
          <div className="oc-field-label">配置文件</div>
          <code style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)' }}>runtime_config.json · config.yaml · env vars</code>
        </div>
      </ConsoleCard>
    </main>
  );
}

window.ConfigPage = ConfigPage;
