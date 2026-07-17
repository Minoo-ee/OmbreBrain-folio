"""Small, dependency-free OAuth 2.1 server for remote MCP clients.

OAuth is deliberately opt-in.  The dashboard keeps using the stronger admin
token while ``/mcp`` may use short-lived OAuth access tokens.  Authorization
codes require PKCE (S256), refresh tokens rotate, and only token hashes are
stored on disk.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import html
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlparse


def _now() -> int:
    return int(time.time())


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _token(prefix: str) -> str:
    return prefix + secrets.token_urlsafe(32)


def _pkce_s256(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


class OAuthError(ValueError):
    def __init__(self, error: str, description: str, status: int = 400):
        super().__init__(description)
        self.error = error
        self.description = description
        self.status = status


class OAuthManager:
    ACCESS_TTL = 3600
    CODE_TTL = 300
    REFRESH_TTL = 30 * 24 * 3600

    def __init__(self, buckets_dir: str):
        system_dir = Path(buckets_dir).expanduser().resolve() / "_system"
        system_dir.mkdir(parents=True, exist_ok=True)
        self.path = system_dir / "oauth-state.json"
        self._lock = asyncio.Lock()
        self._state: dict[str, Any] = self._load()

    def _empty(self) -> dict[str, Any]:
        return {"version": 1, "clients": {}, "codes": {}, "access": {}, "refresh": {}}

    def _load(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                return self._empty()
            state = self._empty()
            for key in ("clients", "codes", "access", "refresh"):
                if isinstance(raw.get(key), dict):
                    state[key] = raw[key]
            return state
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return self._empty()

    def _save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        payload = json.dumps(self._state, ensure_ascii=False, indent=2, sort_keys=True)
        with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, self.path)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    def _clean(self) -> None:
        now = _now()
        for key in ("codes", "access", "refresh"):
            self._state[key] = {
                token_hash: item
                for token_hash, item in self._state[key].items()
                if int(item.get("expires_at", 0)) > now
            }

    @staticmethod
    def public_base_url(request) -> str:
        configured = os.environ.get("OMBRE_PUBLIC_BASE_URL", "").strip().rstrip("/")
        if configured:
            if not configured.startswith(("https://", "http://localhost", "http://127.0.0.1")):
                raise OAuthError("server_error", "OMBRE_PUBLIC_BASE_URL must use https", 500)
            return configured
        # Host is client-controlled on a direct public request. Only derive an
        # origin for loopback development; public OAuth must be pinned by env.
        hostname = str(request.url.hostname or "").strip("[]").lower()
        if hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise OAuthError("server_error", "set OMBRE_PUBLIC_BASE_URL before enabling public OAuth", 500)
        return f"{request.url.scheme}://{request.url.netloc}".rstrip("/")

    async def register(self, payload: dict[str, Any]) -> dict[str, Any]:
        redirect_uris = payload.get("redirect_uris")
        if not isinstance(redirect_uris, list) or not redirect_uris or len(redirect_uris) > 10:
            raise OAuthError("invalid_client_metadata", "redirect_uris must be a non-empty list")
        clean_uris: list[str] = []
        for uri in redirect_uris:
            uri = str(uri or "").strip()
            parsed = urlparse(uri)
            local_http = parsed.scheme == "http" and (parsed.hostname or "").lower() in {"localhost", "127.0.0.1", "::1"}
            secure = parsed.scheme == "https" and bool(parsed.hostname)
            if not uri or parsed.fragment or parsed.username or not (secure or local_http):
                raise OAuthError("invalid_redirect_uri", "redirect URI must use https (localhost may use http)")
            clean_uris.append(uri)
        if payload.get("token_endpoint_auth_method", "none") != "none":
            raise OAuthError("invalid_client_metadata", "only public PKCE clients are supported")
        client_id = _token("obc_")
        client = {
            "client_id": client_id,
            "client_name": str(payload.get("client_name") or "MCP client")[:120],
            "redirect_uris": clean_uris,
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "created_at": _now(),
        }
        async with self._lock:
            if len(self._state["clients"]) >= 100:
                raise OAuthError("invalid_client_metadata", "client registration limit reached", 429)
            self._state["clients"][client_id] = client
            self._save()
        return dict(client)

    def validate_authorize(self, params: dict[str, str]) -> dict[str, Any]:
        client_id = params.get("client_id", "")
        client = self._state["clients"].get(client_id)
        if not client:
            raise OAuthError("invalid_request", "unknown client_id")
        redirect_uri = params.get("redirect_uri", "")
        if redirect_uri not in client.get("redirect_uris", []):
            raise OAuthError("invalid_request", "redirect_uri is not registered")
        if params.get("response_type") != "code":
            raise OAuthError("unsupported_response_type", "response_type must be code")
        challenge = params.get("code_challenge", "")
        if params.get("code_challenge_method") != "S256" or not (43 <= len(challenge) <= 128):
            raise OAuthError("invalid_request", "PKCE S256 is required")
        scope = params.get("scope", "") or "mcp"
        if any(part not in {"mcp"} for part in scope.split()):
            raise OAuthError("invalid_scope", "only the mcp scope is supported")
        return {
            "client": client,
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "state": params.get("state", ""),
            "scope": scope,
            "code_challenge": challenge,
        }

    def approval_html(self, params: dict[str, str]) -> str:
        auth = self.validate_authorize(params)
        fields = "".join(
            f'<input type="hidden" name="{html.escape(k)}" value="{html.escape(str(params.get(k, "")))}">'
            for k in ("client_id", "redirect_uri", "response_type", "state", "scope", "code_challenge", "code_challenge_method")
        )
        client_name = html.escape(auth["client"].get("client_name", "MCP client"))
        return f"""<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">
<title>授权 Ombre Brain</title><style>body{{font:16px system-ui;max-width:520px;margin:8vh auto;padding:24px;background:#f5f0e8;color:#342f2a}}main{{background:#fff;padding:28px;border-radius:16px;box-shadow:0 8px 30px #0001}}input,button{{box-sizing:border-box;width:100%;padding:12px;margin-top:10px;border:1px solid #d8cfc3;border-radius:9px}}button{{background:#6e4f9a;color:white;font-weight:700;cursor:pointer}}small{{color:#71685f}}</style>
<main><h1>允许连接 Ombre Brain？</h1><p><b>{client_name}</b> 将获得 MCP 记忆读写权限，不会获得管理控制台权限。</p><small>请输入管理员 Token 完成这一次授权。Token 不会保存到 OAuth 客户端。</small><form method=\"post\" action=\"/oauth/authorize\">{fields}<input type=\"password\" name=\"admin_token\" autocomplete=\"current-password\" placeholder=\"管理员 Token\" required><button name=\"decision\" value=\"approve\">允许连接</button></form></main>"""

    async def issue_code(self, params: dict[str, str]) -> str:
        auth = self.validate_authorize(params)
        code = _token("obk_")
        async with self._lock:
            self._clean()
            self._state["codes"][_digest(code)] = {
                "client_id": auth["client_id"],
                "redirect_uri": auth["redirect_uri"],
                "scope": auth["scope"],
                "code_challenge": auth["code_challenge"],
                "expires_at": _now() + self.CODE_TTL,
            }
            self._save()
        query = {"code": code}
        if auth["state"]:
            query["state"] = auth["state"]
        separator = "&" if "?" in auth["redirect_uri"] else "?"
        return auth["redirect_uri"] + separator + urlencode(query)

    async def exchange_code(self, form: dict[str, str]) -> dict[str, Any]:
        code = form.get("code", "")
        verifier = form.get("code_verifier", "")
        if not code or not verifier:
            raise OAuthError("invalid_grant", "code and code_verifier are required")
        code_hash = _digest(code)
        async with self._lock:
            self._clean()
            record = self._state["codes"].pop(code_hash, None)
            if not record:
                raise OAuthError("invalid_grant", "authorization code is invalid or expired")
            if form.get("client_id") != record["client_id"] or form.get("redirect_uri") != record["redirect_uri"]:
                self._save()
                raise OAuthError("invalid_grant", "client or redirect URI mismatch")
            if not hmac.compare_digest(_pkce_s256(verifier), record["code_challenge"]):
                self._save()
                raise OAuthError("invalid_grant", "PKCE verification failed")
            result = self._new_token_pair(record["client_id"], record["scope"])
            self._save()
            return result

    def _new_token_pair(self, client_id: str, scope: str) -> dict[str, Any]:
        access = _token("oba_")
        refresh = _token("obr_")
        now = _now()
        common = {"client_id": client_id, "scope": scope}
        self._state["access"][_digest(access)] = {**common, "expires_at": now + self.ACCESS_TTL}
        self._state["refresh"][_digest(refresh)] = {**common, "expires_at": now + self.REFRESH_TTL}
        return {
            "access_token": access,
            "token_type": "Bearer",
            "expires_in": self.ACCESS_TTL,
            "refresh_token": refresh,
            "scope": scope,
        }

    async def refresh(self, form: dict[str, str]) -> dict[str, Any]:
        refresh = form.get("refresh_token", "")
        async with self._lock:
            self._clean()
            record = self._state["refresh"].pop(_digest(refresh), None) if refresh else None
            if not record or form.get("client_id") != record["client_id"]:
                self._save()
                raise OAuthError("invalid_grant", "refresh token is invalid or expired")
            requested = form.get("scope", record["scope"])
            if not set(requested.split()).issubset(set(record["scope"].split())):
                self._save()
                raise OAuthError("invalid_scope", "scope escalation is not allowed")
            result = self._new_token_pair(record["client_id"], requested)
            self._save()
            return result

    async def token(self, form: dict[str, str]) -> dict[str, Any]:
        grant = form.get("grant_type", "")
        if grant == "authorization_code":
            return await self.exchange_code(form)
        if grant == "refresh_token":
            return await self.refresh(form)
        raise OAuthError("unsupported_grant_type", "grant_type is not supported")

    async def validate_bearer(self, value: str) -> bool:
        if not value.lower().startswith("bearer "):
            return False
        raw = value[7:].strip()
        if not raw:
            return False
        async with self._lock:
            self._clean()
            record = self._state["access"].get(_digest(raw))
            return bool(record and "mcp" in str(record.get("scope", "")).split())

    async def revoke(self, token: str) -> None:
        token_hash = _digest(token) if token else ""
        async with self._lock:
            self._state["access"].pop(token_hash, None)
            self._state["refresh"].pop(token_hash, None)
            self._save()
