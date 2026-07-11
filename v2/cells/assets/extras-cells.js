// extras-v2.jsx —— TodayBar / WriteDrawer / FAB / MiniTimeline / DarkToggle / Siblings / Related

const { useState: uS, useEffect: uE, useMemo: uM, useRef: uR } = React;

// ── 暗色切换 ──────────────────────────────────────────
function DarkToggle({ dark, onChange }) {
  return (
    <button
      className={`ob-dark-btn ${dark ? 'on' : ''}`}
      onClick={() => onChange(!dark)}
      title={dark ? '切到日间' : '切到暗夜'}
    >
      <span className="ob-dark-icon">{dark ? '☀' : '☾'}</span>
    </button>
  );
}

// ── 今天状态条 ────────────────────────────────────────
function TodayBar({ todayItems, lastWriteDate, todayDate, allItems, onWrite, onJumpToday }) {
  const all = allItems || todayItems || [];
  const totalCount = all.length;
  const totalDays = new Set(all.map(i => i.date).filter(Boolean)).size || 1;
  // 值得被反复想起 = 钉决 + 高亮 + 重要(>=8) 的并集 (不重复计数)
  const totalHi = all.filter(i => (i.protected || i.pinned) || i.highlight || (i.importance || 5) >= 8).length;
  const state = 'on';

  const f = formatDateV2(todayDate);
  return (
    <div className={`ob-today ob-today-${state}`}>
      <div className="ob-today-l">
        <div className="ob-today-pulse">
          <span className="ob-today-dot" />
          <span className="ob-today-ring" />
        </div>
        <div className="ob-today-text">
          <div className="ob-today-eyebrow">{f.y}-{f.m}-{f.day} · {f.wk}</div>
          <div className="ob-today-label">
            第 <strong className="ob-today-num-big" style={{ color: 'var(--ink-3)' }}>{totalDays}</strong> 天 · <strong className="ob-today-num-pink" style={{ color: 'var(--ink-3)' }}>{totalCount}</strong> 段记忆沉淀于此
          </div>
        </div>
      </div>
      <div className="ob-today-r">
        <div className="ob-today-sub">
          {totalHi > 0
            ? <><strong className="ob-today-num-pink" style={{ color: 'var(--ink-3)' }}>{totalHi}</strong> 条值得被反复想起</>
            : '继续记录这一天'}
        </div>
        <div className="ob-today-actions">
          {todayItems.length > 0 && (
            <button className="ob-today-btn primary" onClick={onJumpToday}>只看今天 ↓</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 右侧 Mini Timeline ──────────────────────────────
// 改成"按天"显示:每天一个点,无记忆的日子保持灰色,有记忆的按代表性 item 着色
function MiniTimeline({ items, onJump }) {
  const [hover, setHover] = uS(null);

  const days = uM(() => {
    if (!items.length) return [];
    const valid = items.filter(i => i.date);
    if (!valid.length) return [];
    const dates = valid.map(i => i.date).sort();
    const startStr = dates[0];
    const endStr = dates[dates.length - 1];
    const [sy, sm, sd] = startStr.split('-').map(Number);
    const [ey, em, ed] = endStr.split('-').map(Number);
    const start = new Date(sy, sm - 1, sd);
    const end = new Date(ey, em - 1, ed);
    const byDate = {};
    for (const it of valid) {
      if (!byDate[it.date]) byDate[it.date] = [];
      byDate[it.date].push(it);
    }
    // 自适应步长: 总跨度越大, 空日抽样越稀疏 (有记忆的天永远显示)
    const totalDays = Math.round((end - start) / 86400000) + 1;
    let emptyStep;
    if (totalDays <= 14)       emptyStep = 1;
    else if (totalDays <= 60)  emptyStep = 3;
    else if (totalDays <= 180) emptyStep = 7;
    else if (totalDays <= 365) emptyStep = 14;
    else                       emptyStep = 30;
    const result = [];
    const cur = new Date(end);
    let counter = 0;
    while (cur >= start) {
      const ds = cur.getFullYear() + '-' +
        String(cur.getMonth() + 1).padStart(2, '0') + '-' +
        String(cur.getDate()).padStart(2, '0');
      const dayItems = byDate[ds] || [];
      if (dayItems.length > 0 || counter % emptyStep === 0) {
        result.push({ date: ds, items: dayItems });
      }
      cur.setDate(cur.getDate() - 1);
      counter++;
    }
    return result;
  }, [items]);

  if (!days.length) return null;
  const compact = days.length > 60;

  return (
    <div className="ob-mini" aria-label="迷你时间线">
      <div className="ob-mini-rail">
        {days.map((d, i) => {
          const top = (i / Math.max(1, days.length - 1)) * 100;
          if (!d.items.length) {
            return (
              <div
                key={d.date}
                className="ob-mini-node"
                style={{
                  top: `${top}%`,
                  background: 'rgba(150, 142, 168, 0.22)',
                  boxShadow: 'none',
                  width: compact ? 3 : 4,
                  height: compact ? 3 : 4,
                  pointerEvents: 'none',
                }}
                title={`${d.date} · 无记忆`}
              />
            );
          }
          const repr = d.items.reduce((best, it) => {
            const rank = (x) => (x.feel ? 3 : 0) + ((x.importance >= 8 || x.highlight) ? 2 : (x.importance || 0) * 0.1);
            return rank(it) > rank(best) ? it : best;
          });
          const isHi = repr.importance >= 8 || repr.highlight;
          const tone = repr.feel ? 'feel' : (isHi ? 'hi' : 'norm');
          return (
            <div
              key={d.date}
              className={`ob-mini-node ob-mini-${tone}`}
              style={{ top: `${top}%` }}
              onMouseEnter={() => setHover({ date: d.date, count: d.items.length, title: repr.title })}
              onMouseLeave={() => setHover(null)}
              onClick={() => onJump(repr)}
              title={`${d.date} · ${d.items.length} 条`}
            />
          );
        })}
      </div>
      {hover && (
        <div className="ob-mini-tip">
          <div className="ob-mini-tip-d">{hover.date}</div>
          <div className="ob-mini-tip-t">{hover.count} 条 · {hover.title}</div>
        </div>
      )}
      <div className="ob-mini-label">
        <span>近</span>
        <span className="ob-mini-bar" />
        <span>远</span>
      </div>
    </div>
  );
}

// ── 浮动 FAB · 返回顶部 (在顶部时隐藏) ──────────────
function Fab({ onClick }) {
  const [show, setShow] = uS(false);
  uE(() => {
    const onScroll = () => setShow(window.scrollY > 200);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  if (!show) return null;
  const handleClick = () => {
    if (typeof onClick === 'function') {
      onClick();
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };
  return (
    <button className="ob-fab" onClick={handleClick} title="返回顶部">
      <span className="ob-fab-arrow">↑</span>
    </button>
  );
}

// ── 写入抽屉（v2 · 信纸感重设计）─────────────────────
function WriteDrawer({ open, onClose, onSave, defaultDate, defaultTime, defaultTags }) {
  // defaultDate/defaultTime 父组件常用 const TODAY (page-load 时算), 跨天没刷新就错
  // 改成抽屉打开那一刻内部自己取当下时间 (跟主版 92806636.js 同步)
  const _freshNow = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    };
  };
  const _initial = _freshNow();
  const [title, setTitle] = uS('');
  const [summary, setSummary] = uS('');
  const [body, setBody] = uS('');
  const [time, setTime] = uS(_initial.time);
  const [date, setDate] = uS(_initial.date);
  const [importance, setImportance] = uS(5);
  const [feel, setFeel] = uS(false);
  const [protectFlag, setProtect] = uS(false);
  const [highlightFlag, setHighlight] = uS(false);
  const [internalizedFlag, setInternalized] = uS(false);
  const [tags, setTags] = uS([]);
  const titleRef = uR(null);

  uE(() => {
    if (open) {
      const now = _freshNow();  // 每次开抽屉重新取
      setTitle(''); setSummary(''); setBody(''); setImportance(5);
      setFeel(false); setProtect(false); setHighlight(false); setInternalized(false);
      setTags(defaultTags || []);
      setDate(now.date); setTime(now.time);
      setTimeout(() => titleRef.current && titleRef.current.focus(), 80);
    }
  }, [open, defaultTags]);

  uE(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && title.trim()) {
        e.preventDefault();
        onSave({ title, summary, body, date, time, importance, feel,
                 protected: protectFlag, highlight: highlightFlag, internalized: internalizedFlag,
                 tags });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, title, summary, body, date, time, importance, feel, protectFlag, highlightFlag, internalizedFlag, tags, onSave, onClose]);

  if (!open) return null;

  const toggleTag = (t) => {
    setTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
  };

  // 注: 来源类 (亲手写/AI 写入/导入) 由 metadata.created_by 决定, 不放进可选 tag
  //     钉决/高亮/已消化/feel 也都有独立 toggle, 不再放 tag — 避免双轨制
  //     这里只保留主题域 tag(跟 ConsoleItemModal 的 allTagOptions 域 tag 部分对齐)
  const allTags = ['编程', '工作', '恋爱', '创作', 'AI', '出行', '内心', '日常', '成长'];
  const valid = title.trim().length > 0;
  const charCount = title.length + summary.length + body.length;

  // importance 标签
  const impTone = importance >= 9 ? '里程碑' : importance >= 7 ? '重要' : importance >= 5 ? '日常' : importance >= 3 ? '碎片' : '微光';

  return (
    <div className="ob-write-wrap" onClick={onClose}>
      <div className="ob-write" onClick={(e) => e.stopPropagation()}>
        {/* 装订线 */}
        <div className="ob-write-binding" />
        <button className="ob-write-close" onClick={onClose} title="Esc">✕</button>

        <div className="ob-write-paper">
          {/* 头标：日期 + 时间 一体化 */}
          <div className="ob-write-stamp">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="ob-write-stamp-d" />
            <span className="ob-write-stamp-sep">·</span>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="ob-write-stamp-t" />
            <button className="ob-write-now" onClick={() => { setDate(defaultDate); setTime(defaultTime); }} title="使用现在">↺</button>
          </div>

          {/* 主标题（极简下划线） */}
          <input
            ref={titleRef}
            className="ob-write-title"
            placeholder="标题——这一刻是什么？"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />

          {/* 摘要 */}
          <textarea
            className="ob-write-sum"
            placeholder="一句话摘要 · 留空则不显示"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows="2"
          />

          {/* 折叠正文 */}
          <details className="ob-write-body-wrap">
            <summary>＋ 展开正文（可选）</summary>
            <textarea
              className="ob-write-body"
              placeholder="…慢慢写。留白也可以。"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows="5"
            />
          </details>

          {/* 横向元数据条 */}
          <div className="ob-write-meta-row">
            {/* importance 大滑块 */}
            <div className="ob-write-imp-wrap">
              <div className="ob-write-imp-hd">
                <span>importance</span>
                <span className="ob-write-imp-num"><b>{importance}</b><em>· {impTone}</em></span>
              </div>
              <div className="ob-write-imp-track">
                {Array.from({ length: 10 }).map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`ob-write-imp-cell ${i < importance ? 'on' : ''} ${i < importance && i >= 7 ? 'hi' : ''}`}
                    onClick={() => setImportance(i + 1)}
                    title={`${i + 1}`}
                  />
                ))}
              </div>
            </div>

            {/* flags */}
            <div className="ob-write-flags">
              <button
                type="button"
                className={`ob-write-flag ${feel ? 'on feel' : ''}`}
                onClick={() => setFeel(!feel)}
              >
                <span className="ob-write-flag-i">♡</span>
                <span>feel</span>
              </button>
              <button
                type="button"
                className={`ob-write-flag ${protectFlag ? 'on protect' : ''}`}
                onClick={() => setProtect(!protectFlag)}
              >
                <span className="ob-write-flag-i">❖</span>
                <span>钉决</span>
              </button>
              <button
                type="button"
                className={`ob-write-flag ${highlightFlag ? 'on highlight' : ''}`}
                onClick={() => setHighlight(!highlightFlag)}
                title="高亮 — breath 浮现时进核心准则区, 不锁 importance"
              >
                <span className="ob-write-flag-i">★</span>
                <span>高亮</span>
              </button>
              <button
                type="button"
                className={`ob-write-flag ${internalizedFlag ? 'on internalized' : ''}`}
                onClick={() => setInternalized(!internalizedFlag)}
                title="已消化 — 已经消化吸收, 不再需要主动浮现"
              >
                <span className="ob-write-flag-i">◐</span>
                <span>已消化</span>
              </button>
            </div>
          </div>

          {/* 标签 */}
          <div className="ob-write-tags-wrap">
            <span className="ob-write-tags-lbl">标签</span>
            <div className="ob-write-tags">
              {allTags.map(t => (
                <button
                  key={t}
                  type="button"
                  className={`ob-write-tag ${tags.includes(t) ? 'on' : ''}`}
                  onClick={() => toggleTag(t)}
                >{t}</button>
              ))}
            </div>
          </div>
        </div>

        {/* 浮动底栏 */}
        <footer className="ob-write-foot">
          <div className="ob-write-foot-meta">
            <span>{charCount} 字</span>
            <span className="dot">·</span>
            <span>⌘↵ 保存</span>
            <span className="dot">·</span>
            <span>Esc 取消</span>
          </div>
          <button
            className="ob-write-save"
            disabled={!valid}
            onClick={() => valid && onSave({
              title, summary, body, date, time, importance, feel,
              protected: protectFlag, highlight: highlightFlag, internalized: internalizedFlag,
              tags,
            })}
          >
            <span>接住这一刻</span>
            <span className="ob-write-save-arrow">↵</span>
          </button>
        </footer>
      </div>
    </div>
  );
}

// 同日其他条目
function SiblingsRow({ items, current, onOpen }) {
  const others = items.filter(i => i.id !== current.id);
  if (others.length === 0) return null;
  return (
    <>
      <div className="ob-modal-section">同日其他记忆 · {others.length}</div>
      <div className="ob-siblings">
        {others.map(it => {
          const isHi = it.importance >= 8 || it.highlight;
          return (
            <button key={it.id} className="ob-sibling" onClick={() => onOpen(it)}>
              <div className="ob-sibling-time">{it.time}</div>
              <div className={`ob-sibling-title ${isHi ? 'hi' : ''} ${it.feel ? 'feel' : ''}`}>{it.title}</div>
              {it.summary && <div className="ob-sibling-sum">{it.summary}</div>}
            </button>
          );
        })}
      </div>
    </>
  );
}

// 关联记忆 — 走 embedding 全库语义相似(/api/bucket/:id/similar)替代旧的 tag 共现打分
function RelatedRow({ all, current, onOpen }) {
  const [similar, setSimilar] = uS(null);
  const [errMsg, setErrMsg] = uS('');

  uE(() => {
    if (!current?.id) return;
    let cancelled = false;
    setSimilar(null);
    setErrMsg('');
    const fn = window.__obFetchSimilar;
    if (!fn) {
      setErrMsg('embedding 未启用');
      setSimilar([]);
      return;
    }
    fn(current.id, 3).then(items => {
      if (cancelled) return;
      const filtered = (items || []).filter(s => s.date !== current.date);
      setSimilar(filtered);
    }).catch(e => {
      if (cancelled) return;
      setErrMsg(e.message || String(e));
      setSimilar([]);
    });
    return () => { cancelled = true; };
  }, [current?.id]);

  if (similar === null) {
    return (
      <>
        <div className="ob-modal-section">可能关联 · 语义相似</div>
        <div className="ob-siblings">
          <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--ink-3)', fontStyle: 'italic' }}>
            正在计算相似度…
          </div>
        </div>
      </>
    );
  }
  if (similar.length === 0) return null;

  const allMap = new Map((all || []).map(a => [a.id, a]));
  const itemsToShow = similar.slice(0, 3).map(s => {
    const full = allMap.get(s.id);
    return {
      ...(full || {
        id: s.id, title: s.name || s.id, summary: s.summary || '',
        date: s.date || '', time: '', tags: [], importance: 5,
      }),
      _simScore: s.score,
    };
  });

  return (
    <>
      <div className="ob-modal-section">可能关联 · 语义相似</div>
      <div className="ob-siblings">
        {itemsToShow.map(it => (
          <button key={it.id} className="ob-sibling related" onClick={() => onOpen(it)}>
            <div className="ob-sibling-time">
              {it.date}{it.time ? ' · ' + it.time : ''}
              {it._simScore != null && (
                <span style={{ marginLeft: 8, opacity: 0.55, fontFamily: 'var(--mono)' }}>
                  {Math.round(it._simScore * 100)}%
                </span>
              )}
            </div>
            <div className={`ob-sibling-title ${it.importance >= 8 ? 'hi' : ''} ${it.feel ? 'feel' : ''}`}>{it.title}</div>
            {it.summary && <div className="ob-sibling-sum">{it.summary}</div>}
          </button>
        ))}
      </div>
    </>
  );
}

window.DarkToggle = DarkToggle;
window.TodayBar = TodayBar;
window.MiniTimeline = MiniTimeline;
window.Fab = Fab;
window.WriteDrawer = WriteDrawer;
window.SiblingsRow = SiblingsRow;
window.RelatedRow = RelatedRow;
