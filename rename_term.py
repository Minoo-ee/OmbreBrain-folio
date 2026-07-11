#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rename_term.py — 桶内"称呼/术语"批量改名 (分词感知 + 预览优先)

通用工具:把记忆桶正文(和标题)里某个**单字中文名**改成另一个名字,同时尽量
不误伤含该字的普通词组。典型用途:某个人/角色的旧称呼想全库统一换掉。

为什么不是简单 replace:
    单字(如某个常见汉字)是高频字,直接字符串替换会毁掉"克服/克制/巧克力/坦克…"
    这类正常词组。本脚本靠一份"正常词名单"(denylist)保护:
      - 落在名单词范围内的该字 → 一律不动(保护)
      - 数字紧邻(疑似"50克"这种单位)→ 不自动改, 列进"待确认"
      - 其余的该字 → 当名字替换
    误差刻意导向"可见的多改"(在 dry-run 的 AUTO 区看得到, 可把词加进 --deny-extra 重跑),
    而不是"隐形的漏改"(分词器会把"克说""想克"误粘成词, 反而漏掉真名字)。
    名单见 DENYLIST_CN, 可用 --deny-extra a,b / --deny-file path 扩充。
    拉丁字母旧称(如 AB):
      - 整词的大写 / 首字母大写形式 → 替换
      - 全小写形式(英文词里到处都是 ke)→ 绝不自动改, 全部列出给你人工认

安全设计 (跟 reverse_compat_migrate.py 同款):
    - 默认 dry-run: 只扫描 + 把会改/待确认/受保护的全写进预览文件, **不写任何桶**。
      加 --apply 才真正写盘。
    - 只改正文 (body) 和 --fields 指定的 frontmatter 文本字段(默认 name/summary —
      这两个会随正文一起喂给摘要器, 必须一起换干净); **绝不动 id/时间/分数/tags 等
      结构字段** → 时间线、衰减、显示日期都不变 (decay 走 last_active, 不靠文件 mtime)。
    - 任何"待确认"的情况(数字旁的字 / 小写拉丁 / 其它字段里出现旧名)一律**不自动改**,
      只列给你看, 你拍板。
    - 不走 OB 写入 API → 不会 bump last_active。
    - 脚本本身不含任何名字, 名字全部命令行传参。

用法 (在 Ombre-Brain 仓根目录 / Render shell 里跑):
    # 1) 先空跑, 生成预览文件(默认 ./rename_preview.txt), 一个字都不写:
    python rename_term.py --old 克 --new 新名 --latin AB

    # 2) 你读完 ./rename_preview.txt, 觉得 AUTO 区都对、REVIEW 区没漏:
    python rename_term.py --old 克 --new 新名 --latin AB --apply

    # 3) (可选, 推荐) 改完同一条命令加 --refresh-caches, 清掉被改桶的 embedding +
    #    可能陈旧的摘要缓存, 让语义搜索 / 摘要都跟新正文一致:
    python rename_term.py --old 克 --new 新名 --latin AB --apply --refresh-caches
    #    然后跑现成的: python backfill_embeddings.py     # 重新生成 embedding

    其它开关:
        --fields a,b           要改名的 frontmatter 文本字段(默认 name,summary; 它们会
                               随正文喂给摘要器, 必须一起换); 其余字段一律不动
        --deny-extra a,b       临时往保护名单里加词(dry-run 看到正常词被误改时用)
        --deny-file path       从文件读保护名单(每行一个词, # 开头为注释)
        --dir /path/buckets    手动指定桶目录(默认走 config / OMBRE_BUCKETS_DIR)
        --exclude-trash        跳过 trash/ 回收站
        --preview-out PATH     预览文件输出位置(默认 ./rename_preview.txt)
        --max-list N           预览里 AUTO 区最多列多少条(默认 2000, 仅防文件过大)

注意:--old 仅支持**单个汉字**的名字(单字成词检测靠它)。多字名字需另想办法。
"""

import os
import re
import sys
import glob
import hashlib

import frontmatter


# ---------- 含旧名单字的"正常词"保护名单 ----------
# 旧名是单字时(如"克"), 直接全替换会毁掉这些正常词。名单里的词一律保护不动。
# 策略偏保守: 宁可漏保护(那处会被换 → 在 dry-run 的 AUTO 区看得到, 可加进名单重跑),
# 也不要过度保护(那会漏掉真名字 → 静默泄漏, 看不见)。名单可用 --deny-extra / --deny-file 扩。
DENYLIST_CN = set("""
克服 克制 克己 克勤克俭 克扣 克星 克难 攻克 相克 生克 克敌 克复 克化 克尽 克日 克期
巧克力 千克 克拉 坦克 扑克 克隆 休克 夹克 克分子
麦克 麦克风 麦克白 马克 马克思 马克杯 杰克 迈克 尼克 洛克 史克 耐克
克里 克里斯 克莱 克劳 克拉克 克林 克林顿 克罗 克什 克格勃 克莉 克丽
扎克 布克 巴克 比克 皮克 瑞克 德里克 帕特里克 埃里克
伊拉克 捷克 莫桑比克 克罗地亚 克什米尔
""".split())


# ---------- 参数解析 (跟仓里其它脚本一样手撸, 不引 argparse 省依赖噪声) ----------

def get_opt(argv, name, default=None):
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            return argv[i + 1]
        print(f"✗ {name} 后面要跟一个值"); sys.exit(2)
    return default


def resolve_buckets_dir(argv) -> str:
    explicit = get_opt(argv, "--dir")
    if explicit:
        return explicit
    try:
        from utils import load_config
        cfg = load_config()
        d = cfg.get("buckets_dir")
        if not d:
            print("✗ config 里没有 buckets_dir, 请用 --dir 显式指定"); sys.exit(2)
        return d
    except Exception as e:
        print(f"✗ 读 config 失败 ({e}); 请用 --dir 显式指定桶目录"); sys.exit(2)


# ---------- 文本处理核心 ----------

# 切分 frontmatter / 正文, 完整保留原始分隔符与字节(含可能的 BOM、CRLF)。
# 四组: 开头 ---行 / frontmatter 内容 / 结尾 ---行 / 正文。拼回 == 原文。
FM_RE = re.compile(r"\A(﻿?---[ \t]*\r?\n)(.*?\r?\n)(---[ \t]*\r?\n)(.*)\Z", re.DOTALL)


def _snippet(text, start, end, pad=18):
    """取一处上下文片段, 换行压成 ⏎ 方便单行展示。"""
    a = max(0, start - pad)
    b = min(len(text), end + pad)
    s = text[a:b].replace("\n", "⏎").replace("\r", "")
    return ("…" if a > 0 else "") + s + ("…" if b < len(text) else "")


def process_cn(text, old_cn, new_name, denylist):
    """
    替换"作为名字"的旧名单字。保护策略 = 名单(denylist): 凡是落在某个名单词
    (克服/巧克力/坦克…)范围内的该字, 一律不动; 其余的该字都当名字替换。
    (不用分词器判断 —— 分词器会把"克说""想克"这类名字+邻字误粘成一个"词",
     导致真名字被当词保护、静默漏改。名单法把误差导向"可见的多改", 而非"隐形的漏改"。)
    返回 (new_text, auto_changes, unit_reviews, protected_counts)
      auto_changes:    [(before_snippet, after_snippet)]  真正会改的
      unit_reviews:    [snippet]                          数字旁的字(疑似单位如 50克), 不改
      protected_counts: {word: count}                     命中名单被保护的词
    """
    # 1) 标出所有"名单词"覆盖的字符区间
    ranges = []
    protected = {}
    for w in denylist:
        if old_cn not in w or len(w) < 2:
            continue
        start = 0
        while True:
            i = text.find(w, start)
            if i < 0:
                break
            ranges.append((i, i + len(w)))
            protected[w] = protected.get(w, 0) + 1
            start = i + len(w)
    ranges.sort()

    def covered(idx):
        for s, e in ranges:
            if s <= idx < e:
                return True
            if s > idx:
                break
        return False

    # 2) 逐个旧名字: 被名单覆盖 → 保护; 数字紧邻 → 疑似单位待确认; 否则 → 替换
    spans = []
    unit_reviews = []
    for mo in re.finditer(re.escape(old_cn), text):
        idx = mo.start()
        if covered(idx):
            continue
        prev = text[idx - 1] if idx > 0 else ""
        if prev.isdigit():
            unit_reviews.append(_snippet(text, idx, idx + len(old_cn)))
            continue
        spans.append((idx, idx + len(old_cn)))

    auto_changes = []
    if not spans:
        return text, auto_changes, unit_reviews, protected

    # 先构建 new_text, 同时记下每处替换在 new_text 里的新位置, 这样"改后"片段
    # 直接从真实结果里截取 → 同窗口里被保护的词组(克服/克制…)会如实保留, 不会误显示成改了。
    out = []
    cur = 0
    new_pos = []
    delta = 0
    for s, e in spans:
        out.append(text[cur:s])
        ns = s + delta
        out.append(new_name)
        new_pos.append((ns, ns + len(new_name)))
        delta += len(new_name) - (e - s)
        cur = e
    out.append(text[cur:])
    new_text = "".join(out)

    for (s, e), (ns, ne) in zip(spans, new_pos):
        auto_changes.append((_snippet(text, s, e), _snippet(new_text, ns, ne)))
    return new_text, auto_changes, unit_reviews, protected


def process_latin(text, latin_token, new_name):
    """
    拉丁字母旧称。大写整词 AB / 首字母大写 Ab → 换; 小写 ab → 只列不换。
    用 ASCII 字母 lookaround 当词边界(中文环境下 \\b 不可靠)。
    返回 (new_text, auto_changes, lower_reviews)
    """
    upper = latin_token.upper()
    title = latin_token[0].upper() + latin_token[1:].lower() if latin_token else latin_token
    lower = latin_token.lower()

    auto_forms = []
    seen = set()
    for f in (upper, title):
        if f and f not in seen:
            seen.add(f); auto_forms.append(f)

    auto_changes = []
    new_text = text

    for form in auto_forms:
        pat = re.compile(r"(?<![A-Za-z])" + re.escape(form) + r"(?![A-Za-z])")
        for m in pat.finditer(new_text):
            auto_changes.append((_snippet(new_text, m.start(), m.end()),
                                 _snippet(new_text, m.start(), m.end()).replace(form, new_name)))
        new_text = pat.sub(new_name, new_text)

    # 小写形式 → 只审, 不改 (在已替换大写后的文本上找)
    lower_reviews = []
    if lower:
        lpat = re.compile(r"(?<![A-Za-z])" + re.escape(lower) + r"(?![A-Za-z])")
        for m in lpat.finditer(new_text):
            lower_reviews.append(_snippet(new_text, m.start(), m.end()))

    return new_text, auto_changes, lower_reviews


# ---------- 主流程 ----------

def main():
    # 终端编码兜底: Windows 控制台默认 GBK, 打印 emoji/符号会崩; 强制 utf-8。
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    argv = sys.argv[1:]
    apply = "--apply" in argv
    exclude_trash = "--exclude-trash" in argv
    refresh_caches = ("--refresh-caches" in argv) or ("--refresh-embeddings" in argv)

    old_cn = get_opt(argv, "--old")
    new_name = get_opt(argv, "--new")
    latin = get_opt(argv, "--latin")   # 可选
    preview_out = get_opt(argv, "--preview-out", "./rename_preview.txt")
    max_list = int(get_opt(argv, "--max-list", "2000"))
    # 会改名的 frontmatter 文本字段 (这些会随正文一起喂给 dehydrator → 必须一起清干净)。
    # 其余字段(id/时间/分数/tags…)一律不动。
    fields = [s.strip() for s in get_opt(argv, "--fields", "name,summary").split(",") if s.strip()]

    # 保护名单 (正常词不被误改); 可扩充
    deny = set(DENYLIST_CN)
    _extra = get_opt(argv, "--deny-extra")
    if _extra:
        deny |= {w.strip() for w in _extra.split(",") if w.strip()}
    _deny_file = get_opt(argv, "--deny-file")
    if _deny_file:
        try:
            with open(_deny_file, encoding="utf-8") as f:
                deny |= {ln.strip() for ln in f if ln.strip() and not ln.lstrip().startswith("#")}
        except Exception as e:
            print(f"⚠ 读 --deny-file 失败 ({e}), 忽略")

    if not new_name or not (old_cn or latin):
        print("✗ 至少要 --new 和 (--old 或 --latin)。\n   例: python rename_term.py --old 克 --new 新名 --latin AB")
        sys.exit(2)
    if old_cn and len(old_cn) != 1:
        print(f"✗ --old 只支持单个汉字, 收到 {old_cn!r}(长度 {len(old_cn)})。多字名字本脚本不处理。")
        sys.exit(2)

    base = os.path.abspath(resolve_buckets_dir(argv))
    if not os.path.isdir(base):
        print(f"✗ 桶目录不存在: {base}"); sys.exit(2)

    print("=" * 64)
    print(f"改名  ({'APPLY 真写' if apply else 'DRY-RUN 仅预览, 不写盘'})")
    print(f"桶目录   : {base}")
    print(f"旧名(中文): {old_cn or '—'}    旧名(拉丁): {latin or '—'}    新名: {new_name}")
    print("=" * 64)

    files = glob.glob(os.path.join(base, "**", "*.md"), recursive=True)
    if exclude_trash:
        trash_prefix = os.path.normpath(os.path.join(base, "trash")) + os.sep
        files = [f for f in files if not os.path.normpath(f).startswith(trash_prefix)]

    scanned = 0
    changed_buckets = 0
    total_auto = 0
    errors = 0
    changed_ids = []
    changed_for_cache = []   # [(bucket_id, 改后正文)] — 用于清 embedding + dehydration 缓存

    # 预览累积
    pv_auto = []          # 每条: (display_name, change_lines[])
    pv_unit = []          # (display, snippet)
    pv_lower = []         # (display, snippet)
    pv_otherfield = []    # (display, field, value)
    protected_total = {}

    latin_any = None
    if latin:
        latin_any = re.compile(r"(?<![A-Za-z])(?:%s|%s|%s)(?![A-Za-z])" % (
            re.escape(latin.upper()),
            re.escape(latin[0].upper() + latin[1:].lower()),
            re.escape(latin.lower())))

    for fp in files:
        try:
            with open(fp, "r", encoding="utf-8", newline="") as f:
                raw = f.read()
        except Exception as e:
            print(f"  [skip] 读取失败 {fp}: {e}"); errors += 1
            continue
        # 仅为分析(id / name / 其它字段)而解析, 不用它写回。
        try:
            meta = frontmatter.loads(raw).metadata
            if not isinstance(meta, dict):
                meta = {}
        except Exception:
            meta = {}
        scanned += 1
        dname = meta.get("name")
        display = dname if isinstance(dname, str) and dname else os.path.basename(fp)

        # 切出 frontmatter / 正文, 保留原始字节
        m = FM_RE.match(raw)
        if m:
            fm_open, fm_body, fm_close, body = m.group(1), m.group(2), m.group(3), m.group(4)
        else:
            fm_open, fm_body, fm_close, body = "", "", "", raw

        file_auto_lines = []

        def run(text, where):
            """对一段文本跑 中文单字 + 拉丁 改名, 顺手收集预览, 返回新文本。"""
            nt = text
            tag = "" if where == "正文" else f" ({where})"
            if old_cn:
                nt, ac, units, prot = process_cn(nt, old_cn, new_name, deny)
                for b, a in ac:
                    file_auto_lines.append(f"   {where}: {b}   →   {a}")
                for sn in units:
                    pv_unit.append((display + tag, sn))
                for w, c in prot.items():
                    protected_total[w] = protected_total.get(w, 0) + c
            if latin:
                nt, ac, lowers = process_latin(nt, latin, new_name)
                for b, a in ac:
                    file_auto_lines.append(f"   {where}: {b}   →   {a}")
                for sn in lowers:
                    pv_lower.append((display + tag, sn))
            return nt

        # ---- 正文 ----
        new_body = run(body, "正文")

        # ---- 改 frontmatter 里指定字段(默认 name/summary)的值, 其余字节一律不动 ----
        new_fm_body = fm_body
        if fm_body:
            for field in fields:
                fre = re.compile(r"(?m)^(" + re.escape(field) + r":[ \t]*)(.*)$")
                nm = fre.search(new_fm_body)
                if not nm:
                    continue
                val = nm.group(2)
                sval = val.strip()
                # 跳过 YAML 块标量/锚点/流式集合(多行或结构化)→ 交给"其它字段"警示, 不冒险动
                if not sval or sval[0] in "|>&*![{":
                    continue
                new_val = run(val, field)
                if new_val != val:
                    new_fm_body = new_fm_body[:nm.start(2)] + new_val + new_fm_body[nm.end(2):]

        # ---- 其它(未在 --fields 内的)frontmatter 字段里若也出现旧名: 只警示, 不动 ----
        for k, v in meta.items():
            if k in fields or not isinstance(v, str) or not v:
                continue
            hit = (old_cn and old_cn in v) or (latin_any and latin_any.search(v))
            if hit:
                pv_otherfield.append((display, k, v[:120]))

        if new_body == body and new_fm_body == fm_body:
            continue

        changed_buckets += 1
        total_auto += len(file_auto_lines)
        bid = meta.get("id")
        if bid:
            changed_ids.append(str(bid))
        changed_for_cache.append((str(bid) if bid else None, new_body))
        if len(pv_auto) < max_list:
            pv_auto.append((display, bid, file_auto_lines))

        if apply:
            try:
                with open(fp, "w", encoding="utf-8", newline="") as f:
                    f.write(fm_open + new_fm_body + fm_close + new_body)
            except Exception as e:
                print(f"  [写失败] {fp}: {e}"); errors += 1

    # ---- 写预览文件 ----
    lines = []
    lines.append("=" * 64)
    lines.append(f"改名预览  ({'APPLY 已写盘' if apply else 'DRY-RUN 未写盘'})")
    lines.append(f"桶目录   : {base}")
    lines.append(f"旧名(中文): {old_cn or '—'}    旧名(拉丁): {latin or '—'}    新名: {new_name}")
    lines.append(f"扫描 {scanned} 桶, {'已改' if apply else '将改'} {changed_buckets} 桶, 共 {total_auto} 处自动替换")
    lines.append("=" * 64)

    lines.append("")
    lines.append(f"—— ① 自动替换 AUTO (共 {total_auto} 处) —— 逐条核对左右两边是不是都对 ——")
    if not pv_auto:
        lines.append("  (无)")
    for display, bid, change_lines in pv_auto:
        lines.append(f"[{display}]  id={bid}")
        lines.extend(change_lines)
    if changed_buckets > len(pv_auto):
        lines.append(f"  …还有 {changed_buckets - len(pv_auto)} 桶未在此列出(--max-list 限制), 全都会改。")

    lines.append("")
    lines.append(f"—— ② 待你确认 REVIEW (不会自动改, 需要你拿主意) ——")
    lines.append(f"  ▸ 小写拉丁 ('{(latin or '').lower()}') 共 {len(pv_lower)} 处 —— 看看哪些其实是名字:")
    if not pv_lower:
        lines.append("    (无)")
    for display, sn in pv_lower:
        lines.append(f"    · [{display}] {sn}")
    lines.append(f"  ▸ 数字旁的'{old_cn or ''}' (疑似单位如 50克) 共 {len(pv_unit)} 处:")
    if not pv_unit:
        lines.append("    (无)")
    for display, sn in pv_unit:
        lines.append(f"    · [{display}] {sn}")
    lines.append(f"  ▸ 其它 frontmatter 字段里出现旧名 共 {len(pv_otherfield)} 处 (本脚本只改正文 + {'/'.join(fields)}, 这些字段没动):")
    if not pv_otherfield:
        lines.append("    (无)")
    for display, k, v in pv_otherfield:
        lines.append(f"    · [{display}] 字段 {k} = {v}")

    lines.append("")
    lines.append(f"—— ③ 受保护未动 PROTECTED (含'{old_cn or ''}'的正常词组, 自动跳过) ——")
    if not protected_total:
        lines.append("  (无)")
    else:
        items = sorted(protected_total.items(), key=lambda kv: -kv[1])
        lines.append("  " + ",  ".join(f"{w}×{c}" for w, c in items[:80]))
        if len(items) > 80:
            lines.append(f"  …另有 {len(items) - 80} 种词组")

    try:
        with open(preview_out, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
    except Exception as e:
        print(f"  ⚠ 预览文件写入失败 ({e}), 下面直接打印简表")

    # ---- 终端简报 ----
    print(f"\n扫描 {scanned} 桶 → {'已改' if apply else '将改'} {changed_buckets} 桶 / {total_auto} 处自动替换")
    print(f"待确认: 小写拉丁 {len(pv_lower)} / 数字旁字 {len(pv_unit)} / 其它字段 {len(pv_otherfield)}")
    print(f"受保护词组种类: {len(protected_total)}")
    if errors:
        print(f"⚠ {errors} 个文件出错(见上)")
    print(f"\n📄 详细预览已写到: {os.path.abspath(preview_out)}")
    print("   (这个文件含你的记忆片段, 只在本机/Render 盘上, 自己看就行)")

    if not apply:
        print("\n→ 读完预览, AUTO 区都对、REVIEW 区没漏, 就加 --apply 真写。")
        print("  建议先确认上面「桶目录」是你要的那个盘。")
    else:
        # 写 changed_ids 便于刷 embedding
        ids_path = os.path.abspath("./rename_changed_ids.txt")
        try:
            with open(ids_path, "w", encoding="utf-8") as f:
                f.write("\n".join(changed_ids))
            print(f"\n✓ 已写盘。改过的桶 id 列在: {ids_path} ({len(changed_ids)} 个)")
        except Exception as e:
            print(f"\n✓ 已写盘。(changed_ids 落地失败: {e})")

        if refresh_caches and changed_for_cache:
            import sqlite3
            # 1) embedding 按 bucket_id 删 (改名后重算才跟正文一致)
            emb_db = os.path.join(base, "embeddings.db")
            if os.path.exists(emb_db):
                conn = sqlite3.connect(emb_db); cur = conn.cursor()
                ed = 0
                for bid in changed_ids:
                    cur.execute("DELETE FROM embeddings WHERE bucket_id = ?", (bid,))
                    ed += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
                conn.commit(); conn.close()
                print(f"✓ 已删除 {ed} 条改过桶的旧 embedding。")
                print("  → 接着跑:  python backfill_embeddings.py   (重算, 语义搜索就跟新正文一致)")
            else:
                print(f"⚠ 没找到 {emb_db}, 跳过 embedding。")
            # 2) dehydration 缓存按 sha256(改后正文) 删 —— 缓存键是内容哈希:
            #    正文改了的桶哈希已变(旧条目自然失效); 只有"正文没变、只改了 name/summary"
            #    的桶哈希没变 → 必须按新正文哈希删掉那条陈旧摘要, 否则模型还会读到旧名。
            deh_db = os.path.join(base, "dehydration_cache.db")
            if os.path.exists(deh_db):
                conn = sqlite3.connect(deh_db); cur = conn.cursor()
                dd = 0
                for _bid, nb in changed_for_cache:
                    h = hashlib.sha256((nb or "").encode()).hexdigest()
                    cur.execute("DELETE FROM dehydration_cache WHERE content_hash = ?", (h,))
                    dd += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
                conn.commit(); conn.close()
                print(f"✓ 已清 {dd} 条可能陈旧的 dehydration 摘要缓存(其余因正文变动已自动失效)。")
            else:
                print(f"(没找到 {deh_db}, 无 dehydration 缓存需清)")
        elif refresh_caches:
            print("\n(没有改动, 无需刷新缓存)")


if __name__ == "__main__":
    main()
