// detail.jsx —— 当日详情侧滑面板 + 单条详情

function DayDetail({ date, items, onClose, onOpenItem, accent }) {
  if (!date) return null;
  const f = formatDate(date);
  // 按时间升序展示当日时间轴（晨→晚），更符合"一天的叙事"
  const sorted = [...items].sort((a, b) => a.time.localeCompare(b.time));

  return (
    <div className="ob-drawer-wrap" onClick={onClose}>
      <div className="ob-drawer" onClick={(e) => e.stopPropagation()} style={{ '--ob-accent': accent }}>
        <div className="ob-drawer-hd">
          <div>
            <div className="ob-drawer-eyebrow">当日全部记忆 · {sorted.length} 条</div>
            <div className="ob-drawer-title">
              <span className="ob-drawer-day">{f.day}</span>
              <span className="ob-drawer-meta">
                <span>{f.y} 年 {f.m} 月</span>
                <span>{f.wk}</span>
              </span>
            </div>
          </div>
          <button className="ob-drawer-close" onClick={onClose}>✕</button>
        </div>

        <div className="ob-drawer-stats">
          <div><b>{sorted.length}</b><span>条目</span></div>
          <div><b>{sorted.filter(i => i.protected || i.pinned).length}</b><span style={{ color: 'var(--c-pin)' }}>❖ 钉决</span></div>
          <div><b>{sorted.filter(i => i.highlight).length}</b><span style={{ color: 'var(--c-highlight)' }}>★ 高亮</span></div>
          <div><b>{sorted.filter(i => (i.importance || 5) >= 8).length}</b><span style={{ color: 'var(--c-fresh)' }}>✦ 重要</span></div>
          <div><b>{sorted.filter(i => i.feel).length}</b><span style={{ color: 'var(--c-feel)' }}>♡ feel</span></div>
        </div>

        <div className="ob-drawer-body">
          <div className="ob-day-axis">
            <div className="ob-day-axis-line" />
            {sorted.map((it, idx) => (
              <article
                key={it.id}
                className={`ob-detail ${onOpenItem ? 'ob-detail-clickable' : ''}`}
                onClick={() => onOpenItem && onOpenItem(it)}
              >
                <div className="ob-detail-axis">
                  <TimelineDot importance={it.importance} highlight={it.highlight} feel={it.feel} />
                  <div className="ob-detail-time">{it.time}</div>
                </div>
                <div className="ob-detail-card">
                  <header className="ob-detail-hd">
                    <h3>{it.title}</h3>
                    {typeof it.score === 'number' && (
                      <span className="ob-detail-score" title="decay 权重">{it.score.toFixed(2)}</span>
                    )}
                    <div className="ob-detail-imp">importance · <b>{it.importance}</b></div>
                  </header>
                  {(it.body || it.preview) && (
                    <div className="ob-detail-body">{it.body || it.preview}</div>
                  )}
                  <div className="ob-detail-foot">
                    <div className="ob-detail-tags">
                      {(it.tags || []).map(t => <Tag key={t} name={t} />)}
                    </div>
                    {it.artifacts && it.artifacts.length > 0 && (
                      <div className="ob-detail-arts">
                        {it.artifacts.map(a => (
                          <span key={a} className="ob-art">▤ {a}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  {onOpenItem && (
                    <div className="ob-detail-open">查看完整详情 →</div>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

window.DayDetail = DayDetail;
