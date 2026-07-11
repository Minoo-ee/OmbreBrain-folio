# -*- coding: utf-8 -*-
# ============================================================
# tools/eval_multiprobe.py — 多锚点 fan-out A/B 评测台 (2026-07-10 真心话案定案)
#
# 干什么: 对比两条取回路径, 用数字回答"多锚点分发值不值得上生产":
#   A) single : 原消息一个查询 → 检索 → 精排 → top-N   (现生产形态的评测侧等价)
#   B) fanout : DeepSeek 拆线索出探针(0-4) → 并行检索 → 合并去重 → 对原消息精排 → top-N
#
# 评测集:
#   --multi tools/eval_set_multi.json  多线索正例 {query, threads:[{label,expect:[...]}]}
#     指标 = 线索覆盖率 (top-N 里有几条线索被至少命中一次)
#   --standard tools/eval_set.json     沿用主评测集
#     正例 → 两路 MRR 对比 (fan-out 不能伤单线索召回)
#     负例/forbid → fan-out 探针数(0=不检索 ✓) + 最终 top-3 泄漏
#
# 用法:
#   python tools/eval_multiprobe.py                  # multi + standard 全跑
#   python tools/eval_multiprobe.py --only multi
#   python tools/eval_multiprobe.py --topn 5 --save
#
# env: OMBRE_BRAIN_URL / OMBRE_ADMIN_TOKEN / SILICONFLOW_API_KEY(精排)
#      DEEPSEEK_API_KEY 或 SEARCH_SUMMARY_API_KEY (fan-out 必须)
# 探针 prompt 就是未来生产 OMBRE_INJECT_MULTIPROBE 的 prompt 底稿 — 改这里=改未来生产语义。
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

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

NEG_LEAK_SCORE = 70

PROBE_SYS = (
    "你是私人记忆检索的前置分发器。用户给AI伴侣发来一条消息, 你判断里面有哪些「值得唤起过去记忆」的独立线索(0-4条), "
    "每条线索输出一个检索探针。规则: "
    "1) 探针=中文短句, 用「她」指代用户、「我」指代AI伴侣(记忆库摘要即此视角), 包含该线索的具体事件/实体/关系词; "
    "2) 不同线索必须真正独立, 不是同一件事的换说法; 但同一段经历的不同时间点或侧面(如当晚的事 vs 第二天的感受)算不同线索; "
    "3) 探针直接描述那段记忆的内容本身(事件/场景/感受), 不要用「她问我/她提到」这类转述框架; "
    "4) 纯寒暄/纯语气/网络整活/角色扮演戏词/无实质回忆点 → 空数组; "
    "5) 最多4条, 宁缺毋滥。只输出 JSON: {\"probes\": [\"...\"]}"
)


def http_json(req, timeout):
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def ds_probes(msg, cfg):
    body = json.dumps({
        "model": cfg["ds_model"],
        "messages": [{"role": "system", "content": PROBE_SYS},
                     {"role": "user", "content": msg}],
        "response_format": {"type": "json_object"},
        "temperature": 0.6,
    }).encode()
    req = urllib.request.Request(
        cfg["ds_base"].rstrip("/") + "/chat/completions", data=body,
        headers={"Authorization": "Bearer " + cfg["ds_key"], "Content-Type": "application/json"},
    )
    data = http_json(req, 40)
    probes = json.loads(data["choices"][0]["message"]["content"]).get("probes") or []
    return [p.strip() for p in probes if isinstance(p, str) and p.strip()][:4]


def search(query, cfg):
    params = urllib.parse.urlencode({
        "q": query, "limit": 10, "include_vector": "true",
        "exclude_pinned": "true", "simulate": "true", "caller": "eval-multiprobe",
    })
    req = urllib.request.Request(
        f"{cfg['base']}/api/search?{params}",
        headers={"X-Admin-Token": cfg["token"], "Accept": "application/json"},
    )
    data = http_json(req, 60)
    return (data.get("keyword_hits") or []) + (data.get("vector_hits") or [])


def rerank_order(query, hits, cfg):
    """对候选 hits 按原消息精排, 返回重排后的 hits; 无 key/失败 → 原序。"""
    if not cfg["sf_key"] or not hits:
        return hits
    docs = [f"{h.get('name','')}: {h.get('summary') or h.get('content_preview') or ''}"[:300]
            for h in hits[:40]]
    body = json.dumps({"model": cfg["sf_model"], "query": query, "documents": docs}).encode()
    req = urllib.request.Request(
        cfg["sf_base"].rstrip("/") + "/rerank", data=body,
        headers={"Authorization": "Bearer " + cfg["sf_key"], "Content-Type": "application/json"},
    )
    try:
        data = http_json(req, 40)
        order = [it["index"] for it in data.get("results", [])]
        return [hits[i] for i in order if i < len(hits)]
    except Exception:
        return hits


def dedup(hits):
    seen, out = set(), []
    for h in hits:
        hid = h.get("id")
        if not hid or hid in seen:
            continue
        seen.add(hid)
        out.append(h)
    return out


def path_single(msg, cfg, topn):
    return rerank_order(msg, dedup(search(msg, cfg)), cfg)[:topn], None


def path_fanout(msg, cfg, topn):
    """DS 探针检索 → 每探针按「对探针本身」精排分座 top-1(线索内相关性) →
    剩余槽位按「对原消息」全局精排补齐。
    保底探针(原消息)只在单探针时加入 — 护短消息不被改写伤到, 又不给长消息带回表面词垃圾。"""
    probes = ds_probes(msg, cfg)
    if not probes:
        return [], probes
    per_probe_hits = []
    for p in probes:
        try:
            per_probe_hits.append(dedup(search(p, cfg)))
        except Exception as ex:
            print(f"    ✗ 探针「{p[:24]}」检索失败: {ex}")
            per_probe_hits.append([])
    # 保底探针(原消息): 结果只进补位池, 永不占座 — 护短消息召回下界, 不给长消息垃圾发座位
    anchor_hits = []
    try:
        anchor_hits = dedup(search(msg[:200], cfg))
    except Exception:
        pass
    # 分座: 每探针的座位 = 它自己池子里对「探针文本」精排的 top-1
    picked, picked_ids = [], set()
    for p, hits in zip(probes, per_probe_hits):
        for h in rerank_order(p, hits, cfg):
            hid = h.get("id")
            if hid and hid not in picked_ids:
                picked.append(h)
                picked_ids.add(hid)
                break
        if len(picked) >= topn:
            break
    # 补位: 全池(含保底)按「对原消息」精排, 填满剩余槽
    union = dedup([h for hits in per_probe_hits for h in hits] + anchor_hits)
    for h in rerank_order(msg, union, cfg):
        if len(picked) >= topn:
            break
        if h.get("id") not in picked_ids:
            picked.append(h)
            picked_ids.add(h.get("id"))
    return picked[:topn], probes


def match(hit, expect_item):
    if expect_item.startswith("id:"):
        return hit.get("id") == expect_item[3:]
    return expect_item in (hit.get("name") or "")


def thread_hit(top, expects):
    for i, h in enumerate(top, start=1):
        if any(match(h, x) for x in expects):
            return i
    return 0


def run_multi(cfg, topn, results):
    path = os.path.join(os.path.dirname(__file__), "eval_set_multi.json")
    with open(path, encoding="utf-8") as f:
        cases = json.load(f)
    print(f"\n══ 多线索正例 ({len(cases)} 条, top-{topn} 线索覆盖率) ══")
    for c in cases:
        q, threads = c["query"], c["threads"]
        print(f"▶ 「{q[:40]}…」 ({len(threads)} 线索)")
        top_a, _ = path_single(q, cfg, topn)
        top_b, probes = path_fanout(q, cfg, topn)
        if probes is not None:
            print("  探针: " + (" / ".join(p[:22] for p in probes) if probes else "(0条)"))
        cov = {"single": 0, "fanout": 0}
        for t in threads:
            ra, rb = thread_hit(top_a, t["expect"]), thread_hit(top_b, t["expect"])
            cov["single"] += 1 if ra else 0
            cov["fanout"] += 1 if rb else 0
            print(f"  线索[{t['label']}]  single: {'rank'+str(ra) if ra else '❌脱靶'}   fanout: {'rank'+str(rb) if rb else '❌脱靶'}")
        print(f"  ── 覆盖 single {cov['single']}/{len(threads)}  vs  fanout {cov['fanout']}/{len(threads)}")
        print(f"  fanout top-{topn}: " + " | ".join(h.get("name", "?")[:12] for h in top_b))
        results.append({"kind": "multi", "query": q, "probes": probes, "coverage": cov,
                        "threads": len(threads)})


def run_standard(cfg, topn, results):
    path = os.path.join(os.path.dirname(__file__), "eval_set.json")
    with open(path, encoding="utf-8") as f:
        eval_set = [e for e in json.load(f)
                    if isinstance(e, dict) and e.get("query") and not e["query"].startswith("_")]
    positives = [e for e in eval_set if not e.get("negative") and not e.get("forbid")]
    negatives = [e for e in eval_set if e.get("negative") or e.get("forbid")]

    print(f"\n══ 标准正例回归 ({len(positives)} 条, 两路 MRR) ══")
    mrr = {"single": 0.0, "fanout": 0.0}
    for e in positives:
        q, expect = e["query"], e.get("expect") or []
        top_a, _ = path_single(q, cfg, topn)
        top_b, probes = path_fanout(q, cfg, topn)
        ra, rb = thread_hit(top_a, expect), thread_hit(top_b, expect)
        mrr["single"] += (1.0 / ra) if ra else 0.0
        mrr["fanout"] += (1.0 / rb) if rb else 0.0
        flag = "✅" if rb else "❌"
        print(f"{flag} single rank={ra or '-'}  fanout rank={rb or '-'}  探针{len(probes or [])}  「{q[:30]}」")
        results.append({"kind": "positive", "query": q, "single_rank": ra, "fanout_rank": rb,
                        "probes": probes})
    n = max(1, len(positives))
    print(f"── MRR@top{topn}: single {mrr['single']/n:.4f}  vs  fanout {mrr['fanout']/n:.4f}")

    print(f"\n══ 负控/禁抓 fan-out 泄漏面 ({len(negatives)} 条) ══")
    clean = 0
    for e in negatives:
        q = e["query"]
        top_b, probes = path_fanout(q, cfg, min(topn, 3))
        if not probes:
            print(f"✅ 0探针=不检索 「{q[:34]}」")
            clean += 1
            results.append({"kind": "negative", "query": q, "probes": [], "leaks": []})
            continue
        banned = e.get("forbid")
        bad = [(h.get("name", "?")[:14], h.get("score", 0)) for h in top_b[:3]
               if (h.get("score") or 0) >= NEG_LEAK_SCORE
               and (not banned or any(x in (h.get("name") or "") for x in banned))]
        mark = "✅" if not bad else "💥"
        if not bad:
            clean += 1
        print(f"{mark} 探针{len(probes)} 「{q[:34]}」 {'干净' if not bad else f'泄漏: {bad}'}")
        results.append({"kind": "negative", "query": q, "probes": probes, "leaks": bad})
    print(f"── 负控干净率: {clean}/{len(negatives)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.environ.get("OMBRE_BRAIN_URL", ""))
    ap.add_argument("--token", default=os.environ.get("OMBRE_ADMIN_TOKEN", ""))
    ap.add_argument("--topn", type=int, default=5, help="最终注入位数量(生产≈5)")
    ap.add_argument("--only", choices=["multi", "standard"], default="")
    ap.add_argument("--save", action="store_true")
    args = ap.parse_args()

    cfg = {
        "base": args.url.rstrip("/"), "token": args.token,
        "ds_key": os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("SEARCH_SUMMARY_API_KEY") or "",
        "ds_base": os.environ.get("SEARCH_SUMMARY_BASE_URL", "https://api.deepseek.com"),
        "ds_model": os.environ.get("SEARCH_SUMMARY_MODEL", "deepseek-chat"),
        "sf_key": os.environ.get("SILICONFLOW_API_KEY", ""),
        "sf_model": os.environ.get("OMBRE_RERANK_MODEL", "Qwen/Qwen3-Reranker-8B"),
        "sf_base": os.environ.get("OMBRE_RERANK_BASE_URL", "https://api.siliconflow.com/v1"),
    }
    if not cfg["base"]:
        sys.exit("缺 OMBRE_BRAIN_URL")
    if not cfg["ds_key"]:
        sys.exit("fan-out 需要 DEEPSEEK_API_KEY 或 SEARCH_SUMMARY_API_KEY")

    results = []
    if args.only in ("", "multi"):
        run_multi(cfg, args.topn, results)
    if args.only in ("", "standard"):
        run_standard(cfg, args.topn, results)

    if args.save:
        out = os.path.join(os.path.dirname(__file__),
                           f"eval_multiprobe_{time.strftime('%Y%m%d_%H%M%S')}.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump({"ts": datetime.now().isoformat(timespec="seconds"),
                       "topn": args.topn, "results": results}, f, ensure_ascii=False, indent=2)
        print(f"\n已存 {out}")


if __name__ == "__main__":
    main()
