// ombre-bridge.js — 把 v2 mock 数据形态接到真实 Ombre-Brain API
// 在 babel 脚本之前加载,提供全局 helper

(function () {
  // bridge 读端注入到 item.tags 显示用的伪 tag — 写端要把它们剥离, 否则会污染 bucket.tags
  var PSEUDO_TAGS = { '亲手写': 1, 'AI 写入': 1, '导入': 1, '已消化': 1, '保护': 1, '重要': 1, '高亮': 1, 'feel(柔软)': 1 };
  function stripPseudoTags(tags) {
    if (!Array.isArray(tags)) return tags;
    return tags.filter(function (t) { return !PSEUDO_TAGS[String(t)]; });
  }

  // 真实 bucket(/api/buckets list 项) → v2 mock 形态
  window.__obRealToMock = function (b) {
    var evt = b.event_time || '';
    var created = b.created || '';
    var hasEvent = !!evt;
    // 没事件时间的桶 fallback 到 created;再没就给个标记日期
    var fallback = created || '2026-01-01';
    var src = hasEvent ? evt : fallback;
    var date = src.length >= 10 ? src.slice(0, 10) : '2026-01-01';
    var time = src.length >= 16 ? src.slice(11, 16) : '00:00';

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
      summary: b.summary || '',           // 用户没填就空,跟其他视图一致
      body: '',  // 列表 endpoint 不返回 content;打开详情时再 lazy-load
      importance: b.importance || 5,
      score: typeof b.score === 'number' ? b.score : 0,   // decay 分数
      noise: !!(b.resolved && (b.importance || 5) === 1),
      resolved: !!b.resolved,
      tags: tags,
      // 注: 不要再 OR b.pinned — API 的 b.pinned = is_protected OR is_highlighted, 二次 OR 会假性耦合
      protected: !!b.protected,
      feel: b.type === 'feel',
      highlight: !!b.highlight,
      internalized: !!(b.internalized || b.digested),
      created_by: b.created_by || '',
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

  // 更新桶 — ItemModal save / 快速 toggle 走这里
  window.__obUpdateBucket = async function (id, patch) {
    var body = {};
    if (patch.title != null) body.name = patch.title;
    if (patch.body != null) body.content = patch.body;
    if (patch.raw_source != null) body.raw_source = patch.raw_source;  // 原文片段(用户手动补全)
    if (patch.created_by != null) body.created_by = patch.created_by;  // 来源 user/ai/import
    if (patch.importance != null) body.importance = patch.importance;
    if (patch.tags != null) body.tags = stripPseudoTags(patch.tags);
    if (patch.protected != null) body.protected = !!patch.protected;
    if (patch.highlight != null) body.highlight = !!patch.highlight;
    if (patch.internalized != null) body.internalized = !!patch.internalized;
    if (patch.noise != null) {
      body.resolved = !!patch.noise;
      if (patch.noise) body.importance = 1;
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
