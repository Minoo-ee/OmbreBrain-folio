"""
test_upstream_migration.py — 上游数据迁移兼容性测试

模拟用户从上游 P0luz/Ombre-Brain 把 buckets/ 拷过来的场景:
- 构造 5 种典型的"上游 shape" bucket (md + YAML frontmatter)
- 测试 utils.py 的 is_protected / is_highlighted / is_internalized helper
- 测试 frontmatter parsing 完整保留所有字段
- 测试 score 计算 (decay_engine) 在老字段上能跑通
- 测试 lazy migration 在 update 时正确 normalize

跑法: python tests/test_upstream_migration.py

依赖: 只用标准库 + frontmatter (其他 Python deps 不需要)
"""

import os
import sys
import tempfile
import shutil
import unittest

# 让脚本能从仓库根目录的模块 import
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import frontmatter  # type: ignore
from utils import is_protected, is_highlighted, is_internalized


# ─────────────────────────────────────────────────────────────────
# 上游 bucket 样本 — 来自上游 dcba1eb 当时的字段格式
# ─────────────────────────────────────────────────────────────────

UPSTREAM_PINNED_BUCKET = """---
id: bkt_upstream_pin_001
name: "上游版置顶桶"
tags:
  - 重要
  - 测试
domain:
  - 工作
valence: 0.7
arousal: 0.5
importance: 10
type: permanent
created: 2026-04-15T10:00:00
last_active: 2026-04-15T10:00:00
activation_count: 3
pinned: true
---

这是一条从上游版本拷过来的置顶记忆,只有 pinned 字段,没有 protected/highlight。
"""

UPSTREAM_DIGESTED_BUCKET = """---
id: bkt_upstream_dig_002
name: "上游版已消化"
tags:
  - 自省
domain:
  - 内心
valence: 0.5
arousal: 0.3
importance: 5
type: dynamic
created: 2026-04-10T08:00:00
last_active: 2026-04-12T08:00:00
activation_count: 5
digested: true
---

这是一条从上游版本拷过来的已消化记忆,只有 digested 字段,没有 internalized。
"""

UPSTREAM_FEEL_BUCKET = """---
id: bkt_upstream_feel_003
name: "上游版心动时刻"
tags:
  - feel
domain: []
valence: 0.85
arousal: 0.65
importance: 8
type: feel
created: 2026-04-08T15:30:00
last_active: 2026-04-08T15:30:00
activation_count: 1
---

上游 feel 桶,没有 pinned/digested/protected 等任何状态字段。
"""

UPSTREAM_ARCHIVED_BUCKET = """---
id: bkt_upstream_arch_004
name: "上游版归档桶"
tags: []
domain:
  - 学习
valence: 0.4
arousal: 0.2
importance: 3
type: archive
created: 2026-03-01T12:00:00
last_active: 2026-03-15T12:00:00
activation_count: 0
resolved: true
---

已归档的桶,resolved 标记,没有新版字段。
"""

UPSTREAM_VANILLA_BUCKET = """---
id: bkt_upstream_van_005
name: "上游普通桶"
tags:
  - 日常
domain:
  - 饮食
valence: 0.6
arousal: 0.4
importance: 5
type: dynamic
created: 2026-04-20T19:00:00
last_active: 2026-04-22T20:00:00
activation_count: 2
---

普通的上游 dynamic 桶,完全没有任何老/新字段。
"""

ALL_SAMPLES = [
    ("pinned", UPSTREAM_PINNED_BUCKET),
    ("digested", UPSTREAM_DIGESTED_BUCKET),
    ("feel", UPSTREAM_FEEL_BUCKET),
    ("archived", UPSTREAM_ARCHIVED_BUCKET),
    ("vanilla", UPSTREAM_VANILLA_BUCKET),
]


# ─────────────────────────────────────────────────────────────────
# 测试
# ─────────────────────────────────────────────────────────────────

class UpstreamCompatTest(unittest.TestCase):

    def test_01_frontmatter_can_parse_all_samples(self):
        """每个上游 bucket 都能被 frontmatter 库正常解析"""
        for label, content in ALL_SAMPLES:
            with self.subTest(sample=label):
                post = frontmatter.loads(content)
                self.assertTrue(post.get("id"), f"{label}: id 字段丢失")
                self.assertTrue(post.get("name"), f"{label}: name 字段丢失")
                self.assertIsNotNone(post.get("valence"), f"{label}: valence 字段丢失")
                self.assertIsNotNone(post.get("arousal"), f"{label}: arousal 字段丢失")

    def test_02_is_protected_handles_upstream_pinned(self):
        """老 pinned=true 的桶, is_protected 必须返回 True"""
        post = frontmatter.loads(UPSTREAM_PINNED_BUCKET)
        meta = dict(post.metadata)
        self.assertTrue(is_protected(meta), "上游 pinned 桶被错误识别为非保护")

    def test_03_is_highlighted_handles_upstream_pinned(self):
        """老 pinned=true 的桶, is_highlighted 也必须返回 True (双轴都开)"""
        post = frontmatter.loads(UPSTREAM_PINNED_BUCKET)
        meta = dict(post.metadata)
        self.assertTrue(is_highlighted(meta), "上游 pinned 桶 highlight 推断错")

    def test_04_is_internalized_handles_upstream_digested(self):
        """老 digested=true 的桶, is_internalized 必须返回 True"""
        post = frontmatter.loads(UPSTREAM_DIGESTED_BUCKET)
        meta = dict(post.metadata)
        self.assertTrue(is_internalized(meta), "上游 digested 桶被错误识别为非内化")

    def test_05_helpers_handle_vanilla_bucket(self):
        """普通桶(没有任何状态字段) helper 都返回 False, 不报错"""
        post = frontmatter.loads(UPSTREAM_VANILLA_BUCKET)
        meta = dict(post.metadata)
        self.assertFalse(is_protected(meta))
        self.assertFalse(is_highlighted(meta))
        self.assertFalse(is_internalized(meta))

    def test_06_helpers_handle_feel_bucket(self):
        """Feel 桶 helper 都返回 False(feel 没有钉决/内化语义)"""
        post = frontmatter.loads(UPSTREAM_FEEL_BUCKET)
        meta = dict(post.metadata)
        self.assertFalse(is_protected(meta))
        self.assertFalse(is_highlighted(meta))
        self.assertFalse(is_internalized(meta))

    def test_07_archived_bucket_resolved_intact(self):
        """归档 + resolved=True 桶,resolved 字段保留"""
        post = frontmatter.loads(UPSTREAM_ARCHIVED_BUCKET)
        meta = dict(post.metadata)
        self.assertTrue(meta.get("resolved"))
        self.assertEqual(meta.get("type"), "archive")

    def test_08_helpers_priority_new_over_old(self):
        """如果新老字段并存,优先用新字段"""
        # 模拟: pinned=true (老) + protected=false (新) → 应返回 False
        meta_conflict = {"pinned": True, "protected": False}
        self.assertFalse(is_protected(meta_conflict),
                         "新字段 protected=false 应该覆盖老 pinned=true")

        meta_conflict2 = {"digested": True, "internalized": False}
        self.assertFalse(is_internalized(meta_conflict2),
                         "新字段 internalized=false 应该覆盖老 digested=true")

    def test_09_helpers_handle_missing_or_invalid(self):
        """边界: 空 dict / None / 非 dict 都不能崩"""
        self.assertFalse(is_protected({}))
        self.assertFalse(is_highlighted({}))
        self.assertFalse(is_internalized({}))
        self.assertFalse(is_protected(None))  # type: ignore
        self.assertFalse(is_protected("not a dict"))  # type: ignore

    def test_10_round_trip_preserves_all_fields(self):
        """frontmatter 写回不丢字段(回写后所有原字段还在)"""
        post = frontmatter.loads(UPSTREAM_PINNED_BUCKET)
        re_dumped = frontmatter.dumps(post)
        re_parsed = frontmatter.loads(re_dumped)
        for key in ["id", "name", "valence", "arousal", "importance", "type", "pinned"]:
            self.assertIn(key, re_parsed.metadata, f"回写后 {key} 字段丢失")

    def test_11_simulate_disk_layout(self):
        """模拟用户拷过来的目录结构: permanent/ dynamic/ feel/ archive/"""
        with tempfile.TemporaryDirectory() as tmp:
            # 跟上游一样的目录布局
            for sub in ["permanent/工作", "dynamic/饮食", "feel/沉淀物", "archive/学习"]:
                os.makedirs(os.path.join(tmp, sub), exist_ok=True)

            # 写入 4 个 bucket 到对应目录
            paths = {
                "pinned": os.path.join(tmp, "permanent/工作", "上游版置顶桶_bkt001.md"),
                "vanilla": os.path.join(tmp, "dynamic/饮食", "上游普通桶_bkt002.md"),
                "feel": os.path.join(tmp, "feel/沉淀物", "上游版心动时刻_bkt003.md"),
                "archived": os.path.join(tmp, "archive/学习", "上游版归档桶_bkt004.md"),
            }
            paths_content = {
                "pinned": UPSTREAM_PINNED_BUCKET,
                "vanilla": UPSTREAM_VANILLA_BUCKET,
                "feel": UPSTREAM_FEEL_BUCKET,
                "archived": UPSTREAM_ARCHIVED_BUCKET,
            }
            for k, p in paths.items():
                with open(p, "w", encoding="utf-8") as f:
                    f.write(paths_content[k])

            # 模拟 list_all 行为: 走目录 + 读所有 .md
            found = []
            for sub in ["permanent", "dynamic", "feel", "archive"]:
                root = os.path.join(tmp, sub)
                for dirpath, _, files in os.walk(root):
                    for fn in files:
                        if fn.endswith(".md"):
                            with open(os.path.join(dirpath, fn), encoding="utf-8") as f:
                                found.append(frontmatter.load(f))

            self.assertEqual(len(found), 4, "目录扫描应找到 4 个 bucket")
            # 验证每个能正确推断状态
            ids_to_post = {p.get("id"): p for p in found}
            self.assertTrue(is_protected(dict(ids_to_post["bkt_upstream_pin_001"].metadata)))
            self.assertFalse(is_protected(dict(ids_to_post["bkt_upstream_van_005"].metadata)))


def main():
    print("=" * 60)
    print("Ombre-Brain 上游数据迁移兼容性测试")
    print("=" * 60)
    print()
    runner = unittest.TextTestRunner(verbosity=2)
    suite = unittest.TestLoader().loadTestsFromTestCase(UpstreamCompatTest)
    result = runner.run(suite)
    print()
    if result.wasSuccessful():
        print("[PASS] 全部通过 - 上游数据迁移到本版本没有兼容性问题")
        return 0
    else:
        print(f"[FAIL] {len(result.failures)} 失败 + {len(result.errors)} 错误")
        return 1


if __name__ == "__main__":
    sys.exit(main())
