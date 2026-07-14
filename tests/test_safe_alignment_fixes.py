import hashlib
import importlib
import json
import sys

import frontmatter
import pytest

from backup_utils import build_backup_payload
from bucket_manager import BucketManager
from dehydrator import Dehydrator
from embedding_engine import EmbeddingEngine


def _config(tmp_path, **overrides):
    config = {
        "buckets_dir": str(tmp_path),
        "matching": {"fuzzy_threshold": 0, "max_results": 10},
        "storage": {"external_change_poll_seconds": 0},
        "dehydration": {
            "api_key": "",
            "base_url": "https://provider-a.example/v1",
            "model": "model-a",
        },
        "embedding": {"enabled": False, "model": "bge-m3:latest"},
    }
    config.update(overrides)
    return config


@pytest.mark.asyncio
async def test_search_filters_before_limit(tmp_path):
    manager = BucketManager(_config(tmp_path))
    for index in range(2):
        await manager.create(
            content=f"alpha excluded {index}",
            tags=["alpha"],
            importance=10,
            domain=["test"],
            valence=0.5,
            arousal=0.3,
            name=f"alpha excluded {index}",
            bucket_type="feel",
        )
    wanted = await manager.create(
        content="alpha wanted",
        tags=["alpha"],
        importance=1,
        domain=["test"],
        valence=0.5,
        arousal=0.3,
        name="alpha wanted",
    )

    results = await manager.search(
        "alpha",
        limit=1,
        record_stats=False,
        result_filter=lambda bucket: bucket["metadata"].get("type") != "feel",
    )
    assert [item["id"] for item in results] == [wanted]


@pytest.mark.asyncio
async def test_external_markdown_edit_invalidates_cache_immediately(tmp_path):
    manager = BucketManager(_config(tmp_path))
    bucket_id = await manager.create(
        content="old body",
        tags=[],
        importance=5,
        domain=["test"],
        valence=0.5,
        arousal=0.3,
        name="external edit",
    )
    await manager.list_all()

    path = manager._find_bucket_file(bucket_id)
    post = frontmatter.load(path)
    post.content = "new body from Obsidian"
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(frontmatter.dumps(post))

    refreshed = await manager.list_all()
    assert next(item for item in refreshed if item["id"] == bucket_id)["content"] == "new body from Obsidian"


def test_dehydration_cache_isolated_by_endpoint_and_model(tmp_path):
    dehydrator = Dehydrator(_config(tmp_path))
    dehydrator._set_cached_summary("same content", "summary-a")
    assert dehydrator._get_cached_summary("same content") == "summary-a"

    dehydrator.model = "model-b"
    assert dehydrator._get_cached_summary("same content") is None
    dehydrator.model = "model-a"
    dehydrator.base_url = "https://provider-b.example/v1"
    assert dehydrator._get_cached_summary("same content") is None


def test_embedding_model_alias_and_endpoint_identity(tmp_path):
    engine = EmbeddingEngine(_config(tmp_path))
    assert engine._model_matches("bge-m3")
    stored_identity = engine._model_identity()
    engine.base_url = "https://another-provider.example/v1"
    assert not engine._model_matches(stored_identity)


def test_backup_payload_excludes_databases_and_redacts_credentials(tmp_path):
    source = tmp_path / "source"
    target = tmp_path / "target"
    (source / "dynamic" / "domain").mkdir(parents=True)
    target.mkdir()
    (source / "dynamic" / "domain" / "memory.md").write_text("memory", encoding="utf-8")
    (source / "embeddings.db").write_bytes(b"derived")
    (source / "dehydration_cache.db").write_bytes(b"derived")
    (source / "search_log.jsonl").write_text("sensitive log", encoding="utf-8")
    (source / "runtime_config.json").write_text(
        json.dumps({
            "active": "main",
            "profiles": {
                "main": {
                    "model": "safe-model",
                    "base_url": "https://safe.example/v1",
                    "api_key": "secret-key",
                }
            },
            "admin_token": "secret-admin",
            "strategy": {"auto_merge": False},
        }),
        encoding="utf-8",
    )

    result = build_backup_payload(source, target)
    assert result["bucket_count"] == 1
    assert (target / "buckets" / "dynamic" / "domain" / "memory.md").is_file()
    assert not (target / "buckets" / "embeddings.db").exists()

    redacted_text = (target / "runtime_config.json").read_text(encoding="utf-8")
    assert "secret-key" not in redacted_text
    assert "secret-admin" not in redacted_text
    redacted = json.loads(redacted_text)
    assert redacted["profiles"]["main"]["model"] == "safe-model"
    assert redacted["strategy"]["auto_merge"] is False

    manifest_path = target / "backup_manifest.json"
    assert hashlib.sha256(manifest_path.read_bytes()).hexdigest() == result["manifest_sha256"]
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert {entry["path"] for entry in manifest["files"]} == {
        "buckets/dynamic/domain/memory.md",
        "runtime_config.json",
    }


@pytest.mark.asyncio
async def test_tool_parameters_preserve_explicit_zero_and_feel_tags(tmp_path, monkeypatch):
    monkeypatch.setenv("OMBRE_BUCKETS_DIR", str(tmp_path / "server-buckets"))
    sys.modules.pop("server", None)
    server = importlib.import_module("server")

    class FakeDecay:
        async def ensure_started(self):
            return None

    class FakeDehydrator:
        async def analyze(self, content):
            return {
                "domain": ["auto"],
                "valence": 0.9,
                "arousal": 0.8,
                "tags": ["auto"],
                "suggested_name": "auto",
            }

    class FakeEmbedding:
        enabled = False

        def __init__(self):
            self.deleted = []

        async def generate_and_store(self, bucket_id, content):
            return False

        def delete_embedding(self, bucket_id):
            self.deleted.append(bucket_id)

    created = []

    class FakeBuckets:
        async def create(self, **kwargs):
            created.append(kwargs)
            return "abcdef123456"

        async def update(self, *args, **kwargs):
            return True

        async def get(self, bucket_id):
            return {
                "id": bucket_id,
                "content": "verbatim [[memory]]",
                "metadata": {"type": "dynamic"},
            }

        async def delete(self, bucket_id):
            return True

    merged = {}

    async def fake_merge_or_create(**kwargs):
        merged.update(kwargs)
        return "abcdef123456", False

    monkeypatch.setattr(server, "decay_engine", FakeDecay())
    monkeypatch.setattr(server, "dehydrator", FakeDehydrator())
    fake_embedding = FakeEmbedding()
    monkeypatch.setattr(server, "embedding_engine", fake_embedding)
    monkeypatch.setattr(server, "bucket_mgr", FakeBuckets())
    monkeypatch.setattr(server, "_merge_or_create", fake_merge_or_create)

    await server.hold("normal", tags="manual", valence=0.0, arousal=0.0)
    assert merged["valence"] == 0.0
    assert merged["arousal"] == 0.0
    assert merged["tags"] == ["auto", "manual"]

    await server.hold("feel", tags="diary,manual", feel=True, valence=0.0, arousal=0.0)
    assert created[-1]["tags"] == ["diary", "manual"]
    assert created[-1]["valence"] == 0.0
    assert created[-1]["arousal"] == 0.0

    assert await server.breath(query="abcdef123456") == "[bucket_id:abcdef123456]\nverbatim memory"
    assert await server.trace(bucket_id="abcdef123456", delete=True) == "已移入回收站: abcdef123456"
    assert fake_embedding.deleted == ["abcdef123456"]
