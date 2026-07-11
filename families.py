# -*- coding: utf-8 -*-
# ============================================================
# families.py — 记忆家族/归纳层 (2026-07-06 设计稿 P1)
#
# 纯派生索引层: 原始桶零接触, families.json 整体可重算。
# 设计稿=Desktop\记忆库优化\07-家族层设计稿_2026-07-06.md, 原型=tools/family_proto.js。
# 要点(原型实证):
#   - 平均连接凝聚聚类(连通分量会链式吞并出200人巨块, 不用)
#   - 钉选/高亮/保护图腾桶排除出成员资格(链式污染源, 与注入引力桶同病同治)
#   - 族规模上限15, 最小3; 阈值默认0.75
#   - 起名/弧线摘要复用 dehydrator 的 LLM 客户端(她的配置=deepseek-chat)
#   - 她的编辑(改名/钉住/解散)在重算时按成员重叠(Jaccard≥0.5)继承
# ============================================================

import hashlib
import json
import logging
import os
import sqlite3
from datetime import datetime

import numpy as np

from utils import parse_iso_datetime

logger = logging.getLogger("ombre_brain.families")

DEFAULT_THRESHOLD = 0.75
MIN_FAMILY = 3
MAX_FAMILY = 15


def _now_iso() -> str:
    # UTC+Z 口径(对齐 utils.now_iso): built_at/updated_at 要和桶的 created(UTC+Z)
    # 可比较, 本地 naive 在 JST 下会把"有没有新桶"的判断压住最多 9 小时。
    # 前端 new Date("...Z") 自动转本地显示, 不受影响。
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _fam_id(member_ids: list) -> str:
    h = hashlib.sha1(",".join(sorted(member_ids)).encode("utf-8")).hexdigest()
    return "fam-" + h[:10]


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


class FamilyManager:
    def __init__(self, base_dir: str, embedding_engine, bucket_mgr, dehydrator=None):
        self.path = os.path.join(base_dir, "families.json")
        self.engine = embedding_engine
        self.bucket_mgr = bucket_mgr
        self.dehydrator = dehydrator
        self.rebuilding = False

    # ---------- 存取 ----------
    def load(self) -> dict:
        try:
            if os.path.exists(self.path):
                with open(self.path, "r", encoding="utf-8") as f:
                    return json.load(f)
        except Exception as e:
            logger.warning(f"[families] load failed: {e}")
        return {"updated_at": "", "params": {}, "families": []}

    def _save(self, state: dict) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.path)

    def update_family(self, fid: str, fields: dict) -> dict | None:
        """她的编辑入口: name / pinned / dissolved。返回更新后的族, 找不到返回 None。"""
        state = self.load()
        for fam in state["families"]:
            if fam["id"] != fid:
                continue
            if "name" in fields and str(fields["name"]).strip():
                fam["name"] = str(fields["name"]).strip()[:24]
                fam["name_is_manual"] = True
            if "pinned" in fields:
                fam["pinned"] = bool(fields["pinned"])
            if "dissolved" in fields:
                fam["dissolved"] = bool(fields["dissolved"])
            fam["edited_at"] = _now_iso()
            self._save(state)
            return fam
        return None

    # ---------- 重建 ----------
    def _load_vectors(self, ids: list) -> dict:
        """从 embedding 库读当前模型的向量; 返回 {bucket_id: np.array}。"""
        out = {}
        conn = sqlite3.connect(self.engine.db_path)
        try:
            rows = conn.execute("SELECT bucket_id, embedding, model FROM embeddings").fetchall()
        finally:
            conn.close()
        want = set(ids)
        for bid, emb, model in rows:
            if bid in want and self.engine._model_matches(model or ""):
                try:
                    out[bid] = np.array(json.loads(emb), dtype=np.float32)
                except Exception:
                    continue
        return out

    @staticmethod
    def _cluster(vec_matrix: np.ndarray, threshold: float) -> list:
        """平均连接凝聚聚类。返回 index 列表的列表(含单人簇)。"""
        n = vec_matrix.shape[0]
        norms = np.linalg.norm(vec_matrix, axis=1, keepdims=True)
        V = vec_matrix / np.clip(norms, 1e-9, None)
        S = V @ V.T
        np.fill_diagonal(S, 0.0)

        clusters = [[i] for i in range(n)]
        SUM = S.copy()                      # SUM[a][b] = 两簇成员两两相似度之和
        sizes = np.ones(n)
        alive = np.ones(n, dtype=bool)

        while True:
            sz = np.outer(sizes, sizes)
            AVG = np.divide(SUM, sz, out=np.zeros_like(SUM), where=sz > 0)
            mask = np.outer(alive, alive)
            np.fill_diagonal(mask, False)
            combo = sizes[:, None] + sizes[None, :]
            AVG[~mask] = -1.0
            AVG[combo > MAX_FAMILY] = -1.0
            idx = int(np.argmax(AVG))
            a, b = divmod(idx, n)
            if AVG[a, b] < threshold:
                break
            # 合并 b 进 a
            clusters[a].extend(clusters[b])
            clusters[b] = []
            SUM[a, :] += SUM[b, :]
            SUM[:, a] += SUM[:, b]
            SUM[a, a] = 0.0
            sizes[a] += sizes[b]
            alive[b] = False
            SUM[b, :] = 0.0
            SUM[:, b] = 0.0
            sizes[b] = 1  # 防除零, 已 dead
        return [clusters[i] for i in range(n) if alive[i]]

    async def _name_family(self, members: list) -> dict:
        """DeepSeek 起名+弧线摘要; 失败回退机械名。members=[{name,event_time,summary}]"""
        fallback = {
            "name": (members[0].get("name") or "未名")[:12] + f"·等{len(members)}条",
            "summary": "",
        }
        dehy = self.dehydrator
        if not (dehy and getattr(dehy, "api_available", False) and dehy.client):
            return fallback
        lines = []
        for m in sorted(members, key=lambda x: x.get("event_time") or ""):
            lines.append(f"- [{(m.get('event_time') or '')[:10]}] {m.get('name')}: {(m.get('summary') or '')[:80]}")
        system = (
            "你是私人记忆库的整理助手。下面是一簇彼此相关的记忆(按时间排序), 它们构成一条主题弧线。\n"
            '输出 JSON: {"name": "...", "summary": "..."}\n'
            "- name: ≤12字的家族名, 抓主题本质(如\"daddy称呼的演变\"), 不用情感泛词\n"
            "- summary: ≤180字, 按时间线讲这条弧线的来龙去脉(起点→转折→现状), 事实性, 用具体词\n"
            "- 内容可能涉及私密/亲密话题, 照常处理, 措辞与原文一致地坦白"
        )
        try:
            resp = await dehy.client.chat.completions.create(
                model=dehy.model,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": "\n".join(lines)[:2400]},
                ],
                response_format={"type": "json_object"},
                max_tokens=300,
                temperature=0.3,
            )
            out = json.loads(resp.choices[0].message.content or "{}")
            name = str(out.get("name", "")).strip()[:24]
            summary = str(out.get("summary", "")).strip()[:400]
            if name:
                return {"name": name, "summary": summary}
        except Exception as e:
            logger.warning(f"[families] naming failed: {e}")
        return fallback

    async def rebuild(self, threshold: float = DEFAULT_THRESHOLD) -> dict:
        """全量重算。返回 {ok, families, orphans, took_s}。"""
        if self.rebuilding:
            return {"ok": False, "error": "rebuild already running"}
        self.rebuilding = True
        t0 = datetime.now()
        try:
            buckets = await self.bucket_mgr.list_all(include_archive=False)
            eligible = []
            for b in buckets:
                meta = b.get("metadata") or b  # list_all 形态兼容
                if meta.get("type") == "feel":
                    continue
                if meta.get("resolved"):
                    continue
                # 图腾桶排除(链式污染源): 钉选/保护/高亮
                if meta.get("pinned") or meta.get("protected") or meta.get("highlight"):
                    continue
                bid = b.get("id") or meta.get("id")
                if bid:
                    eligible.append({
                        "id": bid,
                        "name": meta.get("name") or bid,
                        "event_time": meta.get("event_time") or meta.get("created") or "",
                        "summary": meta.get("summary") or "",
                    })
            vecs = self._load_vectors([e["id"] for e in eligible])
            have = [e for e in eligible if e["id"] in vecs]
            if len(have) < MIN_FAMILY:
                return {"ok": False, "error": f"向量不足: {len(have)}"}
            M = np.stack([vecs[e["id"]] for e in have])
            groups = self._cluster(M, threshold)

            old = self.load()
            old_fams = old.get("families", [])
            new_fams = []
            for g in groups:
                if len(g) < MIN_FAMILY:
                    continue
                members = [have[i] for i in g]
                member_ids = [m["id"] for m in members]
                fid = _fam_id(member_ids)
                # 继承她的编辑: 成员重叠 Jaccard≥0.5 的旧族
                inherited = None
                for of in old_fams:
                    if _jaccard(set(member_ids), set(of.get("member_ids", []))) >= 0.5:
                        inherited = of
                        break
                if inherited and inherited.get("name_is_manual"):
                    named = {"name": inherited["name"], "summary": inherited.get("summary", "")}
                elif inherited and inherited.get("id") == fid and inherited.get("name"):
                    # 成员集完全没变(id=成员哈希) → 复用上次的名字/摘要, 省 DeepSeek 调用
                    # (自动重建挂到写入事件后会频繁跑, 只有真变动的族才重新起名)
                    named = {"name": inherited["name"], "summary": inherited.get("summary", "")}
                else:
                    named = await self._name_family(members)
                new_fams.append({
                    "id": fid,
                    "name": named["name"],
                    "summary": named["summary"],
                    "member_ids": member_ids,
                    "members": [{"id": m["id"], "name": m["name"], "event_time": m["event_time"]}
                                for m in sorted(members, key=lambda x: x.get("event_time") or "")],
                    "size": len(member_ids),
                    "name_is_manual": bool(inherited and inherited.get("name_is_manual")),
                    "pinned": bool(inherited and inherited.get("pinned")),
                    "dissolved": bool(inherited and inherited.get("dissolved")),
                    "built_at": _now_iso(),
                })
            new_fams.sort(key=lambda f: -f["size"])
            state = {
                "updated_at": _now_iso(),
                "params": {"threshold": threshold, "min": MIN_FAMILY, "max": MAX_FAMILY,
                           "model": self.engine.model, "eligible": len(have)},
                "families": new_fams,
            }
            self._save(state)
            took = (datetime.now() - t0).total_seconds()
            logger.info(f"[families] rebuilt: {len(new_fams)} families from {len(have)} buckets in {took:.1f}s")
            return {"ok": True, "families": len(new_fams), "eligible": len(have),
                    "took_s": round(took, 1)}
        except Exception as e:
            logger.exception("[families] rebuild failed")
            return {"ok": False, "error": str(e)}
        finally:
            self.rebuilding = False

    # ---------- 自动重建 (与写入事件同步, 2026-07-09 她拍板) ----------
    # 她的记忆写入跟着"新一天第一条消息"走(4点JST切窗→收口→分日块入OB), 不是定时的。
    # 所以不用挂钟表: 每 poll_s 看一眼"有没有比上次建族更新的桶、且最近 debounce_s 没新写入"
    # → 有就重建。效果: 收口写完尘埃落定十分钟后家族自动刷新; hold 白天写的也能入族。
    # 阀门: env FAMILIES_AUTO_REBUILD=off 关掉。成员没变的族复用命名(见 rebuild), 频繁跑近零成本。
    async def auto_rebuild_loop(self, poll_s: int = 300, debounce_s: int = 600):
        import asyncio
        logger.info(f"[families] auto-rebuild loop up (poll {poll_s}s, debounce {debounce_s}s)")
        while True:
            try:
                await asyncio.sleep(poll_s)
                if self.rebuilding:
                    continue
                state = self.load()
                built_at = state.get("updated_at") or ""
                buckets = await self.bucket_mgr.list_all(include_archive=False)
                newest = ""
                for b in buckets:
                    meta = b.get("metadata") or {}
                    c = str(meta.get("created") or "")
                    if c > newest:
                        newest = c
                if not newest:
                    continue
                # UTC 口径解析比较(对齐 2.5.3 修复): 之前 UTC 的 created 和本地 naive 的
                # built_at 直接串比较, JST 下"有没有新桶"被压住最多 9 小时。
                # 旧格式 built_at(无 Z/offset, 本地时间)不可比 → 视为需要重建,
                # 重建后 updated_at 落成 UTC+Z, 一次收敛。
                newest_dt = parse_iso_datetime(newest)
                built_dt = None
                if built_at and (built_at.rstrip().endswith(("Z", "z")) or "+" in built_at):
                    try:
                        built_dt = parse_iso_datetime(built_at)
                    except (ValueError, TypeError):
                        built_dt = None
                if built_dt is not None and newest_dt <= built_dt:
                    continue  # 没有比上次建族更新的桶
                age_s = (datetime.utcnow() - newest_dt).total_seconds()
                if age_s < debounce_s:
                    continue  # 还在写入余波里, 等尘埃落定
                logger.info(f"[families] new buckets since {built_at or '(never)'} → auto rebuild")
                await self.rebuild()
            except Exception:
                logger.exception("[families] auto-rebuild tick failed (loop continues)")
