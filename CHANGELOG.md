# 更新日志 / Changelog

本 fork 以快照方式发布（无版本号），条目按日期记录。上游对齐条目会标注对应的上游版本。

## 2026-07-10 · 上游对齐批次一（v2.3.19 → v2.5.3 修复类）

从上游两条版本线（v2.4.x / v2.5.x）移植的修复与健壮性改动。功能类（OAuth、multi-owner、目录模式等）不在本批，另行评估。

### 修复 / Fixed

- **记忆桶原子写**（上游 2.5.0）：所有桶 `.md` 写入改为 临时文件 + fsync + `os.replace`，进程被杀/断电/磁盘写满不再产生半截文件；`runtime_config.json`、导入进度、命中统计等原有的手搓原子写一并收敛到同一 helper（补上 fsync）。Windows 下目标文件被同步盘/杀软短暂占用导致 `os.replace` 报 PermissionError 时短重试 3 次，仍失败则报错（不回退成截断式写入）。归档/回收站/恢复等移动操作补防撞名：目标已有同名文件时旁置为 `.stale-<时间戳>`（不带 `.md` 后缀，桶扫描自动忽略），不覆盖、不报错。
- **时间戳时区统一**（上游 2.5.3）：`created`/`last_active` 带 `Z` 后缀（本仓写入格式）或 UTC offset（导入数据）时，衰减引擎与检索时间新鲜度曾因 naive/aware 相减 `TypeError` 一律走 30 天兜底——**衰减打分对几乎所有桶失真，自动归档事实上从未生效**。统一经 `parse_iso_datetime`（naive UTC 口径）解析后恢复真实天数。注意：修复后第一次衰减周期，长期未激活的低重要度桶会按设计归档（归档可恢复、关键词仍可检索）。
- **桶元数据时间字段序列化归一**（上游 2.4.4）：YAML 把不带引号的时间戳解析成 `datetime` 对象，曾导致 dashboard 列表/详情、导入页、`dream()` 排序在遇到上游迁移桶时报错。读取层统一归一为 ISO 字符串。
- **LLM 回复 JSON 宽松解析**（上游 2.4.6，提取策略有意比上游严）：新增 `clean_llm_json()`，容忍 DeepSeek 等模型在 JSON 前后附带说明文字。整体可解析时原样返回；否则取**最后一个**平衡 JSON 值——上游取第一个，会把说明文字里的格式示例（如「请按 `{"k": 0.5}` 的格式」）当成结果吞进去。接入打标、日记拆分、正文重写、批量导入抽取五个解析点。
- **配置布尔安全归一**（上游 2.5.3）：YAML/JSON 里写成带引号的 `"false"`/`"0"` 不再被当作开启。涉及 embedding 开关、检索模式开关、auto_merge。

- **家族自动重建的时区偏移**：`built_at`（本地时间）与桶 `created`（UTC）曾直接字符串比较，JST 环境下"有没有新桶"的判断被压住最多 9 小时。families 状态时间戳改 UTC+Z 口径、比较改解析后进行；旧格式状态视为需要重建，一次收敛。

### 优化 / Improved

- **检索响应性能**（上游 2.5.0）：`list_all()` 活跃桶集内存缓存（写操作失效、touch/时间涟漪就地更新、命中返回逐桶拷贝防检索打分字段污染缓存、60 秒 TTL 兜底外部直接改盘的场景）；breath 浮现结果分波并发脱水（每波 4 条、波间检查 token 预算，不为被裁剪的结果整批调用 LLM）；touch 及时间涟漪移出 breath 响应路径改为后台补账。语义保留：last_active / activation_count / 涟漪照旧；取舍：进程在响应后、后台补账前被杀（重启/部署瞬间）会丢那一次激活计数，属可自愈的启发式数据。
- **embedding 进程内 LRU 查询缓存**（上游 2.4.13）：同一模型同一文本短时间内的重复向量请求只打一次 API。
- **API 超时可配**（上游 2.4.5）：新增 `dehydration.timeout_seconds` / `embedding.timeout_seconds`，环境变量 `OMBRE_COMPRESS_TIMEOUT_SECONDS` / `OMBRE_EMBED_TIMEOUT_SECONDS`。默认值不变（60 / 30 秒）。

### 已核对、无需移植 / Verified not applicable

- 上游 2.4.13 的"写入路径双重 embedding"：本 fork 的 `BucketManager` 不在内部生成向量，显式调用是唯一路径，无此问题。
- 上游 2.5.2 的"hold 降级保存"：本 fork 写入链路已是失败安全（打标失败用默认元数据照存正文；embedding 失败桶照写、事后 backfill；合并失败回落新建桶）。上游"合并只追加原文不走 LLM"的行为变更未采纳，本 fork 保留 LLM 智能合并。

### 测试 / Tests

- 新增 `tests/test_upstream_align_tier1.py`（21 例）：原子写、撞名旁置、时区解析各输入形态、clean_llm_json、时间字段归一、布尔/数值归一、活跃集缓存全生命周期、embedding LRU。
- 存量测试与基线逐项一致（3 failed / 20 errors 为预先存在的 pytest 9 环境兼容问题与已知的 permanent 打分期望值噪音，非本批引入）。
