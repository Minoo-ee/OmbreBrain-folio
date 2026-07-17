#!/usr/bin/env python3
"""Launch isolated Ombre Brain processes for several owners.

Each owner gets a unique port, data directory, config file and authentication
environment.  Secrets are referenced by environment-variable name so they do
not have to be committed in owners.yaml.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "server.py"
DEFAULT_CONFIG = Path(__file__).resolve().parent / "owners.yaml"


def load_owners(config_path: str | os.PathLike[str]) -> list[dict[str, Any]]:
    path = Path(config_path).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"找不到 {path}；先复制 deploy/owners.example.yaml 为 deploy/owners.yaml")
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    rows = data.get("owners")
    if not isinstance(rows, list) or not rows:
        raise ValueError("owners 必须是非空列表")
    owners: list[dict[str, Any]] = []
    for index, row in enumerate(rows, 1):
        if not isinstance(row, dict):
            raise ValueError(f"第 {index} 个 owner 必须是映射")
        name = str(row.get("name") or "").strip()
        if not name or len(name) > 80:
            raise ValueError(f"第 {index} 个 owner 的 name 为空或过长")
        try:
            port = int(row.get("port"))
        except (TypeError, ValueError):
            raise ValueError(f"owner「{name}」的 port 必须是整数") from None
        if not 1024 <= port <= 65535:
            raise ValueError(f"owner「{name}」的 port 必须在 1024..65535")
        raw_dir = str(row.get("buckets_dir") or row.get("vault") or "").strip()
        if not raw_dir:
            raise ValueError(f"owner「{name}」缺 buckets_dir")
        buckets_dir = Path(raw_dir).expanduser()
        if not buckets_dir.is_absolute():
            buckets_dir = path.parent / buckets_dir
        admin_env = str(row.get("admin_token_env") or "").strip()
        if not admin_env or not admin_env.replace("_", "A").isalnum():
            raise ValueError(f"owner「{name}」需要合法的 admin_token_env")
        mcp_key_env = str(row.get("mcp_url_key_env") or "").strip()
        owners.append({
            "name": name,
            "port": port,
            "buckets_dir": str(buckets_dir.resolve()),
            "admin_token_env": admin_env,
            "mcp_url_key_env": mcp_key_env,
        })
    _validate_isolation(owners)
    return owners


def _validate_isolation(owners: list[dict[str, Any]]) -> None:
    ports = [owner["port"] for owner in owners]
    if len(ports) != len(set(ports)):
        raise ValueError("端口重复；每个 owner 必须使用不同端口")
    paths = [Path(owner["buckets_dir"]).resolve() for owner in owners]
    for index, left in enumerate(paths):
        for right in paths[index + 1:]:
            if left == right or left in right.parents or right in left.parents:
                raise ValueError("数据目录不能相同或互相嵌套，否则隔离/备份边界会混淆")


def build_env(
    owner: dict[str, Any],
    owner_count: int,
    base_env: dict[str, str] | None = None,
    secret_env_names: set[str] | None = None,
) -> dict[str, str]:
    source = dict(os.environ if base_env is None else base_env)
    admin_token = source.get(owner["admin_token_env"], "").strip()
    if len(admin_token) < 24:
        raise ValueError(f"{owner['admin_token_env']} 未设置或太短（至少 24 字符）")
    secret_names = set(secret_env_names or ())
    secret_names.add(owner["admin_token_env"])
    if owner.get("mcp_url_key_env"):
        secret_names.add(owner["mcp_url_key_env"])
    env = {key: value for key, value in source.items() if key not in secret_names}
    env.update({
        "OMBRE_OWNER_NAME": owner["name"],
        "OMBRE_OWNER_COUNT": str(owner_count),
        "OMBRE_PORT": str(owner["port"]),
        "OMBRE_BUCKETS_DIR": owner["buckets_dir"],
        "OMBRE_CONFIG_PATH": str(Path(owner["buckets_dir"]) / "config.yaml"),
        "OMBRE_TRANSPORT": "streamable-http",
        "OMBRE_ADMIN_TOKEN": admin_token,
    })
    env.pop("OMBRE_MCP_URL_KEY", None)
    mcp_key_env = owner.get("mcp_url_key_env") or ""
    if mcp_key_env:
        value = source.get(mcp_key_env, "").strip()
        if len(value) < 24:
            raise ValueError(f"{mcp_key_env} 未设置或太短（至少 24 字符）")
        env["OMBRE_MCP_URL_KEY"] = value
    return env


def main(argv: list[str]) -> int:
    args = list(argv[1:])
    check_only = "--check" in args
    args = [arg for arg in args if arg != "--check"]
    config_path = args[0] if args else str(DEFAULT_CONFIG)
    owners = load_owners(config_path)
    secret_names = {
        name for owner in owners
        for name in (owner.get("admin_token_env"), owner.get("mcp_url_key_env"))
        if name
    }
    environments = [build_env(owner, len(owners), secret_env_names=secret_names) for owner in owners]
    print(f"已验证 {len(owners)} 个隔离实例：")
    for owner in owners:
        print(f"  {owner['name']}  http://127.0.0.1:{owner['port']}  {owner['buckets_dir']}")
    if check_only:
        return 0
    processes: list[subprocess.Popen[Any]] = []
    try:
        for owner, env in zip(owners, environments):
            Path(owner["buckets_dir"]).mkdir(parents=True, exist_ok=True)
            process = subprocess.Popen([sys.executable, str(SERVER)], cwd=str(ROOT), env=env, shell=False)
            processes.append(process)
            print(f"  已启动 {owner['name']}（pid {process.pid}）")

        def stop_all(*_args: Any) -> None:
            for process in processes:
                if process.poll() is None:
                    process.terminate()
            for process in processes:
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()

        signal.signal(signal.SIGINT, stop_all)
        if hasattr(signal, "SIGTERM"):
            signal.signal(signal.SIGTERM, stop_all)
        while all(process.poll() is None for process in processes):
            processes[0].wait(timeout=1)
    except subprocess.TimeoutExpired:
        return main_wait(processes)
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
    return next((process.returncode for process in processes if process.returncode), 0) or 0


def main_wait(processes: list[subprocess.Popen[Any]]) -> int:
    while True:
        for process in processes:
            code = process.poll()
            if code is not None:
                for peer in processes:
                    if peer.poll() is None:
                        peer.terminate()
                return code
        try:
            processes[0].wait(timeout=1)
        except subprocess.TimeoutExpired:
            continue


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
