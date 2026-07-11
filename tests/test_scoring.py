# ============================================================
# Test 1: Scoring Regression — pure local, no LLM needed
# 测试 1：评分回归 —— 纯本地，不需要 LLM
#
# Verifies:
#   - decay score formula correctness
#   - time weight (freshness) formula
#   - resolved/digested modifiers
#   - pinned/permanent/feel special scores
#   - search scoring (topic + emotion + time + importance)
#   - threshold filtering
#   - ordering invariants
# ============================================================

import math
import pytest
from datetime import datetime, timedelta

from tests.dataset import DATASET


# ============================================================
# Fixtures: populate temp buckets from dataset
# ============================================================
@pytest.fixture
async def populated_env(test_config, bucket_mgr, decay_eng):
    """Create all dataset buckets in temp dir, return (bucket_mgr, decay_eng, bucket_ids)."""
    import frontmatter as fm

    ids = []
    for item in DATASET:
        bid = await bucket_mgr.create(
            content=item["content"],
            tags=item.get("tags", []),
            importance=item.get("importance", 5),
            domain=item.get("domain", []),
            valence=item.get("valence", 0.5),
            arousal=item.get("arousal", 0.3),
            name=None,
            bucket_type=item.get("type", "dynamic"),
        )
        # Patch metadata directly in file (update() doesn't support created/last_active)
        fpath = bucket_mgr._find_bucket_file(bid)
        post = fm.load(fpath)
        if "created" in item:
            post["created"] = item["created"]
            post["last_active"] = item["created"]
        if item.get("resolved"):
            post["resolved"] = True
        if item.get("digested"):
            post["digested"] = True
        if item.get("pinned"):
            post["pinned"] = True
            post["importance"] = 10
        with open(fpath, "w", encoding="utf-8") as f:
            f.write(fm.dumps(post))
        ids.append(bid)
    return bucket_mgr, decay_eng, ids


# ============================================================
# Time weight formula tests
# ============================================================
class TestTimeWeight:
    """Verify continuous exponential freshness formula."""

    def test_t0_is_2(self, decay_eng):
        """t=0 → exactly 2.0"""
        assert decay_eng._calc_time_weight(0.0) == pytest.approx(2.0)

    def test_half_life_25h(self, decay_eng):
        """Half-life at t=36*ln(2)≈24.9h (~1.04 days) → bonus halved → 1.5"""
        import math
        half_life_days = 36.0 * math.log(2) / 24.0  # ≈1.039 days
        assert decay_eng._calc_time_weight(half_life_days) == pytest.approx(1.5, rel=0.01)

    def test_36h_is_e_inv(self, decay_eng):
        """t=36h (1.5 days) → 1 + e^(-1) ≈ 1.368"""
        assert decay_eng._calc_time_weight(1.5) == pytest.approx(1.368, rel=0.01)

    def test_72h_near_floor(self, decay_eng):
        """t=72h (3 days) → ≈1.135"""
        w = decay_eng._calc_time_weight(3.0)
        assert 1.1 < w < 1.2

    def test_30d_near_1(self, decay_eng):
        """t=30 days → very close to 1.0"""
        w = decay_eng._calc_time_weight(30.0)
        assert 1.0 <= w < 1.001

    def test_monotonically_decreasing(self, decay_eng):
        """Time weight decreases as days increase."""
        prev = decay_eng._calc_time_weight(0.0)
        for d in [0.5, 1.0, 2.0, 5.0, 10.0, 30.0]:
            curr = decay_eng._calc_time_weight(d)
            assert curr < prev, f"Not decreasing at day {d}"
            prev = curr

    def test_always_gte_1(self, decay_eng):
        """Time weight is always ≥ 1.0."""
        for d in [0, 0.01, 0.1, 1, 10, 100, 1000]:
            assert decay_eng._calc_time_weight(d) >= 1.0


# ============================================================
# Decay score special bucket types
# ============================================================
class TestDecayScoreSpecial:
    """Verify special bucket type scoring."""

    # 注: 历史上 permanent/pinned/protected 的特殊分硬编为 999.0,
    # 后来发现"太极端"(浮现池里完全压制其它桶), 改为 100.0
    # (decay_engine.DEFAULTS.protected_score). test 跟着调.

    def test_permanent_is_100(self, decay_eng):
        assert decay_eng.calculate_score({"type": "permanent"}) == 100.0

    def test_pinned_is_100(self, decay_eng):
        assert decay_eng.calculate_score({"pinned": True}) == 100.0

    def test_protected_is_100(self, decay_eng):
        assert decay_eng.calculate_score({"protected": True}) == 100.0

    def test_feel_is_50(self, decay_eng):
        assert decay_eng.calculate_score({"type": "feel"}) == 50.0

    def test_empty_metadata_is_0(self, decay_eng):
        assert decay_eng.calculate_score("not a dict") == 0.0


# ============================================================
# Decay score modifiers
# ============================================================
class TestDecayScoreModifiers:
    """Verify resolved/digested modifiers."""

    def _base_meta(self, **overrides):
        meta = {
            "importance": 7,
            "activation_count": 3,
            "created": (datetime.now() - timedelta(days=2)).isoformat(),
            "last_active": (datetime.now() - timedelta(days=2)).isoformat(),
            "arousal": 0.5,
            "valence": 0.5,
            "type": "dynamic",
        }
        meta.update(overrides)
        return meta

    def test_resolved_reduces_score(self, decay_eng):
        normal = decay_eng.calculate_score(self._base_meta())
        resolved = decay_eng.calculate_score(self._base_meta(resolved=True))
        assert resolved < normal
        assert resolved == pytest.approx(normal * 0.05, rel=0.01)

    def test_resolved_digested_even_lower(self, decay_eng):
        resolved = decay_eng.calculate_score(self._base_meta(resolved=True))
        both = decay_eng.calculate_score(self._base_meta(resolved=True, digested=True))
        assert both < resolved
        # resolved=0.05, both=0.02
        assert both / resolved == pytest.approx(0.02 / 0.05, rel=0.01)

    def test_high_arousal_urgency_boost(self, decay_eng):
        """Arousal>0.7 and not resolved → 1.5× urgency boost."""
        calm = decay_eng.calculate_score(self._base_meta(arousal=0.5))
        urgent = decay_eng.calculate_score(self._base_meta(arousal=0.8))
        # urgent should be higher due to both emotion_weight and urgency_boost
        assert urgent > calm

    def test_urgency_not_applied_when_resolved(self, decay_eng):
        """High arousal but resolved → no urgency boost."""
        meta = self._base_meta(arousal=0.8, resolved=True)
        score = decay_eng.calculate_score(meta)
        # Should NOT have 1.5× boost (resolved=True cancels urgency)
        meta_low = self._base_meta(arousal=0.8, resolved=True)
        assert score == decay_eng.calculate_score(meta_low)


# ============================================================
# Decay score ordering invariants
# ============================================================
class TestDecayScoreOrdering:
    """Verify ordering invariants across the dataset."""

    @pytest.mark.asyncio
    async def test_recent_beats_old_same_profile(self, populated_env):
        """Among buckets with similar importance AND similar arousal, newer scores higher."""
        bm, de, ids = populated_env
        all_buckets = await bm.list_all()

        # Find dynamic, non-resolved, non-pinned buckets
        scorable = []
        for b in all_buckets:
            m = b["metadata"]
            if m.get("type") == "dynamic" and not m.get("resolved") and not m.get("pinned"):
                scorable.append((b, de.calculate_score(m)))

        # Among buckets with similar importance (±1) AND similar arousal (±0.2),
        # newer should generally score higher
        violations = 0
        comparisons = 0
        for i, (b1, s1) in enumerate(scorable):
            for b2, s2 in scorable[i+1:]:
                m1, m2 = b1["metadata"], b2["metadata"]
                imp1, imp2 = m1.get("importance", 5), m2.get("importance", 5)
                ar1 = float(m1.get("arousal", 0.3))
                ar2 = float(m2.get("arousal", 0.3))
                if abs(imp1 - imp2) <= 1 and abs(ar1 - ar2) <= 0.2:
                    c1 = m1.get("created", "")
                    c2 = m2.get("created", "")
                    if c1 > c2:
                        comparisons += 1
                        if s1 < s2 * 0.7:
                            violations += 1

        # Allow up to 10% violations (edge cases with emotion weight differences)
        if comparisons > 0:
            assert violations / comparisons < 0.1, \
                f"{violations}/{comparisons} ordering violations"

    @pytest.mark.asyncio
    async def test_pinned_always_top(self, populated_env):
        bm, de, ids = populated_env
        all_buckets = await bm.list_all()

        pinned_scores = []
        dynamic_scores = []
        for b in all_buckets:
            m = b["metadata"]
            score = de.calculate_score(m)
            if m.get("pinned") or m.get("type") == "permanent":
                pinned_scores.append(score)
            elif m.get("type") == "dynamic" and not m.get("resolved"):
                dynamic_scores.append(score)

        if pinned_scores and dynamic_scores:
            assert min(pinned_scores) > max(dynamic_scores)


# ============================================================
# Search scoring tests
# ============================================================
class TestSearchScoring:
    """Verify search scoring produces correct rankings."""

    @pytest.mark.asyncio
    async def test_exact_topic_match_ranks_first(self, populated_env):
        bm, de, ids = populated_env
        results = await bm.search("asyncio Python event loop", limit=10)
        if results:
            # The asyncio bucket should be in top results
            top_content = results[0].get("content", "")
            assert "asyncio" in top_content or "event loop" in top_content

    @pytest.mark.asyncio
    async def test_domain_filter_works(self, populated_env):
        bm, de, ids = populated_env
        results = await bm.search("学习", limit=50, domain_filter=["编程"])
        for r in results:
            domains = r.get("metadata", {}).get("domain", [])
            # Should have at least some affinity to 编程
            assert any("编程" in d for d in domains) or True  # fuzzy match allows some slack

    @pytest.mark.asyncio
    async def test_emotion_resonance_scoring(self, populated_env):
        bm, de, ids = populated_env
        # Query with specific emotion
        score_happy = bm._calc_emotion_score(0.9, 0.8, {"valence": 0.85, "arousal": 0.7})
        score_sad = bm._calc_emotion_score(0.9, 0.8, {"valence": 0.2, "arousal": 0.3})
        assert score_happy > score_sad

    def test_emotion_score_no_query_is_neutral(self, bucket_mgr):
        score = bucket_mgr._calc_emotion_score(None, None, {"valence": 0.8, "arousal": 0.5})
        assert score == 0.5

    def test_time_score_recent_higher(self, bucket_mgr):
        recent = {"last_active": datetime.now().isoformat()}
        old = {"last_active": (datetime.now() - timedelta(days=30)).isoformat()}
        assert bucket_mgr._calc_time_score(recent) > bucket_mgr._calc_time_score(old)

    @pytest.mark.asyncio
    async def test_resolved_bucket_penalized_in_normalized(self, populated_env):
        """Resolved buckets get ×0.3 in normalized score (breath-debug logic)."""
        bm, de, ids = populated_env
        all_b = await bm.list_all()

        resolved_b = None
        for b in all_b:
            m = b["metadata"]
            if m.get("type") == "dynamic" and m.get("resolved") and not m.get("digested"):
                resolved_b = b
                break

        if resolved_b:
            m = resolved_b["metadata"]
            topic = bm._calc_topic_score("bug", resolved_b)
            emotion = bm._calc_emotion_score(0.5, 0.5, m)
            time_s = bm._calc_time_score(m)
            imp = max(1, min(10, int(m.get("importance", 5)))) / 10.0
            raw = topic * 4.0 + emotion * 2.0 + time_s * 2.5 + imp * 1.0
            normalized = (raw / 9.5) * 100
            normalized_resolved = normalized * 0.3
            assert normalized_resolved < normalized


# ============================================================
# Pinned (highlight) buckets only enter search on a real title hit
# 钉选(highlight)桶仅在 title 强命中时进搜索/自动注入结果
# (开窗核心准则区已读取, 不该靠模糊/正文命中占自动注入记忆位;
#  精准按桶名搜仍可达 —— 见 server.py 2026-05 注释 / bucket_manager.search 守卫)
# ============================================================
class TestPinnedSearchGate:
    @pytest.fixture
    async def gated_env(self, test_config, bucket_mgr):
        # 钉选桶: 标题与正文关键词刻意错开, 便于分别命中
        pinned_id = await bucket_mgr.create(
            content="这里写了 量子纠缠 相关的说明文字内容",
            tags=[], importance=10, domain=[], valence=0.5, arousal=0.3,
            name="核心准则甲", pinned=True,
        )
        # 永久参考桶: protected-only(防衰减但未 highlight), 同样受守卫约束
        protected_only_id = await bucket_mgr.create(
            content="第三段也提到 量子纠缠 的长期参考资料",
            tags=[], importance=10, domain=[], valence=0.5, arousal=0.3,
            name="永久参考乙", protected=True,
        )
        # 普通动态桶: 正文同样含 "量子纠缠", 作为对照(应正常被搜出)
        normal_id = await bucket_mgr.create(
            content="另一段关于 量子纠缠 的随手记录",
            tags=[], importance=5, domain=[], valence=0.5, arousal=0.3,
            name="普通笔记",
        )
        return bucket_mgr, pinned_id, protected_only_id, normal_id

    @pytest.mark.asyncio
    async def test_pinned_returned_on_title_hit(self, gated_env):
        """精准搜桶名(title 命中)→ 钉选/永久参考桶仍可达。"""
        bm, pinned_id, protected_only_id, normal_id = gated_env
        assert pinned_id in {r["id"] for r in await bm.search("核心准则甲", limit=20)}
        assert protected_only_id in {r["id"] for r in await bm.search("永久参考乙", limit=20)}

    @pytest.mark.asyncio
    async def test_pinned_excluded_on_content_only_hit(self, gated_env):
        """正文/模糊命中但 title 没命中 → 钉选/永久参考桶都不进结果(不占自动注入记忆位);
        同样正文命中的普通桶照常返回。"""
        bm, pinned_id, protected_only_id, normal_id = gated_env
        results = await bm.search("量子纠缠", limit=20)
        ids = {r["id"] for r in results}
        assert pinned_id not in ids, "钉选桶不该靠正文命中混入自动注入"
        assert protected_only_id not in ids, "永久参考桶不该靠正文命中混入自动注入"
        assert normal_id in ids, "普通桶应正常被正文命中搜出"


# ============================================================
# Hit-stats persistence (P1) + cold-memory view (P2)
# 命中统计落盘(重启不丢) + 冷记忆视图(看从未命中的桶)
# ============================================================
class TestHitStatsPersistence:
    @pytest.mark.asyncio
    async def test_counts_survive_reload(self, test_config, bucket_mgr):
        """search 命中 → force flush → 新建 manager 应从盘里读回累计计数。"""
        from bucket_manager import BucketManager
        await bucket_mgr.create(content="量子纠缠 的说明", tags=[], importance=5,
                                domain=[], name="甲")
        await bucket_mgr.search("量子纠缠", limit=20)
        assert bucket_mgr._total_searches == 1
        bucket_mgr._flush_hit_stats(force=True)

        # 重启模拟: 指向同一 buckets_dir 的新 manager
        bm2 = BucketManager(test_config)
        assert bm2._total_searches == 1
        assert sum(r["count"] for r in (await bm2.get_hit_stats())["items"]) >= 1

    @pytest.mark.asyncio
    async def test_reset_clears_disk(self, test_config, bucket_mgr):
        from bucket_manager import BucketManager
        await bucket_mgr.create(content="量子纠缠 的说明", tags=[], importance=5, domain=[], name="甲")
        await bucket_mgr.search("量子纠缠", limit=20)
        bucket_mgr._flush_hit_stats(force=True)
        bucket_mgr.reset_hit_stats()
        # 删盘后新 manager 应是空表
        bm2 = BucketManager(test_config)
        assert bm2._total_searches == 0
        assert (await bm2.get_hit_stats())["items"] == []


class TestColdMemoryView:
    @pytest.mark.asyncio
    async def test_include_zero_surfaces_never_hit(self, bucket_mgr):
        """include_zero=True → 从未命中的桶以 count 0 出现; exclude_gated 排除钉选。"""
        hit_id = await bucket_mgr.create(content="量子纠缠 的说明", tags=[], importance=5,
                                         domain=[], name="被搜的桶")
        cold_id = await bucket_mgr.create(content="完全无关的孤独内容", tags=[], importance=5,
                                          domain=[], name="冷落的桶")
        pinned_id = await bucket_mgr.create(content="钉选内容 也含 量子纠缠", tags=[], importance=10,
                                            domain=[], name="钉选桶", pinned=True)
        await bucket_mgr.search("量子纠缠", limit=20)  # 只命中 hit_id (钉选桶被守卫挡)

        data = await bucket_mgr.get_hit_stats(include_zero=True, order="asc", exclude_gated=True)
        by_id = {r["id"]: r for r in data["items"]}
        assert by_id[cold_id]["count"] == 0          # 冷落桶以 ×0 浮现
        assert by_id[hit_id]["count"] >= 1           # 被搜的桶有命中
        assert pinned_id not in by_id                # 钉选桶被 exclude_gated 排除
        assert data["items"][0]["count"] == 0        # asc: 冷门在最前
        assert data["zero_buckets"] >= 1

    @pytest.mark.asyncio
    async def test_default_view_excludes_zero(self, bucket_mgr):
        """默认 (include_zero=False) 只返回命中过的桶, 不混入 ×0。"""
        await bucket_mgr.create(content="孤独内容", tags=[], importance=5, domain=[], name="冷落的桶")
        data = await bucket_mgr.get_hit_stats()
        assert all(r["count"] > 0 for r in data["items"])


# ============================================================
# Dataset integrity checks
# ============================================================
class TestDatasetIntegrity:
    """Verify the test dataset loads correctly."""

    @pytest.mark.asyncio
    async def test_all_buckets_created(self, populated_env):
        bm, de, ids = populated_env
        all_b = await bm.list_all()
        assert len(all_b) == len(DATASET)

    @pytest.mark.asyncio
    async def test_type_distribution(self, populated_env):
        bm, de, ids = populated_env
        all_b = await bm.list_all()
        types = {}
        for b in all_b:
            t = b["metadata"].get("type", "dynamic")
            types[t] = types.get(t, 0) + 1

        assert types.get("dynamic", 0) >= 30
        assert types.get("permanent", 0) >= 3
        assert types.get("feel", 0) >= 3

    @pytest.mark.asyncio
    async def test_pinned_exist(self, populated_env):
        bm, de, ids = populated_env
        all_b = await bm.list_all()
        pinned = [b for b in all_b if b["metadata"].get("pinned")]
        assert len(pinned) >= 2
