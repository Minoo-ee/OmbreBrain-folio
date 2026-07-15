"""Safe, deterministic payload builder for Git backups.

Only source-of-truth Markdown and a redacted runtime configuration are copied.
Derived SQLite indexes/caches and plaintext credentials never enter backup history.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import uuid
from pathlib import Path
from typing import Any

from utils import _win_long_path, atomic_write_text


_SECRET_KEY_PARTS = (
    "api_key",
    "apikey",
    "access_token",
    "refresh_token",
    "admin_token",
    "password",
    "passwd",
    "secret",
    "authorization",
    "private_key",
)


def _is_secret_key(key: Any) -> bool:
    normalized = str(key).strip().lower().replace("-", "_")
    return any(part in normalized for part in _SECRET_KEY_PARTS)


def sanitize_runtime_config(value: Any) -> Any:
    """Return a deep copy with credential-like fields removed."""
    if isinstance(value, dict):
        return {
            str(key): sanitize_runtime_config(item)
            for key, item in value.items()
            if not _is_secret_key(key)
        }
    if isinstance(value, list):
        return [sanitize_runtime_config(item) for item in value]
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(_win_long_path(path), "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _copy_file_atomic(source: str | Path, destination: str | Path) -> None:
    """Binary-safe atomic copy with Windows long-path support."""
    source_long = _win_long_path(source)
    destination = Path(destination)
    os.makedirs(_win_long_path(destination.parent), exist_ok=True)
    temp = destination.with_name(f"{destination.name}.{uuid.uuid4().hex}.tmp")
    temp_long = _win_long_path(temp)
    destination_long = _win_long_path(destination)
    try:
        with open(source_long, "rb") as src, open(temp_long, "wb") as dst:
            shutil.copyfileobj(src, dst, length=1024 * 1024)
            dst.flush()
            os.fsync(dst.fileno())
        os.replace(temp_long, destination_long)
    finally:
        try:
            if os.path.exists(temp_long):
                os.remove(temp_long)
        except OSError:
            pass


def build_backup_payload(buckets_dir: str | os.PathLike, target_root: str | os.PathLike) -> dict:
    """Build a redacted backup tree and return manifest metadata.

    The caller owns ``target_root`` (normally a temporary Git checkout). Existing
    ``buckets/`` and manifest files there are replaced, while the checkout itself
    is left intact.
    """
    source = Path(buckets_dir).resolve()
    target = Path(target_root).resolve()
    if not source.is_dir():
        raise FileNotFoundError(f"buckets_dir does not exist: {source}")

    backup_dir = target / "buckets"
    if backup_dir.exists():
        shutil.rmtree(_win_long_path(backup_dir))
    os.makedirs(_win_long_path(backup_dir), exist_ok=True)

    bucket_count = 0
    source_long = _win_long_path(source)
    for root, _, files in os.walk(source_long):
        for filename in files:
            if not filename.endswith(".md"):
                continue
            src = os.path.join(root, filename)
            relative = os.path.relpath(src, source_long)
            _copy_file_atomic(src, backup_dir / relative)
            bucket_count += 1

    runtime_path = source / "runtime_config.json"
    # Keep the historical filename so an existing tracked plaintext copy is
    # overwritten and staged as redacted content on the very next backup.
    redacted_path = target / "runtime_config.json"
    if runtime_path.is_file():
        with open(_win_long_path(runtime_path), "r", encoding="utf-8") as handle:
            runtime = json.load(handle)
        redacted = sanitize_runtime_config(runtime)
        atomic_write_text(redacted_path, json.dumps(redacted, ensure_ascii=False, indent=2) + "\n")
    elif redacted_path.exists():
        # Overwrite a legacy tracked copy even if the live config was removed.
        atomic_write_text(redacted_path, "{}\n")

    payload_files = []
    target_long = _win_long_path(target)
    discovered = []
    for root, dirs, files in os.walk(target_long):
        dirs[:] = [directory for directory in dirs if directory != ".git"]
        for filename in files:
            if filename == "backup_manifest.json":
                continue
            path = Path(root) / filename
            relative = Path(os.path.relpath(str(path), target_long)).as_posix()
            # A cloned repository can contain documentation unrelated to the payload.
            if not (relative.startswith("buckets/") or relative == "runtime_config.json"):
                continue
            discovered.append((relative, path))
    for relative, path in sorted(discovered, key=lambda item: item[0]):
        payload_files.append({
            "path": relative,
            "size": os.stat(_win_long_path(path)).st_size,
            "sha256": _sha256(path),
        })

    manifest = {
        "version": 1,
        "hash": "sha256",
        "bucket_count": bucket_count,
        "files": payload_files,
    }
    manifest_path = target / "backup_manifest.json"
    atomic_write_text(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return {
        "bucket_count": bucket_count,
        "file_count": len(payload_files),
        "manifest_sha256": _sha256(manifest_path),
    }
