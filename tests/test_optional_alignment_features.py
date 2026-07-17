import asyncio
import base64
import hashlib
import importlib.util
import json
import zipfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

from bucket_manager import BucketManager
from dehydrator import get_system_prompt
from deployment_manager import DeploymentError, DeploymentManager
from embedding_outbox import EmbeddingOutbox, content_hash
from oauth_manager import OAuthError, OAuthManager


def _challenge(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")


@pytest.mark.asyncio
async def test_oauth_pkce_refresh_rotation_and_hashed_storage(tmp_path: Path) -> None:
    manager = OAuthManager(str(tmp_path))
    client = await manager.register({
        "client_name": "test client",
        "redirect_uris": ["http://localhost/callback"],
        "token_endpoint_auth_method": "none",
    })
    verifier = "v" * 48
    params = {
        "client_id": client["client_id"], "redirect_uri": "http://localhost/callback",
        "response_type": "code", "scope": "mcp", "state": "state-1",
        "code_challenge": _challenge(verifier), "code_challenge_method": "S256",
    }
    redirect = await manager.issue_code(params)
    code = parse_qs(urlparse(redirect).query)["code"][0]
    pair = await manager.token({
        "grant_type": "authorization_code", "client_id": client["client_id"],
        "redirect_uri": "http://localhost/callback", "code": code, "code_verifier": verifier,
    })
    assert await manager.validate_bearer("Bearer " + pair["access_token"])
    rotated = await manager.token({
        "grant_type": "refresh_token", "client_id": client["client_id"],
        "refresh_token": pair["refresh_token"],
    })
    assert rotated["refresh_token"] != pair["refresh_token"]
    with pytest.raises(OAuthError):
        await manager.token({
            "grant_type": "refresh_token", "client_id": client["client_id"],
            "refresh_token": pair["refresh_token"],
        })
    persisted = manager.path.read_text(encoding="utf-8")
    assert pair["access_token"] not in persisted
    assert pair["refresh_token"] not in persisted


def test_deployment_settings_are_allowlisted_and_secrets_are_not_persisted(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("OMBRE_PUBLIC_BASE_URL", raising=False)
    monkeypatch.delenv("OMBRE_MCP_AUTH_MODE", raising=False)
    manager = DeploymentManager(str(tmp_path), str(tmp_path / "data"))
    status = manager.apply_settings({
        "public_base_url": "https://memory.example", "mcp_auth_mode": "oauth",
        "dream_hook_enabled": False, "tunnel_autostart": False,
    })
    assert status["mcp_auth_mode"] == "oauth"
    saved = json.loads(manager.settings_path.read_text(encoding="utf-8"))
    assert "token" not in json.dumps(saved).lower()
    with pytest.raises(DeploymentError):
        manager.apply_settings({"admin_token": "should-not-be-written"})


def test_update_archive_rejects_path_traversal(tmp_path: Path) -> None:
    archive = tmp_path / "bad.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("../escape.txt", "bad")
    with pytest.raises(DeploymentError):
        DeploymentManager._safe_extract(archive, tmp_path / "extract")


def test_multi_owner_environment_is_secret_and_storage_isolated(tmp_path: Path) -> None:
    module_path = Path(__file__).parents[1] / "deploy" / "multi_owner.py"
    spec = importlib.util.spec_from_file_location("ombre_multi_owner", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    config = tmp_path / "owners.yaml"
    config.write_text(
        "owners:\n"
        "  - name: A\n    port: 18001\n    buckets_dir: ./a\n    admin_token_env: A_TOKEN\n"
        "  - name: B\n    port: 18002\n    buckets_dir: ./b\n    admin_token_env: B_TOKEN\n",
        encoding="utf-8",
    )
    owners = module.load_owners(config)
    env = module.build_env(
        owners[0], 2, {"A_TOKEN": "a" * 32, "B_TOKEN": "b" * 32},
        secret_env_names={"A_TOKEN", "B_TOKEN"},
    )
    assert env["OMBRE_ADMIN_TOKEN"] == "a" * 32
    assert env["OMBRE_BUCKETS_DIR"] != owners[1]["buckets_dir"]
    assert env["OMBRE_OWNER_COUNT"] == "2"
    assert "A_TOKEN" not in env and "B_TOKEN" not in env


@pytest.mark.asyncio
async def test_quota_guards_concurrent_create_and_degrades_high_importance(tmp_path: Path) -> None:
    manager = BucketManager({
        "buckets_dir": str(tmp_path), "storage": {"external_change_poll_seconds": 0},
        "limits": {"max_pinned": 2, "max_high_importance": 2},
    })
    pin_results = await asyncio.gather(
        *(manager.create(f"pin {index}", protected=True) for index in range(3)),
        return_exceptions=True,
    )
    assert sum(isinstance(result, str) for result in pin_results) == 2
    assert sum(isinstance(result, ValueError) for result in pin_results) == 1

    high_ids = await asyncio.gather(*(manager.create(f"high {index}", importance=9) for index in range(3)))
    high_rows = [await manager.get(bucket_id) for bucket_id in high_ids]
    importance = sorted(row["metadata"]["importance"] for row in high_rows)
    assert importance == [8, 9, 9]


@pytest.mark.asyncio
async def test_embedding_reconcile_never_overwrites_newer_pending_content(tmp_path: Path) -> None:
    class Manager:
        async def list_all(self, include_archive=True):
            return []

        async def get(self, bucket_id):
            return {"id": bucket_id, "metadata": {"type": "dynamic"}, "content": "new content"}

    class Engine:
        enabled = True

        def list_content_ids(self):
            return []

        def list_content_hashes(self):
            return {}

    outbox = EmbeddingOutbox(
        {"buckets_dir": str(tmp_path), "embedding": {"background_indexing": False}},
        Manager(), Engine(),
    )
    outbox.enqueue("bucket-1", "new content")
    await outbox.reconcile(buckets=[{
        "id": "bucket-1", "metadata": {"type": "dynamic"}, "content": "stale content",
    }])
    assert outbox._items["bucket-1"]["content_hash"] == content_hash("new content")


def test_perspective_v4_guards_reverse_subject_flip(monkeypatch) -> None:
    monkeypatch.setenv("HUMAN_NAME", "小明")
    prompt = get_system_prompt("dehydrate")
    assert "反方向同罪" in prompt
    assert "判断不了就保持主语省略" in prompt
    assert "小明" in prompt
