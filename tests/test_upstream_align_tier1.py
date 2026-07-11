# ============================================================
# 上游对齐第一梯队回归测试 (2026-07-10)
# 覆盖: 原子写/撞名旁置(2.5.0) · 时区解析(2.5.3) · clean_llm_json(2.4.6)
#       datetime 序列化归一(2.4.4) · coerce_bool/positive_float(2.5.3/2.4.5)
#       list_all 活跃集缓存(2.5.0) · embedding LRU(2.4.13)
# 全部用同步 test + asyncio.run, 避开 pytest-asyncio async fixture 兼容坑。
# ============================================================

import asyncio
import glob
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, date

import frontmatter
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from utils import (  # noqa: E402
    atomic_write_text,
    clean_llm_json,
    coerce_bool,
    days_since_iso,
    normalize_event_time,
    now_iso,
    parse_iso_datetime,
    positive_float,
)
from bucket_manager import BucketManager  # noqa: E402


def _tmp_mgr():
    tmp = tempfile.mkdtemp(prefix="ob_align_")
    return tmp, BucketManager({"buckets_dir": tmp})


# ---------- 原子写 ----------

class TestAtomicWrite:
    def test_write_and_no_tmp_leftover(self):
        tmp = tempfile.mkdtemp(prefix="ob_atomic_")
        path = os.path.join(tmp, "a.md")
        atomic_write_text(path, "内容一")
        atomic_write_text(path, "内容二")
        with open(path, encoding="utf-8") as f:
            assert f.read() == "内容二"
        assert not glob.glob(path + ".*.tmp"), "临时文件必须清理干净"

    def test_creates_parent_dir(self):
        tmp = tempfile.mkdtemp(prefix="ob_atomic_")
        path = os.path.join(tmp, "sub", "dir", "b.md")
        atomic_write_text(path, "x")
        assert os.path.exists(path)

    def test_bucket_writes_go_atomic(self):
        """create 后不残留 .tmp; 文件内容是完整 frontmatter。"""
        tmp, mgr = _tmp_mgr()
        bid = asyncio.run(mgr.create("原子写测试内容", {"name": "原子", "domain": ["测试"], "valence": 0.5, "arousal": 0.3, "tags": []}))
        fp = mgr._find_bucket_file(bid)
        assert fp and os.path.exists(fp)
        assert not glob.glob(fp + ".*.tmp")
        post = frontmatter.load(fp)
        assert "原子写测试内容" in post.content


# ---------- 撞名旁置 ----------

class TestCollisionSideline:
    def test_archive_collision_sidelines_stale(self):
        tmp, mgr = _tmp_mgr()

        async def run():
            bid = await mgr.create("撞名内容", {"name": "撞", "domain": ["测试"], "valence": 0.5, "arousal": 0.3, "tags": []})
            fp_dyn = mgr._find_bucket_file(bid)
            assert await mgr.archive(bid)
            fp_arc = mgr._find_bucket_file(bid)
            # 模拟崩溃残留: 归档副本复制回 dynamic 原位, 再次归档撞名
            shutil.copy(fp_arc, fp_dyn)
            mgr._invalidate_active_cache()
            assert await mgr.archive(bid)
            sidelined = glob.glob(fp_arc + ".stale-*")
            assert len(sidelined) == 1, "旧副本必须旁置而非覆盖/报错"
            assert os.path.exists(fp_arc)
            # 旁置文件不以 .md 结尾 → 桶扫描忽略, 不产生重复 id
            assert not sidelined[0].endswith(".md")

        asyncio.run(run())


# ---------- 时区解析 (2.5.3 命门) ----------

class TestTimezoneParse:
    def test_z_suffix_not_treated_as_30_days(self):
        """now_iso() 的 Z 后缀时间戳曾因 aware/naive 相减 TypeError 全部兜底成 30 天。"""
        assert days_since_iso(now_iso()) < 0.1

    def test_offset_string(self):
        assert days_since_iso(datetime.utcnow().isoformat() + "+00:00") < 0.1

    def test_naive_string_assumed_utc(self):
        assert days_since_iso(datetime.utcnow().isoformat()) < 0.1

    def test_datetime_and_date_objects(self):
        assert parse_iso_datetime(datetime(2026, 7, 1, 10, 0)) == datetime(2026, 7, 1, 10, 0)
        assert parse_iso_datetime(date(2026, 7, 1)) == datetime(2026, 7, 1, 0, 0)

    def test_bad_data_fallback(self):
        assert days_since_iso("not-a-date", fallback_days=30) == 30.0
        assert days_since_iso("", fallback_days=999) == 999.0
        assert days_since_iso(None, fallback_days=30) == 30.0

    def test_normalize_event_time_no_offset_pollution(self):
        out = normalize_event_time("2026-07-10T09:00:00Z")
        assert "+" not in out and "Z" not in out
        assert normalize_event_time(date(2026, 7, 1)) == "2026-07-01"
        assert normalize_event_time("2026-07-01") == "2026-07-01T00:00:00"
        assert normalize_event_time("垃圾输入") is None


# ---------- clean_llm_json (2.4.6) ----------

class TestCleanLlmJson:
    def test_chatter_around_object(self):
        raw = '好的，以下是分析结果：{"valence": 0.8, "tags": ["a"]} 希望有帮助！'
        assert json.loads(clean_llm_json(raw)) == {"valence": 0.8, "tags": ["a"]}

    def test_markdown_fence(self):
        raw = '```json\n[{"content": "x"}]\n```'
        assert json.loads(clean_llm_json(raw)) == [{"content": "x"}]

    def test_chatter_around_array(self):
        raw = '前言 [1, 2, {"k": "v"}] 后语'
        assert json.loads(clean_llm_json(raw)) == [1, 2, {"k": "v"}]

    def test_no_json_passthrough(self):
        raw = "完全没有 JSON 的回复"
        assert clean_llm_json(raw) == raw
        with pytest.raises(json.JSONDecodeError):
            json.loads(clean_llm_json(raw))

    def test_format_example_not_swallowed(self):
        """说明文字里的格式示例在真实结果之前 — 必须取最后一个平衡值(审计发现#1)。"""
        raw = '请按 {"valence": 0.5} 的格式。实际结果: {"valence": 0.9, "tags": ["关系"]}'
        assert json.loads(clean_llm_json(raw)) == {"valence": 0.9, "tags": ["关系"]}

    def test_whole_string_json_short_circuits(self):
        """整体就是合法 JSON 时原样返回, 不做扫描。"""
        raw = '{"a": [1, 2], "b": {"c": 3}}'
        assert clean_llm_json(raw) == raw


# ---------- datetime 元数据归一 (2.4.4) ----------

class TestMetaDatetimeNormalization:
    def test_datetime_objects_become_iso_strings(self):
        meta = {
            "created": datetime(2026, 4, 15, 10, 0),
            "last_active": date(2026, 7, 1),
            "event_time": "2026-07-01T10:00:00Z",  # 字符串原样保留
            "trashed_at": None,
        }
        out = BucketManager._normalize_meta_datetimes(meta)
        assert out["created"] == "2026-04-15T10:00:00"
        assert out["last_active"] == "2026-07-01"
        assert out["event_time"] == "2026-07-01T10:00:00Z"
        assert out["trashed_at"] is None
        json.dumps(out)  # 不再 500

    def test_unquoted_yaml_timestamp_roundtrip(self):
        """上游迁移桶的裸时间戳 → YAML 解析成 datetime → 读取层必须归一成 str。"""
        tmp, mgr = _tmp_mgr()
        d = os.path.join(tmp, "dynamic", "未分类")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "migrated.md"), "w", encoding="utf-8") as f:
            f.write("---\nid: migrated\ncreated: 2026-04-15T10:00:00\nlast_active: 2026-04-16T10:00:00\n---\n迁移桶内容")
        b = mgr._load_bucket(os.path.join(d, "migrated.md"))
        assert isinstance(b["metadata"]["created"], str)
        assert isinstance(b["metadata"]["last_active"], str)
        # 混着字符串排序不再 TypeError (dream/导入页曾炸)
        sorted([b["metadata"]["created"], "2026-05-01T00:00:00Z", ""])


# ---------- coerce_bool / positive_float ----------

class TestCoercers:
    def test_quoted_false_not_truthy(self):
        assert coerce_bool("false") is False
        assert coerce_bool("0") is False
        assert coerce_bool("off") is False
        assert coerce_bool("true") is True
        assert coerce_bool(True) is True
        assert coerce_bool(None, default=True) is True
        assert coerce_bool("garbage", default=False) is False

    def test_positive_float(self):
        assert positive_float("45", 60.0) == 45.0
        assert positive_float(None, 60.0) == 60.0
        assert positive_float("-5", 60.0) == 60.0
        assert positive_float("abc", 30.0) == 30.0


# ---------- list_all 活跃集缓存 (2.5.0) ----------

class TestActiveCache:
    def test_cache_lifecycle(self):
        tmp, mgr = _tmp_mgr()

        async def run():
            id1 = await mgr.create("缓存内容一", {"name": "一", "domain": ["测试"], "valence": 0.5, "arousal": 0.3, "tags": []})
            id2 = await mgr.create("缓存内容二", {"name": "二", "domain": ["测试"], "valence": 0.5, "arousal": 0.3, "tags": []})
            a = await mgr.list_all()
            assert len(a) == 2 and mgr._active_cache is not None
            # 命中返回浅拷贝: 调用方排序不污染缓存
            b = await mgr.list_all()
            assert b is not mgr._active_cache
            # touch 就地更新, 不清缓存; 缓存与磁盘一致
            await mgr.touch(id1)
            assert mgr._active_cache is not None
            cached = [x for x in mgr._active_cache if x["id"] == id1][0]
            disk = frontmatter.load(mgr._find_bucket_file(id1))
            assert cached["metadata"]["activation_count"] == disk["activation_count"]
            assert cached["metadata"]["last_active"] == disk["last_active"]
            # 写操作失效
            await mgr.update(id1, importance=8)
            assert mgr._active_cache is None
            c = await mgr.list_all()
            assert [x for x in c if x["id"] == id1][0]["metadata"]["importance"] == 8
            # 归档/删除/恢复走失效 → 集合正确
            await mgr.archive(id2)
            assert len(await mgr.list_all()) == 1
            await mgr.delete(id1)
            assert len(await mgr.list_all()) == 0
            await mgr.restore(id1)
            assert len(await mgr.list_all()) == 1
            await mgr.unarchive(id2)
            assert len(await mgr.list_all()) == 2

        asyncio.run(run())

    def test_include_archive_bypasses_cache(self):
        tmp, mgr = _tmp_mgr()

        async def run():
            bid = await mgr.create("归档可见性", {"name": "归", "domain": ["测试"], "valence": 0.5, "arousal": 0.3, "tags": []})
            await mgr.list_all()  # 建缓存
            await mgr.archive(bid)
            full = await mgr.list_all(include_archive=True)
            assert any(b["id"] == bid for b in full)

        asyncio.run(run())


# ---------- embedding LRU (2.4.13) ----------

class TestEmbeddingLru:
    def test_identical_text_hits_cache(self):
        from embedding_engine import EmbeddingEngine

        tmp = tempfile.mkdtemp(prefix="ob_emb_")
        eng = EmbeddingEngine({"buckets_dir": tmp, "dehydration": {"api_key": "fake"}, "embedding": {"api_key": "fake", "model": "test-model"}})
        calls = {"n": 0}

        class _FakeData:
            embedding = [0.1, 0.2, 0.3]

        class _FakeResp:
            data = [_FakeData()]

        class _FakeEmbeddings:
            async def create(self, **kw):
                calls["n"] += 1
                return _FakeResp()

        class _FakeClient:
            embeddings = _FakeEmbeddings()

        eng.client = _FakeClient()

        async def run():
            v1 = await eng._generate_embedding("同一段文本")
            v2 = await eng._generate_embedding("同一段文本")
            assert v1 == v2 == [0.1, 0.2, 0.3]
            assert calls["n"] == 1, "第二次必须命中 LRU 不打 API"
            await eng._generate_embedding("另一段文本")
            assert calls["n"] == 2

        asyncio.run(run())
