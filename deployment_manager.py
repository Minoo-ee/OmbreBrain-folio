"""Deployment helpers used by the optional operations console.

Nothing here starts a tunnel, replaces code, or exits the process unless an
authenticated API call (or an explicit autostart environment variable) asks
for it.  User data and local configuration are never part of an update.
"""

from __future__ import annotations

import asyncio
import compileall
import json
import os
import re
import shutil
import subprocess
import threading
import time
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx


_REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_REF_RE = re.compile(r"^[A-Za-z0-9_./-]{1,160}$")
_TUNNEL_URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com", re.I)


class DeploymentError(RuntimeError):
    pass


class DeploymentManager:
    def __init__(self, project_dir: str, buckets_dir: str):
        self.project_dir = Path(project_dir).resolve()
        self.system_dir = Path(buckets_dir).expanduser().resolve() / "_system"
        self.system_dir.mkdir(parents=True, exist_ok=True)
        self.settings_path = self.system_dir / "deployment-settings.json"
        self.settings = self._load_json(self.settings_path, {})
        self._apply_persisted_defaults()
        self._tunnel_process: subprocess.Popen[str] | None = None
        self._tunnel_thread: threading.Thread | None = None
        self._tunnel_url = ""
        self._tunnel_log: list[str] = []
        self._tunnel_started_at = 0.0
        self._update_lock = asyncio.Lock()
        self._staged: dict[str, Any] = self._load_json(self.system_dir / "staged-update.json", {})

    @staticmethod
    def _load_json(path: Path, default: Any) -> Any:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, type(default)) else default
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return default

    @staticmethod
    def _atomic_json(path: Path, payload: Any) -> None:
        tmp = path.with_suffix(path.suffix + ".tmp")
        with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)

    def _apply_persisted_defaults(self) -> None:
        env_map = {
            "public_base_url": "OMBRE_PUBLIC_BASE_URL",
            "mcp_auth_mode": "OMBRE_MCP_AUTH_MODE",
            "dream_hook_enabled": "OMBRE_ENABLE_DREAM_HOOK",
            "tunnel_autostart": "OMBRE_TUNNEL_AUTOSTART",
            "update_channel": "OMBRE_UPDATE_CHANNEL",
        }
        for key, env_key in env_map.items():
            if env_key not in os.environ and key in self.settings:
                value = self.settings[key]
                os.environ[env_key] = "1" if value is True else "0" if value is False else str(value)

    def onboarding_status(self) -> dict[str, Any]:
        transport = os.environ.get("OMBRE_TRANSPORT", "streamable-http").strip()
        auth_mode = os.environ.get("OMBRE_MCP_AUTH_MODE", "admin").strip().lower()
        admin_ready = bool(os.environ.get("OMBRE_ADMIN_TOKEN", "").strip())
        public_url = os.environ.get("OMBRE_PUBLIC_BASE_URL", "").strip()
        buckets_ready = self.system_dir.parent.exists() and os.access(self.system_dir.parent, os.W_OK)
        backup_ready = bool(os.environ.get("OMBRE_BACKUP_REPO", "").strip() and os.environ.get("OMBRE_BACKUP_TOKEN", "").strip())
        checks = [
            {"id": "storage", "ok": buckets_ready, "label": "持久化记忆目录可写"},
            {"id": "admin_auth", "ok": admin_ready or transport == "stdio", "label": "公网管理鉴权已配置"},
            {"id": "public_url", "ok": bool(public_url) or transport == "stdio", "label": "OAuth 公网地址已固定"},
            {"id": "backup", "ok": backup_ready, "label": "异地自动备份已配置", "recommended": True},
        ]
        return {
            "ready": all(item["ok"] for item in checks if not item.get("recommended")),
            "checks": checks,
            "transport": transport,
            "mcp_auth_mode": auth_mode,
            "public_base_url": public_url,
            "tunnel_autostart": os.environ.get("OMBRE_TUNNEL_AUTOSTART", "0") == "1",
            "dream_hook_enabled": os.environ.get("OMBRE_ENABLE_DREAM_HOOK", "1") == "1",
            "self_update_enabled": os.environ.get("OMBRE_ENABLE_SELF_UPDATE", "0") == "1",
            "restart_enabled": os.environ.get("OMBRE_ENABLE_RESTART", "0") == "1",
            "backup_ready": backup_ready,
        }

    def apply_settings(self, payload: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "public_base_url",
            "mcp_auth_mode",
            "dream_hook_enabled",
            "tunnel_autostart",
            "update_channel",
        }
        unknown = set(payload) - allowed
        if unknown:
            raise DeploymentError("unknown settings: " + ", ".join(sorted(unknown)))
        if "public_base_url" in payload:
            url = str(payload["public_base_url"] or "").strip().rstrip("/")
            if url and not url.startswith(("https://", "http://localhost", "http://127.0.0.1")):
                raise DeploymentError("public_base_url must use https")
            self.settings["public_base_url"] = url
            os.environ["OMBRE_PUBLIC_BASE_URL"] = url
        if "mcp_auth_mode" in payload:
            mode = str(payload["mcp_auth_mode"]).lower()
            if mode not in {"admin", "oauth"}:
                raise DeploymentError("mcp_auth_mode must be admin or oauth")
            self.settings["mcp_auth_mode"] = mode
            os.environ["OMBRE_MCP_AUTH_MODE"] = mode
        for key, env_key in (
            ("dream_hook_enabled", "OMBRE_ENABLE_DREAM_HOOK"),
            ("tunnel_autostart", "OMBRE_TUNNEL_AUTOSTART"),
        ):
            if key in payload:
                if not isinstance(payload[key], bool):
                    raise DeploymentError(f"{key} must be true or false")
                value = payload[key]
                self.settings[key] = value
                os.environ[env_key] = "1" if value else "0"
        if "update_channel" in payload:
            channel = str(payload["update_channel"]).lower()
            if channel not in {"stable", "preview"}:
                raise DeploymentError("update_channel must be stable or preview")
            self.settings["update_channel"] = channel
            os.environ["OMBRE_UPDATE_CHANNEL"] = channel
        self._atomic_json(self.settings_path, self.settings)
        return self.onboarding_status()

    def _cloudflared_binary(self) -> str:
        configured = os.environ.get("OMBRE_CLOUDFLARED_PATH", "").strip()
        candidate = configured or shutil.which("cloudflared") or ""
        if not candidate or not Path(candidate).is_file():
            raise DeploymentError("cloudflared not found; install it or set OMBRE_CLOUDFLARED_PATH")
        return str(Path(candidate).resolve())

    def _read_tunnel_output(self, process: subprocess.Popen[str]) -> None:
        if process.stdout is None:
            return
        for line in process.stdout:
            clean = line.strip()
            if not clean:
                continue
            self._tunnel_log.append(clean[-1000:])
            self._tunnel_log = self._tunnel_log[-80:]
            match = _TUNNEL_URL_RE.search(clean)
            if match:
                self._tunnel_url = match.group(0)

    def tunnel_start(self) -> dict[str, Any]:
        if self._tunnel_process and self._tunnel_process.poll() is None:
            return self.tunnel_status()
        default_target = "http://127.0.0.1:" + os.environ.get("OMBRE_PORT", "8000").strip()
        target = os.environ.get("OMBRE_TUNNEL_TARGET", default_target).strip()
        if not re.fullmatch(r"http://(?:127\.0\.0\.1|localhost):\d{1,5}", target):
            raise DeploymentError("tunnel target must be local http on an explicit port")
        command = [self._cloudflared_binary(), "tunnel", "--url", target, "--no-autoupdate"]
        self._tunnel_url = ""
        self._tunnel_log = []
        try:
            self._tunnel_process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                shell=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except OSError as exc:
            raise DeploymentError(f"could not start cloudflared: {exc}") from exc
        self._tunnel_started_at = time.time()
        self._tunnel_thread = threading.Thread(target=self._read_tunnel_output, args=(self._tunnel_process,), daemon=True)
        self._tunnel_thread.start()
        return self.tunnel_status()

    def tunnel_stop(self) -> dict[str, Any]:
        process = self._tunnel_process
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        return self.tunnel_status()

    def tunnel_status(self) -> dict[str, Any]:
        process = self._tunnel_process
        running = bool(process and process.poll() is None)
        return {
            "running": running,
            "url": self._tunnel_url if running else "",
            "pid": process.pid if running else None,
            "started_at": self._tunnel_started_at if running else None,
            "recent_log": self._tunnel_log[-20:],
            "binary_available": bool(os.environ.get("OMBRE_CLOUDFLARED_PATH", "").strip() or shutil.which("cloudflared")),
        }

    @staticmethod
    def _validate_source() -> tuple[str, str]:
        repo = os.environ.get("OMBRE_UPDATE_REPO", "ceshihaox-dotcom/OmbreBrain-folio").strip()
        ref = os.environ.get("OMBRE_UPDATE_REF", "main").strip()
        if not _REPO_RE.fullmatch(repo) or not _REF_RE.fullmatch(ref) or ".." in ref:
            raise DeploymentError("invalid update repository or ref")
        return repo, ref

    def _local_revision(self) -> str:
        configured = os.environ.get("OMBRE_BUILD_SHA", "").strip()
        if configured:
            return configured
        head = self.project_dir / ".git" / "HEAD"
        try:
            value = head.read_text(encoding="utf-8").strip()
            if value.startswith("ref: "):
                return (self.project_dir / ".git" / value[5:]).read_text(encoding="utf-8").strip()
            return value
        except OSError:
            return "unknown"

    async def update_check(self) -> dict[str, Any]:
        repo, ref = self._validate_source()
        url = f"https://api.github.com/repos/{repo}/commits/{quote(ref, safe='')}"
        async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
            response = await client.get(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "OmbreBrain-Updater"})
        if response.status_code != 200:
            raise DeploymentError(f"update check failed: HTTP {response.status_code}")
        data = response.json()
        remote = str(data.get("sha") or "")
        local = self._local_revision()
        return {
            "repository": repo,
            "ref": ref,
            "local_revision": local,
            "remote_revision": remote,
            "update_available": bool(remote and not remote.startswith(local) and not local.startswith(remote)),
            "published_at": ((data.get("commit") or {}).get("committer") or {}).get("date"),
            "source_url": f"https://github.com/{repo}/tree/{quote(ref, safe='/')}",
        }

    @staticmethod
    def _safe_extract(archive: Path, destination: Path) -> Path:
        with zipfile.ZipFile(archive) as bundle:
            members = bundle.infolist()
            if not members or len(members) > 10000:
                raise DeploymentError("update archive is empty or too large")
            total_uncompressed = 0
            for member in members:
                target = (destination / member.filename).resolve()
                if destination.resolve() not in target.parents and target != destination.resolve():
                    raise DeploymentError("unsafe path in update archive")
                if member.file_size > 64 * 1024 * 1024:
                    raise DeploymentError("oversized file in update archive")
                total_uncompressed += member.file_size
                if total_uncompressed > 256 * 1024 * 1024:
                    raise DeploymentError("update archive expands beyond 256 MiB")
            bundle.extractall(destination)
        roots = [path for path in destination.iterdir() if path.is_dir()]
        if len(roots) != 1:
            raise DeploymentError("unexpected update archive layout")
        return roots[0]

    async def update_stage(self, expected_sha256: str = "") -> dict[str, Any]:
        if os.environ.get("OMBRE_ENABLE_SELF_UPDATE", "0") != "1":
            raise DeploymentError("self-update is disabled; set OMBRE_ENABLE_SELF_UPDATE=1 to opt in")
        repo, ref = self._validate_source()
        async with self._update_lock:
            work = self.system_dir / "updates" / str(int(time.time()))
            work.mkdir(parents=True, exist_ok=False)
            archive = work / "source.zip"
            url = f"https://github.com/{repo}/archive/{quote(ref, safe='/')}.zip"
            digest = __import__("hashlib").sha256()
            size = 0
            async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
                async with client.stream("GET", url, headers={"User-Agent": "OmbreBrain-Updater"}) as response:
                    if response.status_code != 200:
                        raise DeploymentError(f"update download failed: HTTP {response.status_code}")
                    with open(archive, "wb") as handle:
                        async for chunk in response.aiter_bytes():
                            size += len(chunk)
                            if size > 64 * 1024 * 1024:
                                raise DeploymentError("update archive exceeds 64 MiB")
                            digest.update(chunk)
                            handle.write(chunk)
            actual = digest.hexdigest()
            if expected_sha256 and not __import__("hmac").compare_digest(actual, expected_sha256.lower()):
                raise DeploymentError("update archive SHA-256 mismatch")
            source = self._safe_extract(archive, work / "extracted")
            for required in ("server.py", "requirements.txt"):
                if not (source / required).is_file():
                    raise DeploymentError(f"staged update is missing {required}")
            if not compileall.compile_dir(str(source), quiet=1, force=True):
                raise DeploymentError("Python compile guard rejected staged update")
            self._staged = {
                "source": str(source),
                "sha256": actual,
                "repository": repo,
                "ref": ref,
                "staged_at": int(time.time()),
                "size": size,
            }
            self._atomic_json(self.system_dir / "staged-update.json", self._staged)
            return {key: value for key, value in self._staged.items() if key != "source"}

    def update_apply(self, confirmation: str) -> dict[str, Any]:
        if confirmation != "APPLY_STAGED_UPDATE":
            raise DeploymentError("confirmation must be APPLY_STAGED_UPDATE")
        if os.environ.get("OMBRE_ENABLE_SELF_UPDATE", "0") != "1":
            raise DeploymentError("self-update is disabled")
        source = Path(str(self._staged.get("source") or "")).resolve()
        updates_root = (self.system_dir / "updates").resolve()
        if not source.is_dir() or updates_root not in source.parents:
            raise DeploymentError("no valid staged update")
        backup_dir = self.system_dir / "code-backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup = backup_dir / f"before-update-{int(time.time())}.zip"
        excluded = {".git", "buckets", "__pycache__", ".pytest_cache", ".env", "config.yaml"}
        with zipfile.ZipFile(backup, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
            for path in self.project_dir.rglob("*"):
                rel = path.relative_to(self.project_dir)
                if path.is_file() and not any(part in excluded for part in rel.parts):
                    bundle.write(path, rel.as_posix())
        applied = 0
        for path in source.rglob("*"):
            rel = path.relative_to(source)
            if not path.is_file() or any(part in excluded for part in rel.parts):
                continue
            destination = self.project_dir / rel
            destination.parent.mkdir(parents=True, exist_ok=True)
            tmp = destination.with_suffix(destination.suffix + ".update-tmp")
            shutil.copy2(path, tmp)
            os.replace(tmp, destination)
            applied += 1
        return {"ok": True, "applied_files": applied, "backup": str(backup), "restart_required": True}
