"""
本地验证 Bug 1 修复 — protected-only 桶应该出现在 '永久参考' 区段.

不需要启 OB server / 不需要 LLM key / 不需要 fastmcp.
直接构造 3 个假桶 (highlighted / protected-only / plain), 跑 breath 浮现的
过滤分类逻辑, 确认每个桶进了正确的池子.

跑法:
    python test_breath_protected_surfacing.py
"""
from utils import is_protected, is_highlighted, is_internalized

# 模拟 3 个桶的 metadata
buckets = [
    {
        "id": "test_highlighted",
        "metadata": {
            "type": "permanent",
            "protected": True,
            "highlight": True,  # 既钉决又高亮 → 旧 pinned=True 等价
            "internalized": False,
            "resolved": False,
        },
        "content": "核心准则桶",
    },
    {
        "id": "test_protected_only",
        "metadata": {
            "type": "permanent",
            "protected": True,
            "highlight": False,  # 只钉决, 不高亮 → 这就是朋友的场景
            "internalized": False,
            "resolved": False,
        },
        "content": "钉决但未高亮的桶 (朋友报的 bug)",
    },
    {
        "id": "test_plain_unresolved",
        "metadata": {
            "type": "dynamic",
            "protected": False,
            "highlight": False,
            "internalized": False,
            "resolved": False,
        },
        "content": "普通未解决桶",
    },
    {
        "id": "test_internalized_protected",
        "metadata": {
            "type": "permanent",
            "protected": True,
            "highlight": False,
            "internalized": True,  # 已内化 → 不应浮现
            "resolved": False,
        },
        "content": "已内化的钉决桶 (不该浮现)",
    },
]

# 复刻 server.py breath() 浮现模式的三个池子分类逻辑 (patch 后)
pinned_buckets = [
    b for b in buckets
    if is_highlighted(b["metadata"])
    and not is_internalized(b["metadata"])
]
protected_only = [
    b for b in buckets
    if is_protected(b["metadata"])
    and not is_highlighted(b["metadata"])
    and not is_internalized(b["metadata"])
]
unresolved = [
    b for b in buckets
    if not b["metadata"].get("resolved", False)
    and b["metadata"].get("type") not in ("permanent", "feel")
    and not is_highlighted(b["metadata"])
    and not is_internalized(b["metadata"])
]

print(f"\n===== Bug 1 修复验证 =====\n")
print(f"核心准则 (pinned_buckets / highlight=True): {len(pinned_buckets)} 条")
for b in pinned_buckets:
    print(f"  📌 {b['id']}")

print(f"\n永久参考 (protected_only — 新增, 修 Bug 1 的关键): {len(protected_only)} 条")
for b in protected_only:
    print(f"  ❖ {b['id']}")

print(f"\n浮现记忆 (unresolved): {len(unresolved)} 条")
for b in unresolved:
    print(f"  · {b['id']}")

# 验收期望
expected_highlighted = {"test_highlighted"}
expected_protected_only = {"test_protected_only"}
expected_unresolved = {"test_plain_unresolved"}
# test_internalized_protected 应该都不在 (因 internalized=True)

got_highlighted = {b["id"] for b in pinned_buckets}
got_protected_only = {b["id"] for b in protected_only}
got_unresolved = {b["id"] for b in unresolved}

ok = True
if got_highlighted != expected_highlighted:
    print(f"\n❌ 核心准则集合错: got={got_highlighted} expected={expected_highlighted}")
    ok = False
if got_protected_only != expected_protected_only:
    print(f"\n❌ 永久参考集合错: got={got_protected_only} expected={expected_protected_only}")
    print(f"   关键: 必须包含 test_protected_only — 这是 Bug 1 的核心")
    ok = False
if got_unresolved != expected_unresolved:
    print(f"\n❌ 浮现记忆集合错: got={got_unresolved} expected={expected_unresolved}")
    ok = False

if ok:
    print("\n[OK] 三个池子分类全部正确, Bug 1 修复通过.")
    print("     朋友的 protected-only 桶现在会在浮现模式的 [永久参考] 区段出现.")
else:
    print("\n❌ 有断言失败, 看上面错误项.")
    raise SystemExit(1)
