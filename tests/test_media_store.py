import base64
from pathlib import Path

import pytest

from backup_utils import build_backup_payload
from bucket_manager import BucketManager
from media_store import MediaPersistenceError, MediaStore
from restore_utils import apply_verified_restore, inspect_backup_checkout


@pytest.mark.asyncio
async def test_server_readable_temporary_file_is_copied(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    source = tmp_path / "client-temp.png"
    source.write_bytes(b"image-bytes")
    store = MediaStore(str(vault), str(vault / "_media"))

    result = await store.persist("bucket-1", str(source))

    stored = vault / result[0]["path"]
    assert stored.read_bytes() == b"image-bytes"
    assert result[0]["stored"] is True
    assert result[0]["path"].startswith("_media/bucket-1/")
    source.unlink()
    assert stored.read_bytes() == b"image-bytes"


@pytest.mark.asyncio
async def test_base64_media_is_persisted_with_original_suffix(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    store = MediaStore(str(vault), str(vault / "_media"))
    payload = base64.b64encode(b"sound-bytes").decode("ascii")

    result = await store.persist(
        "bucket-2",
        [{"data_base64": payload, "filename": "voice.ogg", "type": "audio/ogg"}],
    )

    stored = vault / result[0]["path"]
    assert stored.suffix == ".ogg"
    assert stored.read_bytes() == b"sound-bytes"


@pytest.mark.asyncio
async def test_external_media_directory_uses_portable_reference(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    external = tmp_path / "separate-media-volume"
    store = MediaStore(str(vault), str(external))
    payload = base64.b64encode(b"portable").decode("ascii")

    result = await store.persist("bucket-external", {
        "data_base64": payload,
        "filename": "photo.png",
        "type": "image/png",
    })

    reference = result[0]["path"]
    assert reference.startswith("_media/bucket-external/")
    assert store.resolve_reference(reference).read_bytes() == b"portable"


@pytest.mark.asyncio
async def test_unreadable_client_temporary_path_is_rejected(tmp_path: Path) -> None:
    store = MediaStore(str(tmp_path / "vault"), str(tmp_path / "vault" / "_media"))
    with pytest.raises(MediaPersistenceError, match="data_base64"):
        await store.persist("bucket-3", "/client-only/temporary/photo.png")


@pytest.mark.asyncio
async def test_bucket_media_append_and_unlink_preserves_file(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    manager = BucketManager({"buckets_dir": str(vault), "media_dir": str(vault / "_media")})
    payload = base64.b64encode(b"one").decode("ascii")
    bucket_id = await manager.create(
        "memory",
        media={"data_base64": payload, "filename": "one.txt", "type": "text/plain"},
    )
    bucket = await manager.get(bucket_id)
    first = bucket["metadata"]["media"][0]
    stored = vault / first["path"]
    assert stored.read_bytes() == b"one"

    second_payload = base64.b64encode(b"two").decode("ascii")
    assert await manager.update(
        bucket_id,
        media_append={"data_base64": second_payload, "filename": "two.txt"},
    )
    assert len((await manager.get(bucket_id))["metadata"]["media"]) == 2

    assert await manager.update(bucket_id, media_remove=first["path"])
    assert len((await manager.get(bucket_id))["metadata"]["media"]) == 1
    assert stored.read_bytes() == b"one"


def test_media_round_trips_through_verified_backup_restore(tmp_path: Path) -> None:
    source = tmp_path / "source"
    (source / "dynamic").mkdir(parents=True)
    (source / "dynamic" / "memory.md").write_text("---\nid: one\n---\nbody", encoding="utf-8")
    media = source / "_media" / "one" / "photo.png"
    media.parent.mkdir(parents=True)
    media.write_bytes(b"photo")
    checkout = tmp_path / "checkout"
    checkout.mkdir()

    built = build_backup_payload(source, checkout)
    assert built["media_count"] == 1

    destination = tmp_path / "destination"
    report = inspect_backup_checkout(checkout, destination)
    assert report["media_count"] == 1
    assert report["media_new"] == 1
    apply_verified_restore(report)
    assert (destination / "_media" / "one" / "photo.png").read_bytes() == b"photo"


@pytest.mark.asyncio
async def test_experience_metadata_is_additive_and_searchable(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    manager = BucketManager({"buckets_dir": str(vault)})
    bucket_id = await manager.create(
        "plain memory",
        why_remembered="because this became a turning point",
        meaning="choose curiosity over fear",
        source_tool="grow",
        grow_batch_id="grow_test_batch",
    )
    bucket = await manager.get(bucket_id)
    assert bucket["metadata"]["why_remembered"] == "because this became a turning point"
    assert bucket["metadata"]["meaning"] == ["choose curiosity over fear"]
    assert bucket["metadata"]["source_tool"] == "grow"
    assert bucket["metadata"]["grow_batch_id"] == "grow_test_batch"

    assert await manager.update(bucket_id, meaning_append="remember the choice")
    updated = await manager.get(bucket_id)
    assert updated["metadata"]["meaning"] == [
        "choose curiosity over fear",
        "remember the choice",
    ]
    hits = await manager.search("curiosity", limit=5, record_stats=False)
    assert hits and hits[0]["id"] == bucket_id
    assert "meaning" in hits[0]["matched_in"]
