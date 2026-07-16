"""Verified, merge-only restore helpers for Ombre Brain Git backups."""

from __future__ import annotations

import hashlib
import json
import os
import time
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from utils import _win_long_path, atomic_write_bytes


class BackupRestoreError(ValueError):
    """A checkout cannot be trusted or safely restored."""


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _safe_relative(raw: str) -> PurePosixPath:
    normalized = str(raw or "").replace("\\", "/")
    path = PurePosixPath(normalized)
    if (
        not normalized
        or normalized.startswith("/")
        or any(part in ("", ".", "..") for part in path.parts)
        or any(":" in part or "\x00" in part for part in path.parts)
    ):
        raise BackupRestoreError(f"备份包含不安全路径: {raw}")
    return path


def inspect_backup_checkout(
    checkout_dir: str | os.PathLike,
    buckets_dir: str | os.PathLike,
    media_dir: str | os.PathLike | None = None,
) -> dict[str, Any]:
    """Verify the manifest and compare its Markdown/media payload with local files."""
    checkout = Path(checkout_dir).resolve()
    local_root = Path(buckets_dir).resolve()
    local_media_root = Path(media_dir).resolve() if media_dir else local_root / "_media"
    manifest_path = checkout / "backup_manifest.json"
    try:
        with open(_win_long_path(manifest_path), "r", encoding="utf-8") as handle:
            manifest = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise BackupRestoreError(f"backup_manifest.json 不可读: {exc}") from exc
    if not isinstance(manifest, dict) or manifest.get("version") != 1 or manifest.get("hash") != "sha256":
        raise BackupRestoreError("不支持或无效的备份清单")
    entries = manifest.get("files")
    if not isinstance(entries, list):
        raise BackupRestoreError("备份清单缺少 files")

    verified: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise BackupRestoreError("备份清单文件项格式错误")
        relative = _safe_relative(str(entry.get("path") or ""))
        relative_text = relative.as_posix()
        if relative_text in seen:
            raise BackupRestoreError(f"备份清单包含重复路径: {relative_text}")
        seen.add(relative_text)
        source = checkout.joinpath(*relative.parts)
        source_real = source.resolve()
        if checkout != source_real and checkout not in source_real.parents:
            raise BackupRestoreError(f"备份路径越界: {relative_text}")
        if source.is_symlink() or not os.path.isfile(_win_long_path(source)):
            raise BackupRestoreError(f"备份文件缺失或不是普通文件: {relative_text}")
        with open(_win_long_path(source), "rb") as handle:
            data = handle.read()
        if entry.get("size") != len(data) or entry.get("sha256") != _sha256(data):
            raise BackupRestoreError(f"备份完整性校验失败: {relative_text}")
        is_media = relative_text.startswith("buckets/_media/")
        is_bucket = (
            relative_text.startswith("buckets/")
            and relative_text.lower().endswith(".md")
            and not is_media
        )
        if not (is_bucket or is_media):
            continue
        if is_media:
            payload_relative = PurePosixPath(*relative.parts[2:])
            destination_root = local_media_root
            public_path = (PurePosixPath("_media") / payload_relative).as_posix()
        else:
            payload_relative = PurePosixPath(*relative.parts[1:])
            destination_root = local_root
            public_path = payload_relative.as_posix()
        destination = destination_root.joinpath(*payload_relative.parts)
        destination_real = destination.resolve()
        if destination_root != destination_real and destination_root not in destination_real.parents:
            raise BackupRestoreError(f"恢复目标越界: {relative_text}")
        local_data = None
        if os.path.isfile(_win_long_path(destination)):
            with open(_win_long_path(destination), "rb") as handle:
                local_data = handle.read()
        status = "new" if local_data is None else "unchanged" if local_data == data else "overwrite"
        verified.append({
            "path": public_path,
            "source": source,
            "destination": destination,
            "data": data,
            "status": status,
            "kind": "media" if is_media else "bucket",
        })

    bucket_files = [item for item in verified if item["kind"] == "bucket"]
    media_files = [item for item in verified if item["kind"] == "media"]
    if not bucket_files:
        raise BackupRestoreError("备份里没有可恢复的 Markdown 记忆")
    declared_count = manifest.get("bucket_count")
    if declared_count is not None and int(declared_count) != len(bucket_files):
        raise BackupRestoreError("备份清单 bucket_count 与实际 Markdown 数量不一致")
    declared_media_count = manifest.get("media_count")
    if declared_media_count is not None and int(declared_media_count) != len(media_files):
        raise BackupRestoreError("备份清单 media_count 与实际附件数量不一致")
    counts = {key: sum(1 for item in bucket_files if item["status"] == key) for key in ("new", "overwrite", "unchanged")}
    media_counts = {key: sum(1 for item in media_files if item["status"] == key) for key in ("new", "overwrite", "unchanged")}
    return {
        "integrity_verified": True,
        "manifest_sha256": _sha256(json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")),
        "bucket_count": len(bucket_files),
        "media_count": len(media_files),
        "new": counts["new"],
        "overwrite": counts["overwrite"],
        "unchanged": counts["unchanged"],
        "media_new": media_counts["new"],
        "media_overwrite": media_counts["overwrite"],
        "media_unchanged": media_counts["unchanged"],
        "files": verified,
    }


def create_pre_restore_backup(
    buckets_dir: str | os.PathLike,
    media_dir: str | os.PathLike | None = None,
) -> str:
    """Create a local ZIP safety net before any restore writes occur."""
    root = Path(buckets_dir).resolve()
    backup_dir = root / ".restore_backups"
    os.makedirs(_win_long_path(backup_dir), exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    destination = backup_dir / f"pre_github_restore_{stamp}.zip"
    destination_long = _win_long_path(destination)
    with zipfile.ZipFile(destination_long, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for current_root, dirs, files in os.walk(_win_long_path(root)):
            dirs[:] = [name for name in dirs if name not in ("_media", ".restore_backups", ".locks")]
            for filename in files:
                if not filename.lower().endswith(".md"):
                    continue
                source = os.path.join(current_root, filename)
                relative = os.path.relpath(source, _win_long_path(root)).replace("\\", "/")
                archive.write(source, arcname=relative)
        media_root = Path(media_dir).resolve() if media_dir else root / "_media"
        if media_root.is_dir():
            media_root_long = _win_long_path(media_root)
            for current_root, _, files in os.walk(media_root_long):
                for filename in files:
                    source = os.path.join(current_root, filename)
                    if os.path.islink(source) or not os.path.isfile(source):
                        continue
                    relative = os.path.relpath(source, media_root_long).replace("\\", "/")
                    archive.write(source, arcname=f"_media/{relative}")
    if not os.path.isfile(destination_long):
        raise BackupRestoreError("恢复前本地安全备份创建失败")
    return str(destination)


def apply_verified_restore(report: dict[str, Any]) -> dict[str, int]:
    """Merge verified Markdown into the local vault; local-only files are preserved."""
    created = overwritten = unchanged = 0
    for item in report.get("files") or []:
        status = item["status"]
        if status == "unchanged":
            unchanged += 1
            continue
        atomic_write_bytes(item["destination"], item["data"])
        if status == "new":
            created += 1
        else:
            overwritten += 1
    return {"created": created, "overwritten": overwritten, "unchanged": unchanged}


def public_restore_report(report: dict[str, Any]) -> dict[str, Any]:
    """Strip local paths and byte payloads before returning a preview to the browser."""
    public = {
        key: report[key]
        for key in ("integrity_verified", "bucket_count", "new", "overwrite", "unchanged")
    } | {
        "sample": [
            {"path": item["path"], "status": item["status"]}
            for item in (report.get("files") or [])[:20]
        ]
    }
    if report.get("media_count"):
        public.update({
            key: report[key]
            for key in ("media_count", "media_new", "media_overwrite", "media_unchanged")
        })
    return public
