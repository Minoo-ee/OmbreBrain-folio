"""Persistent media storage for memory buckets.

Client-side temporary paths are never written into bucket metadata directly.
Media is copied into a content-addressed directory first, then the Markdown
frontmatter receives a stable reference.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import mimetypes
import os
import re
from pathlib import Path
from typing import Any

from utils import _win_long_path, atomic_write_bytes


_SAFE_SUFFIX = re.compile(r"^\.[a-zA-Z0-9]{1,10}$")
_DEFAULT_MAX_MEDIA_BYTES = 25 * 1024 * 1024
_MAX_MEDIA_ITEMS = 20


class MediaPersistenceError(ValueError):
    """Media could not be safely persisted on the Ombre Brain server."""


class MediaStore:
    """Copy media into durable storage and return stable metadata references."""

    def __init__(
        self,
        vault_dir: str,
        media_dir: str,
        *,
        max_bytes: int = _DEFAULT_MAX_MEDIA_BYTES,
    ) -> None:
        self.vault_dir = Path(vault_dir).resolve()
        self.media_dir = Path(media_dir).resolve()
        self.max_bytes = max(1, int(max_bytes))
        os.makedirs(_win_long_path(self.media_dir), exist_ok=True)

    @staticmethod
    def _suffix(name: str, mime_type: str) -> str:
        suffix = Path(name).suffix.lower()
        if _SAFE_SUFFIX.fullmatch(suffix):
            return suffix
        guessed = mimetypes.guess_extension(mime_type or "") or ".bin"
        return guessed if _SAFE_SUFFIX.fullmatch(guessed) else ".bin"

    def _stable_path(self, bucket_id: str, digest: str, suffix: str) -> Path:
        safe_bucket = re.sub(r"[^a-zA-Z0-9_.-]", "_", bucket_id)[:128]
        target_dir = (self.media_dir / safe_bucket).resolve()
        if self.media_dir not in target_dir.parents:
            raise MediaPersistenceError("媒体目录越界，已拒绝保存。")
        os.makedirs(_win_long_path(target_dir), exist_ok=True)
        return target_dir / f"{digest}{suffix}"

    def _frontmatter_path(self, target: Path) -> str:
        # Always store a portable logical reference, even when media_dir lives
        # on a separately mounted disk outside the Markdown vault.
        try:
            return (Path("_media") / target.relative_to(self.media_dir)).as_posix()
        except ValueError:
            raise MediaPersistenceError("媒体目标不在持久媒体目录内。")

    def _read_path(self, raw_path: str) -> tuple[bytes, str]:
        source = Path(raw_path).expanduser().resolve()
        if not os.path.isfile(_win_long_path(source)):
            raise MediaPersistenceError(
                f"媒体临时路径在 OB 服务器上不可读：{raw_path}。"
                "请改传 data_base64，不能把客户端临时路径直接写进记忆。"
            )
        size = os.stat(_win_long_path(source)).st_size
        if size > self.max_bytes:
            raise MediaPersistenceError(
                f"媒体文件超过单项上限 {self.max_bytes} 字节：{raw_path}"
            )
        with open(_win_long_path(source), "rb") as handle:
            return handle.read(), source.name

    def _decode_base64(self, value: str) -> bytes:
        payload = value.strip()
        if payload.startswith("data:"):
            _, separator, payload = payload.partition(",")
            if not separator:
                raise MediaPersistenceError("媒体 data URI 缺少数据部分。")
        # Refuse obviously oversized input before allocating the decoded buffer.
        if len(payload) > ((self.max_bytes + 2) // 3) * 4 + 8:
            raise MediaPersistenceError(f"媒体数据超过单项上限 {self.max_bytes} 字节。")
        try:
            data = base64.b64decode(payload, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise MediaPersistenceError("媒体 data_base64 不是有效 Base64。") from exc
        if len(data) > self.max_bytes:
            raise MediaPersistenceError(f"媒体数据超过单项上限 {self.max_bytes} 字节。")
        return data

    def _persist_one(self, bucket_id: str, item: Any) -> dict[str, Any]:
        entry = {"path": item} if isinstance(item, str) else dict(item or {})
        mime_type = str(entry.get("type") or entry.get("mime_type") or "")[:128]
        if entry.get("data_base64"):
            data = self._decode_base64(str(entry["data_base64"]))
            source_name = str(entry.get("filename") or entry.get("title") or "media")
        else:
            raw_path = str(entry.get("path") or "").strip()
            if not raw_path:
                raise MediaPersistenceError("media 每项必须提供 path 或 data_base64。")
            data, source_name = self._read_path(raw_path)
        digest = hashlib.sha256(data).hexdigest()
        suffix = self._suffix(source_name, mime_type)
        target = self._stable_path(bucket_id, digest, suffix)
        if not os.path.isfile(_win_long_path(target)):
            atomic_write_bytes(target, data)
        result: dict[str, Any] = {
            "path": self._frontmatter_path(target),
            "sha256": digest,
            "size": len(data),
            "stored": True,
        }
        for key, limit in (("title", 200), ("type", 128), ("note", 500)):
            value = entry.get(key)
            if value:
                result[key] = str(value)[:limit]
        if "title" not in result:
            result["title"] = Path(source_name).name[:200]
        return result

    async def persist(self, bucket_id: str, media: Any) -> list[dict[str, Any]]:
        """Persist one or more items; any invalid item fails the whole request."""
        if not media:
            return []
        items = media if isinstance(media, list) else [media]
        if len(items) > _MAX_MEDIA_ITEMS:
            raise MediaPersistenceError(f"单次最多保存 {_MAX_MEDIA_ITEMS} 个媒体附件。")
        return await asyncio.to_thread(
            lambda: [self._persist_one(bucket_id, item) for item in items]
        )

    def resolve_reference(self, reference: str) -> Path:
        """Resolve a stored reference without allowing traversal outside media_dir."""
        raw = str(reference or "").strip()
        candidate = Path(raw)
        if not candidate.is_absolute():
            normalized_parts = Path(raw.replace("\\", "/")).parts
            if normalized_parts and normalized_parts[0] == "_media":
                candidate = self.media_dir.joinpath(*normalized_parts[1:])
            else:
                # Legacy relative references were rooted at the vault.
                candidate = self.vault_dir / candidate
        resolved = candidate.resolve()
        if resolved != self.media_dir and self.media_dir not in resolved.parents:
            raise MediaPersistenceError("媒体引用越界，已拒绝读取。")
        if not os.path.isfile(_win_long_path(resolved)):
            raise MediaPersistenceError("媒体文件不存在。")
        return resolved
