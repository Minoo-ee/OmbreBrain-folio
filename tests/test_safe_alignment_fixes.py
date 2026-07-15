import asyncio
import hashlib
import importlib
import inspect
import json
import os
import sqlite3
import sys
import threading
import time
from types import SimpleNamespace

import frontmatter
import pytest
import yaml

from backup_utils import build_backup_payload
from bucket_manager import BucketManager
from dehydrator import Dehydrator
from embedding_engine import EmbeddingEngine
from embedding_outbox import EmbeddingOutbox, content_hash
from import_memory import ImportEngine
from utils import _win_long_path, atomic_update_config_yaml


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


def test_backup_payload_supports_deep_windows_paths(tmp_path):
    source = tmp_path / "source"
    target = tmp_path / "target"
    segment = "deep-domain-segment-" * 3
    relative_parts = ["dynamic", segment, segment, segment, segment, "memory.md"]
    deep_source = source.joinpath(*relative_parts)
    os.makedirs(_win_long_path(deep_source.parent), exist_ok=True)
    os.makedirs(_win_long_path(target), exist_ok=True)
    with open(_win_long_path(deep_source), "w", encoding="utf-8") as handle:
        handle.write("deep memory")

    result = build_backup_payload(source, target)
    deep_backup = target.joinpath("buckets", *relative_parts)
    assert result["bucket_count"] == 1
    assert os.path.exists(_win_long_path(deep_backup))
    with open(_win_long_path(deep_backup), "r", encoding="utf-8") as handle:
        assert handle.read() == "deep memory"


@pytest.mark.asyncio
async def test_same_bucket_mutations_are_serialized(tmp_path, monkeypatch):
    manager = BucketManager(_config(tmp_path))
    active = 0
    max_active = 0

    async def fake_update(bucket_id, **kwargs):
        nonlocal active, max_active
        assert bucket_id == "same-bucket"
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.03)
        active -= 1
        return True

    monkeypatch.setattr(manager, "_update_locked", fake_update)
    assert await asyncio.gather(
        manager.update("same-bucket", content="one"),
        manager.update("same-bucket", content="two"),
    ) == [True, True]
    assert max_active == 1


def test_config_yaml_concurrent_updates_preserve_every_writer(tmp_path):
    config_path = tmp_path / "config.yaml"
    barrier = threading.Barrier(8)
    failures = []

    def worker(index):
        try:
            barrier.wait()

            def mutate(config):
                time.sleep(0.01)
                config[f"writer_{index}"] = index

            atomic_update_config_yaml(mutate, config_path)
        except Exception as exc:  # pragma: no cover - asserted below
            failures.append(exc)

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)

    assert not failures
    assert not any(thread.is_alive() for thread in threads)
    persisted = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert persisted == {f"writer_{index}": index for index in range(8)}


@pytest.mark.asyncio
async def test_numpy_vector_search_is_stable_and_handles_bad_dimensions(tmp_path, monkeypatch):
    engine = EmbeddingEngine(_config(tmp_path))
    engine.enabled = True

    async def query_vector(_text):
        return [1.0, 0.0]

    monkeypatch.setattr(engine, "_generate_embedding", query_vector)
    rows = [
        ("first", [1.0, 0.0]),
        ("second", [2.0, 0.0]),
        ("mismatch", [1.0, 0.0, 0.0]),
        ("zero", [0.0, 0.0]),
    ]
    with sqlite3.connect(engine.db_path) as connection:
        for bucket_id, vector in rows:
            connection.execute(
                "INSERT OR REPLACE INTO embeddings "
                "(bucket_id, embedding, updated_at, model, content_hash) VALUES (?, ?, ?, ?, ?)",
                (bucket_id, json.dumps(vector), "now", engine._model_identity(), "hash"),
            )
        connection.execute(
            "INSERT OR REPLACE INTO embeddings "
            "(bucket_id, embedding, updated_at, model, content_hash) VALUES (?, ?, ?, ?, ?)",
            ("malformed", "not-json", "now", engine._model_identity(), "hash"),
        )

    results = await engine.search_similar_strict("query", top_k=10)
    assert [bucket_id for bucket_id, _ in results[:2]] == ["first", "second"]
    assert dict(results)["mismatch"] == 0.0
    assert dict(results)["zero"] == 0.0
    assert "malformed" not in dict(results)


@pytest.mark.asyncio
async def test_import_does_not_apply_old_character_cutoff_and_reports_failures(tmp_path, monkeypatch):
    captured = []

    class Completions:
        async def create(self, **kwargs):
            captured.append(kwargs["messages"][-1]["content"])
            return SimpleNamespace(choices=[])

    dehydrator = SimpleNamespace(
        api_available=True,
        model="test-model",
        client=SimpleNamespace(chat=SimpleNamespace(completions=Completions())),
    )
    engine = ImportEngine(_config(tmp_path), SimpleNamespace(), dehydrator)

    below_token_ceiling = "x" * 13000
    await engine._extract_memories(below_token_ceiling)
    assert captured[-1] == below_token_ceiling

    over_token_ceiling = "记" * 11000
    await engine._extract_memories(over_token_ceiling)
    assert len(captured[-1]) < len(over_token_ceiling)
    assert any("visibly truncated" in error for error in engine.state.data["errors"])

    async def one_item(_content):
        return [{"name": "broken", "content": "body"}]

    async def fail_store(_item, event_time=None):
        raise RuntimeError("disk full")

    monkeypatch.setattr(engine, "_extract_memories", one_item)
    monkeypatch.setattr(engine, "_merge_or_create_item", fail_store)
    await engine._process_single_chunk({"content": "conversation"}, preserve_raw=False)
    assert any("disk full" in error for error in engine.state.data["errors"])


@pytest.mark.asyncio
async def test_preserve_raw_import_retry_skips_exact_duplicate(tmp_path, monkeypatch):
    manager = BucketManager(_config(tmp_path))
    await manager.create(
        content="exact imported body",
        tags=["raw"],
        importance=5,
        domain=["journal"],
        valence=0.5,
        arousal=0.3,
        name="existing raw",
    )
    engine = ImportEngine(_config(tmp_path), manager, SimpleNamespace())

    async def repeated_item(_content):
        return [{
            "name": "same raw",
            "content": "exact imported body",
            "domain": ["journal"],
            "preserve_raw": True,
        }]

    monkeypatch.setattr(engine, "_extract_memories", repeated_item)
    await engine._process_single_chunk({"content": "replayed chunk"}, preserve_raw=True)
    assert len(await manager.list_all()) == 1


def test_poison_embedding_item_does_not_trip_global_circuit_by_itself(tmp_path):
    config = _config(
        tmp_path,
        embedding={
            "enabled": True,
            "background_indexing": False,
            "retry_base_seconds": 0.01,
            "retry_max_seconds": 0.02,
            "circuit_failure_threshold": 2,
            "circuit_base_seconds": 5,
            "circuit_max_seconds": 5,
        },
    )
    outbox = EmbeddingOutbox(
        config,
        SimpleNamespace(),
        SimpleNamespace(enabled=True),
    )
    first_digest = content_hash("poison")
    outbox.enqueue("poison-bucket", "poison")
    outbox._fail("poison-bucket", first_digest, "filtered")
    outbox._fail("poison-bucket", first_digest, "filtered again")

    circuit = outbox.status()["circuit"]
    assert circuit["state"] == "closed"
    assert circuit["consecutive_failures"] == 1

    second_digest = content_hash("provider-wide failure")
    outbox.enqueue("another-bucket", "provider-wide failure")
    outbox._fail("another-bucket", second_digest, "also failed")
    assert outbox.status()["circuit"]["state"] == "open"


@pytest.mark.asyncio
async def test_search_endpoint_reports_semantic_degradation(tmp_path, monkeypatch):
    monkeypatch.setenv("OMBRE_BUCKETS_DIR", str(tmp_path / "server-buckets"))
    sys.modules.pop("server", None)
    server = importlib.import_module("server")

    class FakeBuckets:
        async def search(self, *args, **kwargs):
            return []

    class BrokenEmbedding:
        enabled = True

        async def search_similar_strict(self, query, top_k=10):
            raise RuntimeError("provider offline")

    class Request:
        query_params = {"q": "needle", "include_vector": "true"}

    monkeypatch.setattr(server, "bucket_mgr", FakeBuckets())
    monkeypatch.setattr(server, "embedding_engine", BrokenEmbedding())
    monkeypatch.setattr(server, "_ensure_family_auto_rebuild", lambda: None)

    response = await server.api_search(Request())
    body = json.loads(response.body)
    assert response.status_code == 200
    assert body["keyword_hits"] == []
    assert body["vector_hits"] == []
    assert body["vector_status"] == "degraded"
    assert body["vector_ran"] is False
    assert body["vector_notice"]
    assert response.headers["X-Semantic-Search"] == "degraded"


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

    assert len(inspect.signature(server.breath).parameters) == 0
    assert await server.breath_search(query="abcdef123456") == "[bucket_id:abcdef123456]\nverbatim memory"
    assert await server.trace(bucket_id="abcdef123456", delete=True) == "已移入回收站: abcdef123456"
    assert fake_embedding.deleted == ["abcdef123456"]


@pytest.mark.asyncio
async def test_catalog_and_pre_split_grow_are_metadata_only_and_verbatim(tmp_path, monkeypatch):
    monkeypatch.setenv("OMBRE_BUCKETS_DIR", str(tmp_path / "server-buckets"))
    sys.modules.pop("server", None)
    server = importlib.import_module("server")

    class FakeDecay:
        async def ensure_started(self):
            return None

    class FakeBuckets:
        async def list_all(self, include_archive=False):
            assert include_archive is False
            return [
                {
                    "id": "low",
                    "content": "must not leak into catalog",
                    "metadata": {"name": "low", "type": "dynamic", "domain": ["work"], "importance": 2},
                },
                {
                    "id": "high",
                    "content": "must not leak either",
                    "metadata": {"name": "high", "type": "dynamic", "domain": ["work"], "importance": 9},
                },
                {
                    "id": "hidden",
                    "content": "hidden",
                    "metadata": {"name": "hidden", "type": "dynamic", "domain": ["work"], "importance": 10, "internalized": True},
                },
            ]

    class FakeDehydrator:
        async def analyze(self, content):
            return {
                "domain": ["journal"],
                "valence": 0.0,
                "arousal": 0.0,
                "tags": ["verbatim"],
                "suggested_name": content[:4],
            }

        async def digest(self, content):
            raise AssertionError("pre-split grow must not call digest")

    monkeypatch.setattr(server, "decay_engine", FakeDecay())
    monkeypatch.setattr(server, "bucket_mgr", FakeBuckets())
    monkeypatch.setattr(server, "dehydrator", FakeDehydrator())

    catalog = await server.breath_advanced(catalog=True, domain="WORK")
    assert "must not leak" not in catalog
    assert "hidden" not in catalog
    assert catalog.index("high | work | 9") < catalog.index("low | work | 2")

    calls = []

    async def fake_merge_or_create(**kwargs):
        calls.append(kwargs)
        return kwargs["name"], False

    monkeypatch.setattr(server, "_merge_or_create", fake_merge_or_create)
    result = await server.grow(
        content="this is ignored",
        event_time="2026-07-01",
        items=["  first exact body  ", {"content": "second exact body", "importance": 8}],
    )
    assert "2条(预拆分·逐字)|新2合0" in result
    assert [call["content"] for call in calls] == ["first exact body", "second exact body"]
    assert [call["importance"] for call in calls] == [5, 8]
    assert all(call["raw_merge"] is True for call in calls)
    assert all(call["event_time"] == "2026-07-01" for call in calls)
    assert all(call["valence"] == 0.0 and call["arousal"] == 0.0 for call in calls)

    call_count = len(calls)
    too_many = await server.grow(items=["x"] * 101)
    assert "items 过多" in too_many
    assert len(calls) == call_count
    assert "查询过大" in await server.breath_search(query="查" * 6000)


@pytest.mark.asyncio
async def test_embedding_outbox_is_durable_private_and_retries(tmp_path):
    config = _config(
        tmp_path,
        embedding={
            "enabled": True,
            "background_indexing": False,
            "retry_base_seconds": 0.01,
            "retry_max_seconds": 0.02,
        },
    )
    manager = BucketManager(config)

    class FakeEngine:
        enabled = True

        def __init__(self):
            self.fail = True
            self.indexed = {}
            self.deleted = []

        async def generate_and_store(self, bucket_id, content):
            if self.fail:
                return False
            self.indexed[bucket_id] = content_hash(content)
            return True

        def list_all_ids(self):
            return list(self.indexed)

        def list_content_hashes(self):
            return dict(self.indexed)

        def delete_embedding(self, bucket_id):
            self.deleted.append(bucket_id)
            self.indexed.pop(bucket_id, None)

    engine = FakeEngine()
    outbox = EmbeddingOutbox(config, manager, engine)
    manager.attach_embedding_outbox(outbox)
    secret_body = "a private exact memory that must not be copied into the queue"
    bucket_id = await manager.create(
        content=secret_body,
        tags=[],
        importance=5,
        domain=["test"],
        valence=0.5,
        arousal=0.3,
        name="queued memory",
    )

    assert outbox.is_pending(bucket_id)
    queue_text = (tmp_path / ".embedding_outbox.json").read_text(encoding="utf-8")
    assert secret_body not in queue_text
    assert content_hash(secret_body) in queue_text

    assert await outbox.process_once() is True
    assert outbox.status()["retrying"] == 1

    # A new process can recover the pending item from disk and finish it.
    recovered = EmbeddingOutbox(config, manager, engine)
    manager.attach_embedding_outbox(recovered)
    recovered.retry_now()
    engine.fail = False
    assert await recovered.process_once() is True
    assert recovered.status()["pending"] == 0
    assert engine.indexed[bucket_id] == content_hash(secret_body)

    assert await manager.delete(bucket_id) is True
    assert bucket_id in engine.deleted
