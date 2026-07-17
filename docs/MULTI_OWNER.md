# 多人共用，但记忆完全隔离

这里采用“每个人一个进程/容器”的硬隔离：端口、`OMBRE_BUCKETS_DIR`、`config.yaml`、管理员 Token 和 MCP URL Key 均独立。不会在同一个桶目录里靠 owner 字段做软隔离。

本机使用：

1. 复制 `deploy/owners.example.yaml` 为 `deploy/owners.yaml`。
2. 为每个人设置模板中指定的环境变量，例如 `OMBRE_MING_ADMIN_TOKEN`（至少 24 字符）。
3. 先运行 `python deploy/multi_owner.py --check`，确认端口、目录和 Secret 都合法。
4. 运行 `python deploy/multi_owner.py`。任一实例异常退出时，启动器会停止其余实例，避免留下半运行状态。

Docker 使用：

```text
docker compose -f deploy/docker-compose.multi.yml up -d --build
```

增加用户时复制一个 service，并确保宿主端口、数据卷、管理员 Token、MCP URL Key 都不同。示例默认只绑定 `127.0.0.1`；需要公网访问时，应在前面放 TLS 反向代理或 Tunnel。
