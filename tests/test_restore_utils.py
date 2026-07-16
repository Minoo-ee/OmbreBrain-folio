import os
import zipfile

import pytest

from backup_utils import build_backup_payload
from restore_utils import (
    BackupRestoreError,
    apply_verified_restore,
    create_pre_restore_backup,
    inspect_backup_checkout,
    public_restore_report,
)
from utils import _win_long_path


def _write(path, content):
    os.makedirs(_win_long_path(path.parent), exist_ok=True)
    with open(_win_long_path(path), "w", encoding="utf-8") as handle:
        handle.write(content)


def test_verified_restore_preview_and_merge_preserve_local_only_files(tmp_path):
    exported = tmp_path / "exported"
    checkout = tmp_path / "checkout"
    local = tmp_path / "local"
    _write(exported / "dynamic" / "work" / "same.md", "same")
    _write(exported / "dynamic" / "work" / "changed.md", "remote-new")
    _write(exported / "dynamic" / "work" / "new.md", "remote-only")
    _write(local / "dynamic" / "work" / "same.md", "same")
    _write(local / "dynamic" / "work" / "changed.md", "local-old")
    _write(local / "dynamic" / "work" / "local-only.md", "keep me")
    checkout.mkdir()
    build_backup_payload(exported, checkout)

    report = inspect_backup_checkout(checkout, local)
    assert public_restore_report(report) == {
        "integrity_verified": True,
        "bucket_count": 3,
        "new": 1,
        "overwrite": 1,
        "unchanged": 1,
        "sample": [
            {"path": "dynamic/work/changed.md", "status": "overwrite"},
            {"path": "dynamic/work/new.md", "status": "new"},
            {"path": "dynamic/work/same.md", "status": "unchanged"},
        ],
    }

    safety_zip = create_pre_restore_backup(local)
    applied = apply_verified_restore(report)
    assert applied == {"created": 1, "overwritten": 1, "unchanged": 1}
    assert (local / "dynamic" / "work" / "changed.md").read_text(encoding="utf-8") == "remote-new"
    assert (local / "dynamic" / "work" / "new.md").read_text(encoding="utf-8") == "remote-only"
    assert (local / "dynamic" / "work" / "local-only.md").read_text(encoding="utf-8") == "keep me"
    with zipfile.ZipFile(_win_long_path(safety_zip)) as archive:
        assert "dynamic/work/local-only.md" in archive.namelist()
        assert archive.read("dynamic/work/changed.md") == b"local-old"


def test_restore_rejects_manifest_tampering_before_writing(tmp_path):
    exported = tmp_path / "exported"
    checkout = tmp_path / "checkout"
    local = tmp_path / "local"
    _write(exported / "dynamic" / "memory.md", "original")
    checkout.mkdir()
    local.mkdir()
    build_backup_payload(exported, checkout)
    (checkout / "buckets" / "dynamic" / "memory.md").write_text("tampered", encoding="utf-8")

    with pytest.raises(BackupRestoreError, match="完整性校验失败"):
        inspect_backup_checkout(checkout, local)
    assert not (local / "dynamic" / "memory.md").exists()


def test_restore_handles_deep_windows_paths(tmp_path):
    exported = tmp_path / "exported"
    checkout = tmp_path / "checkout"
    local = tmp_path / "local"
    segment = "deep-restore-domain-" * 3
    relative = ["dynamic", segment, segment, segment, segment, "memory.md"]
    _write(exported.joinpath(*relative), "deep restore")
    checkout.mkdir()
    local.mkdir()
    build_backup_payload(exported, checkout)

    report = inspect_backup_checkout(checkout, local)
    apply_verified_restore(report)
    restored = local.joinpath(*relative)
    assert os.path.exists(_win_long_path(restored))
    with open(_win_long_path(restored), "r", encoding="utf-8") as handle:
        assert handle.read() == "deep restore"
