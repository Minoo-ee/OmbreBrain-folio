# 从上游 Ombre-Brain 迁移过来 · 操作指南

> 如果你之前在用 [P0luz/Ombre-Brain](https://github.com/P0luz/Ombre-Brain) 原版,想换到这个优化版本,**这篇文档是必看的**。

## 简短版本(给赶时间的)

```bash
# 1. 备份 (重要,不要跳过)
cp -r ./buckets ./buckets.backup-original

# 2. 检查兼容性
python migrate_from_upstream.py --buckets-dir ./buckets

# 3. 一键修复 (自动备份)
python migrate_from_upstream.py --buckets-dir ./buckets --fix

# 4. 启动服务
python server.py
```

完事。如果默认检查(不带 flag)报告 0 个需要迁移,你甚至连 `--fix` 都不用跑。

---

## 详细版本(给小心谨慎的)

### 关于数据安全的承诺

Render 持久盘曾因环境变量错配发生过**约一周的数据丢失**事故 —— 因此本系统把**数据安全放在头号优先级**。这次迁移工具:

- ✅ 默认 dry-run,不动数据
- ✅ `--fix` 自动备份原 `buckets/` 到 `buckets.backup-时间戳/`
- ✅ 只动需要变的字段,其他字段(包括正文)**字节级保留**
- ✅ 所有被改动都有 commit log 可追溯
- ✅ 即使不跑迁移工具,也有 lazy migration 兜底(读时旧字段自动识别,写时自动转新字段)

### 迁移做了什么

**数据格式核心兼容,只是字段名有调整**:

| 上游字段 | 本版本字段 | 说明 |
|---|---|---|
| `pinned: true` | `protected: true` + `highlight: true` | 拆成两个独立轴(防衰减 + 浮现优先) |
| `pinned: false` | (清掉) | 上游 false 字段也清,避免歧义 |
| `digested: true` | `internalized: true` | 改名,语义更准确 |
| `digested: false` | (清掉) | 跟 `pinned: false` 一样,false 老字段直接清,不留 `internalized: false` |
| 其他所有字段 | **完全不动** | id / name / tags / domain / valence / arousal / importance / type / created / last_active / activation_count / resolved / raw_source / 等等 |

### 完整步骤

#### Step 1 — 备份

迁移前一定要备份。最简单的办法:

```bash
# Linux / macOS
cp -r ./buckets ./buckets.backup-original

# Windows PowerShell
Copy-Item ./buckets ./buckets.backup-original -Recurse
```

如果你用 Render / Railway 等云服务,先在 dashboard 里手动触发一次 snapshot。

#### Step 2 — 安装依赖

迁移脚本只依赖标准库 + frontmatter。**你既然在用上游 OB,这个依赖大概率已经装过了,可跳过这步**;没装再:

```bash
pip install python-frontmatter
```

#### Step 3 — 检查(dry-run)

```bash
python migrate_from_upstream.py --buckets-dir ./buckets
```

输出会告诉你:
- 总共扫了多少个 bucket
- 几个需要迁移
- 哪些文件需要改、改什么
- 有没有解析失败的(罕见)

**如果报告"需要迁移: 0",你已经不用做任何事了**,直接启动服务即可。

#### Step 4 — 修复

```bash
python migrate_from_upstream.py --buckets-dir ./buckets --fix
```

会:
1. 把整个 `./buckets` 备份到 `./buckets.backup-时间戳/`
2. 逐个处理需要迁移的 bucket(写入新字段、清掉老字段、其他保留)
3. 报告成功 / 失败数量

#### Step 5 — 验证

```bash
# 再跑一次检查, 应该报告"需要迁移: 0"
python migrate_from_upstream.py --buckets-dir ./buckets
```

#### Step 6 — 启动服务

```bash
python server.py
```

---

## 不跑迁移工具行不行?

**也行,但不推荐**。

代码里有 `lazy migration` 机制:每次你 `update` 一条 bucket(标记噪声、改重要度等),它会顺手把那条的老字段转成新字段。

所以理论上**不跑工具直接启动也能用**。但有 2 个潜在问题:

1. **慢**:几十/几百条桶的迁移分散到日常使用中,每次操作都多一点 IO
2. **不确定**:你不知道哪些桶已经迁移、哪些还没,排查问题时多一层混乱

跑 5 分钟工具一次性 normalize,后面省心。

---

## 故障 FAQ

### Q1: 跑完 `--fix` 后有些桶看起来"score 不一样"了?

A: 默认参数完全和上游对齐(2026-05-03 起),理论上 score 不会变。但有 2 个可能:
- 你之前手动改过 `runtime_config.json` 里的衰减参数
- 你跑过 `--fix` 后 bucket 的 metadata 字段顺序变了(YAML 字段排序变化但语义不变)

进配置页 → 权重配置看一眼当前的 10 个参数,跟你预期的对照一下。

### Q2: embedding cache 要不要重做?

A: **不需要**。embedding 表的 schema 和上游完全一致,直接复用。

### Q3: 时间显示偏 8-9 小时?

A: 上游对时区处理有 bug,本版本统一用 UTC。如果你以前在中国/日本时区,可能会看到老桶时间显示有偏移。

**修复方法**:暂无自动迁移工具(因为不知道老数据是 UTC 还是本地时间),但**新桶的时间显示是对的**。老桶若偏移很影响:显示时间取 `event_time`(没有才回退 `created`)——手动改 `event_time` 即可纠正显示,没有 event_time 的桶则补一个。`last_active` 只影响衰减计时、不影响显示,可不管。

### Q4: trash/ 文件夹我没有,会出错吗?

A: 不会。本版本会按需自动创建 trash/ 目录。

### Q5: 我不小心跑了 `--fix` 但反悔了,怎么回滚?

A:

```bash
# 删掉迁移后的 buckets/
rm -rf ./buckets

# 恢复备份
mv ./buckets.backup-时间戳 ./buckets
```

### Q6: 迁移完想用 GitHub Actions 自动备份,怎么配?

A: 见 DEPLOY.md「自动备份配置」那节。需要一个私人 git repo 当备份目标 + 设置 `OMBRE_BACKUP_REPO` / `OMBRE_BACKUP_TOKEN` 环境变量。

### Q7: prompt 看着跟上游不太一样?

A: 本版本 6 个 prompt 里:
- DEHYDRATE / MERGE / ANALYZE 跟上游字节级一致
- DIGEST 在上游基础上加了一些功能性规则(查看原文锚点 / 事件时间推断 / 量表校准),已**去掉个人化称谓**
- REDEHYDRATE / REGEN_CONTENT 是本版本独创的(为"重新脱水"功能服务,上游没有)

**配置页 → Prompt 配置 → "⇆ 对齐原作者版本"按钮可以一键切回上游版**。

---

## 出问题怎么办

**先冷静**:

1. 你的原始 `buckets/` 备份在 `buckets.backup-时间戳/`,数据没丢
2. GitHub 仓库里有完整源码历史,代码层任何问题都能 reset

**遇到问题**:

- 报 bug / 反馈:开个 GitHub Issue(仓库顶部 **Issues** 标签 → New issue),写明你做了什么、期望什么、实际看到什么、报错日志(如有)
- 数据没丢(见上),代码层可随时 reset;不会造成不可逆的损失
- 这是个人自用版,我精力/时间有限,不保证及时响应或修复
- 需要稳定、及时的支持,建议使用 [原作者版本](https://github.com/P0luz/Ombre-Brain)

**回滚到上游版**:

回滚有**两条路,代价不同,二选一**(别串着跑)。

**路径 A · 回到迁移前的原始状态**(最简单,但丢失迁移后的新数据)

适合迁移后没产生重要新记忆、或想要干净上游起点的人:

```bash
# 数据:覆盖回迁移前的原始备份
rm -rf ./buckets
mv ./buckets.backup-original ./buckets

# 代码:切回上游
git remote add upstream https://github.com/P0luz/Ombre-Brain.git
git fetch upstream
git checkout upstream/main
```

⚠️ 这会丢失你在本 fork 期间产生 / 修改的所有记忆(回到 `buckets.backup-original` 那一刻)。

**路径 B · 保留所有数据,只把字段转回上游格式**(推荐给已用了一段时间的人)

适合迁移后积累了新记忆、不想丢、只是想让上游能读。

> 关于兼容方向:本版本能读上游数据;但上游**读不了**本版本写出的新字段(protected/highlight/internalized),所以回滚要先把字段转回去。

```bash
# 数据:先备份当前数据(reverse 脚本不自带备份), 再把新字段转回上游格式
cp -r ./buckets ./buckets.backup-before-rollback
python reverse_compat_migrate.py --dir ./buckets           # dry-run,先看会改什么
python reverse_compat_migrate.py --dir ./buckets --apply   # 确认无误后真写

# 代码:切回上游
git remote add upstream https://github.com/P0luz/Ombre-Brain.git
git fetch upstream
git checkout upstream/main
```

protected/highlight → pinned、internalized → digested,保留迁移后全部记忆,上游也能正常读。

---

最后:这套迁移工具是为了让你尽量安心地切到本版本。如果有 edge case 我没覆盖,欢迎反馈——但这是自用版,我精力有限,不保证及时处理。
