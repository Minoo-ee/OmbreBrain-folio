# -*- coding: utf-8 -*-
# ============================================================
# tools/eval_search.py — 检索质量评测台 (2026-07-04 注入精度轮·第1批)
#
# 干什么: 拿一批标注好的 query 打 /api/search?simulate=true (dry-run, 不污染
# 命中统计/检索日志), 算命中率/MRR/负控泄漏, 每次改动前后各跑一遍对比。
# "把『我觉得需要』换成『我测了』"。
#
# 用法:
#   python tools/eval_search.py                        # 用 env OMBRE_BRAIN_URL + OMBRE_ADMIN_TOKEN
#   python tools/eval_search.py --url http://... --token xxx
#   python tools/eval_search.py --vector               # 同时开向量通道
#   python tools/eval_search.py --set my_eval.json     # 换评测集文件
#   python tools/eval_search.py --save                 # 结果存 eval_results_<ts>.json 方便前后对比
#
# 评测集格式 (tools/eval_set.json):
#   [{"query": "...", "expect": ["桶名子串" 或 "id:<bucket_id>"], "note": "..."},
#    {"query": "...", "negative": true, "note": "不该有高分命中的噪声消息"},
#    {"query": "...", "forbid": ["桶名子串", ...], "note": "定向负控"}]
# 指标:
#   正例: rank(第一条 expect 命中的名次, 关键词通道在前向量在后) → hit@1/3/10, MRR
#   负例: top-3 里 score ≥ NEG_LEAK_SCORE(默认70) 视为泄漏
#   定向负控(forbid): 消息本身正常、可以有命中, 但 top-3 高分位出现指定桶 = 泄漏
#   (治"亲密桶泄漏进情感倾诉"这类 — 命中可以, 命中它们不行)
# ============================================================

import argparse
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime

# Windows GBK 控制台会吞 emoji/中文 — 强制 UTF-8 输出
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

NEG_LEAK_SCORE = 70

def rerank_via_api(query, docs, model, api_key, base_url):
    """调外部 reranker(OpenAI 兼容 /rerank, SiliconFlow 等)对候选重排。
    返回按相关度降序的 doc 下标列表; 失败返回 None(调用方回退原序)。
    注意: 绝对分数不可靠(Qwen3-Reranker 相关文档也常 <0.2), 只用相对序。"""
    body = json.dumps({"model": model, "query": query, "documents": docs}).encode()
    req = urllib.request.Request(
        base_url.rstrip("/") + "/rerank", data=body,
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            data = json.loads(r.read().decode("utf-8"))
        return [it["index"] for it in data.get("results", [])]
    except Exception:
        return None

def fetch_search(base, token, query, include_vector):
    params = urllib.parse.urlencode({
        "q": query,
        "limit": 10,
        "include_vector": "true" if include_vector else "false",
        "exclude_pinned": "true",   # 对齐 auto-inject 的真实调用形态
        "simulate": "true",         # dry-run: 不记统计不进日志
        "caller": "eval",
    })
    req = urllib.request.Request(
        f"{base}/api/search?{params}",
        headers={"X-Admin-Token": token, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))

def match_expect(hit, expect_item):
    if expect_item.startswith("id:"):
        return hit.get("id") == expect_item[3:]
    return expect_item in (hit.get("name") or "")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.environ.get("OMBRE_BRAIN_URL", ""))
    ap.add_argument("--token", default=os.environ.get("OMBRE_ADMIN_TOKEN", ""))
    ap.add_argument("--set", default=os.path.join(os.path.dirname(__file__), "eval_set.json"))
    ap.add_argument("--vector", action="store_true", help="同时开向量通道")
    ap.add_argument("--rerank", action="store_true",
                    help="评测侧 reranker A/B 模拟(不动生产链路): 需 env SILICONFLOW_API_KEY")
    ap.add_argument("--rerank-model", default=os.environ.get("OMBRE_RERANK_MODEL", "Qwen/Qwen3-Reranker-8B"))
    ap.add_argument("--rerank-url", default=os.environ.get("OMBRE_RERANK_BASE_URL", "https://api.siliconflow.com/v1"))
    ap.add_argument("--save", action="store_true", help="结果落盘 eval_results_<ts>.json")
    args = ap.parse_args()
    rerank_key = os.environ.get("SILICONFLOW_API_KEY", "")
    if args.rerank and not rerank_key:
        sys.exit("--rerank 需要 env SILICONFLOW_API_KEY")

    base = args.url.rstrip("/")
    if not base:
        sys.exit("缺 OMBRE_BRAIN_URL (env 或 --url)")

    with open(args.set, encoding="utf-8") as f:
        # "_" 开头的 query 是集内说明条目, 不参与评测
        eval_set = [e for e in json.load(f)
                    if isinstance(e, dict) and e.get("query") and not e["query"].startswith("_")]

    positives = [e for e in eval_set if not e.get("negative") and not e.get("forbid")]
    negatives = [e for e in eval_set if e.get("negative")]
    forbids = [e for e in eval_set if e.get("forbid") and not e.get("negative")]
    print(f"评测集: {len(positives)} 正例 + {len(negatives)} 负控 + {len(forbids)} 定向负控"
          f" | vector={'on' if args.vector else 'off'}")
    print("=" * 72)

    results, rr_sum = [], 0.0
    hit_at = {1: 0, 3: 0, 10: 0}
    for e in positives:
        q, expect = e["query"], e.get("expect") or []
        try:
            data = fetch_search(base, args.token, q, args.vector)
        except Exception as ex:
            print(f"✗ 请求失败「{q[:30]}」: {ex}")
            continue
        ordered = (data.get("keyword_hits") or []) + (data.get("vector_hits") or [])
        rank_raw = 0
        for i, h in enumerate(ordered, start=1):
            if any(match_expect(h, x) for x in expect):
                rank_raw = i
                break
        rank = rank_raw
        # --rerank: 把 top-20 候选(name+summary+preview)交给外部 reranker 重排后再算名次
        # (2026-07-09 池子 10→20: enrichment 后全库关键词表面变大, 边缘目标被挤出小池 —
        #  与生产注入管线的精排池扩容同步)
        if args.rerank and ordered:
            pool = ordered[:20]
            docs = [f"{h.get('name','')}: {h.get('summary') or h.get('content_preview') or ''}"[:300]
                    for h in pool]
            order = rerank_via_api(q, docs, args.rerank_model, rerank_key, args.rerank_url)
            if order is not None:
                reranked = [pool[i2] for i2 in order if i2 < len(pool)]
                rank = 0
                for i, h in enumerate(reranked, start=1):
                    if any(match_expect(h, x) for x in expect):
                        rank = i
                        break
        rr = 1.0 / rank if rank else 0.0
        rr_sum += rr
        for k in hit_at:
            if rank and rank <= k:
                hit_at[k] += 1
        top3 = [(h.get("name", "?")[:14], h.get("score", h.get("similarity"))) for h in ordered[:3]]
        mark = "✅" if rank and rank <= 3 else ("⚠️" if rank else "❌")
        rr_note = f"(重排前 {rank_raw or '-'})" if args.rerank and rank != rank_raw else ""
        print(f"{mark} rank={rank or '-':>2}{rr_note} 「{q[:34]}」 期待:{'/'.join(expect)[:20]} top3:{top3}")
        results.append({"query": q, "rank": rank, "rank_raw": rank_raw, "rr": rr, "top3": top3})

    leaks = []
    for e in negatives:
        q = e["query"]
        try:
            data = fetch_search(base, args.token, q, args.vector)
        except Exception as ex:
            print(f"✗ 请求失败「{q[:30]}」: {ex}")
            continue
        ordered = (data.get("keyword_hits") or [])[:3]
        bad = [(h.get("name", "?")[:14], h.get("score", 0)) for h in ordered
               if (h.get("score") or 0) >= NEG_LEAK_SCORE]
        mark = "✅" if not bad else "💥"
        print(f"{mark} 负控「{q[:34]}」 {'干净' if not bad else f'泄漏: {bad}'}")
        results.append({"query": q, "negative": True, "leaks": bad})
        if bad:
            leaks.append({"query": q, "leaks": bad})

    # 定向负控: 有命中可以, 但 forbid 名单里的桶不该出现在 top-3 高分位
    forbid_leaks = []
    for e in forbids:
        q, banned = e["query"], e["forbid"]
        try:
            data = fetch_search(base, args.token, q, args.vector)
        except Exception as ex:
            print(f"✗ 请求失败「{q[:30]}」: {ex}")
            continue
        ordered = (data.get("keyword_hits") or [])[:3]
        bad = [(h.get("name", "?")[:14], h.get("score", 0)) for h in ordered
               if (h.get("score") or 0) >= NEG_LEAK_SCORE
               and any(x in (h.get("name") or "") for x in banned)]
        mark = "✅" if not bad else "💥"
        print(f"{mark} 禁抓「{q[:34]}」 {'干净' if not bad else f'泄漏: {bad}'}")
        results.append({"query": q, "forbid": banned, "leaks": bad})
        if bad:
            forbid_leaks.append({"query": q, "leaks": bad})

    n = max(1, len(positives))
    summary = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "vector": args.vector,
        "rerank": args.rerank and args.rerank_model or "",
        "positives": len(positives),
        "negatives": len(negatives),
        "mrr": round(rr_sum / n, 4),
        "hit@1": f"{hit_at[1]}/{len(positives)}",
        "hit@3": f"{hit_at[3]}/{len(positives)}",
        "hit@10": f"{hit_at[10]}/{len(positives)}",
        "neg_leaks": len(leaks),
        "forbids": len(forbids),
        "forbid_leaks": len(forbid_leaks),
    }
    print("=" * 72)
    print(f"MRR={summary['mrr']}  hit@1={summary['hit@1']}  hit@3={summary['hit@3']}"
          f"  hit@10={summary['hit@10']}  负控泄漏={len(leaks)}/{len(negatives)}"
          f"  定向泄漏={len(forbid_leaks)}/{len(forbids)}")

    if args.save:
        out = os.path.join(os.path.dirname(__file__),
                           f"eval_results_{time.strftime('%Y%m%d_%H%M%S')}.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump({"summary": summary, "results": results}, f, ensure_ascii=False, indent=2)
        print(f"已存 {out}")

if __name__ == "__main__":
    main()
