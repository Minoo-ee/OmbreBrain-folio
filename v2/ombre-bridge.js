// ombre-bridge.js — 把 v2 mock 数据形态接到真实 Ombre-Brain API
// 在 babel 脚本之前加载,提供全局 helper

(function () {
  // bridge 读端注入到 item.tags 显示用的伪 tag — 写端要把它们剥离, 否则会污染 bucket.tags
  // 来源 (user/ai/import) 真值在 metadata.created_by; 状态 (已消化/保护/重要/feel) 真值在各自字段
  var PSEUDO_TAGS = { '亲手写': 1, 'AI 写入': 1, '导入': 1, '已消化': 1, '保护': 1, '重要': 1, '高亮': 1, 'feel(柔软)': 1 };
  function stripPseudoTags(tags) {
    if (!Array.isArray(tags)) return tags;
    return tags.filter(function (t) { return !PSEUDO_TAGS[String(t)]; });
  }

  // ISO 字符串 → 本地 date/time 字符串
  //   带 Z / 时区偏移: 浏览器按 UTC/指定时区解析, 自动转本地显示 (created 字段, 后端写)
  //   无时区标记:   浏览器按本地时区解析, 直接用 (event_time 字段, LLM 从原文文本推断, 无时区)
  //   旧版本曾给 naive 时间补 Z 当 UTC, 导致 LLM 写的本地时间被错移 9 小时, 已废弃此行为
  function isoToLocal(s) {
    if (!s) return { date: '', time: '' };
    var iso = String(s);
    var d = new Date(iso);
    if (isNaN(d.getTime())) {
      // 解析失败退回字符串切片
      var raw = String(s);
      return {
        date: raw.length >= 10 ? raw.slice(0, 10) : '',
        time: raw.length >= 16 ? raw.slice(11, 16) : '',
      };
    }
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return {
      date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
      time: pad(d.getHours()) + ':' + pad(d.getMinutes()),
    };
  }
  // 本地 date(YYYY-MM-DD) + time(HH:MM) → UTC ISO 带 Z。给 update 写路径用。
  function localToUtcIso(date, time) {
    if (!date) return '';
    var t = time || '00:00';
    var d = new Date(date + 'T' + t + ':00');  // 浏览器按本地时区解析
    if (isNaN(d.getTime())) return '';
    return d.toISOString();  // 自动转 UTC 加 Z
  }
  window.__obIsoToLocal = isoToLocal;
  window.__obLocalToUtcIso = localToUtcIso;

  // 真实 bucket(/api/buckets list 项) → v2 mock 形态
  window.__obRealToMock = function (b) {
    var evt = b.event_time || '';
    var created = b.created || '';
    var hasEvent = !!evt;
    var fallback = created || '2026-01-01';
    var src = hasEvent ? evt : fallback;
    var local = isoToLocal(src);
    var date = local.date || '2026-01-01';
    var time = local.time || '00:00';

    var tags = (b.tags || []).slice();
    // 来源伪标签 — 三态 user/ai/import (真值在 metadata.created_by; 这里只是显示用)
    if (b.created_by === 'user') tags.push('亲手写');
    else if (b.created_by === 'import') tags.push('导入');
    else tags.push('AI 写入');
    if (b.internalized || b.digested) tags.push('已消化');
    if (b.protected || b.pinned) tags.push('保护');
    if (b.highlight) tags.push('高亮');
    if (b.type === 'feel') tags.push('feel(柔软)');
    // 注: 不再注入 '重要' tag — importance 是 1-10 数字, 直接看数字, 派生 tag 多余

    return {
      id: b.id,
      date: date,
      time: time,
      title: b.name || b.id,
      summary: b.summary || '',           // 用户没填就空,前端按"无摘要不显示"渲染
      preview: b.content_preview || '',  // 始终是 content 自动截断,给"显示原文"的视图当兜底用
      body: '',  // 列表 endpoint 不返回 content;打开详情时再 lazy-load
      importance: b.importance || 5,
      score: typeof b.score === 'number' ? b.score : 0,   // decay 分数, 999=钉/永久, 50=feel, 其他算出, <0.3 归档
      noise: !!(b.resolved && (b.importance || 5) === 1), // 软删除/噪声: imp=1 + resolved 加速衰减(×0.05)
      resolved: !!b.resolved,
      tags: tags,
      // 注: 不要再 OR b.pinned — 后端 is_protected/is_highlighted 已正确处理 legacy
      // pinned fallback (utils.py); API 返回的 b.pinned 是 "protected OR highlight" 的或值,
      // 这里再 OR 一次会让 highlight=true 把 protected 也派生成 true, 视觉上"耦合"假象.
      protected: !!b.protected,
      feel: b.type === 'feel',
      highlight: !!b.highlight,
      internalized: !!(b.internalized || b.digested),
      created_by: b.created_by || '',  // 来源 user/ai/import (空 = 历史默认 ai)
      domain: Array.isArray(b.domain) ? b.domain.filter(Boolean) : [],
      artifacts: [],
      _hasEventTime: hasEvent,
    };
  };

  // 拉全部桶并 transform。app 在 useEffect 里调
  window.__obFetchBuckets = async function () {
    var r = await fetch('/api/buckets', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('GET /api/buckets ' + r.status);
    var rows = await r.json();
    return rows.map(window.__obRealToMock);
  };

  // 拉单条桶详情(打开 modal 时用,补 body)
  window.__obFetchBucketDetail = async function (id) {
    var r = await fetch('/api/bucket/' + encodeURIComponent(id), { credentials: 'same-origin' });
    if (!r.ok) throw new Error('GET /api/bucket/' + id + ' ' + r.status);
    return r.json();
  };

  // 全字段搜索(标题 / 摘要 / 标签 / 域 / 完整正文) —— 调 /api/search 拿后端 fuzz 命中
  // 默认 include_vector=false:只返回真的"含 query"的桶,不掺向量(语义)结果,
  //   避免出现 title/summary/body 都不含 query 但因语义相近被混进结果的污染情况
  // 返回 { keyword_hits: [{id, name, score, matched_in: ['title'|'summary'|'tag'|'domain'|'content'], ...}], vector_hits: [] }
  // 调用方拿到 ids 集合作为白名单过滤本地 items;matched_in 给 UI 标"命中: 正文"用
  window.__obSearch = async function (query, opts) {
    opts = opts || {};
    var q = (query || '').trim();
    if (!q) return { query: '', keyword_hits: [], vector_hits: [] };
    var params = new URLSearchParams({ q: q, limit: String(opts.limit || 50) });
    if (opts.includeVector) params.set('include_vector', 'true');
    var r = await fetch('/api/search?' + params.toString(), { credentials: 'same-origin' });
    if (!r.ok) throw new Error('GET /api/search ' + r.status);
    return r.json();
  };

  // 新建桶 — WriteDrawer.onSave 走这里
  window.__obCreateBucket = async function (entry) {
    var eventTime = null;
    if (entry.date && entry.time) eventTime = entry.date + 'T' + entry.time + ':00';
    else if (entry.date) eventTime = entry.date;
    var content = (entry.body && entry.body.trim()) || entry.summary || entry.title;
    var body = {
      name: entry.title,
      content: content,
      importance: entry.importance,
      tags: stripPseudoTags(entry.tags || []),
      protected: !!entry.protected,
      highlight: !!entry.highlight,
      internalized: !!entry.internalized,
      event_time: eventTime,
    };
    if (entry.summary) body.summary = entry.summary;  // 后端 /api/bucket/create 读 summary
    if (entry.feel) {
      body.type = 'feel';     // 关键: 让后端 metadata.type='feel', 否则 isFeel() 永远 false
      body.valence = 0.6;
      body.arousal = 0.55;
    }
    var r = await fetch('/api/bucket/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  };

  // 全库语义相似(embedding cosine) — modal "可能关联"区用
  window.__obFetchSimilar = async function (id, n) {
    var r = await fetch('/api/bucket/' + encodeURIComponent(id) + '/similar?n=' + (n || 5));
    if (!r.ok) throw new Error('GET /similar ' + r.status);
    var d = await r.json();
    return d.similar || [];
  };

  // 更新桶 — ItemModal save / 快速 toggle 走这里
  window.__obUpdateBucket = async function (id, patch) {
    var body = {};
    if (patch.title != null) body.name = patch.title;
    if (patch.body != null) body.content = patch.body;
    if (patch.summary != null) body.summary = patch.summary;
    if (patch.raw_source != null) body.raw_source = patch.raw_source;  // 原文片段(用户手动补全)
    if (patch.created_by != null) body.created_by = patch.created_by;  // 来源 user/ai/import
    if (patch.importance != null) body.importance = patch.importance;
    if (patch.tags != null) body.tags = stripPseudoTags(patch.tags);
    if (patch.protected != null) body.protected = !!patch.protected;
    if (patch.highlight != null) body.highlight = !!patch.highlight;
    if (patch.internalized != null) body.internalized = !!patch.internalized;
    // noise(软删除/标记噪声) → 后端没单独字段, 用 resolved + importance=1 表达
    if (patch.noise != null) {
      body.resolved = !!patch.noise;
      if (patch.noise) body.importance = 1;
      // 取消 noise: 不强行恢复 importance(用户原值), 让父级 patch 里若同时改了 importance 自然覆盖
    }
    // event_time:patch 里的 date/time(本地)组装成 UTC ISO,空 → 后端清掉 metadata.event_time
    if (patch.event_time != null) {
      body.event_time = patch.event_time;
    } else if (patch.date != null || patch.time != null) {
      var d = patch.date || '';
      var t = patch.time || '';
      body.event_time = d ? localToUtcIso(d, t) : '';
    }
    // feel 在 ombre-brain 是 type 字段(feel / dynamic),update 端点已暴露 type 切换
    // (commit 089e440 加进了 allowed) — 跟 console bridge 同步处理
    if (patch.type != null) body.type = patch.type;            // feel ↔ dynamic 直传
    if (patch.feel != null) body.type = patch.feel ? 'feel' : 'dynamic';  // 兼容 ItemModal 的 boolean toggle
    var r = await fetch('/api/bucket/' + encodeURIComponent(id) + '/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  };
})();
