// layout-worker.js — 在后台线程跑 quadtree 力导向布局
// 主线程不卡, 几百到几千节点都流畅

// ── 辅助函数 (从 e964578f-... 移植, 保持算法一致) ──

function radiusOf(item) {
  return 5 + (item.importance || 5) * 1.1;
}

function inferType(item) {
  if (item.internalized || item.archived) return 'archived';
  if (item.feel) return 'feel';
  if (item.protected || item.highlight) return 'permanent';
  return 'dynamic';
}

// 排除桥接层自动注入的状态标签 (跟主版同步)
const AUTO_TAGS = new Set([
  '亲手写', 'AI 写入', '已消化', '保护', '重要', 'feel(柔软)',
]);
function _isTopicalTag(t) {
  if (!t) return false;
  const s = String(t);
  if (s.startsWith('__')) return false;
  if (AUTO_TAGS.has(s)) return false;
  return true;
}

function buildLinks(items) {
  const links = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    const aTopical = (a.tags || []).filter(_isTopicalTag);
    if (aTopical.length === 0) continue;
    const aSet = new Set(aTopical);
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      const bTags = b.tags || [];
      const sharedArr = [];
      for (const t of bTags) {
        if (_isTopicalTag(t) && aSet.has(t)) sharedArr.push(t);
      }
      if (sharedArr.length === 0) continue;
      let w = sharedArr.length;
      if (a.date === b.date) w += 0.6;
      if ((a.importance >= 7) && (b.importance >= 7)) w += 0.3;
      if (a.feel && b.feel) w += 0.3;
      links.push({ source: a.id, target: b.id, weight: w, shared: sharedArr });
    }
  }
  // 保险: 边数过多时只留 top-N
  const MAX_LINKS = 600;
  if (links.length > MAX_LINKS) {
    links.sort((a, b) => b.weight - a.weight);
    return links.slice(0, MAX_LINKS);
  }
  return links;
}

// ── Quadtree (Barnes-Hut) ──

function _qtMakeNode(x, y, size) {
  return { x, y, size, point: null, children: null, mass: 0, cx: 0, cy: 0 };
}
function _qtInsert(node, p) {
  node.cx = (node.cx * node.mass + p.x) / (node.mass + 1);
  node.cy = (node.cy * node.mass + p.y) / (node.mass + 1);
  node.mass++;
  if (node.children === null) {
    if (node.point === null) { node.point = p; return; }
    if (node.size < 1) return;
    const old = node.point;
    node.point = null;
    const half = node.size / 2;
    node.children = [
      _qtMakeNode(node.x,        node.y,        half),
      _qtMakeNode(node.x + half, node.y,        half),
      _qtMakeNode(node.x,        node.y + half, half),
      _qtMakeNode(node.x + half, node.y + half, half),
    ];
    _qtInsertChild(node, old);
  }
  _qtInsertChild(node, p);
}
function _qtInsertChild(node, p) {
  const half = node.size / 2;
  const right = p.x >= node.x + half;
  const bottom = p.y >= node.y + half;
  _qtInsert(node.children[(bottom ? 2 : 0) + (right ? 1 : 0)], p);
}
function _qtBuild(positions) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of positions) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX, h = maxY - minY;
  const size = Math.max(w, h, 100) * 1.1 + 1;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const root = _qtMakeNode(cx - size / 2, cy - size / 2, size);
  for (const p of positions) _qtInsert(root, p);
  return root;
}
function _qtApplyRepulsion(node, p, theta) {
  if (node.mass === 0) return;
  if (node.point === p) return;
  // 关键: p 落在 node 边界内必须递归, 否则把含 p 的子树当外部质心 → 节点全被吸到中心
  const insideNode = (
    p.x >= node.x && p.x < node.x + node.size &&
    p.y >= node.y && p.y < node.y + node.size
  );
  const dx = node.cx - p.x;
  const dy = node.cy - p.y;
  const d2 = dx * dx + dy * dy + 0.01;
  const d = Math.sqrt(d2);
  if (!insideNode && (node.point !== null || node.size / d < theta)) {
    const baseForce = 1800 * node.mass / d2;
    let f = baseForce;
    if (node.point !== null) {
      const minD = (p.r + (node.point.r || 5)) * 1.6 + 30;
      if (d < minD) f += (minD - d) * 0.5;
    }
    p.vx -= (dx / d) * f;
    p.vy -= (dy / d) * f;
    return;
  }
  if (node.children) {
    for (const child of node.children) _qtApplyRepulsion(child, p, theta);
  }
}

// ── 布局函数 ──

// id 哈希成 [0,1) 的伪随机, 同样 id 永远拿到同样的"随机数"
// 让 simulateLayout 的初始 jitter 在多次调用 (resize) 之间保持一致
function _seedRand(id, salt) {
  const s = String(id) + (salt || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function simulateLayout(nodes, links, width, height, iters = 220) {
  const N = nodes.length;
  if (N === 0) return [];
  const cx = width / 2, cy = height / 2;
  const ringR = Math.min(width, height) * 0.36;

  const positions = nodes.map((n, i) => {
    const a = (i / N) * Math.PI * 2;
    const importance = n.importance || 5;
    // 用 id 哈希代替 Math.random, resize 后初始位置仍稳定
    const r = ringR * (1.05 - importance * 0.04) + (_seedRand(n.id, 'r') - 0.5) * 30;
    return {
      x: cx + Math.cos(a) * r + (_seedRand(n.id, 'x') - 0.5) * 40,
      y: cy + Math.sin(a) * r + (_seedRand(n.id, 'y') - 0.5) * 40,
      vx: 0, vy: 0,
      r: n.r || 5,
    };
  });

  const idIdx = {};
  nodes.forEach((n, i) => { idIdx[n.id] = i; });
  const linkPairs = [];
  for (const l of links) {
    const a = idIdx[l.source];
    const b = idIdx[l.target];
    if (a !== undefined && b !== undefined) {
      linkPairs.push({ a, b, weight: l.weight });
    }
  }

  const theta = 0.9;
  for (let step = 0; step < iters; step++) {
    const t = 1 - step / iters;
    const tree = _qtBuild(positions);
    for (let i = 0; i < N; i++) _qtApplyRepulsion(tree, positions[i], theta);

    for (const l of linkPairs) {
      const a = positions[l.a], b = positions[l.b];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const target = 130 - Math.min(60, l.weight * 12);
      const k = 0.04 + l.weight * 0.012;
      const f = (d - target) * k;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }

    for (const p of positions) {
      p.vx += (cx - p.x) * 0.008;
      p.vy += (cy - p.y) * 0.008;
    }

    for (const p of positions) {
      p.vx *= 0.78; p.vy *= 0.78;
      p.x += p.vx * t;
      p.y += p.vy * t;
    }
  }

  return nodes.map((n, i) => ({ ...n, x: positions[i].x, y: positions[i].y }));
}

function timeRingLayout(nodes, width, height) {
  const sorted = [...nodes].sort((a, b) =>
    (a.date + a.time).localeCompare(b.date + b.time)
  );
  const cx = width / 2, cy = height / 2;
  const baseR = Math.min(width, height) * 0.18;
  const N = sorted.length;
  return sorted.map((n, i) => {
    const t = i / Math.max(1, N - 1);
    const a = -Math.PI / 2 + t * Math.PI * 1.85;
    const r = baseR + t * Math.min(width, height) * 0.18;
    return { ...n, x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  });
}

function clusterLayout(nodes, width, height) {
  const groups = {};
  nodes.forEach(n => {
    const t = inferType(n);
    (groups[t] = groups[t] || []).push(n);
  });
  const cx = width / 2, cy = height / 2;
  const R = Math.min(width, height) * 0.3;
  const types = Object.keys(groups);
  const out = [];
  types.forEach((t, ti) => {
    const a = -Math.PI / 2 + (ti / types.length) * Math.PI * 2;
    const gcx = cx + Math.cos(a) * R;
    const gcy = cy + Math.sin(a) * R;
    const arr = groups[t];
    const n = arr.length;
    arr.forEach((node, i) => {
      const inner = (i / Math.max(1, n)) * Math.PI * 2;
      const ir = 30 + Math.sqrt(n) * 14;
      out.push({ ...node, x: gcx + Math.cos(inner) * ir, y: gcy + Math.sin(inner) * ir });
    });
  });
  return out;
}

// ── Worker 消息处理 ──
// 主线程 postMessage({ items, mode, width, height, requestId })
// Worker 回 postMessage({ layout, links, requestId })

self.onmessage = function (e) {
  const { items, mode, width, height, requestId } = e.data;
  try {
    const links = buildLinks(items);
    const nodes = items.map(i => ({
      id: i.id, r: radiusOf(i), importance: i.importance,
      date: i.date, time: i.time,
      feel: !!i.feel, protected: !!i.protected,
      archived: !!i.archived, highlight: !!i.highlight,
      internalized: !!i.internalized,
      created_by: i.created_by || '',
    }));
    let layout;
    if (mode === 'time') {
      layout = timeRingLayout(nodes, width, height);
    } else if (mode === 'cluster' || mode === 'type') {
      layout = clusterLayout(nodes, width, height);
    } else {
      layout = simulateLayout(nodes, links, width, height);
    }
    self.postMessage({ layout, links, requestId });
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err), requestId });
  }
};
