# 更新日志 / Changelog

本 fork 以快照方式发布（无版本号），条目按日期记录。上游对齐条目会标注对应的上游版本。

## 2026-07-16 · 数据恢复、持久附件与体验元数据

- 新增 GitHub 备份只读校验与合并恢复：正式恢复前自动生成本地 ZIP，不删除本地独有记忆，并支持 Windows 深路径。
- 对齐持久媒体：`hold` / `trace` / 网页端可上传附件，Markdown 只存稳定引用；桌面、蜂窝和手机端可查看，备份恢复会一并校验附件。
- 对齐 `why_remembered`、可追加 `meaning`、`source_tool` 和 `grow_batch_id`；这些体验元数据可搜索但不改变衰减分数。
- 增加 ngrok 兼容响应头；保留本 fork 更严格的管理员令牌、同源 Cookie 与 CORS 安全边界。

## 2026-07-15 · 上游 2.7.0 体验与可靠性对齐

### 修复 / Fixed

- 同一记忆桶的更新、删除、恢复、归档、取消归档、永久删除和激活写入增加跨线程、跨事件循环、跨进程锁，避免并发读改写互相覆盖。
- embedding 补账熔断区分不同桶；同一条被供应商过滤的“毒内容”反复失败不再拖住所有新记忆。
- `config.yaml` 持久化改为跨进程锁定的原子读改写，并在写后回读验证。
- 导入断点身份绑定格式与分块策略；逐字导入恢复时精确去重；提取、落库和原文附加失败进入前端可见错误列表；移除旧的 12000 字符静默截断，超出 token 安全上限时明确告警。
- Windows Git 备份复制、遍历、哈希和 manifest 写入支持长路径及原子落盘。

### 优化 / Improved

- `breath()` 固定为零参数浮现，并拆出 `breath_search` 与 `breath_advanced`；`breath_legacy` 保留旧参数入口。
- Dashboard 搜索响应增加 `vector_status`、`vector_notice` 与 `X-Semantic-Search`，语义服务降级不再伪装为“零结果”。
- 向量余弦检索改为 NumPy 批量矩阵计算，并隔离坏向量及维度不匹配数据。

### 测试 / Tests

- 新增同桶并发、配置并发、导入截断与恢复去重、毒条目熔断、向量批处理、语义降级状态和 Windows 深路径备份回归；全量结果为 `92 passed, 7 skipped, 5 subtests passed`。

## 2026-07-14 · 安全对齐批次二（正确性 / 数据安全）

### 修复 / Fixed

- 搜索可见性过滤移到 `limit` 切片之前，feel / noise / pinned / trash 不再挤占有效结果窗口；命中统计也只记录调用方实际可见的结果。
- `hold()` 显式传入的 valence / arousal 优先于自动分析，合法的 `0.0` 不再被中和值覆盖；Feel 模式保留调用方 tags；grow 与合并路径同步修复 `0.0 or default`。
- 完整 bucket ID 查询直接返回原文，不再调用脱水模型。
- 脱水缓存绑定 base URL + model；embedding 新写入绑定 endpoint + model，并兼容 `bge-m3` / `bge-m3:latest` 别名。
- 软删除统一移出活跃向量索引，恢复时自动补建；向量检索额外防御性排除 trash。
- 活跃桶缓存改为每秒检查 path / mtime / size，Obsidian、Git 或手工改盘最多约 1 秒可见；可通过 `OMBRE_EXTERNAL_CHANGE_POLL_SECONDS` 调整。
- Windows 原子写入增加长路径前缀，同时保留 PermissionError 短重试。
- Git 备份只复制 Markdown 源数据，`runtime_config.json` 深度脱敏，排除 SQLite/缓存/日志，并生成逐文件 SHA256 manifest。
- 配置 API 的字符串 `"false"` 不再被 `bool()` 误判为开启；搜索 limit 加硬上限。

### 测试 / Tests

- 新增 `pytest.ini`，异步测试统一使用 auto 模式；修正 protected score 的过期断言。
- 新增离线回归：过滤前切片、外部编辑缓存、模型/endpoint 缓存隔离、备份脱敏与 manifest、显式零坐标、Feel tags、原文 ID 读取、软删除向量一致性。
- 全仓结果：`82 passed, 7 skipped, 5 subtests passed`。

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
