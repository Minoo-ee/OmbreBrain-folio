// ombre-bridge.js — 把 v2 mock 数据形态接到真实 Ombre-Brain API
// 在 babel 脚本之前加载,提供全局 helper

(function () {
  // bridge 读端注入到 item.tags 显示用的伪 tag — 写端要把它们剥离, 否则会污染 bucket.tags
  var PSEUDO_TAGS = { '亲手写': 1, 'AI 写入': 1, '导入': 1, '已消化': 1, '保护': 1, '重要': 1, '高亮': 1, 'feel(柔软)': 1 };
  function stripPseudoTags(tags) {
    if (!Array.isArray(tags)) return tags;
    return tags.filter(function (t) { return !PSEUDO_TAGS[String(t)]; });
  }

  // ISO → 本地 date/time
  //   带 Z / 时区偏移: 按 UTC 解析转本地 (created)
  //   无时区: 按本地解析 (event_time, LLM 从原文文本推断, 无时区)
  function isoToLocal(s) {
    if (!s) return { date: '', time: '' };
    var iso = String(s);
    var d = new Date(iso);
    if (isNaN(d.getTime())) {
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
  function localToUtcIso(date, time) {
    if (!date) return '';
    var t = time || '00:00';
    var d = new Date(date + 'T' + t + ':00');
    if (isNaN(d.getTime())) return '';
    return d.toISOString();
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
    // 来源伪标签注入 — 三态: user/ai/import
    // (真值在 metadata.created_by; 这里只是 v2 mock 形态展示用, 改 tag 不会改后端 source)
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
      score: typeof b.score === 'number' ? b.score : 0,   // decay 分数
      noise: !!(b.resolved && (b.importance || 5) === 1),
      resolved: !!b.resolved,
      tags: tags,
      // 注: 不要再 OR b.pinned — API 的 b.pinned = is_protected OR is_highlighted, 二次 OR 会假性耦合
      protected: !!b.protected,
      feel: b.type === 'feel',
      highlight: !!b.highlight,
      internalized: !!(b.internalized || b.digested),
      domain: Array.isArray(b.domain) ? b.domain.filter(Boolean) : [],
      artifacts: [],
      createdBy: b.created_by || 'ai',  // 来源 user/ai/import (camelCase 给 console UI 用)
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
    if (patch.summary != null) body.summary = patch.summary;
    if (patch.raw_source != null) body.raw_source = patch.raw_source;  // 原文片段(用户手动补全)
    if (patch.created_by != null) body.created_by = patch.created_by;  // 来源 user/ai/import
    if (patch.createdBy != null) body.created_by = patch.createdBy;    // camelCase 别名(工作台 active 用)
    if (patch.importance != null) body.importance = patch.importance;
    if (patch.tags != null) body.tags = stripPseudoTags(patch.tags);
    if (patch.protected != null) body.protected = !!patch.protected;
    if (patch.highlight != null) body.highlight = !!patch.highlight;
    if (patch.internalized != null) body.internalized = !!patch.internalized;
    if (patch.noise != null) {
      body.resolved = !!patch.noise;
      if (patch.noise) body.importance = 1;
    }
    // event_time:patch 里的 date/time(本地)组装成 UTC ISO,空 → 后端清掉
    if (patch.event_time != null) {
      body.event_time = patch.event_time;
    } else if (patch.date != null || patch.time != null) {
      var d = patch.date || '';
      var t = patch.time || '';
      body.event_time = d ? localToUtcIso(d, t) : '';
    }
    if (patch.type != null) body.type = patch.type;            // feel ↔ dynamic
    if (patch.feel != null) body.type = patch.feel ? 'feel' : 'dynamic';
    var r = await fetch('/api/bucket/' + encodeURIComponent(id) + '/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  };

  // ---------- 导入工作台专用 ----------
  // 上传文件(multipart) 或 粘贴原文(裸文本 body)
  // mode: 'small' (默认, 强制至少 1 条) 或 'large' (大批量精挑)
  window.__obImportUpload = async function (filenameOrText, isFile, fileObj, mode) {
    var modeQ = '&mode=' + encodeURIComponent(mode || 'small');
    var url = '/api/import/upload?preserve_raw=1' + modeQ;
    var opts;
    if (isFile && fileObj) {
      var fd = new FormData();
      fd.append('file', fileObj, fileObj.name);
      opts = { method: 'POST', body: fd };
    } else {
      // 粘贴原文 — body 直接是文本,filename 走 query
      var fname = filenameOrText || ('paste-' + new Date().toISOString().slice(0, 19).replace(/:/g, '') + '.txt');
      url += '&filename=' + encodeURIComponent(fname);
      opts = {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: filenameOrText  // 这里 filenameOrText 实际上是文本内容,见调用约定
      };
    }
    var r = await fetch(url, opts);
    if (!r.ok) throw new Error('上传失败:' + (await r.text()));
    return r.json();
  };

  // 简洁版:粘贴文本(更直观的调用)
  window.__obImportPasteText = async function (rawText, filenameHint, mode) {
    var fname = filenameHint || ('paste-' + new Date().toISOString().slice(0, 19).replace(/:/g, '') + '.txt');
    var modeQ = '&mode=' + encodeURIComponent(mode || 'small');
    var r = await fetch('/api/import/upload?preserve_raw=1&filename=' + encodeURIComponent(fname) + modeQ, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: rawText,
    });
    if (!r.ok) throw new Error('上传失败:' + (await r.text()));
    return r.json();
  };

  // 上传文件;maxChunks > 0 → sample 模式,只跑前 N 个 chunk(试水/控成本)
  // mode: 'small' (默认, 强制至少 1 条) 或 'large' (大批量精挑)
  window.__obImportFile = async function (file, maxChunks, mode) {
    var fd = new FormData();
    fd.append('file', file, file.name);
    var url = '/api/import/upload?preserve_raw=1&mode=' + encodeURIComponent(mode || 'small');
    if (maxChunks && maxChunks > 0) url += '&max_chunks=' + maxChunks;
    var r = await fetch(url, { method: 'POST', body: fd });
    if (!r.ok) throw new Error('上传失败:' + (await r.text()));
    return r.json();
  };

  // 拉导入进度(轮询)
  window.__obImportStatus = async function () {
    var r = await fetch('/api/import/status');
    if (!r.ok) throw new Error('GET /api/import/status ' + r.status);
    return r.json();
  };

  // 拉最近导入的桶(工作台队列)
  window.__obImportResults = async function (limit) {
    var n = limit || 100;
    var r = await fetch('/api/import/results?limit=' + n);
    if (!r.ok) throw new Error('GET /api/import/results ' + r.status);
    var d = await r.json();
    return d.buckets || [];
  };

  // 拉单条桶的全库 top-N 相似(给"全库相似"按钮用)
  window.__obFetchSimilar = async function (id, n) {
    var r = await fetch('/api/bucket/' + encodeURIComponent(id) + '/similar?n=' + (n || 5));
    if (!r.ok) throw new Error('GET /similar ' + r.status);
    var d = await r.json();
    return d.similar || [];
  };

  // 删除桶(不入库 = 物理删除)
  window.__obDeleteBucket = async function (id) {
    var r = await fetch('/api/bucket/' + encodeURIComponent(id) + '/delete', { method: 'POST' });
    if (!r.ok) throw new Error('删除失败:' + (await r.text()));
    return r.json();
  };
})();
