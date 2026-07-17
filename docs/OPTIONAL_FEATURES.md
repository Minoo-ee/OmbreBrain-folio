# 上游扩展能力：傻子版使用说明

这些能力已经接入，但默认不会擅自开公网、替换代码或重启服务。只想正常用记忆功能的人什么都不用做。

## 你最常用的新入口

- 桌面：`/v2/console/commitments/` 管计划、信件、Anchor 和自我认知。
- 手机：设置 →「关系 / 承诺」。
- 部署管理：`/v2/console/operations/`；手机设置里也有「部署与连接」。

计划、信件、自我认知拥有独立生命周期，不会混入普通 Breath/Dream。Anchor 也不会主动浮现，但手动检索仍能找到；默认最多 24 条。

## OAuth（客户端明确支持 OAuth 时再开）

1. 保留已经配置好的 `OMBRE_ADMIN_TOKEN`。
2. 设置稳定的公开地址，例如 `OMBRE_PUBLIC_BASE_URL=https://memory.example.com`。
3. 在「部署连接」把 MCP 鉴权切成 OAuth，或设置 `OMBRE_MCP_AUTH_MODE=oauth`。
4. 客户端仍连接 `https://memory.example.com/mcp`。它会自动发现 OAuth 元数据、注册公共客户端并打开授权页；在授权页输入管理员 Token。

OAuth 只给 `/mcp` 记忆读写能力，不给管理 API。授权码强制 PKCE S256，访问令牌一小时过期，刷新令牌使用一次就轮换；磁盘只保存令牌哈希。

## Cloudflare Quick Tunnel

1. 自己安装 `cloudflared`，或者设置 `OMBRE_CLOUDFLARED_PATH` 指向它。
2. 打开「部署连接」→ Tunnel → 启动。
3. 页面出现 `trycloudflare.com` 地址后即可访问。想随服务启动，勾选自动拉起。

程序不会静默下载二进制；Tunnel 只允许转发到本机 HTTP 端口。

## 云端 / 本地 Embedding

配置 →「向量化 Embedding」可以真实编辑：

- 云端：选 OpenAI 兼容或 Gemini，填模型和 Base URL，Key 继续用环境变量 `OMBRE_EMBED_API_KEY`。
- 本地：选 Ollama，常用模型 `bge-m3`；Base URL 留空即可自动使用本机（容器内会使用宿主地址）。

切成本地时不会把残留的云端 Key 发给 Ollama。切模型后旧向量不会跨空间混算，后台补账会逐步重建。

## 自更新与重启

默认只能“检查更新”。需要真正下载和应用时：

1. 设 `OMBRE_ENABLE_SELF_UPDATE=1`；默认更新源是 `ceshihaox-dotcom/OmbreBrain-folio`，不是上游仓库，因此不会主动拿上游前端覆盖你的版本。
2. 点「下载并暂存」：程序限制下载大小、防 ZIP 路径穿越，并对暂存代码跑 Python 编译检查。
3. 点「应用暂存版本」，按提示输入确认短语。应用前会先把当前程序代码压成备份；记忆目录、`.env`、`config.yaml` 和 Git 元数据不会替换。
4. 需要网页按钮重启时另设 `OMBRE_ENABLE_RESTART=1`。退出后必须由 Docker、Render、Railway 或 systemd 负责拉起。

有未提交的本地源码实验时不要点“应用”；Git 开发环境建议继续用正常的 fetch/merge 流程。

## 多人 / 多实例

不要让多人共用一个桶目录。按 [MULTI_OWNER.md](./MULTI_OWNER.md) 用每人独立的进程、端口、目录、管理员 Token 和 MCP Key。先运行：

```text
python deploy/multi_owner.py --check
```

检查通过后再去掉 `--check` 启动。

## 配额和开发数据清理

- 默认钉选总量 20；满额后新钉选会明确拒绝。
- 默认普通 `importance >= 9` 总量 24；满额后新写入自动降到 8。
- 可在 `config.yaml` 的 `limits.max_pinned` / `limits.max_high_importance` 调整，0 表示关闭对应限制。
- 「开发测试数据清理」只能物理删除创建时已经带 `test_data=true` 不可变来源标记的桶；普通记忆即使后来手改字段也不能走这条口子。

## Dream Hook

为兼容已有部署默认保留。它现在会排除计划、信件、自我认知、Anchor 和 `dont_surface` 内容，并继续受全局鉴权保护。不需要时在「部署连接」关闭，或设 `OMBRE_ENABLE_DREAM_HOOK=0`。
