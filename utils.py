# ============================================================
# Module: Common Utilities (utils.py)
# 模块：通用工具函数
#
# Provides config loading, logging init, path safety, ID generation, etc.
# 提供配置加载、日志初始化、路径安全校验、ID 生成等基础能力
#
# Depended on by: server.py, bucket_manager.py, dehydrator.py, decay_engine.py
# 被谁依赖：server.py, bucket_manager.py, dehydrator.py, decay_engine.py
# ============================================================

import os
import re
import json
import time
import uuid
import yaml
import logging
from pathlib import Path
from datetime import datetime, date, timezone


def atomic_write_text(path: str, text: str) -> None:
    """原子写文本: 写临时文件 → fsync → os.replace 就位。(对齐上游 2.5.0 记忆安全)

    记忆桶是最不能丢的东西。普通 open("w") 写到一半被杀/断电/磁盘写满, 会把文件
    截断成半截甚至清空。这里保证任何读者或崩溃恢复只会看到「旧的完整版」或
    「新的完整版」, 绝不出现半截文件。os.replace 在同一文件系统上是原子替换
    (POSIX + Windows 均是)。临时名带 uuid: 并发写同一文件也不会撞同一个 .tmp。

    Windows: OneDrive/杀软/索引器可能短暂持有目标文件, 让 replace 报
    PermissionError(截断式写入反而能过) — 短重试 3 次, 仍失败则抛错。
    绝不回退成截断式写入: 报错可重试, 半截文件才是不可挽回的。
    """
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    tmp = f"{path}.{uuid.uuid4().hex}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        for attempt in range(3):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if attempt == 2:
                    raise
                time.sleep(0.05)
    except Exception:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        raise


def sideline_stale_dest(dest: str) -> None:
    """移动/归档目标已存在同名文件时, 把旧文件旁置为 <name>.stale-<ts>。(对齐上游 2.5.0 防撞名)

    同名只可能是历史崩溃/rename 失败留下的同一桶陈旧副本(文件名含桶 id, 不同桶不会同名)。
    直接 shutil.move 的行为不可控: POSIX 静默覆盖(陈旧副本可能含新副本没有的内容), Windows
    直接抛错。旁置后缀不以 .md 结尾 → 所有桶扫描(_find_bucket_file/list_all)自动忽略,
    既不丢字节也不产生重复 id。
    """
    if not os.path.exists(dest):
        return
    ts = datetime.now().strftime("%Y%m%dT%H%M%S")
    stale = f"{dest}.stale-{ts}"
    if os.path.exists(stale):
        stale = f"{dest}.stale-{ts}-{uuid.uuid4().hex[:6]}"
    os.replace(dest, stale)
    logging.getLogger("ombre_brain.utils").warning(
        f"移动目标已存在同名文件, 旧副本已旁置 / sidelined stale duplicate: {stale}"
    )


def positive_float(value, default: float) -> float:
    """把 config/env 里的数值安全归一成正浮点; 非法/非正值回退 default。(对齐上游 2.4.5)"""
    try:
        f = float(value)
        return f if f > 0 else float(default)
    except (TypeError, ValueError):
        return float(default)


_BOOL_TRUE = {"1", "true", "yes", "on"}
_BOOL_FALSE = {"0", "false", "no", "off", ""}


def coerce_bool(value, default: bool = False) -> bool:
    """把 config/env 里的布尔值安全归一。(对齐上游 2.5.3)

    YAML/JSON 里写成带引号的 "false"/"0" 会被解析成字符串, bool("false") == True
    静默把开关误开。认不出的字符串按 default 处理。
    """
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        s = value.strip().lower()
        if s in _BOOL_TRUE:
            return True
        if s in _BOOL_FALSE:
            return False
        return default
    return bool(value)


def clean_llm_json(raw: str) -> str:
    """从 LLM 回复中抠出完整 JSON 值。(对齐上游 2.4.6, 提取策略有意比上游严)

    模型(尤其 DeepSeek)偶尔在 JSON 前后附带说明文字或 Markdown 围栏。
    整体可直接 parse 时原样返回; 否则扫描平衡的数组/对象取**最后一个**——
    说明文字里的格式示例(如「请按 {"k": 0.5} 的格式」)通常出现在真实结果之前,
    上游取第一个会把示例当结果吞进去。找不到平衡值时原样返回,
    让调用方的 json.loads 照常报错走既有兜底。
    """
    cleaned = (raw or "").strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    try:
        json.loads(cleaned)
        return cleaned
    except json.JSONDecodeError:
        pass
    decoder = json.JSONDecoder()
    last = None
    idx = 0
    while idx < len(cleaned):
        if cleaned[idx] not in "[{":
            idx += 1
            continue
        try:
            _value, end = decoder.raw_decode(cleaned[idx:])
        except json.JSONDecodeError:
            idx += 1
            continue
        last = cleaned[idx:idx + end].strip()
        idx += end
    return last if last is not None else cleaned


def parse_iso_datetime(value) -> datetime:
    """把任意时间元数据(ISO 字符串/带 Z 或 offset/datetime/date 对象)解析成 naive UTC datetime。
    (对齐上游 2.5.3 时区统一)

    本仓写侧一律 UTC(now_iso() 带 Z 后缀; 旧代码 utcnow() 无 Z), 但读侧曾直接
    fromisoformat: 带 Z 的字符串在 py3.11+ 解析成 offset-aware, 和 naive 的
    now()/utcnow() 相减直接 TypeError → 各处 except 兜底把桶一律当"30 天前",
    衰减和检索新鲜度分全部失真。统一从这里解析: aware → 转 UTC 去 tzinfo;
    naive 字符串按 UTC 对待(与写侧一致; 上游迁移来的本地时间戳最多差一个时区,
    对天级衰减可忽略)。解析失败抛 ValueError/TypeError, 兜底由调用方决定。
    """
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        parsed = datetime.combine(value, datetime.min.time())
    else:
        raw = str(value or "").strip()
        if not raw:
            raise ValueError("empty datetime")
        if raw[-1:] in ("z", "Z"):
            raw = raw[:-1] + "+00:00"
        parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def days_since_iso(value, fallback_days: float = 30.0) -> float:
    """解析时间元数据, 返回"距现在多少天"(≥0 浮点)。解析失败返回 fallback_days。
    比较基准 utcnow(与存储侧 UTC 一致), 不再用本地 now() 引入时区偏移。"""
    try:
        t = parse_iso_datetime(value)
        return max(0.0, (datetime.utcnow() - t).total_seconds() / 86400.0)
    except (ValueError, TypeError):
        return float(fallback_days)


def load_config(config_path: str = None) -> dict:
    """
    Load configuration file.
    加载配置文件。

    Priority: environment variables > config.yaml > built-in defaults.
    优先级：环境变量 > config.yaml > 内置默认值。
    """
    # --- Built-in defaults (fallback so it runs even without config.yaml) ---
    # --- 内置默认配置（兜底，保证即使没有 config.yaml 也能跑）---
    defaults = {
        "transport": "stdio",
        "log_level": "INFO",
        "buckets_dir": os.path.join(os.path.dirname(os.path.abspath(__file__)), "buckets"),
        "merge_threshold": 75,
        "auto_merge": True,   # False = 关闭相似桶自动合并(永远新建); 默认 True = 上游行为不变
        "dehydration": {
            "model": "deepseek-chat",
            "base_url": "https://api.deepseek.com/v1",
            "api_key": "",
            "max_tokens": 1024,
            "temperature": 0.1,
        },
        "decay": {
            "lambda": 0.05,
            "threshold": 0.3,
            "check_interval_hours": 24,
            "emotion_weights": {
                "base": 1.0,
                "arousal_boost": 0.8,
            },
        },
        "matching": {
            "fuzzy_threshold": 50,
            "max_results": 5,
        },
    }

    # --- Load user config from YAML file ---
    # --- 从 YAML 文件加载用户自定义配置 ---
    if config_path is None:
        config_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "config.yaml"
        )

    config = defaults.copy()
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                file_config = yaml.safe_load(f) or {}
            if isinstance(file_config, dict):
                config = _deep_merge(defaults, file_config)
            else:
                logging.warning(
                    f"Config file is not a valid YAML dict, using defaults / "
                    f"配置文件不是有效的 YAML 字典，使用默认配置: {config_path}"
                )
        except yaml.YAMLError as e:
            logging.warning(
                f"Failed to parse config file, using defaults / "
                f"配置文件解析失败，使用默认配置: {e}"
            )

    # --- Environment variable overrides (highest priority) ---
    # --- 环境变量覆盖敏感/运行时配置（优先级最高）---
    env_api_key = os.environ.get("OMBRE_API_KEY", "")
    if env_api_key:
        config.setdefault("dehydration", {})["api_key"] = env_api_key

    env_base_url = os.environ.get("OMBRE_BASE_URL", "")
    if env_base_url:
        config.setdefault("dehydration", {})["base_url"] = env_base_url

    env_model = os.environ.get("OMBRE_MODEL", "")
    if env_model:
        config.setdefault("dehydration", {})["model"] = env_model

    # Embedding 单独的 API key + base url(默认 fallback 到 dehydration)
    env_embed_key = os.environ.get("OMBRE_EMBED_API_KEY", "")
    if env_embed_key:
        config.setdefault("embedding", {})["api_key"] = env_embed_key
    env_embed_base = os.environ.get("OMBRE_EMBED_BASE_URL", "")
    if env_embed_base:
        config.setdefault("embedding", {})["base_url"] = env_embed_base
    # embedding 模型名独立可配 — 让"换 embedding 供应商"真正等于改 env + 跑一次 backfill
    env_embed_model = os.environ.get("OMBRE_EMBED_MODEL", "")
    if env_embed_model:
        config.setdefault("embedding", {})["model"] = env_embed_model

    env_transport = os.environ.get("OMBRE_TRANSPORT", "")
    if env_transport:
        config["transport"] = env_transport

    env_buckets_dir = os.environ.get("OMBRE_BUCKETS_DIR", "")
    if env_buckets_dir:
        config["buckets_dir"] = env_buckets_dir

    # auto_merge 开关 — OMBRE_AUTO_MERGE=false 关闭相似桶自动合并(默认 True = 上游行为不变)
    env_auto_merge = os.environ.get("OMBRE_AUTO_MERGE", "")
    if env_auto_merge.strip():
        config["auto_merge"] = env_auto_merge.strip().lower() in ("1", "true", "yes", "on")

    # --- runtime_config.json 覆盖 (前端 config 页可改,持久盘) ---
    # 优先级:runtime_config.json > env vars > config.yaml > 默认
    # 文件位置:{buckets_dir}/runtime_config.json
    try:
        rc_path = os.path.join(config.get("buckets_dir", "./buckets"), "runtime_config.json")
        if os.path.exists(rc_path):
            with open(rc_path, "r", encoding="utf-8") as f:
                rc = json.load(f)
            # API profile 激活
            active_id = rc.get("active")
            profiles = rc.get("profiles", {})
            if active_id and active_id in profiles:
                p = profiles[active_id]
                if p.get("api_key"):
                    config.setdefault("dehydration", {})["api_key"] = p["api_key"]
                if p.get("base_url"):
                    config.setdefault("dehydration", {})["base_url"] = p["base_url"]
                if p.get("model"):
                    config.setdefault("dehydration", {})["model"] = p["model"]
            # 策略参数(合并阈值 / max_recall)
            strategy = rc.get("strategy", {})
            if strategy.get("merge_threshold") is not None:
                config["merge_threshold"] = int(strategy["merge_threshold"])
            if strategy.get("auto_merge") is not None:
                # coerce_bool: 手编 runtime_config.json 写成 "false" 字符串也不误开
                config["auto_merge"] = coerce_bool(strategy["auto_merge"], default=True)
            if strategy.get("max_recall") is not None:
                config.setdefault("matching", {})["max_results"] = int(strategy["max_recall"])
    except Exception:
        pass  # runtime config 出问题不影响启动,沉默退化到 env/yaml

    # --- Validate bucket storage path before touching the filesystem ---
    # --- 启动期校验存储路径，防止配错把数据写到非持久位置 ---
    # 历史踩坑(2026-04-26):OMBRE_BUCKETS_DIR 在 Render dashboard 里被填成了
    # 字面字符串 "OMBRE_BUCKETS_DIR" 而不是路径,os.path.join 把它当相对路径
    # 解析成 ./OMBRE_BUCKETS_DIR/,数据写到容器临时盘上;持久盘 mount 在
    # /opt/render/project/src/buckets/ 历来一字节都没收到。redeploy 时
    # 临时盘擦除 → 数据全丢。这个 check 让此类错配在启动期立刻报错。
    buckets_dir = config["buckets_dir"]
    if not os.path.isabs(buckets_dir):
        raise RuntimeError(
            f"buckets_dir must be an absolute path, got {buckets_dir!r}. "
            f"This often means OMBRE_BUCKETS_DIR was accidentally set to the "
            f"variable name instead of the path. "
            f"Set it to e.g. /opt/render/project/src/buckets (Render) "
            f"or /data (Docker)."
        )

    # --- Ensure bucket storage directories exist ---
    # --- 确保记忆桶存储目录存在 ---
    for subdir in ["permanent", "dynamic", "archive"]:
        os.makedirs(os.path.join(buckets_dir, subdir), exist_ok=True)

    # 启动期把最终解析到的存储路径打到日志,出问题时一眼看到。
    logging.info(f"Bucket storage path resolved to: {buckets_dir!r}")

    return config


# =============================================================
# LLM 调用开销估算 — 给前端显示"刚那次花了多少钱"用,数字仅供参考
# 价格 = USD per 1M tokens,(input, output) 元组
# 模型名按前缀匹配,未知模型返回 None(前端显示"未估算")
# =============================================================
LLM_PRICING = {
    "claude-sonnet-4-6":  (3.00, 15.00),
    "claude-sonnet-4":    (3.00, 15.00),
    "claude-sonnet":      (3.00, 15.00),
    "claude-haiku-4-5":   (1.00,  5.00),
    "claude-haiku":       (1.00,  5.00),
    "claude-opus":        (15.00, 75.00),
    "gemini-2.5-flash":   (0.075,  0.30),
    "gemini-2.0-flash":   (0.075,  0.30),
    "gemini-2.5-pro":     (1.25,  10.00),
    "gemini-1.5-flash":   (0.075,  0.30),
    "gemini-1.5-pro":     (1.25,  10.00),
    "deepseek-chat":      (0.14,   0.28),
    "deepseek-reasoner":  (0.55,   2.19),
    "qwen-max":           (0.40,   1.60),
    "qwen-plus":          (0.10,   0.30),
    "gpt-4.1":            (2.00,   8.00),
    "gpt-4o-mini":        (0.15,   0.60),
    "gpt-4o":             (2.50,  10.00),
}

def estimate_llm_cost(model: str, prompt_tokens: int, completion_tokens: int) -> dict:
    """返回 {usd, cny, in_tokens, out_tokens, model_matched, known}"""
    if not model:
        return {"usd": 0.0, "cny": 0.0, "in_tokens": prompt_tokens or 0, "out_tokens": completion_tokens or 0, "model_matched": "", "known": False}
    m = model.lower()
    # 精确匹配优先,失败按最长前缀匹配
    matched_key = None
    if m in LLM_PRICING:
        matched_key = m
    else:
        for k in sorted(LLM_PRICING.keys(), key=len, reverse=True):
            if m.startswith(k) or k in m:
                matched_key = k
                break
    if not matched_key:
        return {"usd": 0.0, "cny": 0.0, "in_tokens": prompt_tokens or 0, "out_tokens": completion_tokens or 0, "model_matched": "", "known": False}
    p_in, p_out = LLM_PRICING[matched_key]
    p_tok = max(0, int(prompt_tokens or 0))
    c_tok = max(0, int(completion_tokens or 0))
    usd = (p_tok / 1_000_000) * p_in + (c_tok / 1_000_000) * p_out
    return {
        "usd": round(usd, 6),
        "cny": round(usd * 7.2, 4),  # 估算汇率
        "in_tokens": p_tok,
        "out_tokens": c_tok,
        "model_matched": matched_key,
        "known": True,
    }


def normalize_event_time(s):
    """把任意 event_time 输入(YYYY-MM-DD / 完整 ISO 时间戳 / datetime 对象)
    标准化成 ISO 格式字符串。无效输入或空字符串返回 None。
    用于 hold/grow/trace/import 路径校验用户/AI 提供的事件时间。"""
    if s is None:
        return None
    if isinstance(s, str):
        s = s.strip()
        if not s:
            return None
    try:
        if isinstance(s, date) and not isinstance(s, datetime):
            return s.isoformat()  # 纯日期对象保持 YYYY-MM-DD 短格式
        # datetime 对象或字符串: 统一走 parse_iso_datetime(naive UTC),
        # 防带 Z/offset 的输入把 "+00:00" 混进存储(对齐上游 2.5.3)
        return parse_iso_datetime(s).isoformat()
    except (ValueError, TypeError):
        return None


def is_protected(meta: dict) -> bool:
    """读"防自动衰减归档"标记,兼容旧字段名 `pinned`。
    优先用新字段 `protected`,完全没设过才退回旧字段 `pinned`。
    历史(2026-04-26):pinned 之前耦合了"防衰减"+"作为核心准则浮现"两件事,
    切片 4 拆成 protected(防衰减) + highlight(浮现优先) 两个独立轴。
    旧 pinned=True 的桶在迁移前继续被读成 protected+highlight 都 True。"""
    if not isinstance(meta, dict):
        return False
    if "protected" in meta:
        return bool(meta.get("protected"))
    return bool(meta.get("pinned", False))


def is_highlighted(meta: dict) -> bool:
    """读"breath 浮现时作为核心准则置顶"标记,兼容旧字段名 `pinned`。
    跟 is_protected 是镜像:优先用新字段 highlight,没设过退回旧 pinned。"""
    if not isinstance(meta, dict):
        return False
    if "highlight" in meta:
        return bool(meta.get("highlight"))
    return bool(meta.get("pinned", False))


def is_internalized(meta: dict) -> bool:
    """读"已内化"标记,兼容旧字段名 `digested`。
    优先用新字段 `internalized`(即使是 False 也以它为准),
    只在 `internalized` 完全没设过时才退回旧字段 `digested`。
    历史(2026-04-26):字段从 digested 重命名为 internalized,
    语义改为"用户手动隐藏不浮现"(原本跟 feel 写入耦合,跟权重无关)。"""
    if not isinstance(meta, dict):
        return False
    if "internalized" in meta:
        return bool(meta.get("internalized"))
    return bool(meta.get("digested", False))


def _deep_merge(base: dict, override: dict) -> dict:
    """
    Deep-merge two dicts; override values take precedence.
    深度合并两个字典，override 的值覆盖 base。
    """
    result = base.copy()
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def setup_logging(level: str = "INFO") -> None:
    """
    Initialize logging system.
    初始化日志系统。

    Note: In MCP stdio mode, stdout is occupied by the protocol;
    logs must go to stderr.
    注意：MCP stdio 模式下 stdout 被协议占用，日志只能走 stderr。
    """
    log_level = getattr(logging, level.upper(), None)
    if not isinstance(log_level, int):
        log_level = logging.INFO

    logging.basicConfig(
        level=log_level,
        format="[%(asctime)s] %(name)s %(levelname)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=[logging.StreamHandler()],  # StreamHandler defaults to stderr
    )


def generate_bucket_id() -> str:
    """
    Generate a unique bucket ID (12-char short UUID for readability).
    生成唯一的记忆桶 ID（12 位短 UUID，方便人类阅读）。
    """
    return uuid.uuid4().hex[:12]


def strip_wikilinks(text: str) -> str:
    """
    Remove Obsidian wikilink brackets: [[word]] → word
    去除 Obsidian 双链括号
    """
    return re.sub(r"\[\[([^\]]+)\]\]", r"\1", text) if text else text


def sanitize_name(name: str) -> str:
    """
    Sanitize bucket name, keeping only safe characters.
    Prevents path traversal attacks (e.g. ../../etc/passwd).
    清洗桶名称，只保留安全字符。防止路径遍历攻击。
    """
    if not isinstance(name, str):
        return "unnamed"
    # \u767d\u540d\u5355: \w (UNICODE \u5b57\u6bcd\u6570\u5b57\u4e0b\u5212\u7ebf + CJK) + \u7a7a\u767d + \u5e38\u7528\u4e2d\u82f1\u6587\u6807\u70b9
    # \u8def\u5f84\u654f\u611f\u5b57\u7b26 (/ \ : * < > | " ?) \u4ecd\u7136\u8fc7\u6ee4\u6389, \u8de8\u5e73\u53f0\u6587\u4ef6\u7cfb\u7edf\u90fd\u5b89\u5168
    # \u201c\u201d (\u4e2d\u6587\u53cc\u5f15\u53f7 "" ) + \u2018\u2019 (\u4e2d\u6587\u5355\u5f15\u53f7 '' ) \u52a0\u8fdb\u767d\u540d\u5355 \u2014 \u6807\u9898\u91cc\u4fdd\u7559
    cleaned = re.sub(
        r"[^\w\s\u4e00-\u9fff\-.,!()'\u3002\u3001\uff0c\uff01\uff1f\uff08\uff09\u300c\u300d\u201c\u201d\u2018\u2019\u00b7\u2014\u2026]",
        "",
        name,
        flags=re.UNICODE,
    )
    # \u8def\u5f84\u904d\u5386\u9632\u5fa1: .. \u6216\u66f4\u591a\u8fde\u7eed . \u6298\u6210\u5355\u4e2a
    cleaned = re.sub(r"\.{2,}", ".", cleaned)
    # \u9996\u90e8 . \u53bb\u6389 (\u907f\u514d .hidden / \u9690\u5f0f\u76f8\u5bf9\u8def\u5f84)
    cleaned = cleaned.lstrip(".")
    cleaned = cleaned.strip()[:80]
    return cleaned if cleaned else "unnamed"


def safe_path(base_dir: str, filename: str) -> Path:
    """
    Construct a safe file path, ensuring it stays within base_dir.
    Prevents directory traversal.
    构造安全的文件路径，确保最终路径始终在 base_dir 内部。
    """
    base = Path(base_dir).resolve()
    target = (base / filename).resolve()
    if not str(target).startswith(str(base)):
        raise ValueError(
            f"Path safety check failed / 路径安全检查失败: "
            f"{target} is not inside / 不在 {base} 内"
        )
    return target


def count_tokens_approx(text: str) -> int:
    """
    Rough token count estimate.
    粗略估算 token 数。

    Chinese ≈ 1 char = 1.5 tokens, English ≈ 1 word = 1.3 tokens.
    Used to decide whether dehydration is needed; precision not required.
    中文 ≈ 1字=1.5token，英文 ≈ 1词=1.3token。
    用于判断是否需要脱水压缩，不追求精确。
    """
    if not text:
        return 0
    chinese_chars = len(re.findall(r"[\u4e00-\u9fff]", text))
    english_words = len(re.findall(r"[a-zA-Z]+", text))
    return int(chinese_chars * 1.5 + english_words * 1.3 + len(text) * 0.05)


def now_iso() -> str:
    """
    Return current UTC time as ISO format string with explicit Z suffix.
    返回当前 UTC 时间,带 Z 标记。前端按本地时区显示。
    历史(2026-04-28):之前用 datetime.now() 在 UTC 容器里产 naive ISO,
    JST 用户前端看时间偏移 9 小时,改成显式标 UTC 让前端能正确转换。
    """
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"
