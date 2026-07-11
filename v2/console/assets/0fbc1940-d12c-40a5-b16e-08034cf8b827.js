// console-network.jsx —— 记忆网络（tag 共现 + 聚类轻量版）

const { useState: cnS, useEffect: cnE, useMemo: cnM, useRef: cnR } = React;

function NetworkPage({ items }) {
  const containerRef = cnR(null);
  const [size, setSize] = cnS({ w: 1080, h: 540 });
  const [hoverNode, setHoverNode] = cnS(null);
  const [selectedTag, setSelectedTag] = cnS(null);
  const [edgeWeightMin, setEdgeWeightMin] = cnS(2);

  cnE(() => {
    const update = () => {
      if (!containerRef.current) return;
      const r = containerRef.current.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // 计算 tag 节点和共现边
  const { nodes, links, stats } = cnM(() => {
    // tag 频次
    const tagCount = {};
    items.forEach(i => (i.tags || []).forEach(t => {
      tagCount[t] = (tagCount[t] || 0) + 1;
    }));

    // tag 间共现矩阵
    const coOcc = {};
    items.forEach(i => {
      const ts = (i.tags || []);
      for (let a = 0; a < ts.length; a++) {
        for (let b = a + 1; b < ts.length; b++) {
          const k = [ts[a], ts[b]].sort().join('||');
          coOcc[k] = (coOcc[k] || 0) + 1;
        }
      }
    });

    const sortedTags = Object.entries(tagCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 18);  // 取前 18 个高频 tag

    const tagSet = new Set(sortedTags.map(t => t[0]));
    const cx = size.w / 2;
    const cy = size.h / 2;
    const baseR = Math.min(size.w, size.h) * 0.35;

    // 圆形布局 + 中心高频
    const nodes = sortedTags.map(([tag, count], i) => {
      const angle = (i / sortedTags.length) * Math.PI * 2 - Math.PI / 2;
      // 越高频越靠中心
      const importance = count / sortedTags[0][1];
      const r = baseR * (1 - importance * 0.35);
      return {
        id: tag,
        count,
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
        radius: 8 + Math.sqrt(count) * 4,
        importance,
      };
    });

    const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]));

    // 边
    const links = Object.entries(coOcc)
      .map(([k, w]) => {
        const [a, b] = k.split('||');
        if (!nodeMap[a] || !nodeMap[b]) return null;
        return { source: nodeMap[a], target: nodeMap[b], weight: w };
      })
      .filter(Boolean)
      .filter(l => l.weight >= edgeWeightMin);

    // 聚类（简单 BFS 找连通分量）
    const adj = {};
    nodes.forEach(n => { adj[n.id] = []; });
    links.forEach(l => {
      adj[l.source.id].push(l.target.id);
      adj[l.target.id].push(l.source.id);
    });
    const visited = new Set();
    let clusters = 0;
    nodes.forEach(n => {
      if (visited.has(n.id)) return;
      clusters++;
      const queue = [n.id];
      while (queue.length) {
        const cur = queue.shift();
        if (visited.has(cur)) continue;
        visited.add(cur);
        adj[cur].forEach(x => !visited.has(x) && queue.push(x));
      }
    });

    return {
      nodes,
      links,
      stats: {
        totalTags: Object.keys(tagCount).length,
        shownTags: nodes.length,
        edges: links.length,
        clusters,
        density: links.length / Math.max(1, nodes.length * (nodes.length - 1) / 2),
      }
    };
  }, [items, size, edgeWeightMin]);

  // 选中 tag 时的相关记忆
  const relatedItems = cnM(() => {
    if (!selectedTag) return [];
    return items.filter(i => (i.tags || []).includes(selectedTag)).slice(0, 12);
  }, [items, selectedTag]);

  return (
    <main className="oc-main">
      <ConsolePageHd
        title="记忆网络"
        sub={<>tag 之间的共现关系图谱 —— 节点大小 = 该 tag 出现频次，连线粗细 = 两个 tag 同时出现的次数。点击节点查看相关记忆。</>}
        rightSlot={<div className="ob-page-counter"><b>{stats.shownTags}</b> 节点 · <b>{stats.edges}</b> 边</div>}
      />

      {/* 统计条 */}
      <div className="oc-net-stats" style={{ marginBottom: 18 }}>
        <span>共 <b>{stats.totalTags}</b> 个 tag</span>
        <span>显示 <b>{stats.shownTags}</b> 高频</span>
        <span>边 <b>{stats.edges}</b></span>
        <span>独立簇 <b>{stats.clusters}</b></span>
        <span>密度 <b>{(stats.density * 100).toFixed(1)}%</b></span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          边权重 ≥
          <input
            type="range"
            min={1}
            max={6}
            step={1}
            value={edgeWeightMin}
            onChange={(e) => setEdgeWeightMin(+e.target.value)}
            style={{ width: 80 }}
          />
          <b style={{ minWidth: 14, textAlign: 'right' }}>{edgeWeightMin}</b>
        </span>
      </div>

      {/* 网络图 */}
      <div className="oc-network-canvas" ref={containerRef}>
        <svg viewBox={`0 0 ${size.w} ${size.h}`}>
          <defs>
            <radialGradient id="netGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#a78bd0" stopOpacity="0.5" />
              <stop offset="100%" stopColor="#a78bd0" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* 边 */}
          {links.map((l, i) => (
            <line
              key={i}
              x1={l.source.x}
              y1={l.source.y}
              x2={l.target.x}
              y2={l.target.y}
              stroke="#a78bd0"
              strokeWidth={Math.min(3.5, 0.6 + l.weight * 0.4)}
              strokeOpacity={
                selectedTag
                  ? (l.source.id === selectedTag || l.target.id === selectedTag ? 0.7 : 0.05)
                  : (hoverNode
                    ? (l.source.id === hoverNode || l.target.id === hoverNode ? 0.7 : 0.08)
                    : 0.22)
              }
              style={{ transition: 'stroke-opacity .2s' }}
            />
          ))}

          {/* 节点 */}
          {nodes.map((n) => {
            const isHover = hoverNode === n.id;
            const isSelected = selectedTag === n.id;
            const isFaded = (selectedTag && !isSelected && !links.some(l =>
              (l.source.id === selectedTag && l.target.id === n.id) ||
              (l.target.id === selectedTag && l.source.id === n.id)
            ));
            return (
              <g
                key={n.id}
                className="oc-network-node"
                transform={`translate(${n.x},${n.y})`}
                opacity={isFaded ? 0.2 : 1}
                style={{ transition: 'opacity .25s' }}
                onMouseEnter={() => setHoverNode(n.id)}
                onMouseLeave={() => setHoverNode(null)}
                onClick={() => setSelectedTag(prev => prev === n.id ? null : n.id)}
              >
                {(isHover || isSelected) && (
                  <circle r={n.radius * 2.5} fill="url(#netGlow)" />
                )}
                <circle
                  r={n.radius}
                  fill={isSelected ? '#6e4f9a' : (n.importance > 0.6 ? '#d4a85f' : '#a78bd0')}
                  stroke={isSelected ? '#6e4f9a' : 'rgba(255,255,255,0.5)'}
                  strokeWidth={isSelected ? 2 : 1}
                />
                <text
                  y={n.radius + 14}
                  fontSize={Math.min(13, 9 + n.importance * 5)}
                  fontWeight={n.importance > 0.5 ? 500 : 400}
                >
                  #{n.id}
                </text>
                <text
                  y={n.radius + 26}
                  fontSize={9}
                  fill="var(--ink-4)"
                  style={{ fontFamily: 'var(--mono)' }}
                >
                  ×{n.count}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* 选中 tag 详情 */}
      {selectedTag && (
        <ConsoleCard
          label={`#${selectedTag}`}
          sub={`${relatedItems.length} 条相关记忆`}
          foot={
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>提示：点击节点切换；再次点击或选他处取消</span>
              <button className="oc-imp-action" onClick={() => setSelectedTag(null)}>✕ 取消</button>
            </div>
          }
        >
          <div className="oc-imported-list" style={{ maxHeight: 360 }}>
            {relatedItems.map(it => (
              <div key={it.id} className="oc-imported-item">
                <div className="oc-imported-hd">
                  <div className="oc-imported-title">{it.title}</div>
                  <div className="oc-imported-meta">
                    {it.date} · imp <b style={{ color: 'var(--accent)' }}>{it.importance}</b>
                  </div>
                </div>
                <div className="oc-imported-body">{it.summary || it.body}</div>
                <div className="oc-imported-tags">
                  {(it.tags || []).slice(0, 6).map(t => <span key={t}>#{t}</span>)}
                </div>
              </div>
            ))}
          </div>
        </ConsoleCard>
      )}

      {/* 高频共现对 */}
      <ConsoleCard label="高频共现" sub="共同出现次数最多的前 10 对">
        <div className="oc-imported-list" style={{ maxHeight: 280 }}>
          {[...links]
            .sort((a, b) => b.weight - a.weight)
            .slice(0, 10)
            .map((l, i) => (
              <div key={i} className="oc-pattern">
                <div className="oc-pattern-icon">⊗</div>
                <div className="oc-pattern-body">
                  <div className="oc-pattern-title">
                    #{l.source.id} <span style={{ color: 'var(--ink-4)', fontStyle: 'normal' }}>↔</span> #{l.target.id}
                  </div>
                  <div className="oc-pattern-stat">
                    共同出现 <b>{l.weight}</b> 次 · 占比 <b>{((l.weight / items.length) * 100).toFixed(1)}%</b>
                  </div>
                </div>
              </div>
            ))}
        </div>
      </ConsoleCard>
    </main>
  );
}

window.NetworkPage = NetworkPage;
