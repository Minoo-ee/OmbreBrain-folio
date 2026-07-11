# -*- coding: utf-8 -*-
# ============================================================
# tools/find_memory.py — 记忆追猎小弟 (2026-07-10 泄漏侧开战轮)
#
# 干什么: 治"该想起没想起, 但库太大定位不到那条真实记忆"。
# 拿一句模糊提示("应该跟海边散步那次有关") → DeepSeek 扩成多路探针
# → OB /api/search (关键词+向量, simulate 不污染统计) → 合并去重
# → SiliconFlow 精排 → 出"就是这条吗"勾选清单。
# 确认一条 = 评测集正例 +1 + 该桶补同义词 tags 的 enrichment 候选。
#
# 用法:
#   python tools/find_memory.py "模糊提示"                    # 单条追猎
#   python tools/find_memory.py "提示" --context "当时那条消息"
#   python tools/find_memory.py --from-feedback path/to/inject-feedback.jsonl
#                                                            # 收割 action=missing 的记一笔
#   python tools/find_memory.py "提示" --md                   # 结果落 find_memory_<ts>.md 勾选清单
#
# env: OMBRE_BRAIN_URL + OMBRE_ADMIN_TOKEN (必须);
#      DEEPSEEK_API_KEY 或 SEARCH_SUMMARY_API_KEY (探针扩写, 没有就只用原句);
#      SILICONFLOW_API_KEY (精排, 没有就按 命中路数+分数 排)
# 铁则: 只读只产清单, 永不直改记忆原始层。
# ============================================================

import argparse
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

TOP_SHOW = 12


def http_json(req, timeout):
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def deepseek_probes(hint, context, key, base, model):
    """把模糊提示扩成 3-4 路换角度探针。失败/没 key → 只回原句。"""
    if not key:
        return [hint]
    sys_p = (
        "你帮用户在私人记忆库里定位一条模糊记忆。把她的提示改写成3-4个检索探针, 各换一个角度: "
        "1)同义换说法 2)可能的具体实体/关键词 3)事件经过描述 4)情绪或关系框架。"
        "探针是中文短句, 别加解释。只输出 JSON: {\"probes\": [\"...\", ...]}"
    )
    user_p = f"提示: {hint}" + (f"\n当时的消息(上下文): {context}" if context else "")
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": sys_p}, {"role": "user", "content": user_p}],
        "response_format": {"type": "json_object"},
        "temperature": 1.0,
    }).encode()
    req = urllib.request.Request(
        base.rstrip("/") + "/chat/completions", data=body,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    try:
        data = http_json(req, 30)
        probes = json.loads(data["choices"][0]["message"]["content"]).get("probes") or []
        probes = [p.strip() for p in probes if isinstance(p, str) and p.strip()]
        return ([hint] + probes)[:5]
    except Exception as ex:
        print(f"  (DeepSeek 扩写失败, 只用原句: {ex})")
        return [hint]


def search(base, token, query):
    params = urllib.parse.urlencode({
        "q": query, "limit": 10,
        "include_vector": "true",
        "exclude_pinned": "false",   # 追猎和注入不同: 钉选的也要能找到
        "simulate": "true", "caller": "find-memory",
    })
    req = urllib.request.Request(
        f"{base}/api/search?{params}",
        headers={"X-Admin-Token": token, "Accept": "application/json"},
    )
    data = http_json(req, 60)
    return (data.get("keyword_hits") or []) + (data.get("vector_hits") or [])


def rerank(query, docs, key, model, base):
    body = json.dumps({"model": model, "query": query, "documents": docs}).encode()
    req = urllib.request.Request(
        base.rstrip("/") + "/rerank", data=body,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    try:
        data = http_json(req, 40)
        return [it["index"] for it in data.get("results", [])]
    except Exception:
        return None


def hunt(hint, context, cfg):
    print(f"\n🔎 追猎「{hint}」" + (f"  (上下文: {context[:40]}…)" if context else ""))
    probes = deepseek_probes(hint, context, cfg["ds_key"], cfg["ds_base"], cfg["ds_model"])
    if len(probes) > 1:
        print("  探针: " + " / ".join(p[:24] for p in probes))

    pool = {}  # id → {hit, probes:set, best_score}
    for p in probes:
        try:
            hits = search(cfg["base"], cfg["token"], p)
        except Exception as ex:
            print(f"  ✗ 探针「{p[:24]}」检索失败: {ex}")
            continue
        for h in hits:
            hid = h.get("id")
            if not hid:
                continue
            ent = pool.setdefault(hid, {"hit": h, "probes": set(), "best": 0.0})
            ent["probes"].add(p[:16])
            ent["best"] = max(ent["best"], float(h.get("score") or h.get("similarity") or 0))

    if not pool:
        print("  (一无所获 — 可能真没写进库, 这本身就是发现)")
        return []

    entries = list(pool.values())
    docs = [f"{e['hit'].get('name','')}: {e['hit'].get('summary') or e['hit'].get('content_preview') or ''}"[:300]
            for e in entries]
    order = None
    if cfg["sf_key"]:
        order = rerank(hint, docs[:30], cfg["sf_key"], cfg["sf_model"], cfg["sf_base"])
    ranked = ([entries[i] for i in order if i < len(entries)] if order is not None
              else sorted(entries, key=lambda e: (len(e["probes"]), e["best"]), reverse=True))

    out = []
    for i, e in enumerate(ranked[:TOP_SHOW], start=1):
        h = e["hit"]
        brief = (h.get("summary") or h.get("content_preview") or "").replace("\n", " ")[:80]
        print(f"  {i:>2}. {h.get('name','?')}  [{h.get('id','')}]  中{len(e['probes'])}路/最高{e['best']:.0f}分")
        print(f"      {brief}")
        out.append({"rank": i, "id": h.get("id"), "name": h.get("name"),
                    "brief": brief, "probes": sorted(e["probes"]), "best_score": e["best"]})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("hint", nargs="?", help="模糊提示")
    ap.add_argument("--context", default="", help="当时那条消息(帮探针扩写定向)")
    ap.add_argument("--from-feedback", default="", help="inject-feedback.jsonl 路径, 收割 action=missing")
    ap.add_argument("--url", default=os.environ.get("OMBRE_BRAIN_URL", ""))
    ap.add_argument("--token", default=os.environ.get("OMBRE_ADMIN_TOKEN", ""))
    ap.add_argument("--md", action="store_true", help="落盘 find_memory_<ts>.md 勾选清单")
    args = ap.parse_args()

    if not args.url:
        sys.exit("缺 OMBRE_BRAIN_URL (env 或 --url)")
    cfg = {
        "base": args.url.rstrip("/"), "token": args.token,
        "ds_key": os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("SEARCH_SUMMARY_API_KEY") or "",
        "ds_base": os.environ.get("SEARCH_SUMMARY_BASE_URL", "https://api.deepseek.com"),
        "ds_model": os.environ.get("SEARCH_SUMMARY_MODEL", "deepseek-chat"),
        "sf_key": os.environ.get("SILICONFLOW_API_KEY", ""),
        "sf_model": os.environ.get("OMBRE_RERANK_MODEL", "Qwen/Qwen3-Reranker-8B"),
        "sf_base": os.environ.get("OMBRE_RERANK_BASE_URL", "https://api.siliconflow.com/v1"),
    }

    jobs = []
    if args.from_feedback:
        with open(args.from_feedback, encoding="utf-8") as f:
            for line in f:
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if e.get("action") == "missing" and e.get("note"):
                    jobs.append({"hint": e["note"], "context": e.get("query", ""), "ts": e.get("ts", "")})
        print(f"收割 {len(jobs)} 条 missing 记一笔")
    elif args.hint:
        jobs.append({"hint": args.hint, "context": args.context, "ts": ""})
    else:
        sys.exit("要么给模糊提示, 要么 --from-feedback")

    all_results = []
    for j in jobs:
        all_results.append({**j, "candidates": hunt(j["hint"], j["context"], cfg)})

    if args.md:
        out = os.path.join(os.path.dirname(__file__), f"find_memory_{time.strftime('%Y%m%d_%H%M%S')}.md")
        lines = ["# 记忆追猎清单 — 勾中的=就是这条 (变评测正例+补tags候选)", ""]
        for r in all_results:
            lines.append(f"## 「{r['hint']}」" + (f"  ({r['ts'][:10]})" if r["ts"] else ""))
            if r["context"]:
                lines.append(f"> 当时的消息: {r['context'][:100]}")
            lines += [f"- [ ] **{c['name']}** (`{c['id']}`) — {c['brief']}" for c in r["candidates"]] or ["(空手而归)"]
            lines.append("")
        with open(out, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        print(f"\n已存 {out}")


if __name__ == "__main__":
    main()
