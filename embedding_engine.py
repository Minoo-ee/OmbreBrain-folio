# ============================================================
# Module: Embedding Engine (embedding_engine.py)
# 模块：向量化引擎
#
# Generates embeddings via Gemini API (OpenAI-compatible),
# stores them in SQLite, and provides cosine similarity search.
# 通过 Gemini API（OpenAI 兼容）生成 embedding，
# 存储在 SQLite 中，提供余弦相似度搜索。
#
# Depended on by: server.py, bucket_manager.py
# 被谁依赖：server.py, bucket_manager.py
# ============================================================

import os
import json
import math
import sqlite3
import logging
import asyncio
from collections import OrderedDict
from pathlib import Path

from openai import AsyncOpenAI

from utils import coerce_bool, positive_float

logger = logging.getLogger("ombre_brain.embedding")

# 进程内 LRU 查询缓存上限(对齐上游 2.4.13): 同一段文本对同一模型的向量恒定,
# 短时间内的重复请求(search+向量兜底同一 query / hold 链路同一新内容)只打一次 API。
_EMBED_CACHE_MAXSIZE = 128


class EmbeddingEngine:
    """
    Embedding generation + SQLite vector storage + cosine search.
    向量生成 + SQLite 向量存储 + 余弦搜索。
    """

    def __init__(self, config: dict):
        dehy_cfg = config.get("dehydration", {})
        embed_cfg = config.get("embedding", {})

        # 优先用 embedding 独立的 api_key / base_url(env: OMBRE_EMBED_API_KEY / OMBRE_EMBED_BASE_URL),
        # 没配就 fallback 到 dehydration 的(常见情况:同一家 Gemini key 跑 dehydration + embedding)。
        # 重要:dehydration 用 deepseek/openrouter 等其他家时,这里必须独立配 Gemini key,
        # 否则用别家的 key 调 gemini-embedding-001 会一直 401/404 静默失败。
        self.api_key = embed_cfg.get("api_key") or dehy_cfg.get("api_key", "")
        self.base_url = embed_cfg.get("base_url") or dehy_cfg.get("base_url") or "https://generativelanguage.googleapis.com/v1beta/openai/"
        self.model = embed_cfg.get("model", "gemini-embedding-001")
        # coerce_bool: YAML 里写成带引号的 "false" 也不误开(对齐上游 2.5.3)
        self.enabled = bool(self.api_key) and coerce_bool(embed_cfg.get("enabled"), default=True)
        # embedding 请求超时可配(对齐上游 2.4.5):
        # env OMBRE_EMBED_TIMEOUT_SECONDS > config embedding.timeout_seconds > 30s
        self.timeout_seconds = positive_float(
            os.environ.get("OMBRE_EMBED_TIMEOUT_SECONDS") or embed_cfg.get("timeout_seconds"),
            30.0,
        )

        # --- SQLite path: buckets_dir/embeddings.db ---
        db_path = os.path.join(config["buckets_dir"], "embeddings.db")
        self.db_path = db_path

        # --- 进程内 LRU: (model, text) → vector (对齐上游 2.4.13) ---
        self._embed_cache: "OrderedDict[str, list[float]]" = OrderedDict()

        # --- Initialize client ---
        if self.enabled:
            self.client = AsyncOpenAI(
                api_key=self.api_key,
                base_url=self.base_url,
                timeout=self.timeout_seconds,
            )
        else:
            self.client = None

        # --- Initialize SQLite ---
        self._init_db()

    # 建库早于 model 列的历史行没有 model 值 — 按当年唯一在用的模型归属
    _LEGACY_MODEL = "gemini-embedding-001"

    def _init_db(self):
        """Create embeddings table if not exists."""
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS embeddings (
                bucket_id TEXT PRIMARY KEY,
                embedding TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        # 模型感知(2026-07-04): 不同模型的向量空间不可混算(同维度也不行)。
        # 每行记生成时的模型名; 读取侧只认当前模型的向量 → 换模型后旧向量
        # 自动视为"缺失", backfill 重灌即可, 不会静默混算出垃圾相似度。
        try:
            conn.execute("ALTER TABLE embeddings ADD COLUMN model TEXT DEFAULT ''")
        except sqlite3.OperationalError:
            pass  # 列已存在
        conn.commit()
        conn.close()

    def _model_matches(self, stored_model: str) -> bool:
        """空值(老库)按 _LEGACY_MODEL 归属; 只有与当前模型一致的向量才可用。"""
        return (stored_model or self._LEGACY_MODEL) == self.model

    def _query_text(self, query: str) -> str:
        """查询侧文本预处理 — Qwen3-Embedding 系官方用法: 查询要带 instruction
        前缀、文档侧保持原文(非对称检索)。不带前缀 = 降级模式, 检索质量明显打折
        (实测: 换说法查询从可召回掉到完全召不回)。其他模型原样返回不受影响。"""
        if "qwen3-embedding" in (self.model or "").lower():
            instruct = os.environ.get(
                "OMBRE_EMBED_QUERY_INSTRUCT",
                "Given a chat message from the user, retrieve relevant personal memories about the user and the assistant",
            )
            return f"Instruct: {instruct}\nQuery: {query}"
        return query

    async def generate_and_store(self, bucket_id: str, content: str) -> bool:
        """
        Generate embedding for content and store in SQLite.
        为内容生成 embedding 并存入 SQLite。
        Returns True on success, False on failure.
        """
        if not self.enabled or not content or not content.strip():
            return False

        try:
            embedding = await self._generate_embedding(content)
            if not embedding:
                return False
            self._store_embedding(bucket_id, embedding)
            return True
        except Exception as e:
            logger.warning(f"Embedding generation failed for {bucket_id}: {e}")
            return False

    async def _generate_embedding(self, text: str) -> list[float]:
        """Call API to generate embedding vector."""
        # Truncate to avoid token limits
        truncated = text[:2000]
        # LRU 命中: 同一模型同一文本的向量恒定, 不再重打 API(对齐上游 2.4.13)
        cache_key = f"{self.model}:{truncated}"
        cached = self._embed_cache.get(cache_key)
        if cached is not None:
            self._embed_cache.move_to_end(cache_key)
            return list(cached)
        try:
            response = await self.client.embeddings.create(
                model=self.model,
                input=truncated,
            )
            if response.data and len(response.data) > 0:
                embedding = response.data[0].embedding
                self._embed_cache[cache_key] = list(embedding)
                self._embed_cache.move_to_end(cache_key)
                if len(self._embed_cache) > _EMBED_CACHE_MAXSIZE:
                    self._embed_cache.popitem(last=False)
                return embedding
            return []
        except Exception as e:
            logger.warning(f"Embedding API call failed: {e}")
            return []

    def _store_embedding(self, bucket_id: str, embedding: list[float]):
        """Store embedding in SQLite (带生成模型名)."""
        from utils import now_iso
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            "INSERT OR REPLACE INTO embeddings (bucket_id, embedding, updated_at, model) VALUES (?, ?, ?, ?)",
            (bucket_id, json.dumps(embedding), now_iso(), self.model),
        )
        conn.commit()
        conn.close()

    def delete_embedding(self, bucket_id: str):
        """Remove embedding when bucket is deleted."""
        conn = sqlite3.connect(self.db_path)
        conn.execute("DELETE FROM embeddings WHERE bucket_id = ?", (bucket_id,))
        conn.commit()
        conn.close()

    async def get_embedding(self, bucket_id: str) -> list[float] | None:
        """Retrieve stored embedding for a bucket.
        Returns None if not found — 或者存的是别的模型的向量(等同缺失, 触发 backfill 重灌)。"""
        conn = sqlite3.connect(self.db_path)
        row = conn.execute(
            "SELECT embedding, model FROM embeddings WHERE bucket_id = ?", (bucket_id,)
        ).fetchone()
        conn.close()
        if row and self._model_matches(row[1]):
            try:
                return json.loads(row[0])
            except json.JSONDecodeError:
                return None
        return None

    async def search_similar(self, query: str, top_k: int = 10) -> list[tuple[str, float]]:
        """
        Search for buckets similar to query text.
        Returns list of (bucket_id, similarity_score) sorted by score desc.
        搜索与查询文本相似的桶。返回 (bucket_id, 相似度分数) 列表。
        """
        if not self.enabled:
            return []

        try:
            query_embedding = await self._generate_embedding(self._query_text(query))
            if not query_embedding:
                return []
        except Exception as e:
            logger.warning(f"Query embedding failed: {e}")
            return []

        # Load all embeddings from SQLite (只取当前模型的向量 — 跨模型不可混算)
        conn = sqlite3.connect(self.db_path)
        rows = conn.execute("SELECT bucket_id, embedding, model FROM embeddings").fetchall()
        conn.close()

        if not rows:
            return []

        # Calculate cosine similarity
        results = []
        for bucket_id, emb_json, stored_model in rows:
            if not self._model_matches(stored_model):
                continue
            try:
                stored_embedding = json.loads(emb_json)
                sim = self._cosine_similarity(query_embedding, stored_embedding)
                results.append((bucket_id, sim))
            except (json.JSONDecodeError, Exception):
                continue

        results.sort(key=lambda x: x[1], reverse=True)
        return results[:top_k]

    @staticmethod
    def _cosine_similarity(a: list[float], b: list[float]) -> float:
        """Calculate cosine similarity between two vectors."""
        if len(a) != len(b) or not a:
            return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = math.sqrt(sum(x * x for x in a))
        norm_b = math.sqrt(sum(x * x for x in b))
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot / (norm_a * norm_b)
