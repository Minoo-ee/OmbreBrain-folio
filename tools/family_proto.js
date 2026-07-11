// 记忆家族聚类原型 (2026-07-06) — 验证: 阈值多少出健康家族? 有没有巨型连通块?
// 嵌入文本 = name + tags + summary/preview (生产版用 OB 已存的全文向量, 这里近似)
const fs = require('fs');

const SF_KEY = process.env.SILICONFLOW_API_KEY;
const MODEL = 'Qwen/Qwen3-Embedding-4B';

async function embedBatch(texts) {
  const r = await fetch('https://api.siliconflow.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SF_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!r.ok) throw new Error(`embed HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return d.data.sort((a, b) => a.index - b.index).map(x => x.embedding);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// 平均连接凝聚聚类(简化): 先连通分量看巨块风险, 再对比平均连接
function components(n, simFn, threshold) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (simFn(i, j) >= threshold) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
  }
  const groups = {};
  for (let i = 0; i < n; i++) { const r = find(i); (groups[r] = groups[r] || []).push(i); }
  return Object.values(groups);
}

async function main() {
  const all = JSON.parse(fs.readFileSync('buckets.json', 'utf8'));
  const active = all.filter(b => !b.resolved && b.type !== 'feel');
  console.log('聚类对象:', active.length, '桶');

  const texts = active.map(b => {
    const tags = (b.tags || []).filter(t => !t.startsWith('__')).slice(0, 8).join(' ');
    return `${b.name || ''} ${tags} ${(b.summary || b.content_preview || '').slice(0, 180)}`;
  });

  let vecs = [];
  const cachePath = 'family-proto-vecs.json';
  if (fs.existsSync(cachePath)) {
    vecs = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    console.log('用缓存向量', vecs.length);
  } else {
    for (let i = 0; i < texts.length; i += 32) {
      vecs.push(...await embedBatch(texts.slice(i, i + 32)));
      if ((i / 32) % 5 === 0) console.log('嵌入进度', Math.min(i + 32, texts.length), '/', texts.length);
    }
    fs.writeFileSync(cachePath, JSON.stringify(vecs));
  }

  // 预计算相似度(只存上三角超过0.6的, 省内存)
  const n = vecs.length;
  const simMap = new Map();
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const s = cosine(vecs[i], vecs[j]);
    if (s >= 0.6) simMap.set(i * n + j, s);
  }
  const simFn = (i, j) => { const k = i < j ? i * n + j : j * n + i; return simMap.get(k) || 0; };
  console.log('相似对(≥0.6):', simMap.size);

  for (const th of [0.70, 0.75, 0.80]) {
    const groups = components(n, simFn, th).sort((a, b) => b.length - a.length);
    const fams = groups.filter(g => g.length >= 3);
    const singles = groups.filter(g => g.length === 1).length;
    const biggest = groups[0].length;
    console.log(`\n== 阈值 ${th}: 家族(≥3人) ${fams.length} 个 | 最大 ${biggest} | 孤儿 ${singles} | 2人对 ${groups.filter(g=>g.length===2).length}`);
    // 展示前6个家族
    fams.slice(0, 6).forEach((g, gi) => {
      console.log(`  家族${gi + 1}(${g.length}人): ${g.slice(0, 8).map(i => active[i].name).join(' | ')}${g.length > 8 ? ' …' : ''}`);
    });
  }
}

main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
