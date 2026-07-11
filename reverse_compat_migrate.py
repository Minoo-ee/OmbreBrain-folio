#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
reverse_compat_migrate.py — 反向兼容迁移 (fork → 上游)

这个 fork 把"钉决/隐藏"语义拆成了新字段:
    protected     防自动衰减归档
    highlight     breath 浮现时进核心准则区
    internalized  隐藏不浮现 (原 digested)
而上游(原作者版)只认老字段 `pinned` / `digested`。平时 fork 写入会主动清掉老字段
(bucket_manager.update 里的 _drop),保持数据集干净 —— 代价是:**直接切回上游 / 把数据
交给只跑上游的人时, 这些状态会全部丢失**(上游读不到 protected/highlight/internalized)。

本脚本在"要切回上游 / 导出给上游用户"之前跑一次, 把新字段**回填**成上游认识的老字段:
    pinned   = protected OR highlight     (上游 pinned = 防衰减+浮现, 任一新轴为真即置真)
    digested = internalized               (上游 digested = 隐藏不浮现)

安全设计:
    - 默认 dry-run: 只扫描 + 报告会改哪些, 不写任何文件。加 --apply 才真正写盘。
    - 只动老字段 pinned / digested; **绝不触碰 protected / highlight / internalized**
      (fork 继续照常工作, 这只是额外让数据"也能被上游读懂")。
    - 幂等: 重复跑安全, 已同步的不再改。
    - buckets 目录用 load_config() 解析 —— 跟 server 同一个来源, 避免 OMBRE_BUCKETS_DIR
      错配跑错盘 (见历史事故)。跑前会把解析到的目录打印出来给你确认。

用法 (在 Ombre-Brain 仓根目录跑):
    python reverse_compat_migrate.py                 # dry-run, 看会改哪些
    python reverse_compat_migrate.py --apply         # 确认无误后真写
    python reverse_compat_migrate.py --dir /path/buckets   # 手动指定桶目录 (不走 config)
    python reverse_compat_migrate.py --exclude-trash       # 跳过 trash/ 回收站
"""

import os
import sys
import glob

import frontmatter

from utils import is_protected, is_highlighted, is_internalized


def resolve_buckets_dir(argv) -> str:
    # 优先 --dir 显式指定
    if "--dir" in argv:
        i = argv.index("--dir")
        if i + 1 < len(argv):
            return argv[i + 1]
        print("✗ --dir 后面要跟路径"); sys.exit(2)
    # 否则走跟 server 一样的 config 解析
    try:
        from utils import load_config
        cfg = load_config()
        d = cfg.get("buckets_dir")
        if not d:
            print("✗ config 里没有 buckets_dir, 请用 --dir 显式指定"); sys.exit(2)
        return d
    except Exception as e:
        print(f"✗ 读 config 失败 ({e}); 请用 --dir 显式指定桶目录"); sys.exit(2)


def main():
    argv = sys.argv[1:]
    apply = "--apply" in argv
    exclude_trash = "--exclude-trash" in argv

    base = resolve_buckets_dir(argv)
    base = os.path.abspath(base)
    if not os.path.isdir(base):
        print(f"✗ 桶目录不存在: {base}"); sys.exit(2)

    print("=" * 64)
    print(f"反向兼容迁移  ({'APPLY 真写' if apply else 'DRY-RUN 仅预览'})")
    print(f"桶目录: {base}")
    if exclude_trash:
        print("(跳过 trash/ 回收站)")
    print("=" * 64)

    files = glob.glob(os.path.join(base, "**", "*.md"), recursive=True)
    if exclude_trash:
        trash_prefix = os.path.normpath(os.path.join(base, "trash")) + os.sep
        files = [f for f in files if not os.path.normpath(f).startswith(trash_prefix)]

    scanned = 0
    would_change = 0
    set_pinned = 0
    clear_pinned = 0
    set_digested = 0
    clear_digested = 0
    errors = 0
    samples = []

    for fp in files:
        try:
            post = frontmatter.load(fp)
        except Exception as e:
            print(f"  [skip] 加载失败 {fp}: {e}")
            errors += 1
            continue
        meta = post.metadata if isinstance(post.metadata, dict) else {}
        scanned += 1

        want_pinned = bool(is_protected(meta) or is_highlighted(meta))
        want_digested = bool(is_internalized(meta))

        changes = []

        # --- pinned ---
        cur_pinned = meta.get("pinned", None)
        if want_pinned and cur_pinned is not True:
            post["pinned"] = True
            changes.append("pinned→True")
            set_pinned += 1
        elif (not want_pinned) and ("pinned" in meta):
            # 老数据残留的 pinned, 但 fork 已不认为它钉选 → 清掉, 免得上游误读
            try:
                del post["pinned"]
            except Exception:
                pass
            changes.append("pinned✗(清残留)")
            clear_pinned += 1

        # --- digested ---
        cur_digested = meta.get("digested", None)
        if want_digested and cur_digested is not True:
            post["digested"] = True
            changes.append("digested→True")
            set_digested += 1
        elif (not want_digested) and ("digested" in meta):
            try:
                del post["digested"]
            except Exception:
                pass
            changes.append("digested✗(清残留)")
            clear_digested += 1

        if not changes:
            continue

        would_change += 1
        name = meta.get("name", os.path.basename(fp))
        if len(samples) < 15:
            samples.append(f"  · {name}  [{', '.join(changes)}]")

        if apply:
            try:
                with open(fp, "w", encoding="utf-8") as f:
                    f.write(frontmatter.dumps(post))
            except Exception as e:
                print(f"  [写失败] {fp}: {e}")
                errors += 1

    print(f"\n扫描 {scanned} 桶, {'已改' if apply else '将改'} {would_change} 桶")
    print(f"  pinned:   置真 {set_pinned} / 清残留 {clear_pinned}")
    print(f"  digested: 置真 {set_digested} / 清残留 {clear_digested}")
    if errors:
        print(f"  ⚠ {errors} 个文件出错(见上)")
    if samples:
        print("\n样例(最多 15 条):")
        print("\n".join(samples))
    if not apply and would_change:
        print(f"\n→ 看着对就加 --apply 真写。建议先确认上面「桶目录」是你要的那个盘。")
    elif apply:
        print("\n✓ 完成。fork 字段没动, 只补/清了上游用的 pinned/digested。")
    else:
        print("\n✓ 无需改动(所有桶的老字段已与新字段一致)。")


if __name__ == "__main__":
    main()
