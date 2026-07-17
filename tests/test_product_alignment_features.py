from pathlib import Path

import pytest

import bucket_manager as bucket_module
from bucket_manager import BucketManager


@pytest.mark.asyncio
async def test_plan_and_letter_are_isolated_and_counted(tmp_path: Path) -> None:
    manager = BucketManager({"buckets_dir": str(tmp_path), "storage": {"external_change_poll_seconds": 0}})

    plan_id = await manager.create(
        "finish the release",
        tags=["__plan__"],
        bucket_type="plan",
        domain=["plan"],
        weight=0.8,
    )
    await manager.update(plan_id, status="active", change_log=[{"action": "created"}])
    letter_id = await manager.create(
        "an exact letter",
        tags=["__letter__"],
        bucket_type="letter",
        domain=["letter"],
    )
    await manager.update(letter_id, author="AI", title="Hello", letter_date="2026-07-17")

    plan = await manager.get(plan_id)
    letter = await manager.get(letter_id)
    stats = await manager.get_stats()
    assert Path(plan["path"]).is_relative_to(tmp_path / "plans")
    assert plan["metadata"]["weight"] == 0.8
    assert Path(letter["path"]).is_relative_to(tmp_path / "letters")
    assert letter["metadata"]["author"] == "AI"
    assert stats["plan_count"] == 1
    assert stats["letter_count"] == 1


@pytest.mark.asyncio
async def test_plan_status_moves_between_status_directories(tmp_path: Path) -> None:
    manager = BucketManager({"buckets_dir": str(tmp_path), "storage": {"external_change_poll_seconds": 0}})
    bucket_id = await manager.create("a plan", bucket_type="plan", domain=["plan"], weight=0.5)

    assert await manager.update(bucket_id, status="resolved")

    bucket = await manager.get(bucket_id)
    assert bucket["metadata"]["status"] == "resolved"
    assert Path(bucket["path"]).parent.name == "resolved"


@pytest.mark.asyncio
async def test_extended_semantics_are_persisted(tmp_path: Path) -> None:
    manager = BucketManager({"buckets_dir": str(tmp_path), "storage": {"external_change_poll_seconds": 0}})
    first_id = await manager.create(
        "first",
        tags=["brand-new-topic"],
        triggered_by="source-id",
        dont_surface=True,
    )
    second_id = await manager.create("second", tags=["brand-new-topic"])

    first = await manager.get(first_id)
    second = await manager.get(second_id)
    assert first["metadata"]["first_of_kind"] is True
    assert first["metadata"]["triggered_by"] == "source-id"
    assert first["metadata"]["dont_surface"] is True
    assert not second["metadata"].get("first_of_kind", False)


@pytest.mark.asyncio
async def test_anchor_cap_is_enforced_under_shared_turn(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(bucket_module, "_ANCHOR_LIMIT", 2)
    manager = BucketManager({"buckets_dir": str(tmp_path), "storage": {"external_change_poll_seconds": 0}})
    ids = [await manager.create(f"memory {index}") for index in range(3)]

    assert (await manager.set_anchor(ids[0], True))["ok"] is True
    assert (await manager.set_anchor(ids[1], True))["ok"] is True
    rejected = await manager.set_anchor(ids[2], True)
    assert rejected["ok"] is False
    assert rejected["count"] == 2
    assert (await manager.set_anchor(ids[0], False))["count"] == 1


@pytest.mark.asyncio
async def test_hard_delete_requires_immutable_test_provenance_and_reason(tmp_path: Path) -> None:
    manager = BucketManager({"buckets_dir": str(tmp_path), "storage": {"external_change_poll_seconds": 0}})
    real_id = await manager.create("real memory")
    test_id = await manager.create("fixture", test_data=True, source_tool="test")

    assert (await manager.hard_delete_test_bucket(real_id, reason="cleanup"))["error"] == "not_erasable_test_data"
    assert (await manager.hard_delete_test_bucket(test_id))["error"] == "delete_reason_required"
    assert (await manager.hard_delete_test_bucket(test_id, reason="test cleanup"))["ok"] is True
    assert await manager.get(test_id) is None
    assert await manager.get(real_id) is not None
