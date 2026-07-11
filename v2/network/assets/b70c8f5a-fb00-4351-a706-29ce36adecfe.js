// constellation-canvas.jsx —— 星图画布（SVG + pan/zoom + hover/click）

const { useState: ccS, useEffect: ccE, useRef: ccR, useMemo: ccM, useCallback: ccCb } = React;

function StarCanvas({
  items, links, layout, width, height,
  selectedId, focusId, hoverId,
  onHover, onSelect, onBlur,
  searchQuery,
  filteredTypes,
  showLinks, showLabels, linkOpacity,
  zoom, setZoom, pan, setPan,
  now,
}) {
  const svgRef = ccR(null);
  const [dragging, setDragging] = ccS(false);
  const dragRef = ccR({ x: 0, y: 0, startPan: null });

  // 节点 by id 索引
  const nodeMap = ccM(() => {
    const m = {};
    layout.forEach(n => m[n.id] = n);
    return m;
  }, [layout]);

  // 计算"焦点模式"下应保留的节点集（一跳邻居）
  const focusSet = ccM(() => {
    if (!focusId) return null;
    const set = new Set([focusId]);
    links.forEach(l => {
      if (l.source === focusId) set.add(l.target);
      if (l.target === focusId) set.add(l.source);
    });
    return set;
  }, [focusId, links]);

  // 搜索命中
  const searchSet = ccM(() => {
    if (!searchQuery) return null;
    const q = searchQuery.toLowerCase();
    const matched = new Set();
    items.forEach(it => {
      const text = (it.title + ' ' + (it.summary || '') + ' ' + (it.body || '') + ' ' + (it.tags || []).join(' ')).toLowerCase();
      if (text.includes(q)) matched.add(it.id);
    });
    // 加入一跳邻居作为"路径"
    const path = new Set(matched);
    links.forEach(l => {
      if (matched.has(l.source)) path.add(l.target);
      if (matched.has(l.target)) path.add(l.source);
    });
    return { matched, path };
  }, [searchQuery, items, links]);

  // 决定每个节点是否 faded
  const isFaded = (id) => {
    if (filteredTypes && filteredTypes.size > 0) {
      const t = inferType(items.find(i => i.id === id));
      if (!filteredTypes.has(t)) return true;
    }
    if (focusSet && !focusSet.has(id)) return true;
    if (searchSet && !searchSet.path.has(id)) return true;
    return false;
  };

  // 连线 faded 判断
  const isLinkFaded = (l) => {
    if (focusSet && !(focusSet.has(l.source) && focusSet.has(l.target))) return true;
    if (searchSet) {
      // 至少一端在 matched 中才高亮
      if (!(searchSet.matched.has(l.source) || searchSet.matched.has(l.target))) return true;
    }
    return false;
  };

  // pan/zoom 事件
  const onMouseDown = (e) => {
    if (e.button !== 0) return;
    setDragging(true);
    dragRef.current = { x: e.clientX, y: e.clientY, startPan: { ...pan } };
  };
  const onMouseMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - dragRef.current.x;
    const dy = e.clientY - dragRef.current.y;
    setPan({ x: dragRef.current.startPan.x + dx, y: dragRef.current.startPan.y + dy });
  };
  const onMouseUp = () => setDragging(false);

  const onWheel = (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom(z => Math.max(0.3, Math.min(3, z * delta)));
  };

  ccE(() => {
    const el = svgRef.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // viewBox 不变；用 g transform 控制 pan/zoom
  const cx = width / 2, cy = height / 2;
  const transform = `translate(${pan.x},${pan.y}) translate(${cx},${cy}) scale(${zoom}) translate(${-cx},${-cy})`;

  // hover 浮卡位置
  const hoverItem = hoverId ? items.find(i => i.id === hoverId) : null;
  const hoverNode = hoverId ? nodeMap[hoverId] : null;

  // 浮卡屏幕坐标
  let cardPos = null;
  if (hoverNode) {
    const sx = (hoverNode.x - cx) * zoom + cx + pan.x;
    const sy = (hoverNode.y - cy) * zoom + cy + pan.y;
    const r = (radiusOf(hoverItem)) * zoom;
    cardPos = { left: Math.min(width - 300, sx + r + 14), top: Math.max(12, sy - 60) };
  }

  // 该节点的关联（用于浮卡）
  const hoverRelated = ccM(() => {
    if (!hoverId) return [];
    const out = [];
    links.forEach(l => {
      if (l.source === hoverId) out.push({ id: l.target, w: l.weight });
      if (l.target === hoverId) out.push({ id: l.source, w: l.weight });
    });
    return out.sort((a, b) => b.w - a.w).slice(0, 2)
      .map(r => items.find(i => i.id === r.id)).filter(Boolean);
  }, [hoverId, links, items]);

  return (
    <>
      <div
        className={`cs-canvas ${dragging ? 'dragging' : ''}`}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onClick={(e) => {
          if (e.target.tagName === 'svg' || e.target.classList.contains('cs-canvas-bg')) {
            onBlur && onBlur();
          }
        }}
      >
        <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid slice">
          <defs>
            {/* 背景星点纹理 */}
            <radialGradient id="cs-glow-permanent">
              <stop offset="0%" stopColor="#d4a85f" stopOpacity="0.6"/>
              <stop offset="100%" stopColor="#d4a85f" stopOpacity="0"/>
            </radialGradient>
            <radialGradient id="cs-glow-feel">
              <stop offset="0%" stopColor="#d291b3" stopOpacity="0.5"/>
              <stop offset="100%" stopColor="#d291b3" stopOpacity="0"/>
            </radialGradient>
            <radialGradient id="cs-glow-dynamic">
              <stop offset="0%" stopColor="#a78bd0" stopOpacity="0.45"/>
              <stop offset="100%" stopColor="#a78bd0" stopOpacity="0"/>
            </radialGradient>
            <radialGradient id="cs-glow-archived">
              <stop offset="0%" stopColor="#8a8898" stopOpacity="0.2"/>
              <stop offset="100%" stopColor="#8a8898" stopOpacity="0"/>
            </radialGradient>
            <pattern id="cs-stardust" x="0" y="0" width="80" height="80" patternUnits="userSpaceOnUse">
              <circle cx="12" cy="20" r="0.5" fill="#fff" opacity="0.18"/>
              <circle cx="56" cy="48" r="0.4" fill="#a78bd0" opacity="0.25"/>
              <circle cx="36" cy="68" r="0.35" fill="#fff" opacity="0.12"/>
              <circle cx="68" cy="14" r="0.4" fill="#fff" opacity="0.15"/>
            </pattern>
          </defs>

          <rect className="cs-canvas-bg" x="0" y="0" width={width} height={height} fill="url(#cs-stardust)"/>

          <g transform={transform}>
            {/* 连线 */}
            {showLinks && links.map((l, i) => {
              const a = nodeMap[l.source], b = nodeMap[l.target];
              if (!a || !b) return null;
              const faded = isLinkFaded(l);
              const sw = Math.max(0.4, Math.min(2, 0.4 + l.weight * 0.35));
              return (
                <line
                  key={i}
                  className={`cs-link ${faded ? 'faded' : ''}`}
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  strokeWidth={sw / Math.max(0.5, zoom)}
                  opacity={faded ? 0.05 : linkOpacity * Math.min(1, l.weight / 3)}
                />
              );
            })}

            {/* 星点 */}
            {layout.map(n => {
              const it = items.find(i => i.id === n.id);
              if (!it) return null;
              const t = inferType(it);
              const vis = TYPE_VIS[t];
              const r = radiusOf(it);
              const act = activityOf(it, now);
              const faded = isFaded(it.id);
              const hi = it.importance >= 8 || it.highlight;
              const isSel = selectedId === it.id;
              const isHov = hoverId === it.id;

              // 光晕半径：永久星 + 重要 + 最近活跃
              const glowR = r * (1.8 + (hi ? 0.6 : 0) + act * 1.2);

              return (
                <g
                  key={it.id}
                  className={`cs-star ${faded ? 'faded' : ''} ${isSel ? 'selected' : ''}`}
                  transform={`translate(${n.x},${n.y})`}
                  onMouseEnter={() => onHover && onHover(it.id)}
                  onMouseLeave={() => onHover && onHover(null)}
                  onClick={(e) => { e.stopPropagation(); onSelect && onSelect(it.id); }}
                >
                  {/* 外层光晕 */}
                  <circle className="cs-star-glow" r={glowR} fill={`url(#cs-glow-${t})`} />
                  {/* 中圈（feel/permanent 多一层） */}
                  {(t === 'permanent' || t === 'feel' || hi) && (
                    <circle r={r * 1.4} fill="none" stroke={vis.fill} strokeOpacity={0.35} strokeWidth={0.6}/>
                  )}
                  {/* 核心 */}
                  <circle
                    className="cs-star-core"
                    r={isHov || isSel ? r * 1.18 : r}
                    fill={vis.fill}
                    opacity={t === 'archived' ? 0.55 : 1}
                  />
                  {/* permanent 星：四芒星十字光 */}
                  {t === 'permanent' && (
                    <g opacity={0.5}>
                      <line x1={-r * 2.4} y1="0" x2={r * 2.4} y2="0" stroke={vis.fill} strokeWidth="0.5"/>
                      <line x1="0" y1={-r * 2.4} x2="0" y2={r * 2.4} stroke={vis.fill} strokeWidth="0.5"/>
                    </g>
                  )}
                  {/* 标签 */}
                  {(showLabels === 'all' || (showLabels === 'smart' && (hi || isHov || isSel))) && (
                    <text
                      className="cs-star-label"
                      y={r + 14}
                      style={{ fontSize: Math.max(9, 11 / Math.max(0.7, zoom)) }}
                    >{it.title}</text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      {/* hover 浮卡 */}
      {hoverItem && cardPos && (
        <div className="cs-hover-card" style={{ left: cardPos.left, top: cardPos.top }}>
          <div className="cs-hover-eyebrow">
            <span className="cs-hover-dot" style={{ background: TYPE_VIS[inferType(hoverItem)].fill }}/>
            <span>{inferType(hoverItem)}</span>
            <span style={{ opacity: 0.5 }}>·</span>
            <span>{(hoverItem.tags || []).slice(0,2).join(' / ') || '未分类'}</span>
            <span style={{ opacity: 0.5 }}>·</span>
            <span>imp:{hoverItem.importance}</span>
          </div>
          <h3 className="cs-hover-title">{hoverItem.title}</h3>
          {hoverItem.summary && <div className="cs-hover-sum">{hoverItem.summary}</div>}
          {hoverRelated.length > 0 && (
            <div className="cs-hover-related">
              <b>关联：</b>{hoverRelated.map(r => r.title).join('、')}
            </div>
          )}
          <div className="cs-hover-foot">{hoverItem.date} · {hoverItem.time} · 点击查看 →</div>
        </div>
      )}
    </>
  );
}

window.StarCanvas = StarCanvas;
