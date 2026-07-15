"""Durable write-behind queue for the derived embedding index.

Markdown buckets remain the source of truth.  The queue stores only bucket IDs,
content hashes and retry metadata, so provider outages never block a memory
write and never duplicate private memory text into another file.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import threading
import time
from typing import Any

from utils import atomic_write_text, coerce_bool, now_iso, positive_float


logger = logging.getLogger("ombre_brain.embedding_outbox")
_OUTBOX_FILENAME = ".embedding_outbox.json"
_IDLE_POLL_SECONDS = 30.0


def content_hash(content: str) -> str:
    return hashlib.sha256((content or "").encode("utf-8")).hexdigest()


class EmbeddingOutbox:
    """Persist desired vector state and retry it in the background."""

    def __init__(self, config: dict, bucket_mgr: Any, embedding_engine: Any) -> None:
        self.bucket_mgr = bucket_mgr
        self.embedding_engine = embedding_engine
        self.path = os.path.join(config["buckets_dir"], _OUTBOX_FILENAME)
        embed_cfg = config.get("embedding", {}) or {}
        self.background_enabled = coerce_bool(
            embed_cfg.get("background_indexing", True), default=True
        )
        self.retry_base_seconds = positive_float(embed_cfg.get("retry_base_seconds"), 5.0)
        self.retry_max_seconds = max(
            self.retry_base_seconds,
            positive_float(embed_cfg.get("retry_max_seconds"), 300.0),
        )
        try:
            self.circuit_failure_threshold = max(
                1, int(embed_cfg.get("circuit_failure_threshold", 3))
            )
        except (TypeError, ValueError):
            self.circuit_failure_threshold = 3
        self.circuit_base_seconds = positive_float(embed_cfg.get("circuit_base_seconds"), 30.0)
        self.circuit_max_seconds = max(
            self.circuit_base_seconds,
            positive_float(embed_cfg.get("circuit_max_seconds"), 600.0),
        )

        self._lock = threading.RLock()
        self._items: dict[str, dict[str, Any]] = self._load_items()
        self._event: asyncio.Event | None = None
        self._task: asyncio.Task | None = None
        self._start_task: asyncio.Task | None = None
        self._running = False
        self._processed = 0
        self._last_success = ""
        self._consecutive_failures = 0
        self._circuit_open_until = 0.0
        self._circuit_trips = 0

    @property
    def running(self) -> bool:
        return self._running

    def enqueue(self, bucket_id: str, content: str, *, reset_retry: bool = True) -> bool:
        """Durably upsert one desired index state without storing its content."""
        bucket_id = str(bucket_id or "").strip()
        if not bucket_id:
            return False
        if not (content or "").strip():
            self.discard(bucket_id)
            return False

        now = now_iso()
        digest = content_hash(content)
        with self._lock:
            current = self._items.get(bucket_id) or {}
            same_content = current.get("content_hash") == digest
            self._items[bucket_id] = {
                "content_hash": digest,
                "queued_at": str(current.get("queued_at") or now) if same_content else now,
                "updated_at": now,
                "attempts": 0 if reset_retry or not same_content else int(current.get("attempts") or 0),
                "next_attempt_at": 0.0 if reset_retry or not same_content else float(current.get("next_attempt_at") or 0.0),
                "last_attempt_at": str(current.get("last_attempt_at") or "") if same_content else "",
                "last_error": "" if reset_retry or not same_content else str(current.get("last_error") or ""),
            }
            self._persist_locked()
        self._wake()
        self.ensure_started()
        return True

    def discard(self, bucket_id: str) -> bool:
        with self._lock:
            if bucket_id not in self._items:
                return False
            self._items.pop(bucket_id, None)
            self._persist_locked()
        return True

    def remove(self, bucket_id: str) -> None:
        """Forget pending work and delete the derived vector for a removed bucket."""
        self.discard(bucket_id)
        if self.embedding_engine:
            self.embedding_engine.delete_embedding(bucket_id)

    def is_pending(self, bucket_id: str) -> bool:
        with self._lock:
            return bucket_id in self._items

    def pending_ids(self) -> set[str]:
        with self._lock:
            return set(self._items)

    def status(self) -> dict[str, Any]:
        with self._lock:
            items = [dict(item) for item in self._items.values()]
        failed = [item for item in items if int(item.get("attempts") or 0) > 0]
        next_retry = min(
            (float(item.get("next_attempt_at") or 0.0) for item in items if item.get("next_attempt_at")),
            default=0.0,
        )
        last_error = ""
        if failed:
            latest = max(failed, key=lambda item: str(item.get("last_attempt_at") or ""))
            last_error = str(latest.get("last_error") or "")
        return {
            "running": self._running,
            "background_enabled": self.background_enabled,
            "provider_ready": bool(self.embedding_engine and getattr(self.embedding_engine, "enabled", False)),
            "pending": len(items),
            "retrying": len(failed),
            "processed": self._processed,
            "last_success": self._last_success,
            "last_error": last_error,
            "next_retry_at": max(next_retry, self._circuit_open_until),
            "circuit": {
                "state": "open" if self._circuit_delay() > 0 else "closed",
                "consecutive_failures": self._consecutive_failures,
                "failure_threshold": self.circuit_failure_threshold,
                "open_until": self._circuit_open_until,
                "trips": self._circuit_trips,
            },
        }

    def ensure_started(self) -> bool:
        """Schedule startup when called from an async request; safe in imports/tests."""
        if self._running or not self.background_enabled:
            return False
        if self._start_task and not self._start_task.done():
            return False
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return False
        self._start_task = loop.create_task(self.start(), name="ombre-embedding-outbox-start")
        return True

    async def start(self, *, reconcile: bool = True) -> bool:
        if self._running or not self.background_enabled:
            return False
        self._running = True
        self._event = asyncio.Event()
        if reconcile:
            try:
                await self.reconcile(include_archive=True)
            except Exception as exc:
                logger.warning("Embedding outbox startup reconciliation failed: %s", exc)
        self._task = asyncio.create_task(self._run(), name="ombre-embedding-outbox")
        self._wake()
        return True

    async def stop(self) -> None:
        self._running = False
        self._wake()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None
        self._event = None

    def retry_now(self) -> int:
        self._consecutive_failures = 0
        self._circuit_open_until = 0.0
        changed = 0
        with self._lock:
            for item in self._items.values():
                if float(item.get("next_attempt_at") or 0.0) > 0:
                    item["next_attempt_at"] = 0.0
                    changed += 1
            if changed:
                self._persist_locked()
        self._wake()
        return changed

    async def reconcile(self, *, include_archive: bool = True, buckets: list[dict] | None = None) -> int:
        """Queue missing/hash-stale vectors and remove orphan derived rows."""
        if buckets is None:
            buckets = await self.bucket_mgr.list_all(include_archive=include_archive)
        current: dict[str, tuple[str, str]] = {}
        for bucket in buckets:
            meta = bucket.get("metadata") or {}
            bucket_id = str(bucket.get("id") or "")
            content = str(bucket.get("content") or "")
            if bucket_id and content.strip() and meta.get("type") != "trashed":
                current[bucket_id] = (content, content_hash(content))

        engine = self.embedding_engine
        indexed_ids = set(engine.list_all_ids()) if engine else set()
        indexed_hashes = dict(engine.list_content_hashes()) if engine else {}
        for orphan_id in indexed_ids - set(current):
            try:
                engine.delete_embedding(orphan_id)
            except Exception as exc:
                logger.warning("Could not remove orphan embedding %s: %s", orphan_id, exc)

        queued = 0
        changed = False
        now = now_iso()
        with self._lock:
            for bucket_id in list(self._items):
                if bucket_id not in current:
                    self._items.pop(bucket_id, None)
                    changed = True
            for bucket_id, (_content, digest) in current.items():
                stored_hash = str(indexed_hashes.get(bucket_id) or "")
                needs_index = bucket_id not in indexed_ids or (stored_hash and stored_hash != digest)
                existing = self._items.get(bucket_id)
                if not needs_index:
                    if existing is not None:
                        self._items.pop(bucket_id, None)
                        changed = True
                    continue
                if existing and existing.get("content_hash") == digest:
                    continue
                self._items[bucket_id] = {
                    "content_hash": digest,
                    "queued_at": now,
                    "updated_at": now,
                    "attempts": 0,
                    "next_attempt_at": 0.0,
                    "last_attempt_at": "",
                    "last_error": "",
                }
                queued += 1
                changed = True
            if changed:
                self._persist_locked()
        if changed:
            self._wake()
        return queued

    async def process_once(self) -> bool:
        engine = self.embedding_engine
        if not engine or not getattr(engine, "enabled", False) or self._circuit_delay() > 0:
            return False
        bucket_id, item, _ = self._next_due()
        if not bucket_id or item is None:
            return False
        await self._process(bucket_id, item, engine)
        return True

    async def wait_until_idle(self, timeout: float = 10.0) -> bool:
        deadline = time.monotonic() + max(0.0, timeout)
        while time.monotonic() < deadline:
            if self.status()["pending"] == 0:
                return True
            await asyncio.sleep(0.02)
        return self.status()["pending"] == 0

    async def _run(self) -> None:
        while self._running:
            if self._event:
                self._event.clear()
            engine = self.embedding_engine
            if not engine or not getattr(engine, "enabled", False):
                await self._wait(_IDLE_POLL_SECONDS)
                continue
            if self._circuit_delay() > 0:
                await self._wait(self._circuit_delay())
                continue
            bucket_id, item, delay = self._next_due()
            if bucket_id and item is not None:
                await self._process(bucket_id, item, engine)
            else:
                await self._wait(delay)

    async def _process(self, bucket_id: str, item: dict[str, Any], engine: Any) -> None:
        bucket = await self.bucket_mgr.get(bucket_id)
        if not bucket:
            self.discard(bucket_id)
            return
        content = str(bucket.get("content") or "")
        digest = content_hash(content)
        if not content.strip():
            self.discard(bucket_id)
            return
        if digest != item.get("content_hash"):
            self.enqueue(bucket_id, content)
            return
        try:
            ok = bool(await engine.generate_and_store(bucket_id, content))
        except Exception as exc:
            self._fail(bucket_id, digest, exc)
            return
        if not ok:
            self._fail(bucket_id, digest, "generate_and_store returned false")
            return
        latest = await self.bucket_mgr.get(bucket_id)
        latest_content = str(latest.get("content") or "") if latest else ""
        if not latest:
            engine.delete_embedding(bucket_id)
            self.discard(bucket_id)
        elif content_hash(latest_content) != digest:
            self.enqueue(bucket_id, latest_content)
        else:
            self._complete(bucket_id, digest)

    def _complete(self, bucket_id: str, digest: str) -> None:
        with self._lock:
            current = self._items.get(bucket_id)
            if not current or current.get("content_hash") != digest:
                return
            self._items.pop(bucket_id, None)
            self._processed += 1
            self._last_success = now_iso()
            self._persist_locked()
        self._consecutive_failures = 0
        self._circuit_open_until = 0.0

    def _fail(self, bucket_id: str, digest: str, error: Any) -> None:
        with self._lock:
            current = self._items.get(bucket_id)
            if not current or current.get("content_hash") != digest:
                return
            attempts = int(current.get("attempts") or 0) + 1
            delay = min(self.retry_max_seconds, self.retry_base_seconds * (2 ** min(attempts - 1, 16)))
            current.update(
                attempts=attempts,
                last_attempt_at=now_iso(),
                updated_at=now_iso(),
                last_error=str(error)[:300],
                next_attempt_at=time.time() + delay,
            )
            self._persist_locked()
        self._consecutive_failures += 1
        if self._consecutive_failures >= self.circuit_failure_threshold:
            exponent = min(self._consecutive_failures - self.circuit_failure_threshold, 16)
            circuit_delay = min(self.circuit_max_seconds, self.circuit_base_seconds * (2 ** exponent))
            was_open = self._circuit_delay() > 0
            self._circuit_open_until = max(self._circuit_open_until, time.time() + circuit_delay)
            if not was_open:
                self._circuit_trips += 1
        logger.warning("Embedding queued for retry: bucket=%s attempt=%s delay=%.1fs", bucket_id, attempts, delay)

    def _circuit_delay(self) -> float:
        return max(0.0, self._circuit_open_until - time.time())

    def _next_due(self) -> tuple[str, dict[str, Any] | None, float]:
        now = time.time()
        with self._lock:
            if not self._items:
                return "", None, _IDLE_POLL_SECONDS
            bucket_id, item = min(
                self._items.items(),
                key=lambda pair: (float(pair[1].get("next_attempt_at") or 0.0), str(pair[1].get("queued_at") or ""), pair[0]),
            )
            due_at = float(item.get("next_attempt_at") or 0.0)
            if due_at <= now:
                return bucket_id, dict(item), 0.0
            return "", None, min(_IDLE_POLL_SECONDS, max(0.01, due_at - now))

    async def _wait(self, timeout: float) -> None:
        if not self._event:
            await asyncio.sleep(timeout)
            return
        try:
            await asyncio.wait_for(self._event.wait(), timeout=max(0.01, timeout))
        except asyncio.TimeoutError:
            pass

    def _wake(self) -> None:
        if self._event:
            self._event.set()

    def _load_items(self) -> dict[str, dict[str, Any]]:
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
            raw = payload.get("items", {}) if isinstance(payload, dict) else {}
            return {
                str(bucket_id): dict(item)
                for bucket_id, item in raw.items()
                if bucket_id and isinstance(item, dict) and item.get("content_hash")
            }
        except FileNotFoundError:
            return {}
        except Exception as exc:
            logger.warning("Embedding outbox is unreadable; it will be rebuilt: %s", exc)
            return {}

    def _persist_locked(self) -> None:
        payload = {"version": 1, "updated_at": now_iso(), "items": self._items}
        atomic_write_text(self.path, json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
