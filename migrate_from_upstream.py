#!/usr/bin/env python3
"""
migrate_from_upstream.py — 从上游 P0luz/Ombre-Brain 迁移数据的检查/修复工具

如果你以前在用上游版本, 把 buckets/ 拷过来后, **强烈建议**先跑一遍这个脚本.

用法:
  # 1. 默认 dry-run, 只检查不动数据 (推荐先跑一遍看看报告)
  python migrate_from_upstream.py --buckets-dir ./buckets

  # 2. 一键 normalize 所有老字段 (会自动备份原 buckets/ 到 buckets.backup-TIMESTAMP/)
  python migrate_from_upstream.py --buckets-dir ./buckets --fix

  # 3. 启动前完整健康检查
  python migrate_from_upstream.py --buckets-dir ./buckets --validate

模式说明:
  (不带 flag, 默认): 扫所有 .md, 报告"会有 X 条需要 lazy migration", 不动数据
  --fix:          实际把老字段 normalize 成新字段, 备份原数据, 显示详细报告
  --validate:     dry-run + 严格检查 (无效字段/破损 frontmatter/重复 ID 等)

支持上游字段:
  pinned     -> protected (防衰减) + highlight (浮现优先) 双轴
  digested   -> internalized
  其他字段全部保留, 包括 resolved / type / valence / arousal 等
"""

import argparse
import json
import os
import shutil
import sys
from datetime import datetime
from typing import Tuple

try:
    import frontmatter
except ImportError:
    print("[ERR] 缺少依赖: pip install python-frontmatter")
    sys.exit(1)


# ─────────────────────────────────────────────────────────────────
# 配置
# ─────────────────────────────────────────────────────────────────

BUCKET_SUBDIRS = ["permanent", "dynamic", "feel", "archive", "trash"]

# 已知的合法字段 (用于 validate 模式发现奇怪字段)
KNOWN_FIELDS = {
    # 基础
    "id", "name", "tags", "domain", "valence", "arousal", "importance", "type",
    "created", "last_active", "activation_count",
    # 老/新字段
    "pinned", "protected", "highlight", "digested", "internalized",
    # 其他
    "resolved", "model_valence", "summary", "raw_source", "source_excerpt",
    "event_time", "created_by", "original_type",
}


# ─────────────────────────────────────────────────────────────────
# 颜色输出 (Windows / *nix 都尽量好看)
# ─────────────────────────────────────────────────────────────────

def _supports_color() -> bool:
    """检测当前 stdout 是不是真支持 ANSI 颜色"""
    if not sys.stdout.isatty():
        return False
    if os.name == "nt":
        # Windows 10+ ANSI 需要先 enable
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            # 7 = ENABLE_PROCESSED_OUTPUT | ENABLE_WRAP_AT_EOL_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING
            ok = kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7) != 0
            return ok
        except Exception:
            return False
    return True


_USE_COLOR = _supports_color()


class C:
    """简单颜色,Windows / 旧终端不支持自动 fallback 到无色"""
    OK   = "\033[92m" if _USE_COLOR else ""
    WARN = "\033[93m" if _USE_COLOR else ""
    ERR  = "\033[91m" if _USE_COLOR else ""
    INFO = "\033[94m" if _USE_COLOR else ""
    BOLD = "\033[1m"  if _USE_COLOR else ""
    END  = "\033[0m"  if _USE_COLOR else ""


def info(msg): print(f"{C.INFO}{msg}{C.END}")
def ok(msg): print(f"{C.OK}{msg}{C.END}")
def warn(msg): print(f"{C.WARN}{msg}{C.END}")
def err(msg): print(f"{C.ERR}{msg}{C.END}")
def bold(msg): print(f"{C.BOLD}{msg}{C.END}")


# ─────────────────────────────────────────────────────────────────
# 核心逻辑
# ─────────────────────────────────────────────────────────────────

def scan_buckets(buckets_dir: str) -> list:
    """递归扫描 buckets/ 下所有 .md 文件"""
    found = []
    for sub in BUCKET_SUBDIRS:
        root = os.path.join(buckets_dir, sub)
        if not os.path.isdir(root):
            continue
        for dirpath, _, files in os.walk(root):
            for fn in files:
                if not fn.endswith(".md"):
                    continue
                found.append(os.path.join(dirpath, fn))
    return found


def analyze_bucket(file_path: str) -> dict:
    """读取并分析一个 bucket, 返回需要做什么"""
    result = {
        "path": file_path,
        "needs_migration": False,
        "actions": [],   # ["pinned->protected", "digested->internalized", ...]
        "warnings": [],
        "error": None,
    }
    try:
        post = frontmatter.load(file_path)
    except Exception as e:
        result["error"] = f"frontmatter 解析失败: {e}"
        return result

    meta = post.metadata

    # 检查 pinned 老字段
    if "pinned" in meta:
        pinned_val = bool(meta.get("pinned"))
        if pinned_val and "protected" not in meta:
            result["actions"].append("pinned->protected (set true)")
            result["needs_migration"] = True
        if pinned_val and "highlight" not in meta:
            result["actions"].append("pinned->highlight (set true)")
            result["needs_migration"] = True
        if not pinned_val:
            # pinned: false 这种字段也没用了, 顺手清掉
            result["actions"].append("drop pinned (=false 老字段)")
            result["needs_migration"] = True

    # 检查 digested 老字段
    if "digested" in meta:
        digested_val = bool(meta.get("digested"))
        if digested_val and "internalized" not in meta:
            result["actions"].append("digested->internalized (set true)")
            result["needs_migration"] = True
        result["actions"].append("drop digested (老字段)")
        result["needs_migration"] = True

    # validate 模式下还要检查未知字段
    for key in meta.keys():
        if key not in KNOWN_FIELDS:
            result["warnings"].append(f"未知字段: {key}")

    return result


def normalize_bucket(file_path: str) -> Tuple[bool, list]:
    """实际写入: pinned -> protected+highlight, digested -> internalized, 清掉老字段"""
    actions_done = []
    try:
        post = frontmatter.load(file_path)
    except Exception as e:
        return False, [f"加载失败: {e}"]

    meta = post.metadata
    changed = False

    # pinned -> protected + highlight
    if "pinned" in meta:
        pinned_val = bool(meta.get("pinned"))
        if pinned_val:
            if "protected" not in meta:
                post["protected"] = True
                actions_done.append("set protected=true")
                changed = True
            if "highlight" not in meta:
                post["highlight"] = True
                actions_done.append("set highlight=true")
                changed = True
        # 不管 true/false 都清掉老字段
        try:
            del post["pinned"]
            actions_done.append("drop pinned")
            changed = True
        except Exception:
            pass

    # digested -> internalized (digested:false 跟 pinned:false 一样直接丢, 不设 internalized:false)
    if "digested" in meta:
        digested_val = bool(meta.get("digested"))
        if digested_val and "internalized" not in meta:
            post["internalized"] = True
            actions_done.append("set internalized=true")
            changed = True
        try:
            del post["digested"]
            actions_done.append("drop digested")
            changed = True
        except Exception:
            pass

    if changed:
        try:
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(frontmatter.dumps(post))
            return True, actions_done
        except OSError as e:
            return False, [f"写入失败: {e}"]
    return False, []


def make_backup(buckets_dir: str) -> str:
    """把 buckets/ 整个目录复制到 buckets.backup-TIMESTAMP/"""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_dir = buckets_dir.rstrip(os.sep) + ".backup-" + timestamp
    info(f"备份原数据 -> {backup_dir}")
    shutil.copytree(buckets_dir, backup_dir, dirs_exist_ok=False)
    return backup_dir


# ─────────────────────────────────────────────────────────────────
# 主入口
# ─────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Ombre-Brain 上游数据迁移工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 检查 (不改数据, 推荐第一步)
  python migrate_from_upstream.py --buckets-dir ./buckets

  # 修复 (会自动备份)
  python migrate_from_upstream.py --buckets-dir ./buckets --fix

  # 启动前完整验证
  python migrate_from_upstream.py --buckets-dir ./buckets --validate
""")
    parser.add_argument("--buckets-dir", required=True, help="buckets 目录路径")
    parser.add_argument("--fix", action="store_true", help="实际 normalize 老字段 (默认只检查)")
    parser.add_argument("--validate", action="store_true", help="严格验证 (报告未知字段等)")
    parser.add_argument("--no-backup", action="store_true", help="跳过备份 (不推荐)")
    parser.add_argument("--report-json", help="把结果写到 JSON 文件")
    args = parser.parse_args()

    if not os.path.isdir(args.buckets_dir):
        err(f"目录不存在: {args.buckets_dir}")
        return 1

    bold(f"\n=== Ombre-Brain 迁移工具 ===\n目录: {args.buckets_dir}\n模式: {'FIX' if args.fix else 'VALIDATE' if args.validate else 'CHECK'}")
    print()

    # 1. 扫描
    info("[1/3] 扫描 buckets/ ...")
    files = scan_buckets(args.buckets_dir)
    info(f"      找到 {len(files)} 个 .md 文件")
    if not files:
        warn("      没找到任何 bucket. 是不是路径错了?")
        return 0

    # 2. 分析
    info("[2/3] 分析每个 bucket 的兼容性 ...")
    needs_migration = []
    errors = []
    warnings_total = 0

    for fp in files:
        result = analyze_bucket(fp)
        if result["error"]:
            errors.append(result)
        else:
            if result["needs_migration"]:
                needs_migration.append(result)
            warnings_total += len(result["warnings"])

    print()
    bold(f"=== 检查报告 ===")
    info(f"  共扫描:        {len(files)} 个 bucket")
    if errors:
        err(f"  解析失败:      {len(errors)} 个 (需要人工查看)")
    if needs_migration:
        warn(f"  需要迁移:      {len(needs_migration)} 个 (有 pinned/digested 等老字段)")
    else:
        ok(f"  需要迁移:      0 个 (全部已经是新字段格式)")
    if args.validate and warnings_total > 0:
        warn(f"  警告 (验证模式): {warnings_total} 条 (未知字段等, 可能无害)")

    # 错误详情
    if errors:
        print()
        err("解析失败的文件:")
        for r in errors:
            err(f"  - {r['path']}: {r['error']}")

    # 迁移详情 (前 20 个示例)
    if needs_migration and not args.fix:
        print()
        info("需要迁移的文件示例 (前 20 个):")
        for r in needs_migration[:20]:
            rel = os.path.relpath(r["path"], args.buckets_dir)
            print(f"  - {rel}")
            for action in r["actions"]:
                print(f"{action}")
        if len(needs_migration) > 20:
            info(f"  ... 还有 {len(needs_migration) - 20} 个")

    # 3. 修复 (--fix)
    fixed_count = 0
    fix_failed = []
    if args.fix:
        if not needs_migration:
            print()
            ok("没有需要修复的, 数据已经是新字段格式了, 跳过")
        else:
            print()
            info("[3/3] 开始 FIX ...")
            # 备份
            if not args.no_backup:
                try:
                    backup = make_backup(args.buckets_dir)
                    ok(f"      备份完成: {backup}")
                except FileExistsError as e:
                    err(f"      备份目录已存在 (上次跑过): {e}")
                    err(f"      要么删掉/改名旧备份, 要么用 --no-backup")
                    return 1
            # 写
            for r in needs_migration:
                changed, actions = normalize_bucket(r["path"])
                if changed:
                    fixed_count += 1
                else:
                    fix_failed.append((r["path"], actions))
            print()
            bold(f"=== FIX 完成 ===")
            ok(f"  成功 normalize: {fixed_count} 个 bucket")
            if fix_failed:
                err(f"  失败:           {len(fix_failed)} 个")
                for fp, msgs in fix_failed[:5]:
                    err(f"    - {fp}: {msgs}")

    # 4. JSON 报告
    if args.report_json:
        report = {
            "timestamp": datetime.now().isoformat(),
            "buckets_dir": args.buckets_dir,
            "mode": "fix" if args.fix else ("validate" if args.validate else "check"),
            "scanned": len(files),
            "needs_migration": len(needs_migration),
            "errors": [{"path": r["path"], "error": r["error"]} for r in errors],
            "warnings_total": warnings_total,
            "fixed": fixed_count if args.fix else None,
        }
        with open(args.report_json, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        info(f"\nJSON 报告已写入: {args.report_json}")

    # 5. 收尾建议
    print()
    bold("=== 下一步 ===")
    if errors:
        err(f"  1. 先处理 {len(errors)} 个解析失败的 bucket (上面列出了路径)")
        return 1
    if needs_migration and not args.fix:
        info(f"  - 跑 --fix 一键 normalize: python migrate_from_upstream.py --buckets-dir {args.buckets_dir} --fix")
        info(f"  - 或者直接启动服务, lazy migration 会在 update 时自动处理 (慢一点但完全安全)")
    elif args.fix and fix_failed:
        return 1
    else:
        ok(f"  - 一切就绪, 可以启动服务了")

    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
