# -*- coding: utf-8 -*-
# ============================================================
# tools/enrich_summaries.py — 存量记忆 enrichment (2026-07-06 写入侧轮·第1刀)
#
# 干什么: 给缺 summary 的活跃桶批量产「summary + 补充 tags」候选。
# 生成标准 = Desktop\记忆库优化\03-写作规范.md (summary=事实摘要含具体词;
# tags=同义词别名, 禁情感泛词)。
#
# 纪律(设计铁则3): 只产候选文件, 本脚本的生成模式**不写库**;
# 审阅通过后用 --apply 落库, 且 summary 只填空不覆盖(除非 --force)。
# 管线 LLM = DeepSeek(铁则2, 亲密内容不拒答)。
#
# 用法:
#   python tools/enrich_summaries.py --sample 15         # 试产15条 → 候选jsonl + 审阅md
#   python tools/enrich_summaries.py                     # 全量(缺summary的都跑)
#   python tools/enrich_summaries.py --apply tools/enrich_candidates_xxx.jsonl
#                                                        # 审阅通过后落库
#   env: OMBRE_BRAIN_URL / OMBRE_ADMIN_TOKEN / DEEPSEEK_API_KEY(或SEARCH_SUMMARY_API_KEY)
# ============================================================

import argparse
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

DEEPSEEK_BASE = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")

# 情感泛词黑名单 — 规范铁条: 这些词当 tag = 引力陷阱(07-06 生产实锤)
EMOTION_TAG_BLACKLIST = {
    "喜欢", "关系", "亲密", "温度", "成长", "信任", "连接", "爱", "情感", "感情",
    "心动", "温柔", "陪伴", "安全感", "亲密感", "在意", "重要", "珍惜", "幸福",
    "甜蜜", "浪漫", "心跳", "悸动", "依赖", "归属感",
    # 万物通用词 = 同款陷阱: 人名俩字每条记忆都沾, 当 tag 零区分度(试产15条实测模型会吐)
    "Rin", "Soren", "rin", "soren", "工具", "日常", "记忆", "对话", "AI",
}

def http_json(url, headers=None, data=None, timeout=60):
    req = urllib.request.Request(url, headers=headers or {}, data=data)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))

def ob_get(base, token, path):
    return http_json(f"{base}{path}", headers={"X-Admin-Token": token})

def ob_post(base, token, path, body):
    return http_json(
        f"{base}{path}",
        headers={"X-Admin-Token": token, "Content-Type": "application/json"},
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
    )

def deepseek_enrich(api_key, name, tags, event_time, content):
    """一条记忆 → {"summary": str, "tags_add": [str]}; 失败返回 None。"""
    system = (
        "你是私人记忆库的整理助手。给一条记忆生成检索友好的 summary 和补充 tags。\n"
        "规则:\n"
        "1. summary: 1~3句事实摘要, ≤120字, 覆盖谁/何时/何事/结果, 必须用记忆里的具体词"
        "(人名/事物名/数字/地点), 不写感想不写意义。\n"
        "2. tags_add: 0~5个补充标签 = 这件事的其他叫法/同义词/她可能用的口语说法/具体锚点。"
        "禁止情感泛词(喜欢/关系/亲密/温度/成长/信任/连接等)。已有tags里的不要重复。\n"
        "3. 记忆内容可能涉及私密/亲密话题, 照常处理, 摘要用与原文一致的坦白措辞。\n"
        '4. 只输出 JSON: {"summary": "...", "tags_add": ["...", "..."]}'
    )
    user = (
        f"桶名: {name}\n现有tags: {', '.join(tags) if tags else '(无)'}\n"
        f"事件时间: {event_time or '(未知)'}\n正文:\n{content[:2000]}"
    )
    body = {
        "model": DEEPSEEK_MODEL,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "response_format": {"type": "json_object"},
        "temperature": 0.3,
        "max_tokens": 300,
    }
    for attempt in (1, 2):
        try:
            data = http_json(
                f"{DEEPSEEK_BASE}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                timeout=90,
            )
            out = json.loads(data["choices"][0]["message"]["content"])
            summary = str(out.get("summary", "")).strip()
            tags_add = [str(t).strip() for t in (out.get("tags_add") or []) if str(t).strip()]
            # 黑名单兜底: 模型没守规矩也拦下来
            tags_add = [t for t in tags_add if t not in EMOTION_TAG_BLACKLIST][:5]
            if summary:
                return {"summary": summary, "tags_add": tags_add}
        except Exception as e:
            if attempt == 2:
                print(f"  ✗ DeepSeek 失败: {e}")
            time.sleep(1)
    return None

def cmd_generate(args, base, token, ds_key):
    buckets = ob_get(base, token, "/api/buckets")
    targets = [
        b for b in buckets
        if not b.get("resolved") and b.get("type") != "feel"
        and not (b.get("summary") or "").strip()
    ]
    # 老的优先(时间越久越可能被问起时靠 summary 救)
    targets.sort(key=lambda b: b.get("event_time") or b.get("created") or "")
    total = len(targets)
    if args.sample:
        targets = targets[: args.sample]
    print(f"缺 summary 全库共 {total} 条, 本次跑 {len(targets)} 条")

    ts = time.strftime("%Y%m%d_%H%M%S")
    out_jsonl = os.path.join(os.path.dirname(__file__), f"enrich_candidates_{ts}.jsonl")
    results = []

    def work(b):
        detail = ob_get(base, token, f"/api/bucket/{urllib.parse.quote(b['id'])}")
        content = detail.get("content", "")
        meta = detail.get("metadata", {}) or {}
        vis_tags = [t for t in (meta.get("tags") or []) if not str(t).startswith("__")]
        cand = deepseek_enrich(ds_key, meta.get("name") or b["id"], vis_tags,
                               meta.get("event_time"), content)
        if cand is None:
            return None
        # 生成侧就去掉与现有 tags 的重复(模型偶尔不守"不要重复"指令, 试产实测)
        cand["tags_add"] = [t for t in cand["tags_add"] if t not in vis_tags]
        return {
            "id": b["id"], "name": meta.get("name") or b["id"],
            "event_time": meta.get("event_time") or "",
            "old_tags": vis_tags, "content_head": content[:120].replace("\n", " "),
            **cand,
        }

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for i, r in enumerate(ex.map(work, targets), start=1):
            if r:
                results.append(r)
            if i % 20 == 0:
                print(f"  进度 {i}/{len(targets)}")

    with open(out_jsonl, "w", encoding="utf-8") as f:
        for r in results:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"候选已写 {out_jsonl} ({len(results)} 条, 失败 {len(targets)-len(results)})")

    # 审阅用 markdown
    md_path = args.md or os.path.join(os.path.dirname(__file__), f"enrich_review_{ts}.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(f"# enrichment 候选审阅 · {datetime.now():%Y-%m-%d %H:%M} · {len(results)} 条\n\n")
        f.write("规则见 `记忆库优化/03-写作规范.md`。看完没问题 → 跑 `--apply <候选文件>` 落库"
                "(summary 只填空不覆盖)。\n\n---\n\n")
        for r in results:
            f.write(f"### {r['name']}  `{r['event_time'][:10]}`\n\n")
            f.write(f"- 正文开头: {r['content_head']}…\n")
            f.write(f"- **拟 summary**: {r['summary']}\n")
            f.write(f"- 现有 tags: {', '.join(r['old_tags']) or '(无)'}\n")
            f.write(f"- **拟补 tags**: {', '.join(r['tags_add']) or '(无)'}\n\n")
    print(f"审阅页已写 {md_path}")

def cmd_apply(args, base, token):
    with open(args.apply, encoding="utf-8") as f:
        cands = [json.loads(l) for l in f if l.strip()]
    print(f"落库 {len(cands)} 条候选 (summary 只填空; tags 合并去重)")
    ok = fail = skip = 0
    for i, c in enumerate(cands, start=1):
        try:
            detail = ob_get(base, token, f"/api/bucket/{urllib.parse.quote(c['id'])}")
            meta = detail.get("metadata", {}) or {}
            body = {}
            if not (meta.get("summary") or "").strip() or args.force:
                body["summary"] = c["summary"]
            cur_tags = meta.get("tags") or []   # 含隐藏 __ tag, 必须原样保留(update 是整体替换)
            add = [t for t in c.get("tags_add", []) if t not in cur_tags]
            if add:
                body["tags"] = cur_tags + add
            if not body:
                skip += 1
                continue
            r = ob_post(base, token, f"/api/bucket/{urllib.parse.quote(c['id'])}/update", body)
            if r.get("ok"):
                ok += 1
            else:
                fail += 1
                print(f"  ✗ {c['name']}: {r}")
        except Exception as e:
            fail += 1
            print(f"  ✗ {c['name']}: {e}")
        if i % 25 == 0:
            print(f"  进度 {i}/{len(cands)}")
    print(f"完成: 写入 {ok} / 跳过 {skip} / 失败 {fail}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.environ.get("OMBRE_BRAIN_URL", ""))
    ap.add_argument("--token", default=os.environ.get("OMBRE_ADMIN_TOKEN", ""))
    ap.add_argument("--sample", type=int, default=0, help="只试产前 N 条(按事件时间最老优先)")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--md", default="", help="审阅 markdown 输出路径(默认 tools/ 下)")
    ap.add_argument("--apply", default="", help="落库模式: 传候选 jsonl 路径")
    ap.add_argument("--force", action="store_true", help="apply 时覆盖已有 summary(默认只填空)")
    args = ap.parse_args()

    base = args.url.rstrip("/")
    if not base:
        sys.exit("缺 OMBRE_BRAIN_URL")
    if args.apply:
        cmd_apply(args, base, args.token)
        return
    ds_key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("SEARCH_SUMMARY_API_KEY", "")
    if not ds_key:
        sys.exit("缺 DEEPSEEK_API_KEY / SEARCH_SUMMARY_API_KEY")
    cmd_generate(args, base, args.token, ds_key)

if __name__ == "__main__":
    main()
