// console-import.jsx —— 历史对话导入 / 已导入记忆 / 高频模式

const { useState: ciS, useMemo: ciM, useRef: ciR } = React;

function ImportPage({ items }) {
  const [over, setOver] = ciS(false);
  const [keepRaw, setKeepRaw] = ciS(false);
  const [filter, setFilter] = ciS('all');  // all / dynamic / permanent / feel
  const [search, setSearch] = ciS('');
  const inputRef = ciR(null);
  const [patterns, setPatterns] = ciS([]);
  const [analyzing, setAnalyzing] = ciS(false);

  const onDrop = (e) => {
    e.preventDefault();
    setOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) alert(`收到 ${files.length} 个文件（mock）：\n${files.map(f => f.name).join('\n')}`);
  };

  const importable = ciM(() => {
    return items.filter(i => {
      if (filter === 'dynamic' && i.protected) return false;
      if (filter === 'permanent' && !i.protected) return false;
      if (filter === 'feel' && !i.feel) return false;
      if (search && !`${i.title} ${i.summary} ${(i.tags || []).join(' ')}`.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [items, filter, search]);

  // 检测高频模式
  const detectPatterns = () => {
    setAnalyzing(true);
    setTimeout(() => {
      // 模拟：抽取 tag 共现 top + feel 集中时段 + 重复主题
      const tagCount = {};
      items.forEach(i => (i.tags || []).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; }));
      const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 4);
      const feelCount = items.filter(i => i.feel).length;
      const ps = [
        topTags[0] && {
          icon: '⊕',
          title: `高频主题 · #${topTags[0][0]}`,
          stat: `共出现 ${topTags[0][1]} 次 · 占比 ${((topTags[0][1] / items.length) * 100).toFixed(1)}%`,
          accent: 'topic',
        },
        topTags[1] && {
          icon: '◑',
          title: `次高频 · #${topTags[1][0]}`,
          stat: `共出现 ${topTags[1][1]} 次 · 与 #${topTags[0][0]} 多次共现`,
          accent: 'topic',
        },
        feelCount > 0 && {
          icon: '♡',
          title: 'feel 类记忆集中区',
          stat: `${feelCount} 条情感性记忆 · 建议夜间合并时跳过避免被压缩`,
          accent: 'feel',
        },
        {
          icon: '↻',
          title: '重复触发：「记忆系统」相关讨论',
          stat: '近 7 天 4 次 · 建议升格为永久 / 钉决',
          accent: 'pattern',
        },
        {
          icon: '⌁',
          title: '深夜活跃模式',
          stat: '23:00 后写入 6 条 · 占比 27.3% · 多带情感色彩',
          accent: 'time',
        },
      ].filter(Boolean);
      setPatterns(ps);
      setAnalyzing(false);
    }, 800);
  };

  return (
    <main className="oc-main">
      <ConsolePageHd
        title="导入"
        sub={<>把过去的对话与笔记倒进来 —— 系统会自动脱水、打标、计算情感与重要度，再合并入库。支持 Claude JSON / ChatGPT 导出 / DeepSeek / Markdown / 纯文本。</>}
        rightSlot={<div className="ob-page-counter"><b>{items.length}</b> 已入库 · <b>{patterns.length || 0}</b> 模式</div>}
      />

      {/* 拖拽区 */}
      <ConsoleCard label="历史对话导入" sub="支持 Claude JSON · ChatGPT 导出 · DeepSeek · Markdown · 纯文本">
        <div
          className={`oc-drop${over ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current && inputRef.current.click()}
        >
          <div className="oc-drop-icon">⌖</div>
          <div className="oc-drop-text">
            拖拽文件到此处，或 <a>点击选择</a>
          </div>
          <div className="oc-drop-hint">
            JSON · MD · TXT · ZIP · 单个文件 ≤ 50 MB · 批量 ≤ 200 文件
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              if (files.length) alert(`选中 ${files.length} 个文件（mock）`);
            }}
          />
        </div>
        <div style={{ marginTop: 14, display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="oc-checkbox">
            <input type="checkbox" checked={keepRaw} onChange={(e) => setKeepRaw(e.target.checked)} />
            保留原文模式（特殊情境 / 暗号 / 仅仪式性内容不摘要）
          </label>
          <label className="oc-checkbox">
            <input type="checkbox" defaultChecked />
            自动 embedding
          </label>
          <label className="oc-checkbox">
            <input type="checkbox" defaultChecked />
            自动打标
          </label>
          <button className="oc-btn oc-btn-ghost" style={{ marginLeft: 'auto' }}>导入设置 …</button>
        </div>
      </ConsoleCard>

      {/* 已导入记忆 */}
      <ConsoleCard
        label="已导入记忆"
        sub={`${importable.length} / ${items.length} 条 · 可搜索、过滤、刷新`}
        foot={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>提示：点条目可前往时间线查看；操作不会改写原始对话</span>
            <button className="oc-btn oc-btn-ghost" onClick={() => alert('刷新（mock）')}>↻ 刷新</button>
          </div>
        }
      >
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="oc-input"
            placeholder="搜索标题 / 摘要 / 标签…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          {[
            ['all', '全部'],
            ['dynamic', 'dynamic'],
            ['permanent', '钉决'],
            ['feel', 'feel'],
          ].map(([k, label]) => (
            <button
              key={k}
              className={`oc-btn ${filter === k ? 'oc-btn-primary' : 'oc-btn-ghost'}`}
              onClick={() => setFilter(k)}
              style={{ padding: '6px 14px', fontSize: 12 }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="oc-imported-list">
          {importable.map(it => (
            <div key={it.id} className="oc-imported-item">
              <div className="oc-imported-hd">
                <div className="oc-imported-title">
                  {it.protected && <span style={{ color: 'var(--accent)', marginRight: 4 }}>❖</span>}
                  {it.feel && <span style={{ color: 'var(--rose-deep)', marginRight: 4 }}>♡</span>}
                  {it.title}
                </div>
                <div className="oc-imported-meta">
                  {it.protected ? 'permanent' : 'dynamic'} · {it.date} · imp {it.importance}
                </div>
              </div>
              <div className="oc-imported-body">{it.summary || it.body}</div>
              <div className="oc-imported-tags">
                {(it.tags || []).slice(0, 8).map(t => <span key={t}>#{t}</span>)}
              </div>
              <div className="oc-imported-actions">
                <button className={`oc-imp-action${it.protected ? ' on' : ''}`}>❖ 钉决</button>
                <button className="oc-imp-action">★ 高亮</button>
                <button className="oc-imp-action">🪶 噤声</button>
                <button className="oc-imp-action danger">🗑 删除</button>
              </div>
            </div>
          ))}
          {importable.length === 0 && (
            <div className="oc-pattern-empty">无符合条件的记忆 —— 调整筛选或搜索词</div>
          )}
        </div>
      </ConsoleCard>

      {/* 高频模式检测 */}
      <ConsoleCard
        label="高频模式"
        sub="基于已导入记忆，自动找出值得升格 / 内化 / 提醒的反复出现的主题"
        foot={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>越早做模式检测，记忆系统越能识别"你真正在意的事"</span>
            <button className="oc-btn oc-btn-primary" onClick={detectPatterns} disabled={analyzing}>
              {analyzing ? '◐ 分析中…' : '⌖ 检测高频模式'}
            </button>
          </div>
        }
      >
        {patterns.length === 0 ? (
          <div className="oc-pattern-empty">
            未检测到高频模式 —— 点击下方按钮开始分析
          </div>
        ) : (
          patterns.map((p, i) => (
            <div key={i} className="oc-pattern">
              <div className="oc-pattern-icon">{p.icon}</div>
              <div className="oc-pattern-body">
                <div className="oc-pattern-title">{p.title}</div>
                <div className="oc-pattern-stat">{p.stat}</div>
              </div>
              <button className="oc-imp-action" style={{ marginLeft: 'auto', alignSelf: 'center' }}>
                查看相关 →
              </button>
            </div>
          ))
        )}
      </ConsoleCard>
    </main>
  );
}

window.ImportPage = ImportPage;
