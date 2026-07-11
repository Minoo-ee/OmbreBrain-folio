// import-workbench.jsx —— 导入工作台 (真实数据接入版)
// 数据流:
//   - 队列:GET /api/import/results → API → mock shape
//   - 选中条目 body/相似:GET /api/bucket/:id (lazy) + GET /api/bucket/:id/similar
//   - 编辑/状态/删除:POST /api/bucket/:id/{update,delete}
//   - 状态(已精修/存疑)用隐藏 tag (__import_refined / __import_flagged) 表达
//   - 上传文件 / 粘贴原文:走 ombre-bridge 的 helper

const { useState: iwS, useEffect: iwE, useMemo: iwM, useRef: iwR, useCallback: iwC } = React;

// 隐藏 tag 前缀 — 不展示给用户
const STATUS_TAG_REFINED = '__import_refined';
const STATUS_TAG_FLAGGED = '__import_flagged';
function statusOf(item) {
  const tags = item.tags || [];
  if (tags.includes(STATUS_TAG_REFINED)) return 'refined';
  if (tags.includes(STATUS_TAG_FLAGGED)) return 'flagged';
  return 'pending';
}
// bridge 注入的"伪 tag" — 来源 / 状态 在 imp-paper 都有独立 UI (source pill /
// type pill / importance bar) 显示, 不应该塞进 tag 列表里让用户误以为可以
// 像普通 tag 一样删除. 删除伪 tag 也无效因为 fetchQueue 重拉时 bridge 又注入.
// 修复"导入台标签无法删除" (实际是删了又出现) — visibleTags 一起过滤掉.
const _CONSOLE_PSEUDO_TAGS = new Set([
  '亲手写', 'AI 写入', '导入',                                    // 来源伪 tag (用 source pill 切换)
  '已消化', '保护', '重要', 'feel(柔软)',                          // 状态伪 tag (用对应 toggle / type pill 切换)
]);
function visibleTags(tags) {
  return (tags || []).filter(t => !String(t).startsWith('__') && !_CONSOLE_PSEUDO_TAGS.has(String(t)));
}

// API bucket → 工作台 item shape
function bucketToItem(b) {
  // b 形如 /api/import/results 的元素 + 可选 content/raw_source
  return {
    id: b.id,
    batch: 'recent',  // 单批次视图(workbench 当前默认),后续可拓展真实 batch_id
    status: statusOf(b),
    title: b.name || b.id,
    summary: b.summary || (b.content || '').slice(0, 160),
    body: b.body || b.content || '',
    rawSource: b.raw_source || '',
    createdBy: b.created_by || 'ai',  // 来源 user/ai/import (来源 pill 切换读这字段)
    tags: b.tags || [],
    importance: b.importance || 5,
    score: typeof b.score === 'number' ? b.score : 0,
    // 注: 不要再 OR b.pinned — API 的 b.pinned 是 protected||highlight 的或值, 二次 OR 会假性耦合
    protected: !!b.protected,
    highlight: !!b.highlight,
    feel: b.type === 'feel',
    timeHint: (() => {
      // event_time / created 是 UTC ISO,转本地 "YYYY-MM-DD HH:MM"
      const src = b.event_time || b.created || '';
      if (!src) return '';
      if (window.__obIsoToLocal) {
        const lt = window.__obIsoToLocal(src);
        return lt.date + (lt.time ? ' ' + lt.time : '');
      }
      return src.slice(0, 16).replace('T', ' ');
    })(),
    type: b.type || 'dynamic',
    aiReasons: {},   // 后端没存推理理由,留空 — UI 自动隐藏推理卡片
    similar: [],      // 全库相似,首次激活时按需 fetch
  };
}

// 同批 (frontend) 相似计算:tag 共现 + importance/feel 加权
function sameBatchSimilar(target, queue, topN) {
  if (!target) return [];
  const targetTags = new Set(visibleTags(target.tags));
  const out = [];
  for (const q of queue) {
    if (q.id === target.id) continue;
    const qtags = visibleTags(q.tags);
    const shared = qtags.filter(t => targetTags.has(t));
    if (shared.length === 0) continue;
    let score = shared.length / Math.max(targetTags.size + qtags.length, 1) * 2;
    if (target.feel && q.feel) score += 0.2;
    if ((target.importance || 5) >= 7 && (q.importance || 5) >= 7) score += 0.1;
    out.push({ id: q.id, title: q.title, score: Math.min(1, score), date: q.timeHint?.slice(0, 10) || '', hint: '同批 · 共享 ' + shared.join('/') });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, topN || 3);
}

// RedehydrateModal 已抽到 v2/redehy-modal.js — 工作台 + ItemModal 编辑界面共用 window.RedehydrateModal

function ImportWorkbench() {
  const [queue, setQueue] = iwS([]);
  const [loading, setLoading] = iwS(true);
  const [loadError, setLoadError] = iwS(null);
  const [activeId, setActiveId] = iwS(null);
  const [filter, setFilter] = iwS('pending');
  const [editing, setEditing] = iwS(null);
  const [rawOpen, setRawOpen] = iwS(false);
  // 原文编辑态 — 工作台"原文"显式按钮触发, 跟 body/title/summary 的"点开就改"区别开
  // (原文重要, 改动需要额外一次点击确认避免误改)
  const [editingRaw, setEditingRaw] = iwS(false);
  const [rawDraft, setRawDraft] = iwS('');
  const [savingRaw, setSavingRaw] = iwS(false);
  const [tagInput, setTagInput] = iwS(false);
  const [tagDraft, setTagDraft] = iwS('');
  const [toast, setToast] = iwS(null);
  const [over, setOver] = iwS(false);
  const fileRef = iwR(null);

  // 上传相关
  const [uploading, setUploading] = iwS(false);
  const [importStatus, setImportStatus] = iwS(null);  // 后端 import_engine 状态
  const importPollRef = iwR(null);                     // 轮询定时器
  const importDismissedRef = iwR(false);               // 用户主动关掉进度条后不再自动展示
  const [pasteOpen, setPasteOpen] = iwS(false);
  const [pasteText, setPasteText] = iwS('');
  const [pasteName, setPasteName] = iwS('');

  // 全库相似 cache(key=bucket_id)
  const [similarCache, setSimilarCache] = iwS({});
  const [similarLoading, setSimilarLoading] = iwS(false);
  // 全库相似过滤:只显示已精修(隐藏待办/存疑/无状态),处理大量待办时避免合并俩半成品
  const [simShowRefinedOnly, setSimShowRefinedOnly] = iwS(false);

  // 全库相似"查看"打开的完整 modal
  const [previewItem, setPreviewItem] = iwS(null);

  // 重新脱水中的 bucket id(避免重复点)
  const [redehydrating, setRedehydrating] = iwS(null);
  // 重新脱水弹窗 + 预览态
  const [redehyModalOpen, setRedehyModalOpen] = iwS(false);
  const [redehyPreview, setRedehyPreview] = iwS(null);  // null = options 阶段; obj = preview 阶段

  // 会话开销累计 — { usd, cny, count, lastLabel, lastUsd }
  const [sessionCost, setSessionCost] = iwS({ usd: 0, cny: 0, count: 0, lastLabel: '', lastUsd: 0 });
  const addSessionCost = (cost, label) => {
    setSessionCost(s => ({
      usd: +(s.usd + (cost.usd || 0)).toFixed(6),
      cny: +(s.cny + (cost.cny || 0)).toFixed(4),
      count: s.count + 1,
      lastLabel: label,
      lastUsd: cost.usd || 0,
    }));
  };

  // 合并预览状态:{ a:{id,name}, b:{id,name}, merged_content, tags, domain, importance, valence, arousal, b_summary, b_event_time, b_created }
  const [mergePreview, setMergePreview] = iwS(null);
  const [mergeLoading, setMergeLoading] = iwS(false);  // preview 或 commit 进行中
  const [mergeLoadingPair, setMergeLoadingPair] = iwS(null);  // {aName, bName} 首次合并 loading 遮罩展示用

  // 试跑模式:导入时只跑前 N 个 chunk(控成本)
  const [sampleMode, setSampleMode] = iwS(false);
  const [sampleChunks, setSampleChunks] = iwS(5);
  // 导入分量模式: 'large' (大批量, 宁缺勿滥, 默认) | 'small' (补漏 · 必出 1 条)
  // 大份量稳定 = 5-06 朋友那版的行为, 漏的 chunk 用户用 SMALL 模式手动补即可
  const [importMode, setImportMode] = iwS('large');

  // hover 详情卡:hover 相似项时弹出
  const [hoverItem, setHoverItem] = iwS(null);
  const [hoverPos, setHoverPos] = iwS({ x: 0, y: 0 });
  const [hoverDetail, setHoverDetail] = iwS({});  // id → {body, tags, ...}
  const hoverTimerRef = iwR(null);

  // ---------- 拉真实数据 ----------
  const fetchQueue = iwC(async (opts = {}) => {
    try {
      if (!opts.silent) setLoadError(null);
      const rows = await window.__obImportResults(500);
      setQueue(rows.map(bucketToItem));
      setLoading(false);
    } catch (e) {
      console.error('[import-workbench] load failed', e);
      // 静默模式(轮询触发):只在 console 报错,不弹红色 banner
      if (!opts.silent) setLoadError(e.message || String(e));
      setLoading(false);
    }
  }, []);

  iwE(() => { fetchQueue(); }, [fetchQueue]);

  // ---------- 导入进度轮询 ----------
  const stopImportPolling = () => {
    if (importPollRef.current) {
      clearInterval(importPollRef.current);
      importPollRef.current = null;
    }
  };

  const startImportPolling = () => {
    if (importPollRef.current) return;  // 已在轮询
    importDismissedRef.current = false;
    const tick = async () => {
      try {
        const s = await window.__obImportStatus();
        setImportStatus(s);
        // 跑着的时候顺手刷队列让新桶实时浮现(silent:502 时别弹红 banner)
        if (s.status === 'running') {
          fetchQueue({ silent: true });
        }
        if (s.status === 'completed' || s.status === 'error' || s.status === 'idle') {
          stopImportPolling();
          fetchQueue({ silent: true });
          // 完成后:有产出才自动收(12 秒);0 产出 / 解析失败 → 一直挂着等用户手动关
          const hasOutput = (s.memories_created || 0) + (s.memories_merged || 0) + (s.memories_raw || 0) > 0;
          if (s.status === 'completed' && hasOutput && s.last_llm_parsed_ok !== false) {
            setTimeout(() => {
              setImportStatus(prev => prev && prev.status === 'completed' ? null : prev);
            }, 12000);
          }
          // error 永远挂着;0 产出永远挂着;让用户看 last_llm_output 诊断
        }
      } catch (e) {
        console.warn('[import status] poll fail', e);
      }
    };
    tick();  // 立刻拉一次
    importPollRef.current = setInterval(tick, 1500);
  };

  // 页面卸载时停轮询
  iwE(() => () => stopImportPolling(), []);

  // 启动时若后端正在跑(刷新页面回来),也接上轮询
  iwE(() => {
    (async () => {
      try {
        const s = await window.__obImportStatus();
        if (s && (s.status === 'running' || s.status === 'paused')) {
          setImportStatus(s);
          startImportPolling();
        }
      } catch (e) { /* ignore */ }
    })();
  }, []);

  // 派生:过滤
  const filtered = iwM(() => {
    if (filter === 'all') return queue;
    return queue.filter(q => q.status === filter);
  }, [queue, filter]);

  // 进度
  const refinedCount = queue.filter(q => q.status === 'refined').length;
  const totalCount = queue.length;

  // 派生 batch(单批次,从 queue 统计反推)
  const batch = iwM(() => ({
    id: 'recent',
    name: '最近导入',
    source: 'Mixed',
    importedAt: queue[0]?.timeHint || '',
    total: totalCount,
    refined: refinedCount,
    raw: '—',
    note: '工作台显示最近 500 条记忆库桶,精修后状态会同步保存。',
  }), [queue, totalCount, refinedCount]);

  // 默认选中第一个 pending
  iwE(() => {
    if (!activeId || !queue.find(q => q.id === activeId)) {
      const first = queue.find(q => q.status === 'pending') || queue[0];
      if (first) setActiveId(first.id);
    }
  }, [queue]);

  const active = queue.find(q => q.id === activeId);

  // 选中后 lazy-load body + 同批相似 + 全库相似
  iwE(() => {
    if (!active) return;
    // body: 只在没加载过且 body 是 preview 时拉
    if (!active._bodyLoaded) {
      window.__obFetchBucketDetail(active.id).then(d => {
        setQueue(qs => qs.map(q => q.id === active.id ? {
          ...q,
          body: d.content || '',
          rawSource: (d.metadata && d.metadata.raw_source) || q.rawSource,
          _bodyLoaded: true,
        } : q));
      }).catch(e => console.warn('detail load fail', e));
    }
    // 全库相似(异步,不阻塞 UI),拉 20 条让用户在隐藏滚动条里浏览
    if (!similarCache[active.id]) {
      setSimilarLoading(true);
      window.__obFetchSimilar(active.id, 20).then(sim => {
        setSimilarCache(c => ({ ...c, [active.id]: sim }));
        setSimilarLoading(false);
      }).catch(e => {
        console.warn('similar fetch fail', e);
        setSimilarCache(c => ({ ...c, [active.id]: [] }));
        setSimilarLoading(false);
      });
    }
  }, [activeId]);

  // ---------- 编辑(乐观更新 + 后端同步) ----------
  const updateActive = async (patch) => {
    if (!activeId) return;
    setQueue(qs => qs.map(q => q.id === activeId ? { ...q, ...patch } : q));
    try {
      await window.__obUpdateBucket(activeId, patch);
    } catch (e) {
      alert('保存失败:' + e.message + '\n刷新中...');
      await fetchQueue();
    }
  };

  // 原文保存 — 跟 updateActive 分开是因为本地字段名 (rawSource camelCase) 跟
  // 后端字段名 (raw_source snake_case) 不同, 直接 spread 会两份并存。
  // 8KB 上限对齐 bucket_manager.update 的截断点。
  const saveRaw = async () => {
    if (!activeId || savingRaw) return;
    const trunc = String(rawDraft || '').slice(0, 8000);
    setSavingRaw(true);
    setQueue(qs => qs.map(q => q.id === activeId ? { ...q, rawSource: trunc } : q));
    try {
      await window.__obUpdateBucket(activeId, { raw_source: trunc });
      setEditingRaw(false);
      setRawDraft('');
      setToast({ msg: '原文已保存' });
    } catch (e) {
      alert('原文保存失败:' + e.message + '\n刷新中...');
      await fetchQueue();
    } finally {
      setSavingRaw(false);
    }
  };

  // ---------- 重新脱水: 两步 — preview (生成预览) → commit (确认写入) ----------
  // 入口:打开弹窗 (Phase 1 选项)
  const openRedehydrateModal = () => {
    if (!active || redehydrating) return;
    setRedehyPreview(null);
    setRedehyModalOpen(true);
  };

  const closeRedehydrateModal = () => {
    if (redehydrating) return;
    setRedehyModalOpen(false);
    setRedehyPreview(null);
  };

  // 跑预览 (调 /redehydrate, 不写盘)
  const runRedehydratePreview = async ({ regenerate_content }) => {
    if (!active || redehydrating) return;
    setRedehydrating(active.id);
    const label = regenerate_content ? '正在生成预览(含正文)…' : '正在生成预览…';
    setToast({ msg: label });
    try {
      const r = await fetch('/api/bucket/' + encodeURIComponent(active.id) + '/redehydrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regenerate_content: !!regenerate_content }),
      });
      const data = await r.json();
      if (!r.ok) {
        if (data.raw_output) console.warn('[redehydrate] LLM 原始输出:', data.raw_output);
        const snippet = data.raw_output ? '\n\nLLM 原文片段(已打到 console):\n' + String(data.raw_output).slice(0, 200) : '';
        throw new Error((data.error || ('HTTP ' + r.status)) + snippet);
      }
      setRedehyPreview(data);
      if (data.cost && data.cost.known) {
        addSessionCost(data.cost, regenerate_content ? '重新脱水预览(含正文)' : '重新脱水预览');
      }
      setToast(null);
    } catch (e) {
      console.error('[redehydrate preview] failed', e);
      const msg = e.message || String(e);
      let friendly = msg;
      if (/503|UNAVAILABLE|high demand|overloaded/i.test(msg)) {
        friendly = '当前模型暂时过载(503),等几分钟再试。\n或在 /v2/console/config/ 切换到另一个 profile。\n\n原始错误:\n' + msg;
      } else if (/429|rate|quota/i.test(msg)) {
        friendly = '触发 API 速率限制(429)。等一会儿再试。\n\n原始错误:\n' + msg;
      } else if (/401|403|invalid.*key|authentication/i.test(msg)) {
        friendly = 'API key 验证失败 — 去 /v2/console/config/ 检查 profile。\n\n原始错误:\n' + msg;
      } else if (/无法解析|parse|JSON/i.test(msg)) {
        friendly = 'LLM 输出无法解析(可能截断或非 JSON)。建议换个能力更强的 profile 重试。\n\n原始错误:\n' + msg;
      } else if (/无原文|raw_source/i.test(msg)) {
        friendly = '此条没有保存原文(raw_source),无法重新提炼正文。请取消勾选后再试。\n\n原始错误:\n' + msg;
      }
      alert('生成预览失败:\n\n' + friendly);
      setToast(null);
    } finally {
      setRedehydrating(null);
    }
  };

  // 用户在预览界面点"接受" → commit (调 /redehydrate-commit, 写入)
  const commitRedehydrate = async (finalDraft) => {
    if (!active || redehydrating) return;
    setRedehydrating(active.id);
    setToast({ msg: '正在写入…' });
    try {
      const r = await fetch('/api/bucket/' + encodeURIComponent(active.id) + '/redehydrate-commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(finalDraft),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      // 同步本地 queue
      const visibleTagsArr = (finalDraft.tags || []).filter(t => !String(t).startsWith('__'));
      setQueue(qs => qs.map(q => q.id === active.id ? {
        ...q,
        title: finalDraft.name || q.title,
        summary: finalDraft.summary || q.summary,
        tags: visibleTagsArr.concat((q.tags || []).filter(t => String(t).startsWith('__'))),
        body: finalDraft.content !== undefined ? finalDraft.content : q.body,
      } : q));
      const applied = (data.applied || []).join('/');
      setToast({ msg: `已写入 · 更新: ${applied || '无字段'}` });
      setTimeout(() => setToast(null), 3500);
      setRedehyModalOpen(false);
      setRedehyPreview(null);
    } catch (e) {
      console.error('[redehydrate commit] failed', e);
      alert('写入失败:\n' + (e.message || String(e)));
      setToast(null);
    } finally {
      setRedehydrating(null);
    }
  };

  // ---------- 合并到全库相似项(预览 → 重做 → 接受) ----------
  const fetchMergePreview = async (a, b) => {
    setMergeLoading(true);
    try {
      const r = await fetch(`/api/bucket/${encodeURIComponent(a.id)}/merge-preview?into=${encodeURIComponent(b.id)}`, {
        method: 'POST',
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      setMergePreview(data);
      if (data.cost && data.cost.known) addSessionCost(data.cost, '合并预览');
    } catch (e) {
      alert('合并预览失败:\n' + e.message);
      setMergePreview(null);
    } finally {
      setMergeLoading(false);
    }
  };

  const startMerge = async (simItem) => {
    if (!active) return;
    if (mergeLoading) return;
    // simItem = 全库相似项,active = 工作台当前条目;A=active(新), B=sim(老)
    setMergeLoadingPair({ aName: active.title, bName: simItem.name });
    try {
      await fetchMergePreview(active, { id: simItem.id, name: simItem.name });
    } finally {
      setMergeLoadingPair(null);
    }
  };

  const rerollMerge = async () => {
    if (!mergePreview) return;
    await fetchMergePreview(mergePreview.a, mergePreview.b);
  };

  // editedDraft 是用户在 modal 里改过的草稿(可能 = 原始预览,也可能改了字段)
  const commitMerge = async (editedDraft) => {
    if (!mergePreview || mergeLoading) return;
    setMergeLoading(true);
    try {
      // 优先用 editedDraft.body(用户编辑过的内容),没有就退到原始预览的 merged_content
      const finalContent = (editedDraft && editedDraft.body) || mergePreview.merged_content;
      const r = await fetch(`/api/bucket/${encodeURIComponent(mergePreview.a.id)}/merge-commit?into=${encodeURIComponent(mergePreview.b.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merged_content: finalContent }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      const aId = mergePreview.a.id;
      const bId = mergePreview.b.id;
      const bName = (editedDraft && editedDraft.title) || mergePreview.b.name;
      // 如果用户在 modal 里改了 title/summary/tags/importance,顺手 update 一下 B
      if (editedDraft) {
        const extraPatch = {};
        if (editedDraft.title && editedDraft.title !== mergePreview.b.name) extraPatch.title = editedDraft.title;
        if (editedDraft.summary != null) extraPatch.summary = editedDraft.summary;
        if (editedDraft.tags) extraPatch.tags = editedDraft.tags;
        if (editedDraft.importance != null) extraPatch.importance = editedDraft.importance;
        if (Object.keys(extraPatch).length > 0) {
          try { await window.__obUpdateBucket(bId, extraPatch); }
          catch (e) { console.warn('[merge] post-commit field update failed', e); }
        }
      }
      // 乐观:从 queue 抹掉 A;从 similarCache 各 key 里抹掉 A 也抹掉 B(B 已变,缓存失效)
      setQueue(qs => qs.filter(q => q.id !== aId));
      setSimilarCache(c => {
        const next = {};
        for (const k of Object.keys(c)) {
          if (k === aId) continue;  // A 没了,它的 cache 直接丢
          next[k] = (c[k] || []).filter(s => s.id !== aId && s.id !== bId);
        }
        return next;
      });
      // 切到下一条 pending(A 没了,activeId 失效)
      setActiveId(prev => {
        if (prev !== aId) return prev;
        const remain = queue.filter(q => q.id !== aId);
        const next = remain.find(q => q.status === 'pending') || remain[0];
        return next ? next.id : null;
      });
      setMergePreview(null);
      setToast({ msg: `已合并到「${bName}」,A 已删除` });
      setTimeout(() => setToast(null), 3000);
    } catch (e) {
      alert('合并提交失败:\n' + e.message);
    } finally {
      setMergeLoading(false);
    }
  };

  // ---------- 全库相似"查看"→ 打开完整 modal ----------
  // 把后端 detail 重塑成 ItemModal 期望的 mock shape
  const reshapeBucketDetail = (id, detail, fallback) => {
    const meta = (detail && detail.metadata) || {};
    const evt = meta.event_time || meta.created || '';
    const date = evt && evt.length >= 10 ? evt.slice(0, 10) : (fallback?.date || '2026-01-01');
    const time = evt && evt.length >= 16 ? evt.slice(11, 16) : (fallback?.time || '00:00');
    const tags = (meta.tags || []).slice();
    return {
      id,
      date,
      time,
      title: meta.name || fallback?.name || id,
      summary: meta.summary || (detail && detail.content || '').slice(0, 200) || fallback?.summary || '',
      body: (detail && detail.content) || '',
      importance: meta.importance != null ? meta.importance : 5,
      tags,
      // 注: 不再 OR meta.pinned — utils.is_protected/is_highlighted 已正确处理 legacy fallback
      protected: !!meta.protected,
      feel: meta.type === 'feel',
      highlight: !!meta.highlight,
      internalized: !!(meta.internalized || meta.digested),
      artifacts: [],
    };
  };

  const openSimPreview = async (sim) => {
    setPreviewItem({ id: sim.id, title: sim.name || sim.id, summary: sim.summary || '', body: '⌛ 加载完整内容…', importance: 5, tags: [], date: sim.date || '', time: '00:00', _loading: true });
    try {
      const detail = await window.__obFetchBucketDetail(sim.id);
      const shaped = reshapeBucketDetail(sim.id, detail, sim);
      // 防竞态:用户已经切到下一条或关掉了 modal 就别覆盖
      setPreviewItem(prev => (prev && prev.id === sim.id) ? shaped : prev);
    } catch (e) {
      console.warn('preview detail fail', e);
      setPreviewItem(prev => (prev && prev.id === sim.id) ? { ...prev, body: '(加载失败)', _loading: false } : prev);
    }
  };

  // modal 内部保存/删除回调 — 透传到后端 + 同步 similarCache + 队列
  const handlePreviewUpdate = async (id, patch) => {
    if (patch.__delete) {
      // 真实删除 + 关闭 modal + 把这条从所有 similarCache / 队列里抹掉
      setSimilarCache(c => {
        const next = {};
        for (const k of Object.keys(c)) next[k] = (c[k] || []).filter(s => s.id !== id);
        return next;
      });
      setQueue(qs => qs.filter(q => q.id !== id));
      setPreviewItem(null);
      try {
        const r = await fetch('/api/bucket/' + encodeURIComponent(id) + '/delete', { method: 'POST' });
        if (!r.ok) throw new Error(await r.text());
      } catch (e) {
        alert('删除失败:' + e.message + '\n刷新中...');
        await fetchQueue();
      }
      return;
    }
    // 普通更新:乐观刷 modal + similarCache 里的同 id 项(name/summary)
    setPreviewItem(prev => prev && prev.id === id ? { ...prev, ...patch } : prev);
    setSimilarCache(c => {
      const next = {};
      for (const k of Object.keys(c)) {
        next[k] = (c[k] || []).map(s => s.id === id ? {
          ...s,
          name: patch.title != null ? patch.title : s.name,
          summary: patch.summary != null ? patch.summary : s.summary,
        } : s);
      }
      return next;
    });
    // 如果这条同时在工作台队列里(是当前批次刚导入的),也顺手刷
    setQueue(qs => qs.map(q => q.id === id ? { ...q, ...patch } : q));
    try {
      await window.__obUpdateBucket(id, patch);
    } catch (e) {
      alert('保存失败:' + e.message);
    }
  };

  // 完成精修(toggle:再点取消回 pending)
  const markRefined = async () => {
    if (!active) return;
    const prev = { ...active };
    const wasRefined = active.status === 'refined';
    let newTags;
    if (wasRefined) {
      // 取消精修 → 回 pending
      newTags = (active.tags || []).filter(t => t !== STATUS_TAG_REFINED && t !== STATUS_TAG_FLAGGED);
    } else {
      // 标记精修(顺手清掉存疑)
      newTags = [...(active.tags || []).filter(t => t !== STATUS_TAG_FLAGGED && t !== STATUS_TAG_REFINED), STATUS_TAG_REFINED];
    }
    const newStatus = statusOf({ tags: newTags });
    setQueue(qs => qs.map(q => q.id === activeId ? { ...q, tags: newTags, status: newStatus } : q));
    try {
      await window.__obUpdateBucket(activeId, { tags: newTags });
    } catch (e) {
      alert('保存失败:' + e.message);
      await fetchQueue();
      return;
    }
    if (!wasRefined) {
      // 跳到下一条 pending
      const idx = queue.findIndex(q => q.id === activeId);
      const next = queue.slice(idx + 1).find(q => q.status === 'pending')
        || queue.find(q => q.status === 'pending' && q.id !== activeId);
      if (next) setActiveId(next.id);
    }
    setEditing(null);
    setRawOpen(false);
    setEditingRaw(false);
    setRawDraft('');
    setToast({
      msg: wasRefined ? `已撤销精修标记 "${prev.title}"` : `已精修 "${prev.title}"`,
      undo: async () => {
        const restored = (prev.tags || []).slice();
        setQueue(qs => qs.map(q => q.id === prev.id ? { ...q, tags: restored, status: statusOf({ tags: restored }) } : q));
        setActiveId(prev.id);
        setToast(null);
        try { await window.__obUpdateBucket(prev.id, { tags: restored }); }
        catch (e) { alert('撤销失败:' + e.message); }
      },
    });
    setTimeout(() => setToast(t => (t && t.msg.includes(prev.title)) ? null : t), 4500);
  };

  // 标记存疑(toggle:再点取消回 pending)
  const flagItem = async () => {
    if (!active) return;
    const wasFlagged = active.status === 'flagged';
    let newTags;
    if (wasFlagged) {
      newTags = (active.tags || []).filter(t => t !== STATUS_TAG_FLAGGED && t !== STATUS_TAG_REFINED);
    } else {
      newTags = [...(active.tags || []).filter(t => t !== STATUS_TAG_REFINED && t !== STATUS_TAG_FLAGGED), STATUS_TAG_FLAGGED];
    }
    const newStatus = statusOf({ tags: newTags });
    setQueue(qs => qs.map(q => q.id === activeId ? { ...q, tags: newTags, status: newStatus } : q));
    try {
      await window.__obUpdateBucket(activeId, { tags: newTags });
    } catch (e) {
      alert('保存失败:' + e.message);
      await fetchQueue();
      return;
    }
    if (!wasFlagged) {
      const idx = queue.findIndex(q => q.id === activeId);
      const next = queue.slice(idx + 1).find(q => q.status === 'pending');
      if (next) setActiveId(next.id);
    }
  };

  // 不入库 — 软删除(移到回收站,可恢复)
  const deleteItem = async () => {
    if (!active) return;
    if (!confirm(`不入库「${active.title}」?\n移到回收站,可在 /v2/console/trash/ 恢复。`)) return;
    try {
      await window.__obDeleteBucket(activeId);
    } catch (e) {
      alert('删除失败:' + e.message);
      return;
    }
    const idx = queue.findIndex(q => q.id === activeId);
    setQueue(qs => qs.filter(q => q.id !== activeId));
    const remaining = queue.filter(q => q.id !== activeId);
    const next = remaining[idx] || remaining[idx - 1];
    if (next) setActiveId(next.id);
    else setActiveId(null);
  };

  // tag 操作 — 只对可见 tag 操作,不能删隐藏的状态 tag
  const removeTag = (t) => {
    if (String(t).startsWith('__')) return;
    updateActive({ tags: (active.tags || []).filter(x => x !== t) });
  };
  const addTag = () => {
    const v = tagDraft.trim();
    if (v && !v.startsWith('__') && !(active.tags || []).includes(v)) {
      updateActive({ tags: [...(active.tags || []), v] });
    }
    setTagDraft('');
    setTagInput(false);
  };

  // ---------- 上传 ----------
  const handleFiles = async (files) => {
    if (!files || !files.length) return;
    const maxChunks = sampleMode ? Math.max(1, parseInt(sampleChunks, 10) || 5) : 0;
    if (sampleMode) {
      const ok = window.confirm(`试跑模式开启:每个文件只解析前 ${maxChunks} 个对话块(约 ${maxChunks * 12} KB)。\n用于试水,看效果和实际花费再决定要不要全量。\n继续?`);
      if (!ok) return;
    }
    setUploading(true);
    let succeeded = 0;
    for (const f of files) {
      try {
        await window.__obImportFile(f, maxChunks, importMode);
        succeeded++;
      } catch (e) {
        alert(`上传 ${f.name} 失败:` + e.message);
      }
    }
    setUploading(false);
    if (succeeded > 0) {
      const modeTag = importMode === 'small' ? ' · 小分量(补漏)' : '';
      const tag = (maxChunks > 0 ? ` (试跑 · 前 ${maxChunks} 块)` : '') + modeTag;
      setToast({ msg: `已开始解析 ${succeeded} 个文件${tag}` });
      setTimeout(() => setToast(null), 4000);
      startImportPolling();  // 启动进度轮询,1.5s 一次
    }
  };

  const submitPaste = async () => {
    if (!pasteText.trim()) { alert('请粘贴对话内容'); return; }
    setUploading(true);
    try {
      await window.__obImportPasteText(pasteText, pasteName.trim() || undefined, importMode);
      setToast({ msg: '已开始解析粘贴的内容' });
      setTimeout(() => setToast(null), 3000);
      startImportPolling();
      setPasteText('');
      setPasteName('');
      setPasteOpen(false);
    } catch (e) {
      alert('上传失败:' + e.message);
    }
    setUploading(false);
  };

  // ESC 退出编辑
  iwE(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setEditing(null);
        setTagInput(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 拖拽
  const onDrop = (e) => {
    e.preventDefault();
    setOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    handleFiles(files);
  };
  const onPickFile = (e) => {
    handleFiles(Array.from(e.target.files || []));
    e.target.value = '';
  };

  // 同批相似(派生,不缓存)
  const sbSimilar = iwM(() => sameBatchSimilar(active, queue, 3), [active, queue]);
  const fullSimilar = active ? (similarCache[active.id] || []) : [];

  // hover 相似项:延迟 200ms 弹出详情卡
  const onSimEnter = (e, simItem, sourceQueue) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    const rect = e.currentTarget.getBoundingClientRect();
    hoverTimerRef.current = setTimeout(() => {
      // 同批:从 queue 找完整 item;全库:用 simItem.id 查 hoverDetail/lazy fetch
      const src = sourceQueue ? queue.find(q => q.id === simItem.id) : null;
      if (src) {
        setHoverItem({ ...src, _src: 'batch' });
      } else {
        // 全库相似:先用 simItem 现有信息,异步补 body
        setHoverItem({
          id: simItem.id,
          title: simItem.name,
          summary: simItem.summary || '',
          body: hoverDetail[simItem.id]?.content || '',
          tags: hoverDetail[simItem.id]?.tags || [],
          importance: hoverDetail[simItem.id]?.importance,
          score: simItem.score,
          date: simItem.date,
          type: simItem.type,
          _src: 'global',
          _bodyLoaded: !!hoverDetail[simItem.id],
        });
        if (!hoverDetail[simItem.id]) {
          window.__obFetchBucketDetail(simItem.id).then(d => {
            setHoverDetail(c => ({ ...c, [simItem.id]: { content: d.content, tags: d.metadata?.tags, importance: d.metadata?.importance, type: d.metadata?.type } }));
            // 如果当前还在 hover 这个 item,实时更新
            setHoverItem(prev => (prev && prev.id === simItem.id) ? {
              ...prev, body: d.content || '', tags: d.metadata?.tags || prev.tags,
              importance: d.metadata?.importance ?? prev.importance, _bodyLoaded: true,
            } : prev);
          }).catch(e => console.warn('hover detail fail', e));
        }
      }
      setHoverPos({ x: rect.left, y: rect.top });
    }, 200);
  };
  const onSimLeave = () => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    setHoverItem(null);
  };

  return (
    <>
      {/* 拖拽区 + 粘贴面板 — Claude Design v3 组件 */}
      <div
        style={{ margin: '0 28px 14px' }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={(e) => {
          // 只在真离开外框时关闭(child 内部冒泡的 leave 不触发)
          if (e.currentTarget.contains(e.relatedTarget)) return;
          setOver(false);
        }}
        onDrop={onDrop}
      >
        {window.ImportDropZone && React.createElement(window.ImportDropZone, {
          isOver: over,
          draggedFiles: null,  // 浏览器 dragover 阶段拿不到文件元数据,松手后才有,组件会回退到"松手即开始解析"
          tryMode: sampleMode,
          onTryModeChange: setSampleMode,
          importMode: importMode,
          onImportModeChange: setImportMode,
          onPickFiles: () => { if (!uploading) fileRef.current?.click(); },
          onPasteToggle: () => setPasteOpen(o => !o),
        })}
        <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={onPickFile} />

        {window.ImportPasteSheet && React.createElement(window.ImportPasteSheet, {
          open: pasteOpen,
          value: pasteText,
          filename: pasteName,
          onChange: setPasteText,
          onFilenameChange: setPasteName,
          onClose: () => setPasteOpen(false),
          onOpen: () => setPasteOpen(true),
          onClear: () => { setPasteText(''); setPasteName(''); },
          onSubmit: () => submitPaste(),
        })}
      </div>

      {/* loading / 错误 banner */}
      {loading && (
        <div style={{ margin: '0 28px 14px', padding: '12px 18px', background: 'rgba(110,79,154,0.08)', border: '1px solid rgba(110,79,154,0.2)', borderRadius: 10, color: 'var(--accent)', fontSize: 13 }}>
          正在加载工作台数据 …
        </div>
      )}
      {loadError && (
        <div style={{ margin: '0 28px 14px', padding: '12px 18px', background: 'rgba(139,74,74,0.08)', border: '1px solid rgba(139,74,74,0.3)', borderRadius: 10, color: '#8B4A4A', fontSize: 13 }}>
          加载失败:{loadError} · <a onClick={fetchQueue} style={{ cursor: 'pointer', textDecoration: 'underline' }}>重试</a>
        </div>
      )}

      {/* 导入进度横幅 — Claude Design v3 组件 */}
      {importStatus && importStatus.status !== 'idle' && !importDismissedRef.current && window.ImportProgressBanner && (
        <div style={{ margin: '0 28px 14px' }}>
          {React.createElement(window.ImportProgressBanner, {
            state: importStatus,
            onPause: async () => {
              try { await fetch('/api/import/pause', { method: 'POST' }); } catch (e) { /* ignore */ }
            },
            onResume: () => alert('继续(resume)暂未实装,请重新上传文件继续'),
            onCancel: () => { importDismissedRef.current = true; setImportStatus(null); stopImportPolling(); },
            onDismiss: () => { importDismissedRef.current = true; setImportStatus(null); },
            onRetry: () => alert('重试/跳过此块暂未实装,请重新上传文件'),
            onCopyLLM: () => {
              const txt = importStatus.last_llm_output || '';
              if (!txt) return;
              if (navigator.clipboard) {
                navigator.clipboard.writeText(txt).then(
                  () => setToast({ msg: 'LLM 原文已复制' }),
                  () => alert('复制失败,可手动选中:\n' + txt.slice(0, 500))
                );
              } else {
                alert(txt.slice(0, 500));
              }
              setTimeout(() => setToast(null), 2000);
            },
          })}
        </div>
      )}

      {/* 批次条 */}
      <div className="imp-batchbar">
        <div className="imp-batch-info">
          <div className="imp-batch-name">
            {batch.name}
            <span className="imp-batch-source">{batch.source}</span>
          </div>
          <div className="imp-batch-meta">
            <span>共 <b>{totalCount}</b> 条</span>
            <span>·</span>
            <span>已精修 <b>{refinedCount}</b></span>
            <span>·</span>
            <span>待办 <b>{queue.filter(q => q.status === 'pending').length}</b></span>
            <span>·</span>
            <span>存疑 <b>{queue.filter(q => q.status === 'flagged').length}</b></span>
          </div>
          <div className="imp-batch-note">{batch.note}</div>
        </div>

        <div className="imp-progress">
          <div className="imp-progress-label">
            <b>{refinedCount} / {totalCount}</b>
            已精修
          </div>
          <div className="imp-progress-ring">
            <svg width="56" height="56">
              <circle cx="28" cy="28" r="24" className="bg" />
              <circle
                cx="28" cy="28" r="24"
                className="fg"
                strokeDasharray={2 * Math.PI * 24}
                strokeDashoffset={2 * Math.PI * 24 * (1 - refinedCount / Math.max(1, totalCount))}
              />
            </svg>
            <div className="imp-progress-num">{Math.round(refinedCount / Math.max(1, totalCount) * 100)}%</div>
          </div>
        </div>

        <div className="imp-batch-switch">
          <button className="imp-batch-pill on" onClick={fetchQueue} title="刷新工作台">
            ↻ 刷新
          </button>
        </div>
      </div>

      {/* 三栏 */}
      <div className="imp-shell">

        {/* 左队列 */}
        <aside className="imp-queue">
          <div className="imp-queue-hd">
            <div className="imp-queue-title">队列 · {filtered.length} / {totalCount}</div>
            <div className="imp-queue-filters">
              {[
                ['pending', '待办'],
                ['flagged', '存疑'],
                ['refined', '已精修'],
                ['all', '全部'],
              ].map(([k, label]) => (
                <button
                  key={k}
                  className={`imp-queue-fpill${filter === k ? ' on' : ''}`}
                  onClick={() => setFilter(k)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="imp-queue-list">
            {filtered.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--ink-4)', fontSize: 12, fontStyle: 'italic' }}>
                此分类暂无条目
              </div>
            )}
            {filtered.map(q => (
              <div
                key={q.id}
                className={`imp-q-item ${q.status} ${q.id === activeId ? 'active' : ''}`}
                onClick={() => { setActiveId(q.id); setEditing(null); setRawOpen(false); setEditingRaw(false); setRawDraft(''); }}
              >
                <div className="imp-q-status" />
                <div className="imp-q-body">
                  <div className="imp-q-title">{q.title}</div>
                  <div className="imp-q-meta">
                    {q.feel && <span className="imp-q-feel">♡</span>}
                    {q.protected && <span style={{ color: 'var(--accent)' }}>❖</span>}
                    <span>imp <b>{q.importance}</b></span>
                    {q.timeHint && <span>· {q.timeHint.slice(5, 10)}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* 中间信纸卡 */}
        <main>
          {active ? (
            <article className="imp-paper">
              <div className="imp-paper-meta">
                <span className="imp-paper-id">{active.id.slice(0, 12).toUpperCase()}</span>
                <span>{active.timeHint}</span>
              </div>

              {/* 标题 */}
              <h1
                className={`imp-paper-title${editing === 'title' ? ' editing' : ''}`}
                onClick={() => editing !== 'title' && setEditing('title')}
              >
                {editing === 'title' ? (
                  <input
                    autoFocus
                    value={active.title}
                    onChange={(e) => setQueue(qs => qs.map(q => q.id === activeId ? { ...q, title: e.target.value } : q))}
                    onBlur={() => { updateActive({ title: active.title }); setEditing(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { updateActive({ title: active.title }); setEditing(null); } }}
                  />
                ) : active.title}
              </h1>

              <div className="imp-paper-when">
                {active.timeHint} · 已脱水 {active.body?.length || 0} 字
              </div>

              {/* AI 建议横幅(后端没存,有就显示,没就不渲染 — 留位以待将来) */}
              {active.suggestion && (
                <div className="imp-suggestion" style={{ marginBottom: 32 }}>
                  <div className="imp-suggestion-tag">
                    {active.suggestion === 'split' ? '↯ 建议拆分' : '⚯ 建议合并'}
                  </div>
                  <div className="imp-suggestion-body">{active.suggestionDetail}</div>
                  <div className="imp-suggestion-actions">
                    <button className="imp-sim-act">采纳</button>
                    <button className="imp-sim-act">忽略</button>
                    <button className="imp-sim-act">查看对比</button>
                  </div>
                </div>
              )}

              {/* 摘要 */}
              <div className="imp-field-label">摘要</div>
              <div
                className={`imp-paper-summary${editing === 'summary' ? ' editing' : ''}`}
                onClick={() => editing !== 'summary' && setEditing('summary')}
              >
                {editing === 'summary' ? (
                  <textarea
                    autoFocus
                    value={active.summary}
                    onChange={(e) => setQueue(qs => qs.map(q => q.id === activeId ? { ...q, summary: e.target.value } : q))}
                    onBlur={() => { updateActive({ summary: active.summary }); setEditing(null); }}
                  />
                ) : (active.summary || <span style={{ color: 'var(--ink-4)' }}>(无摘要,正文首段会作为摘要)</span>)}
              </div>

              {/* 正文 */}
              <div className="imp-field-label">正文</div>
              <div
                className={`imp-paper-summary${editing === 'body' ? ' editing' : ''}`}
                onClick={() => editing !== 'body' && setEditing('body')}
                style={{ fontSize: 14, fontFamily: 'var(--sans)', lineHeight: 1.8, marginBottom: 24 }}
              >
                {editing === 'body' ? (
                  <textarea
                    autoFocus
                    value={active.body}
                    onChange={(e) => setQueue(qs => qs.map(q => q.id === activeId ? { ...q, body: e.target.value } : q))}
                    onBlur={() => { updateActive({ body: active.body }); setEditing(null); }}
                    style={{ minHeight: 140 }}
                  />
                ) : (active.body || <span style={{ color: 'var(--ink-4)' }}>{active._bodyLoaded ? '(正文为空)' : '⌛ 加载中…'}</span>)}
              </div>

              {/* 原文抽屉(只在后端 preserve_raw 留了原文时显示)
                  编辑态: 右下角不明显 [✎ 编辑] → textarea 替换 + [取消][保存]
                  原文重要, 故"显式按钮触发"区别于 body/title/summary 的"点开就改" */}
              {active.rawSource && (() => {
                const draftLen = (rawDraft || '').length;
                const overLimit = draftLen > 8000;
                return (
                <div className={`imp-raw${rawOpen ? ' open' : ''}${editingRaw ? ' editing' : ''}`}>
                  <div
                    className="imp-raw-trigger"
                    onClick={() => { if (!editingRaw) setRawOpen(o => !o); }}
                    style={editingRaw ? { cursor: 'not-allowed' } : undefined}
                  >
                    <span>
                      <span className="imp-raw-arrow">▸</span> &nbsp;
                      查看原文 <b>·</b> 来源对话片段{editingRaw ? ' · 编辑中' : ''}
                    </span>
                    <span style={{ opacity: 0.6 }}>
                      {editingRaw
                        ? `${draftLen} / 8000${overLimit ? ' · 会截断' : ''}`
                        : `${active.rawSource.split('\n').length} 行`}
                    </span>
                  </div>
                  <div className="imp-raw-body">
                    {editingRaw ? (
                      <div className="imp-raw-edit-wrap">
                        <textarea
                          className="imp-raw-edit-textarea"
                          value={rawDraft}
                          onChange={(e) => setRawDraft(e.target.value)}
                          autoFocus
                          placeholder="补全或修订原文片段。保留说话人前缀(用户:/AI:) 让以后「重新脱水」锚点更准。"
                        />
                      </div>
                    ) : (
                      <div className="imp-raw-content">{active.rawSource}</div>
                    )}
                    <div className="imp-raw-foot">
                      {editingRaw ? (
                        <>
                          <button
                            type="button"
                            className="imp-raw-edit-btn"
                            onClick={() => { setEditingRaw(false); setRawDraft(''); }}
                            disabled={savingRaw}
                          >取消</button>
                          <button
                            type="button"
                            className="imp-raw-edit-btn primary"
                            onClick={saveRaw}
                            disabled={savingRaw}
                          >{savingRaw ? '⌛ 保存中…' : '保存'}</button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="imp-raw-edit-btn"
                          onClick={() => { setRawDraft(active.rawSource || ''); setEditingRaw(true); }}
                          title="原文重要,点击进入编辑态(避免误改)"
                        >✎ 编辑</button>
                      )}
                    </div>
                  </div>
                </div>
                );
              })()}

              {/* tags */}
              <div className="imp-field-label">标签</div>
              <div className="imp-paper-tags">
                {visibleTags(active.tags).map(t => {
                  const isFeel = t.startsWith('feel');
                  const isProtect = t === '保护';
                  return (
                    <span
                      key={t}
                      className={`imp-tag-chip${isFeel ? ' feel' : ''}${isProtect ? ' protect' : ''}`}
                      onClick={() => removeTag(t)}
                    >
                      #{t}<span className="imp-tag-x">×</span>
                    </span>
                  );
                })}
                {tagInput ? (
                  <input
                    className="imp-tag-input"
                    autoFocus
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onBlur={addTag}
                    onKeyDown={(e) => { if (e.key === 'Enter') addTag(); if (e.key === 'Escape') { setTagInput(false); setTagDraft(''); } }}
                    placeholder="新标签…"
                  />
                ) : (
                  <button className="imp-tag-add" onClick={() => setTagInput(true)}>+ 添加</button>
                )}
              </div>

              {/* 属性 */}
              <div className="imp-attrs">
                <div className="imp-attr-row">
                  <div className="imp-attr-key">重要度</div>
                  <div className="imp-imp-bar">
                    <div className="imp-imp-track"
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        const v = Math.round(((e.clientX - r.left) / r.width) * 10);
                        updateActive({ importance: Math.max(1, Math.min(10, v)) });
                      }}
                    >
                      <div className="imp-imp-fill" style={{ width: `${(active.importance || 0) * 10}%` }} />
                    </div>
                    <span className="imp-imp-num">{active.importance}</span>
                  </div>
                </div>
                {/* 权重 score: 完整显示, 跟 importance 一行下面;
                    类型/事件时间被推到这后面 */}
                {typeof active.score === 'number' && (
                  <div className="imp-attr-row">
                    <div className="imp-attr-key">权重 score</div>
                    <div style={{
                      flex: 1,
                      fontFamily: 'var(--mono)',
                      fontSize: 13,
                      color: 'var(--ink-2)',
                      letterSpacing: '0.04em',
                    }}>
                      {active.score.toFixed(2)}
                      <span style={{ marginLeft: 10, fontSize: 10, color: 'var(--ink-4)' }}>
                        {active.score >= 100 ? '· 永久 / 钉决' :
                         active.score >= 5 ? '· 活跃' :
                         active.score >= 1 ? '· 一般' :
                         active.score >= 0.3 ? '· 临近归档' : '· 即将归档'}
                      </span>
                    </div>
                  </div>
                )}
                {/* 来源 — 三态 pill, 直接 click 切换 (改错恢复成本低, 不需要"显式编辑"门).
                    历史 'ai' 桶过工作台时一键改成 import/user, 下次新导入直接是 import */}
                <div className="imp-attr-row">
                  <div className="imp-attr-key">来源</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
                    {[['import', '导入'], ['ai', 'AI 写入'], ['user', '亲手写']].map(([k, label]) => (
                      <button
                        key={k}
                        className={`imp-batch-pill${(active.createdBy || 'ai') === k ? ' on' : ''}`}
                        title={k === 'import' ? '从聊天记录导入的(主流)' : k === 'ai' ? 'AI 主动写入(breath/grow)' : '在写入抽屉手写的'}
                        onClick={() => updateActive({ createdBy: k })}
                        style={{ whiteSpace: 'nowrap' }}
                      >{label}</button>
                    ))}
                  </div>
                </div>
                <div className="imp-attr-row">
                  <div className="imp-attr-key">类型</div>
                  {/* 默认 = 动态 (无 active button); 钉决/噪声 互斥, 高亮 独立可叠加 */}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      className={`imp-batch-pill${active.protected ? ' on tone-pin' : ''}`}
                      title="钉决: 永不衰减归档, importance 锁 10"
                      onClick={() => updateActive({ protected: !active.protected, noise: false })}
                    >钉决</button>
                    <button
                      className={`imp-batch-pill${active.highlight && !active.protected ? ' on tone-highlight' : ''}`}
                      title={active.protected ? '钉决已含「高亮」效果, 取消钉决后此项才生效' : '高亮: 浮现优先 + score 加成 (跟类型独立, 可叠加)'}
                      onClick={() => updateActive({ highlight: !active.highlight })}
                      disabled={active.protected}
                      style={active.protected ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
                    >高亮</button>
                    <button
                      className={`imp-batch-pill${active.noise ? ' on tone-noise' : ''}`}
                      title="噪声: 加速衰减(×0.05) + importance 锁 1, 几天内自动归档"
                      onClick={() => updateActive({ noise: !active.noise, protected: false })}
                    >噪声</button>
                  </div>
                </div>
                <div className="imp-attr-row">
                  <div className="imp-attr-key">情感</div>
                  <div className={`imp-toggle feel${active.feel ? ' on' : ''}`} onClick={() => updateActive({ feel: !active.feel })}>
                    <div className="imp-toggle-dot" />
                    <span style={{ fontSize: 12, color: active.feel ? 'var(--rose-deep)' : 'var(--ink-3)', fontFamily: 'var(--mono)' }}>
                      {active.feel ? '♡ feel' : '中性'}
                    </span>
                  </div>
                </div>
                <div className="imp-attr-row">
                  <div className="imp-attr-key">事件时间</div>
                  <div style={{ flex: 1, display: 'flex', gap: 6 }}>
                    <input
                      type="date"
                      value={(active.timeHint || '').slice(0, 10)}
                      onChange={(e) => {
                        // onChange 只更新本地 (避免 native picker / 输入过程中 partial 触发立即 fetch)
                        const dateOnly = e.target.value;
                        const oldTime = (active.timeHint || '').slice(11, 16);
                        setQueue(qs => qs.map(q => q.id === activeId ? { ...q, timeHint: dateOnly + (oldTime ? ' ' + oldTime : '') } : q));
                      }}
                      onBlur={(e) => {
                        // onBlur 才 fetch — 用户编辑完离开输入框, 数据完整
                        const dateOnly = e.target.value;
                        if (!dateOnly || dateOnly.length !== 10) return;  // 不完整不发请求
                        const oldTime = (active.timeHint || '').slice(11, 16) || '';
                        const eventTime = window.__obLocalToUtcIso
                          ? window.__obLocalToUtcIso(dateOnly, oldTime || '00:00')
                          : (dateOnly + 'T' + (oldTime || '00:00') + ':00');
                        window.__obUpdateBucket(activeId, { event_time: eventTime || null }).catch(err => alert('保存失败:' + err.message));
                      }}
                      style={{
                        flex: 2, padding: '6px 10px',
                        border: '1px solid var(--line)', borderRadius: 6,
                        background: 'var(--paper)', color: 'var(--ink)',
                        fontFamily: 'inherit', fontSize: 12,
                      }}
                    />
                    <input
                      type="time"
                      value={(active.timeHint || '').slice(11, 16)}
                      onChange={(e) => {
                        const timeOnly = e.target.value;
                        const dateOnly = (active.timeHint || '').slice(0, 10);
                        setQueue(qs => qs.map(q => q.id === activeId ? { ...q, timeHint: dateOnly + (timeOnly ? ' ' + timeOnly : '') } : q));
                      }}
                      onBlur={(e) => {
                        const timeOnly = e.target.value;
                        const dateOnly = (active.timeHint || '').slice(0, 10);
                        if (!dateOnly || dateOnly.length !== 10) return;  // 没日期就没法组装 ISO
                        if (!timeOnly || !/^\d{2}:\d{2}$/.test(timeOnly)) return;  // 时间不完整不发请求
                        const eventTime = window.__obLocalToUtcIso
                          ? window.__obLocalToUtcIso(dateOnly, timeOnly)
                          : (dateOnly + 'T' + timeOnly + ':00');
                        window.__obUpdateBucket(activeId, { event_time: eventTime }).catch(err => alert('保存失败:' + err.message));
                      }}
                      style={{
                        flex: 1, padding: '6px 10px',
                        border: '1px solid var(--line)', borderRadius: 6,
                        background: 'var(--paper)', color: 'var(--ink)',
                        fontFamily: 'inherit', fontSize: 12,
                      }}
                    />
                  </div>
                </div>
                <div className="imp-attr-row">
                  <div className="imp-attr-key">状态</div>
                  <span className={`imp-status-chip imp-status-${active.status}`}>
                    {active.status === 'refined' && '✓ 已精修'}
                    {active.status === 'pending' && '⌛ 待精修'}
                    {active.status === 'flagged' && '⚑ 存疑'}
                  </span>
                </div>
              </div>

              {/* 底部动作 — 精修/存疑 是 toggle,再点取消 */}
              <div className="imp-paper-actions">
                <button className="imp-act imp-act-primary" onClick={markRefined}>
                  {active.status === 'refined' ? '↺ 取消精修' : '✓ 完成精修'}
                </button>
                <button className="imp-act imp-act-skip" onClick={flagItem}>
                  {active.status === 'flagged' ? '↺ 取消存疑' : '⚑ 标记存疑'}
                </button>
                <button
                  className="imp-act"
                  onClick={openRedehydrateModal}
                  disabled={redehydrating === active.id}
                  title="LLM 重新生成标题/摘要/标签/情感(可选同时重写正文)"
                >
                  {redehydrating === active.id ? '⌛ 提炼中…' : '↻ 重新脱水'}
                </button>
                <button className="imp-act imp-act-danger" style={{ marginLeft: 'auto' }} onClick={deleteItem}>
                  ✕ 不入库
                </button>
              </div>
            </article>
          ) : (
            <div className="imp-paper imp-empty">
              <div className="imp-empty-icon">⌖</div>
              <div className="imp-empty-title">{loading ? '加载中…' : (queue.length === 0 ? '工作台空空如也' : '没有匹配的条目')}</div>
              <div className="imp-empty-sub">{queue.length === 0 ? '上传文件或粘贴对话开始第一次导入。' : '切换筛选或刷新看看。'}</div>
            </div>
          )}
        </main>

        {/* 右 AI 边注 */}
        <aside className="imp-aside">
          {active && (
            <>
              {/* 同批相似(前端基于 tag 共现算) */}
              {sbSimilar.length > 0 && (
                <div className="imp-aside-card">
                  <div className="imp-aside-title">同批相似 · {sbSimilar.length}</div>
                  <div className="imp-aside-body" style={{ marginTop: 4 }}>
                    {sbSimilar.map((s) => (
                      <div
                        key={s.id}
                        className="imp-sim-item"
                        onClick={() => setActiveId(s.id)}
                        onMouseEnter={(e) => onSimEnter(e, s, true)}
                        onMouseLeave={onSimLeave}
                        style={{ cursor: 'pointer' }}
                      >
                        <div className="imp-sim-hd">
                          <div className="imp-sim-title">{s.title}</div>
                          <div className="imp-sim-score">{Math.round(s.score * 100)}%</div>
                        </div>
                        <div className="imp-sim-hint">{s.hint}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 全库相似(后端 embedding) */}
              {(() => {
                const enriched = fullSimilar.map(s => ({ ...s, _status: statusOf({ tags: s.tags || [] }) }));
                const visible = simShowRefinedOnly ? enriched.filter(s => s._status === 'refined') : enriched;
                const hiddenCount = enriched.length - visible.length;
                // 状态点配色:待办无点(默认),已精修绿,存疑橙
                const dotColor = (st) => st === 'refined' ? '#5b8a5b' : st === 'flagged' ? '#b08040' : null;
                const dotTitle = (st) => st === 'refined' ? '已精修' : st === 'flagged' ? '存疑' : '待办';
                return (
                  <div className="imp-aside-card">
                    <div className="imp-aside-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span>
                        全库相似
                        {similarLoading && <span style={{ opacity: 0.5, fontSize: 11 }}> · 加载中</span>}
                        {!similarLoading && enriched.length > 0 && (
                          <span style={{ opacity: 0.7 }}> · {visible.length}{hiddenCount > 0 && simShowRefinedOnly ? `/${enriched.length}` : ''}</span>
                        )}
                      </span>
                      {enriched.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setSimShowRefinedOnly(v => !v)}
                          title="只看已精修的目标桶,避免合并两个待办半成品"
                          style={{
                            marginLeft: 'auto',
                            padding: '2px 8px',
                            fontSize: 10, fontFamily: 'var(--mono)',
                            letterSpacing: '0.04em',
                            background: simShowRefinedOnly ? 'color-mix(in oklab, var(--accent) 12%, var(--paper))' : 'transparent',
                            color: simShowRefinedOnly ? 'var(--accent)' : 'var(--ink-3)',
                            border: '0.5px solid ' + (simShowRefinedOnly ? 'var(--accent)' : 'var(--line-2)'),
                            borderRadius: 10, cursor: 'pointer',
                            transition: 'all 120ms ease',
                          }}
                        >仅已精修</button>
                      )}
                    </div>
                    <div
                      className="imp-aside-body imp-sim-scroll"
                      style={{ marginTop: 4, maxHeight: '52vh', overflowY: 'auto' }}
                    >
                      {enriched.length === 0 && !similarLoading && (
                        <div style={{ fontSize: 11, color: 'var(--ink-4)', fontStyle: 'italic' }}>
                          暂无显著相似(可能是 embedding 还没生成,或全库都不相似)
                        </div>
                      )}
                      {enriched.length > 0 && visible.length === 0 && !similarLoading && (
                        <div style={{ fontSize: 11, color: 'var(--ink-4)', fontStyle: 'italic' }}>
                          已精修的相似项为空。{hiddenCount} 条相似还在待办/存疑,取消勾选查看。
                        </div>
                      )}
                      {visible.map((s) => {
                        const dc = dotColor(s._status);
                        return (
                          <div
                            key={s.id}
                            className="imp-sim-item"
                            onMouseEnter={(e) => onSimEnter(e, s, false)}
                            onMouseLeave={onSimLeave}
                          >
                            <div className="imp-sim-hd">
                              <div className="imp-sim-title" style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                                {dc && (
                                  <span
                                    title={dotTitle(s._status)}
                                    style={{
                                      width: 6, height: 6, borderRadius: '50%',
                                      background: dc, flexShrink: 0,
                                      boxShadow: '0 0 0 1.5px ' + (s._status === 'refined' ? 'rgba(91,138,91,0.18)' : 'rgba(176,128,64,0.18)'),
                                    }}
                                  />
                                )}
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                              </div>
                              <div className="imp-sim-score">{Math.round(s.score * 100)}%</div>
                            </div>
                            <div className="imp-sim-hint">{s.summary?.slice(0, 60)}…{s.date && ' · ' + s.date}</div>
                            <div className="imp-sim-actions">
                              <button
                                className="imp-sim-act"
                                onClick={() => startMerge(s)}
                                disabled={mergeLoading}
                                title={s._status !== 'refined' ? '注意:这条还是待办/存疑,合并后会一起进入 B' : '把当前条目合并到这条相似的老桶里'}
                              >合并</button>
                              <button className="imp-sim-act" onClick={() => openSimPreview(s)}>查看</button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* 摘要由来 / 标签理由 / 重要度推算 — 后端没存,留位 */}
              {active.aiReasons?.summary && (
                <div className="imp-aside-card">
                  <div className="imp-aside-title">摘要由来</div>
                  <div className="imp-aside-body">{active.aiReasons.summary}</div>
                </div>
              )}
              {active.aiReasons?.tags?.length > 0 && (
                <div className="imp-aside-card">
                  <div className="imp-aside-title">标签理由</div>
                  <div className="imp-aside-body">
                    <ul>{active.aiReasons.tags.map((t, i) => <li key={i}>{t}</li>)}</ul>
                  </div>
                </div>
              )}
              {active.aiReasons?.importance && (
                <div className="imp-aside-card">
                  <div className="imp-aside-title">重要度推算</div>
                  <div className="imp-aside-body" style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>
                    {active.aiReasons.importance}
                  </div>
                </div>
              )}

              <div className="imp-aside-card" style={{ background: 'var(--bg-2)' }}>
                <div className="imp-aside-title" style={{ color: 'var(--ink-3)' }}>提示</div>
                <div className="imp-aside-body" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                  点击任意字段进入编辑,<code>Esc</code> 退出。所有改动会自动保存到记忆库 — 时间线 / 记忆格 / 星图都会同步。
                </div>
              </div>
            </>
          )}
        </aside>
      </div>

      {/* 撤销 toast */}
      {toast && (
        <div className="imp-toast">
          <span>✓ {toast.msg}</span>
          {toast.undo && <button onClick={toast.undo}>撤销</button>}
        </div>
      )}

      {/* 相似项 hover 详情卡(浮在左侧朝信纸方向,方便对比) */}
      {hoverItem && (
        <div
          className="imp-hover-card"
          style={{
            // 出现在源条目左边一点,垂直对齐源条目顶部
            // 320px 宽 + 8px 间距 + transform 微调让其不超出视口
            left: Math.max(12, hoverPos.x - 332),
            top: Math.min(hoverPos.y, window.innerHeight - 380),
          }}
        >
          <div className="imp-hover-hd">
            <div className="imp-hover-title">{hoverItem.title}</div>
            {hoverItem.score != null && (
              <div className="imp-hover-score">{Math.round(hoverItem.score * 100)}%</div>
            )}
          </div>
          {hoverItem.summary && (
            <div className="imp-hover-summary">{hoverItem.summary}</div>
          )}
          {hoverItem._src === 'global' && !hoverItem._bodyLoaded ? (
            <div className="imp-hover-body" style={{ fontStyle: 'italic', opacity: 0.6 }}>⌛ 加载完整内容…</div>
          ) : hoverItem.body ? (
            <div className="imp-hover-body">{hoverItem.body}</div>
          ) : null}
          <div className="imp-hover-meta">
            {hoverItem.feel && <span style={{ color: 'var(--rose-deep)' }}>♡ feel</span>}
            {hoverItem.protected && <span style={{ color: 'var(--accent)' }}>❖ 保护</span>}
            {hoverItem.importance != null && <span>imp <b>{hoverItem.importance}</b>/10</span>}
            {hoverItem.type && hoverItem.type !== 'dynamic' && <span>· {hoverItem.type}</span>}
            {(hoverItem.date || hoverItem.timeHint) && <span>· {hoverItem.date || hoverItem.timeHint}</span>}
          </div>
          {visibleTags(hoverItem.tags).length > 0 && (
            <div className="imp-hover-tags">
              {visibleTags(hoverItem.tags).slice(0, 8).map(t => (
                <span key={t} className="imp-hover-tag">#{t}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 重新脱水弹窗 — 两阶段 (options → preview) */}
      <RedehydrateModal
        open={redehyModalOpen}
        item={active}
        busy={redehydrating === (active && active.id)}
        preview={redehyPreview}
        onCancel={closeRedehydrateModal}
        onPreview={runRedehydratePreview}
        onReroll={runRedehydratePreview}
        onCommit={commitRedehydrate}
      />

      {/* 全库相似 → 查看:复用 ItemModal,跟时间线/记忆格里同款 */}
      {previewItem && window.ConsoleItemModal && React.createElement(window.ConsoleItemModal, {
        item: previewItem,
        allItems: [previewItem],
        onClose: () => setPreviewItem(null),
        onUpdate: handlePreviewUpdate,
      })}

      {/* 合并预览 → 复用 ConsoleItemModal 的 merge 模式(完整可编辑) */}
      {mergePreview && window.ConsoleItemModal && React.createElement(window.ConsoleItemModal, {
        // 把预览结果塑成 mock item 形态喂给 modal,身份用 B 的(因为合并写入 B)
        item: {
          id: mergePreview.b.id,
          title: mergePreview.b.name,
          summary: mergePreview.b_summary || '',
          body: mergePreview.merged_content,
          // 日期优先 event_time, 没有就用 created (B 永远有 created); 这样合并后编辑界面不会空一截
          date: ((mergePreview.b_event_time || mergePreview.b_created || '').slice(0, 10)) || '',
          time: ((mergePreview.b_event_time || mergePreview.b_created || '').slice(11, 16)) || '',
          importance: mergePreview.importance || 5,
          tags: mergePreview.tags || [],
          protected: false, feel: false, highlight: false, internalized: false,
          artifacts: [],
        },
        allItems: [],
        mode: 'merge',
        mergeHeader: {
          aName: mergePreview.a.name,
          bName: mergePreview.b.name,
          aContent: mergePreview.a_content || '',
          bContent: mergePreview.b_content || '',
        },
        rerollLoading: mergeLoading,
        commitLoading: mergeLoading,
        onClose: () => { if (!mergeLoading) setMergePreview(null); },
        onReroll: rerollMerge,
        // saveEdit 走这条路:接受合并,把 modal 里编辑过的 draft 一起带上
        onUpdate: (id, draft) => commitMerge(draft),
      })}
      {/* 首次合并 loading 遮罩 — paper 风格 + spinner + A→B 对照 */}
      {!mergePreview && mergeLoading && (
        <div className="ob-merge-loader-mask">
          <div className="ob-merge-loader-card">
            <div className="ob-merge-loader-spinner" />
            <div className="ob-merge-loader-title">正在合并</div>
            {mergeLoadingPair && (
              <div className="ob-merge-loader-pair">
                <span className="ob-merge-loader-pair-name">「{mergeLoadingPair.aName}」</span>
                <span className="ob-merge-loader-pair-arrow">→</span>
                <span className="ob-merge-loader-pair-name">「{mergeLoadingPair.bName}」</span>
              </div>
            )}
            <div className="ob-merge-loader-hint">
              LLM 整合两段内容<span className="ob-merge-loader-dots" />
            </div>
          </div>
        </div>
      )}

      {/* 会话开销浮动 widget — 累计本次会话所有 LLM 调用花费 */}
      {sessionCost.count > 0 && (
        <div
          style={{
            position: 'fixed', right: 18, bottom: 18, zIndex: 50,
            padding: '8px 14px',
            background: 'var(--paper)',
            border: '0.5px solid var(--line-2)',
            borderRadius: 999,
            boxShadow: '0 8px 24px -8px rgba(0,0,0,0.18)',
            fontSize: 11,
            fontFamily: 'var(--mono)',
            color: 'var(--ink-2)',
            display: 'flex', alignItems: 'center', gap: 10,
            cursor: 'default',
          }}
          title={`本次会话累计 ${sessionCost.count} 次 LLM 调用\n上次: ${sessionCost.lastLabel} ~$${sessionCost.lastUsd.toFixed(4)}`}
        >
          <span style={{ color: 'var(--ink-4)' }}>本次会话</span>
          <span style={{ color: 'var(--accent)', fontWeight: 600 }}>${sessionCost.usd.toFixed(4)}</span>
          <span style={{ color: 'var(--ink-3)' }}>≈ ¥{sessionCost.cny.toFixed(2)}</span>
          <span style={{ color: 'var(--ink-4)' }}>· {sessionCost.count} 次</span>
          <button
            onClick={() => setSessionCost({ usd: 0, cny: 0, count: 0, lastLabel: '', lastUsd: 0 })}
            style={{
              background: 'transparent', border: 0, padding: '0 4px',
              cursor: 'pointer', color: 'var(--ink-4)', fontSize: 12,
            }}
            title="清零"
          >✕</button>
        </div>
      )}
    </>
  );
}

window.ImportWorkbench = ImportWorkbench;
