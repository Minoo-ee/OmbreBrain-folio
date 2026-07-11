"""HTTP 冒烟测试 — 验证已部署的 Ombre-Brain 实例端到端可用

用法:
    python tests/test_http_smoke.py                          # 本地默认 http://127.0.0.1:8000
    python tests/test_http_smoke.py --base-url URL          # 远端
    python tests/test_http_smoke.py --quick                 # 跳过创建/更新/删除等写操作

跑过的端点覆盖了前端依赖的全部主链路。任何一项 FAIL 就退出非 0,
适合发版前手动跑一遍 / 接进 CI / 朋友本地装好后跑一次自检。

注意: 测试桶 name 永远以 "__SMOKE_TEST_" 开头, 失败也能被识别清理。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
import urllib.error
from typing import Any


SMOKE_TAG = "__SMOKE_TEST_"


# ── 简单 HTTP client (stdlib, 零依赖) ─────────────────────────────
def _request(method: str, url: str, body: dict | None = None, timeout: int = 30) -> tuple[int, Any]:
    """Returns (status_code, parsed_json_or_text). Never raises on HTTP 4xx/5xx."""
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            text = raw.decode("utf-8", errors="replace")
            try:
                return resp.status, json.loads(text)
            except json.JSONDecodeError:
                return resp.status, text
    except urllib.error.HTTPError as e:
        raw = e.read() if e.fp else b""
        text = raw.decode("utf-8", errors="replace") if raw else ""
        try:
            return e.code, json.loads(text)
        except (json.JSONDecodeError, ValueError):
            return e.code, text or str(e)
    except urllib.error.URLError as e:
        return 0, f"URLError: {e.reason}"
    except Exception as e:
        return 0, f"{type(e).__name__}: {e}"


# ── 单个 check 的辅助 ──────────────────────────────────────────────
class Result:
    def __init__(self):
        self.passed: list[str] = []
        self.failed: list[tuple[str, str]] = []
        self.skipped: list[str] = []

    def ok(self, name: str):
        self.passed.append(name)
        print(f"  \033[32m[OK]\033[0m {name}")

    def fail(self, name: str, reason: str):
        self.failed.append((name, reason))
        print(f"  \033[31m[FAIL]\033[0m {name}  →  {reason}")

    def skip(self, name: str, reason: str = ""):
        self.skipped.append(name)
        msg = f"  \033[33m[SKIP]\033[0m {name}"
        if reason:
            msg += f"  →  {reason}"
        print(msg)


def section(title: str):
    print(f"\n\033[36m▌ {title}\033[0m")


# ── 各检查项 ──────────────────────────────────────────────────────
def check_health(base: str, r: Result):
    section("1. /health 基础存活")
    code, data = _request("GET", f"{base}/health")
    if code == 200:
        r.ok(f"GET /health  → 200 ({data!r:.80})")
    else:
        r.fail("GET /health", f"status={code} body={data!r:.200}")
        # health 挂掉后续大概率全挂, 直接放弃后续以免误报
        print("\n\033[31m⨯ /health 挂掉, 服务器没起来 / URL 错 / 网络不通\033[0m")
        sys.exit(1)


def check_list(base: str, r: Result):
    section("2. /api/buckets 列表 (前端首屏)")
    code, data = _request("GET", f"{base}/api/buckets")
    if code != 200:
        r.fail("GET /api/buckets", f"status={code}")
        return
    if not isinstance(data, list):
        r.fail("GET /api/buckets", f"应返回 array, 实际 {type(data).__name__}")
        return
    r.ok(f"GET /api/buckets  → {len(data)} 条")

    # 抽查 metadata 形状 (空数据时跳过)
    if data:
        sample = data[0]
        for k in ("id", "summary"):
            if k not in sample:
                r.fail("buckets[0] shape", f"缺字段 {k}")
                return
        r.ok("buckets[0] 字段完整 (id, summary)")


def check_network(base: str, r: Result):
    section("3. /api/network 星图数据")
    code, data = _request("GET", f"{base}/api/network")
    if code != 200:
        r.fail("GET /api/network", f"status={code}")
        return
    if not isinstance(data, dict) or "nodes" not in data or "links" not in data:
        r.fail("GET /api/network", f"应返回 {{nodes, links}}, 实际 keys={list(data) if isinstance(data, dict) else type(data).__name__}")
        return
    r.ok(f"GET /api/network  → {len(data['nodes'])} 节点 / {len(data['links'])} 连线")


def check_breath_debug(base: str, r: Result):
    section("4. /api/breath-debug 主动生态")
    code, data = _request("GET", f"{base}/api/breath-debug")
    if code != 200:
        r.fail("GET /api/breath-debug", f"status={code}")
        return
    r.ok("GET /api/breath-debug  → 200")


def check_decay_config(base: str, r: Result):
    section("5. /api/decay-config 衰减配置")
    code, data = _request("GET", f"{base}/api/decay-config")
    if code != 200:
        r.fail("GET /api/decay-config", f"status={code}")
        return
    if not isinstance(data, dict):
        r.fail("GET /api/decay-config", "应返回 object")
        return
    r.ok(f"GET /api/decay-config  → {len(data)} keys")


def check_embeddings(base: str, r: Result):
    section("6. /api/embeddings/diagnose 向量系统")
    code, data = _request("GET", f"{base}/api/embeddings/diagnose")
    if code != 200:
        r.fail("GET /api/embeddings/diagnose", f"status={code}")
        return
    # 不强制 enabled, 只要返回正常报告即可 (允许用户没配 Gemini key)
    if isinstance(data, dict) and data.get("enabled") is False:
        r.skip("embeddings 未启用", "未配 Gemini API key, 向量搜索不可用 (可选功能)")
    else:
        r.ok(f"GET /api/embeddings/diagnose  → enabled={isinstance(data, dict) and data.get('enabled')}")


def check_trash(base: str, r: Result):
    section("7. /api/trash 回收站")
    code, data = _request("GET", f"{base}/api/trash")
    if code != 200:
        r.fail("GET /api/trash", f"status={code}")
        return
    # /api/trash 形状可能是 list 或 {buckets: [...]}, 都 OK
    count = len(data) if isinstance(data, list) else len(data.get("buckets", [])) if isinstance(data, dict) else 0
    r.ok(f"GET /api/trash  → {count} 条")


def check_crud_lifecycle(base: str, r: Result) -> str | None:
    """完整 create → read → update → archive → restore → purge 链路。返回创建的 bucket id (用于异常清理)"""
    section("8. CRUD 全链路 (create → update → archive → restore → purge)")
    bid = None

    # 8.1 create
    marker = f"{SMOKE_TAG}{int(time.time())}"
    payload = {
        "content": f"This is a smoke test bucket created at {time.strftime('%Y-%m-%d %H:%M:%S')}. Safe to delete.",
        "name": marker,
        "tags": ["smoke-test"],
        "domain": ["测试"],
        "importance": 3,
        "valence": 0.5,
        "arousal": 0.3,
    }
    code, data = _request("POST", f"{base}/api/bucket/create", body=payload)
    if code != 200 or not isinstance(data, dict) or not data.get("id"):
        r.fail("POST /api/bucket/create", f"status={code} body={data!r:.200}")
        return None
    bid = data["id"]
    r.ok(f"create  → id={bid}")

    # 8.2 read back
    code, data = _request("GET", f"{base}/api/bucket/{bid}")
    if code != 200 or not isinstance(data, dict):
        r.fail("GET /api/bucket/{id}", f"status={code}")
        return bid
    meta = data.get("metadata") or {}
    if meta.get("name") != marker:
        r.fail("read-back name 校验", f"expected {marker}, got {meta.get('name')!r}")
        return bid
    r.ok(f"read-back  → name 一致")

    # 8.3 update
    new_marker = marker + "_updated"
    code, data = _request("POST", f"{base}/api/bucket/{bid}/update", body={"name": new_marker})
    if code != 200:
        r.fail("POST /api/bucket/{id}/update", f"status={code}")
        return bid
    code, data = _request("GET", f"{base}/api/bucket/{bid}")
    if (data.get("metadata") or {}).get("name") != new_marker:
        r.fail("update 后再读取", f"name 没改成 {new_marker}")
        return bid
    r.ok(f"update  → name 改为 {new_marker[:40]}...")

    # 8.4 archive (soft delete)
    code, data = _request("POST", f"{base}/api/bucket/{bid}/archive")
    if code != 200:
        r.fail("POST /api/bucket/{id}/archive", f"status={code}")
        return bid
    r.ok("archive  → 已软删")

    # 8.5 出现在 trash
    code, data = _request("GET", f"{base}/api/trash")
    found = False
    if isinstance(data, list):
        found = any(b.get("id") == bid for b in data if isinstance(b, dict))
    elif isinstance(data, dict):
        for b in data.get("buckets", []):
            if isinstance(b, dict) and b.get("id") == bid:
                found = True
                break
    if not found:
        r.fail("archive 后回收站中未找到", f"id={bid} 应该在 /api/trash")
    else:
        r.ok("archive 后出现在 /api/trash")

    # 8.6 restore
    code, data = _request("POST", f"{base}/api/bucket/{bid}/restore")
    if code != 200:
        r.fail("POST /api/bucket/{id}/restore", f"status={code}")
        return bid
    r.ok("restore  → 恢复")

    # 8.7 final cleanup: purge (hard delete)
    code, data = _request("POST", f"{base}/api/bucket/{bid}/purge")
    if code != 200:
        r.fail("POST /api/bucket/{id}/purge", f"status={code} (测试桶残留, 需要手动清理)")
        return bid
    r.ok("purge  → 测试桶已清理干净")
    return None  # cleanup OK


def cleanup_orphans(base: str, r: Result):
    """以防上次 smoke test 半路崩了, 把残留的 __SMOKE_TEST_* 桶都清掉"""
    section("9. 残留清理 (上次失败的 smoke 桶)")
    code, data = _request("GET", f"{base}/api/buckets")
    if code != 200 or not isinstance(data, list):
        r.skip("无法列表查询", "已在前面记录")
        return
    orphans = [b for b in data if isinstance(b, dict) and str(b.get("name", "")).startswith(SMOKE_TAG)]
    if not orphans:
        r.ok("无残留")
        return
    purged = 0
    for b in orphans:
        bid = b.get("id")
        if not bid:
            continue
        c, _ = _request("POST", f"{base}/api/bucket/{bid}/purge")
        if c == 200:
            purged += 1
    r.ok(f"清理 {purged}/{len(orphans)} 条残留")


# ── main ──────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", default="http://127.0.0.1:8000", help="目标 URL (default: %(default)s)")
    ap.add_argument("--quick", action="store_true", help="只跑只读检查, 跳过 CRUD 写操作")
    args = ap.parse_args()

    base = args.base_url.rstrip("/")
    print(f"\033[36mOmbre-Brain HTTP smoke test\033[0m  →  {base}")
    print(f"启动时间: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")

    r = Result()

    check_health(base, r)
    check_list(base, r)
    check_network(base, r)
    check_breath_debug(base, r)
    check_decay_config(base, r)
    check_embeddings(base, r)
    check_trash(base, r)

    if args.quick:
        r.skip("CRUD 写链路", "--quick 模式")
    else:
        cleanup_orphans(base, r)
        leftover_id = check_crud_lifecycle(base, r)
        if leftover_id:
            print(f"\n\033[33m⚠ CRUD 中途失败, 测试桶 {leftover_id} 可能还在, 下次跑会自动清理\033[0m")

    # 总结
    print("\n" + "=" * 60)
    total = len(r.passed) + len(r.failed) + len(r.skipped)
    print(f"通过 \033[32m{len(r.passed)}\033[0m / 失败 \033[31m{len(r.failed)}\033[0m / 跳过 \033[33m{len(r.skipped)}\033[0m  (共 {total})")
    if r.failed:
        print("\n失败项:")
        for name, reason in r.failed:
            print(f"  • {name}: {reason}")
        sys.exit(1)
    print("\n\033[32m✓ 全部通过, 后端链路健康\033[0m")
    sys.exit(0)


if __name__ == "__main__":
    main()
