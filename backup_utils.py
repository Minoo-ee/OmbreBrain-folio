"""Safe, deterministic payload builder for Git backups.

Only source-of-truth Markdown and a redacted runtime configuration are copied.
Derived SQLite indexes/caches and plaintext credentials never enter backup history.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path
from typing import Any


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
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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
        shutil.rmtree(backup_dir)
    backup_dir.mkdir(parents=True, exist_ok=True)

    bucket_count = 0
    for src in source.rglob("*.md"):
        if not src.is_file():
            continue
        relative = src.relative_to(source)
        dest = backup_dir / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        bucket_count += 1

    runtime_path = source / "runtime_config.json"
    # Keep the historical filename so an existing tracked plaintext copy is
    # overwritten and staged as redacted content on the very next backup.
    redacted_path = target / "runtime_config.json"
    if runtime_path.is_file():
        with runtime_path.open("r", encoding="utf-8") as handle:
            runtime = json.load(handle)
        redacted = sanitize_runtime_config(runtime)
        redacted_path.write_text(
            json.dumps(redacted, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    elif redacted_path.exists():
        # Overwrite a legacy tracked copy even if the live config was removed.
        redacted_path.write_text("{}\n", encoding="utf-8")

    payload_files = []
    for path in sorted(target.rglob("*")):
        if not path.is_file() or ".git" in path.parts or path.name == "backup_manifest.json":
            continue
        relative = path.relative_to(target).as_posix()
        # A cloned repository can contain documentation unrelated to the payload.
        if not (relative.startswith("buckets/") or relative == "runtime_config.json"):
            continue
        payload_files.append({
            "path": relative,
            "size": path.stat().st_size,
            "sha256": _sha256(path),
        })

    manifest = {
        "version": 1,
        "hash": "sha256",
        "bucket_count": bucket_count,
        "files": payload_files,
    }
    manifest_path = target / "backup_manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return {
        "bucket_count": bucket_count,
        "file_count": len(payload_files),
        "manifest_sha256": _sha256(manifest_path),
    }
