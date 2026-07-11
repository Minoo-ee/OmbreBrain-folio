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
function TodayBar({ todayItems, lastWriteDate, todayDate, focusToday, totalDays, totalHi, totalCount, onWrite, onJumpToday }) {
  const state = 'on';
  const days = totalDays || 1;
  const count = totalCount || todayItems.length;

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
            第 <strong className="ob-today-num-big" style={{ color: 'var(--ink-3)' }}>{days}</strong> 天 · <strong className="ob-today-num-pink" style={{ color: 'var(--ink-3)' }}>{count}</strong> 段记忆沉淀于此
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
            <button
              className="ob-today-btn primary"
              onClick={onJumpToday}
              title={focusToday ? '点击退出聚焦,恢复全部' : '聚焦今天 · 其他天减淡'}
              style={{ transition: 'all .2s' }}
            >
              {focusToday ? '✕ 退出聚焦' : '只看今天 ↓'}
            </button>
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
    const [sy, sm, sd] = dates[0].split('-').map(Number);
    const [ey, em, ed] = dates[dates.length - 1].split('-').map(Number);
    const start = new Date(sy, sm - 1, sd);
    const end = new Date(ey, em - 1, ed);

    // 按日期分组
    const byDate = {};
    for (const it of valid) {
      if (!byDate[it.date]) byDate[it.date] = [];
      byDate[it.date].push(it);
    }
    const fmt = (dt) => dt.getFullYear() + '-' +
      String(dt.getMonth() + 1).padStart(2, '0') + '-' +
      String(dt.getDate()).padStart(2, '0');

    // 这是个"快速跳转进度条", 不是逐日清单。跨度大就把节点压成"区间"(N 天一段),
    // 否则两三个月就几十个点 → 又密又难点。每个节点代表 bucketDays 天的一段。
    const totalDays = Math.round((end - start) / 86400000) + 1;
    let bucketDays;
    if (totalDays <= 30)       bucketDays = 1;   // 一月内: 一天一点
    else if (totalDays <= 90)  bucketDays = 3;   // 三月内: 3 天一段
    else if (totalDays <= 365) bucketDays = 7;   // 一年内: 一周一段
    else                       bucketDays = 30;  // 超一年: 一月一段

    // 从 end 倒推, 每 bucketDays 天聚成一段(顶部=最新)
    const result = [];
    const bEnd = new Date(end);
    while (bEnd >= start) {
      let bStart = new Date(bEnd);
      bStart.setDate(bStart.getDate() - (bucketDays - 1));
      if (bStart < start) bStart = new Date(start);
      // 收集这段范围内所有 item
      const seg = [];
      const cur = new Date(bEnd);
      while (cur >= bStart) {
        const ds = fmt(cur);
        if (byDate[ds]) seg.push(...byDate[ds]);
        cur.setDate(cur.getDate() - 1);
      }
      result.push({ from: fmt(bStart), to: fmt(bEnd), single: bucketDays === 1, items: seg });
      bEnd.setDate(bEnd.getDate() - bucketDays);
    }
    return result;
  }, [items]);

  if (!days.length) return null;

  // 节点过多缩小尺寸 (基于实际显示节点数)
  const compact = days.length > 40;

  return (
    <div className="ob-mini" aria-label="迷你时间线">
      <div className="ob-mini-rail">
        {days.map((d, i) => {
          const top = (i / Math.max(1, days.length - 1)) * 100;
          // 区间标签: 单日显完整日期, 多日显 "MM/DD–MM/DD"
          const label = d.single ? d.to : `${d.from.slice(5).replace('-', '/')}–${d.to.slice(5).replace('-', '/')}`;
          if (!d.items.length) {
            // 这段没记忆 — 灰色小点,不可点
            return (
              <div
                key={d.to}
                className="ob-mini-node"
                style={{
                  top: `${top}%`,
                  background: 'rgba(150, 142, 168, 0.22)',
                  boxShadow: 'none',
                  width: compact ? 3 : 4,
                  height: compact ? 3 : 4,
                  pointerEvents: 'none',
                }}
                title={`${label} · 无记忆`}
              />
            );
          }
          // 有记忆 — 选最强代表(feel > 重要 > 普通)
          const repr = d.items.reduce((best, it) => {
            const rank = (x) => (x.feel ? 3 : 0) + ((x.importance >= 8 || x.highlight) ? 2 : (x.importance || 0) * 0.1);
            return rank(it) > rank(best) ? it : best;
          });
          const isHi = repr.importance >= 8 || repr.highlight;
          const tone = repr.feel ? 'feel' : (isHi ? 'hi' : 'norm');
          return (
            <div
              key={d.to}
              className={`ob-mini-node ob-mini-${tone}`}
              style={{ top: `${top}%` }}
              onMouseEnter={() => setHover({ date: label, count: d.items.length, title: repr.title })}
              onMouseLeave={() => setHover(null)}
              onClick={() => onJump(repr)}
              title={`${label} · ${d.items.length} 条`}
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
function WriteDrawer({ open, onClose, onSave, defaultTags }) {
  // defaultDate/defaultTime 不再从父组件传 — 抽屉打开那一刻自己取当下时间
  // 之前父组件用 const TODAY (页面加载时计算) 永远不变, 跨天没刷新就错日期
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
            <button className="ob-write-now" onClick={() => { const n = _freshNow(); setDate(n.date); setTime(n.time); }} title="使用现在">↺</button>
          </div>

          {/* 主标题（极简下划线） */}
          <input
            ref={titleRef}
            className="ob-write-title"
            placeholder="标题——这一刻是什么？"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
          />

          {/* 摘要 */}
          <textarea
            className="ob-write-sum"
            placeholder="一句话摘要 · 留空则不显示"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows="2"
          />

          {/* 正文 */}
          <textarea
            className="ob-write-body"
            placeholder="正文区域"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows="5"
          />

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
  const [similar, setSimilar] = uS(null);   // null = loading, [] = no result, [...] = items
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
      // 过滤掉同日条目(同日已经在 SiblingsRow 显示)
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

  // 用 all 数组里完整 mock 优先,缺了就用 similar 自带最小字段合成
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
