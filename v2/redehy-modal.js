// redehy-modal.js — 共享重新脱水弹窗 (工作台 + ItemModal 编辑界面共用)
//
// 暴露: window.RedehydrateModal
//
// Props:
//   open      bool         是否显示
//   item      { id, title, rawSource }   当前记忆 (rawSource 控制"重写正文"勾选可用性)
//   busy      bool         父组件正在 fetch (preview / commit / reroll); 禁用按钮
//   preview   null|object  null = options 阶段 (Phase 1)
//                          { old, new, regenerated_content, cost } = preview 阶段 (Phase 2)
//   onCancel  ()
//   onPreview ({ regenerate_content })
//   onReroll  ({ regenerate_content })
//   onCommit  (finalDraft)
//             finalDraft = { content?, name, summary, tags, domain, valence, arousal }
//
// 调用方负责把 item.rawSource 准备好 (workbench 已在 bucketToItem 里映射;
// ItemModal 用 item._meta?.raw_source 兜底). 这层组件不直接读 _meta.

(function () {
  const { useState, useEffect } = React;

  function RedehydrateModal({ open, item, busy, preview, onCancel, onPreview, onReroll, onCommit }) {
    const [regenContent, setRegenContent] = useState(false);
    const [draftContent, setDraftContent] = useState('');
    const [draftName, setDraftName]       = useState('');
    const [draftSummary, setDraftSummary] = useState('');
    const [draftTags, setDraftTags]       = useState([]);
    const [tagInput, setTagInput]         = useState('');

    useEffect(() => {
      if (!open) {
        setRegenContent(false);
        setDraftContent(''); setDraftName(''); setDraftSummary('');
        setDraftTags([]); setTagInput('');
      }
    }, [open]);

    useEffect(() => {
      if (preview && preview.new) {
        setDraftContent(preview.new.content || '');
        setDraftName(preview.new.name || '');
        setDraftSummary(preview.new.summary || '');
        setDraftTags(Array.isArray(preview.new.tags) ? preview.new.tags : []);
      }
    }, [preview]);

    if (!open || !item) return null;
    const hasSource = !!(item.rawSource && String(item.rawSource).trim());
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onCancel(); };

    const isPreview = !!preview;

    const addTag = () => {
      const t = tagInput.trim();
      if (!t) return;
      if (!draftTags.includes(t)) setDraftTags([...draftTags, t]);
      setTagInput('');
    };
    const rmTag = (t) => setDraftTags(draftTags.filter(x => x !== t));

    if (!isPreview) {
      return (
        <div className="redehy-modal-mask" onClick={busy ? undefined : onCancel} onKeyDown={onKey}>
          <div className="redehy-modal" onClick={e => e.stopPropagation()}>
            <div className="redehy-modal-hd">
              <div className="redehy-modal-icon">↻</div>
              <div className="redehy-modal-title">重新脱水</div>
            </div>
            <div className="redehy-modal-target">「{item.title || '未命名'}」</div>
            <div className="redehy-modal-desc">
              让 LLM 重新生成这条记忆的<b>标题 / 摘要 / 标签 / 情感坐标</b>。<br/>
              预览界面会显示新旧对比, 你确认后才会写入。
            </div>

            <label className={'redehy-opt' + (hasSource ? '' : ' is-disabled')}>
              <input
                type="checkbox"
                checked={regenContent && hasSource}
                disabled={!hasSource || busy}
                onChange={e => setRegenContent(e.target.checked)}
              />
              <div className="redehy-opt-text">
                <div className="redehy-opt-ttl">同时重新提炼正文</div>
                <div className="redehy-opt-sub">
                  {hasSource
                    ? '基于原文 (raw_source) + 主题锚点重写正文 (聚焦当前主题, 不会扩到原文其他主题)。多耗一次 LLM 调用。'
                    : '此条无原文 (raw_source 为空), 无法重新提炼正文。'}
                </div>
              </div>
            </label>

            <div className="redehy-modal-foot">
              <button className="redehy-btn" onClick={onCancel} disabled={busy}>取消</button>
              <button
                className="redehy-btn is-primary"
                onClick={() => onPreview({ regenerate_content: regenContent && hasSource })}
                disabled={busy}
              >
                {busy ? '生成预览中…' : '生成预览'}
              </button>
            </div>
          </div>
        </div>
      );
    }

    const old = preview.old || {};
    const newM = preview.new || {};
    const showContentDiff = preview.regenerated_content;

    return (
      <div className="redehy-modal-mask redehy-modal-mask-wide" onClick={busy ? undefined : onCancel} onKeyDown={onKey}>
        <div className="redehy-modal redehy-modal-preview" onClick={e => e.stopPropagation()}>
          <div className="redehy-modal-hd">
            <div className="redehy-modal-icon">↻</div>
            <div className="redehy-modal-title">重新脱水 · 预览</div>
            <div className="redehy-preview-cost">
              {preview.cost && preview.cost.known
                ? `约 $${preview.cost.usd.toFixed(4)} (¥${preview.cost.cny.toFixed(2)})`
                : ''}
            </div>
          </div>
          <div className="redehy-modal-target">「{item.title || '未命名'}」</div>

          {showContentDiff && (
            <div className="redehy-diff-block">
              <div className="redehy-diff-row">
                <div className="redehy-diff-col">
                  <div className="redehy-diff-lbl redehy-diff-lbl-old">旧正文</div>
                  <div className="redehy-diff-readonly">{old.content || '(空)'}</div>
                </div>
                <div className="redehy-diff-col">
                  <div className="redehy-diff-lbl redehy-diff-lbl-new">新正文 · 可编辑</div>
                  <textarea
                    className="redehy-diff-edit"
                    value={draftContent}
                    onChange={e => setDraftContent(e.target.value)}
                    rows={Math.min(20, Math.max(6, draftContent.split('\n').length + 1))}
                    disabled={busy}
                  />
                </div>
              </div>
            </div>
          )}

          <div className="redehy-diff-block">
            <div className="redehy-diff-row">
              <div className="redehy-diff-col">
                <div className="redehy-diff-lbl redehy-diff-lbl-old">旧 · 标题</div>
                <div className="redehy-diff-readonly redehy-diff-line">{old.name || '(空)'}</div>
                <div className="redehy-diff-lbl redehy-diff-lbl-old">旧 · 摘要</div>
                <div className="redehy-diff-readonly">{old.summary || '(空)'}</div>
                <div className="redehy-diff-lbl redehy-diff-lbl-old">旧 · 标签</div>
                <div className="redehy-diff-tags">
                  {(old.tags || []).filter(t => !String(t).startsWith('__')).map((t, i) => (
                    <span key={i} className="redehy-tag-chip">{t}</span>
                  ))}
                  {(!old.tags || old.tags.length === 0) && <span className="redehy-diff-empty">(无)</span>}
                </div>
              </div>
              <div className="redehy-diff-col">
                <div className="redehy-diff-lbl redehy-diff-lbl-new">新 · 标题 · 可编辑</div>
                <input
                  className="redehy-diff-edit redehy-diff-edit-line"
                  value={draftName}
                  onChange={e => setDraftName(e.target.value)}
                  disabled={busy}
                />
                <div className="redehy-diff-lbl redehy-diff-lbl-new">新 · 摘要 · 可编辑</div>
                <textarea
                  className="redehy-diff-edit"
                  value={draftSummary}
                  onChange={e => setDraftSummary(e.target.value)}
                  rows={2}
                  disabled={busy}
                />
                <div className="redehy-diff-lbl redehy-diff-lbl-new">新 · 标签 · 可编辑</div>
                <div className="redehy-diff-tags-edit">
                  {draftTags.map((t, i) => (
                    <span key={i} className="redehy-tag-chip is-new">
                      {t}<span className="x" onClick={() => !busy && rmTag(t)}>×</span>
                    </span>
                  ))}
                  <input
                    className="redehy-tag-input"
                    value={tagInput}
                    onChange={e => setTagInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
                    onBlur={addTag}
                    placeholder="+ 加标签"
                    disabled={busy}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="redehy-modal-foot redehy-modal-foot-preview">
            <button className="redehy-btn" onClick={onCancel} disabled={busy}>取消 (不写入)</button>
            <div style={{ flex: 1 }} />
            <button
              className="redehy-btn"
              onClick={() => onReroll({ regenerate_content: showContentDiff })}
              disabled={busy}
              title="再让 LLM 跑一次, 当前编辑会丢失"
            >
              {busy ? '生成中…' : '↻ 重做'}
            </button>
            <button
              className="redehy-btn is-primary"
              onClick={() => onCommit({
                content: showContentDiff ? draftContent : undefined,
                name: draftName,
                summary: draftSummary,
                tags: draftTags,
                domain: newM.domain,
                valence: newM.valence,
                arousal: newM.arousal,
              })}
              disabled={busy}
            >
              {busy ? '写入中…' : '✓ 接受并写入'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  window.RedehydrateModal = RedehydrateModal;
})();
