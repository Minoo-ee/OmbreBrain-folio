# 部署指南 · 本 fork 特有项

> **基础部署方式(Docker / 本地 / Obsidian 集成)请看 [README.md](./README.md)** — 那是原作者写的非常完整的指南。
> 本文档只补充本 fork 新增的部署选项。

## 一键部署到 Render(推荐云部署用户)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ceshihaox-dotcom/OmbreBrain-folio)

点上面按钮 → Render 会自动读 `render.yaml` → 你只需要填几个环境变量就完事:

**🔑 安全(Render 自动搞定,你不用填)**:
- `OMBRE_ADMIN_TOKEN` - **Render 会自动生成**一个强随机值(`render.yaml` 里 `generateValue: true`)。
  这是全局鉴权的门:除了静态页和 `/health`,所有 `/api/*` 和 `/mcp` 都必须带 `X-Admin-Token: <token>` header。
  → **默认就安全,不会裸奔,也不用你自己想密码。** 想用网页 / 接 claude.ai 时,到
  Render → 你的服务 → **Environment**,复制 `OMBRE_ADMIN_TOKEN` 的值(下面会用到)。
  (Docker / 手动部署没有自动生成,必须自己设一个,否则公网模式拒绝启动;确知私网/反代已鉴权可设 `OMBRE_ALLOW_NO_AUTH=1` 显式裸跑。)

**LLM 配置(强烈建议填)** — 不填服务也能启动, 但脱水/打标会降级为本地关键词提取, 质量差很多:
- `OMBRE_API_KEY` - 你的 LLM API key
- `OMBRE_BASE_URL` - 例 `https://api.deepseek.com/v1`
- `OMBRE_MODEL` - 例 `deepseek-chat`

**强烈推荐**(给云部署用户长期保命):
- `OMBRE_BACKUP_REPO` - 你的私人 backup repo(例 `github.com/yourname/my-ombre-backup`)
- `OMBRE_BACKUP_TOKEN` - GitHub Personal Access Token(权限 `repo`)

**可选**:
- `OMBRE_EMBED_API_KEY` + `OMBRE_EMBED_BASE_URL` - embedding 模型独立配置
- `OMBRE_ALLOWED_ORIGINS` - CORS 允许的浏览器跨源 origin(逗号分隔,默认仅同源,一般不用填)
- 其他配置见 [.env.example](./.env.example)

部署完成后访问:
- 主网页: `https://your-app.onrender.com/v2/`
- 控制台: `https://your-app.onrender.com/v2/console/`
- 手机端: `https://your-app.onrender.com/v2/mobile/`

**首次打开网页**会弹窗要 `X-Admin-Token` —— 粘贴上面从 Render Environment 复制的
`OMBRE_ADMIN_TOKEN` 值,存进浏览器 localStorage 后自动刷新,之后这台设备/浏览器就不用再输了。

### 接入说明(各客户端怎么带 token)
- **本地 stdio 模式**(Claude Desktop / Cursor 在本机直接跑 OB):**不需要 token**,鉴权只在
  公网 HTTP 模式生效,本地无感,跟以前一样用。
- **Claude Desktop / Cursor / Claude Code 等连远程 OB**:在 MCP 配置里加自定义 header
  `X-Admin-Token: <token>`(支持 header 字段的客户端直接填);不支持的用 `mcp-remote` 桥:
  ```jsonc
  // claude_desktop_config.json
  { "mcpServers": { "ombre-brain": {
    "command": "npx",
    "args": ["-y","mcp-remote","https://你的域名/mcp","--header","X-Admin-Token:${OMBRE_TOKEN}"],
    "env": { "OMBRE_TOKEN": "<粘贴 token>" }
  }}}
  ```
- **claude.ai 网页版自定义连接器**:**不支持自定义 header**(只有 URL + 可选 OAuth),
  所以不能用 `X-Admin-Token` 连。两条路:
  - **(推荐) Claude Desktop + 上面的 mcp-remote**,或本地 stdio 模式 —— 安全性最高。
  - **(可选 · Option ① · 把密钥放进 URL)** 如果你就是想用 claude.ai 网页版连:设一个
    **独立**的环境变量 `OMBRE_MCP_URL_KEY`(随机字符串、**URL 安全**,建议 hex,例
    `python -c "import secrets;print(secrets.token_hex(24))"`;**别**跟 `OMBRE_ADMIN_TOKEN` 同值),
    然后在 claude.ai 连接器 URL 里二选一(两种都支持):
    ```
    https://你的域名/<OMBRE_MCP_URL_KEY 的值>/mcp     ← 推荐(密钥在路径里,最稳)
    https://你的域名/mcp?key=<OMBRE_MCP_URL_KEY 的值>  ← 备选(密钥在 query)
    ```
    > 推荐**路径形态**:密钥在 URL 路径里、每个请求都必然带上,不依赖客户端是否在后续请求
    > 保留 query。两种都试过本地鉴权矩阵通过;若一种连不上/调几次掉线,换另一种。
    - **默认不设 `OMBRE_MCP_URL_KEY` = 这条口子关闭**,行为跟以前完全一样(纯 header)。
    - **它比 header 弱**:URL 里的密钥可能被人看到(分享截图 / 浏览器历史)。所以它**只开 `/mcp`**
      (读写删记忆),**打不开** `/api/*`(销毁/换模型/改配置那些仍只认 `X-Admin-Token`)。
      正因为权限更小,它跟主 token 分开、**可以单独轮换**(泄漏了只换这一个,不动主 token)。
    - **轮换**:在 Render Environment 改 `OMBRE_MCP_URL_KEY` 的值 → 重启 → 旧 URL 立刻失效,
      把新 URL 重新填进 claude.ai 连接器即可。
    - 服务端已对访问日志做脱敏:`?key=` 和路径里的密钥字面值都会被遮成 `***`,不进 uvicorn access log。
- **每日自动备份的 token**:若设了 `OMBRE_ADMIN_TOKEN`,备份工作流也要在仓库 Actions 里配同名 secret(否则 backup 401)——详见下文「自动备份配置」。

---

## 自动备份配置(强烈建议)

云部署的持久盘有概率出事(曾发生过环境变量错配导致约一周数据丢失的事故)。本 fork 自带每日自动备份机制。

**先理清两层**(最容易配错):
- **服务端负责真正备份** ← Render 服务上的 `OMBRE_BACKUP_REPO` + `OMBRE_BACKUP_TOKEN`(干活的)。`/api/backup` 要成功, 前提是这俩已配好。
- **GitHub Actions 只是定时闹钟** ← 代码仓库 Actions 里的 `OMBRE_BACKUP_URL`, 每天到点去 call 你服务的 `/api/backup`, 它自己不备份。

下面分步配:

### Step 1 — 建一个 backup repo

到 GitHub 建一个**空 private repo**,例如 `my-ombre-backup`。

### Step 2 — 创建 GitHub Token

[GitHub Settings → Developer settings → Personal access tokens](https://github.com/settings/tokens) → 生成新 token,只勾 `repo` 权限。

### Step 3 — 配置环境变量

```
OMBRE_BACKUP_REPO=https://github.com/yourname/my-ombre-backup   # 必须带 https://
OMBRE_BACKUP_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
OMBRE_BACKUP_USER=ombre-bot   # 可选,默认 ombre-bot
```

### Step 4 — 验证

部署后,POST `/api/backup` 手动触发一次:

```bash
# 设了 OMBRE_ADMIN_TOKEN(Render 默认会自动生成)→ 必须带 header:
curl -X POST https://your-app.onrender.com/api/backup \
  -H "X-Admin-Token: <你的 OMBRE_ADMIN_TOKEN>"

# 确知没设 token(本地 / 显式 OMBRE_ALLOW_NO_AUTH=1)才可以不带:
# curl -X POST https://your-app.onrender.com/api/backup
```

返回 `{"ok": true, "commit_sha": "..."}` 就是成了(不带 header 又设了 token 会 401)。

去你的 backup repo 看一下,应该有第一次提交。

### Step 5 — 启用每日 cron

GitHub Actions 工作流 `.github/workflows/daily-backup.yml` 已经写好了,只需在你 fork 的**代码仓库**里配置:

1. **必填 —— 一个 Variable(不是 Secret)**:
   - 仓库 → Settings → Secrets and variables → Actions → **Variables 标签页** → New repository variable
   - Name: `OMBRE_BACKUP_URL`
   - Value: `https://your-app.onrender.com` (你的部署域名,**不带尾斜杠、不带 `/api/backup`** —— 工作流会自己拼)
2. **仅当**你给服务设了 `OMBRE_ADMIN_TOKEN`,再加一个 **Secret**(Secrets 标签页):
   - Name: `OMBRE_ADMIN_TOKEN`,Value 跟服务端那个**完全一致**(否则备份会 401 失败)

完成后每天 **UTC 19:00**(= 北京 03:00 / JST 04:00)自动触发。(GitHub cron 走 UTC, yml 里写的是 `0 19 * * *`。)

> ⚠️ **重要(防"假装有备份")**: 如果没设 `OMBRE_BACKUP_URL`,工作流会**静默跳过、不报错也不备份**。配完**务必去 Actions 页面手动触发一次**(`每日备份 buckets` → Run workflow)确认跑出绿勾 + 你的 backup repo 里真有提交。别只配不验。

---

## 持久盘出事后,怎么从备份恢复

备份的终点是恢复。万一持久盘损坏 / 误删 / 平台故障,按这个流程把 backup repo 的数据恢复到新部署:

1. **拿到备份数据**: 把 backup repo clone 到本地
   ```bash
   git clone https://github.com/yourname/my-ombre-backup.git
   ```
2. **准备干净服务**: Render 新建服务(或对原服务重置持久盘),按上面「一键部署」配好环境变量
3. **把 buckets 放回持久盘**: 将 backup repo 里的 `buckets/` 内容放到持久盘挂载路径
   - Render 持久盘路径: `/opt/render/project/src/buckets`
   - 目前没有对称的 `/api/restore` 端点,这步是手动操作(Render Shell 放文件,或本地拷好整盘镜像)
4. **重启服务**
5. **验证**: 访问 `/health`(应返回 `{"status":"ok",...}`)和 `/v2/`,确认桶数跟备份时一致

> `embeddings.db`(向量库)若没一起恢复,语义检索会缺失——恢复后跑 `python backfill_embeddings.py` 重建即可,关键词检索不受影响。

---

## 从上游 Ombre-Brain 迁移过来?

如果你之前在用 [上游版本](https://github.com/P0luz/Ombre-Brain) 想换到本 fork,**先看 [MIGRATION.md](./MIGRATION.md)**。

简短版:

```bash
# 备份原数据
cp -r ./buckets ./buckets.backup-original

# 检查兼容性 (dry-run)
python migrate_from_upstream.py --buckets-dir ./buckets

# 一键 normalize 老字段 (自动备份)
python migrate_from_upstream.py --buckets-dir ./buckets --fix

# 启动
python server.py
```

详细 FAQ + 故障处理见 [MIGRATION.md](./MIGRATION.md)。

---

## 本 fork 跟上游有什么区别?

见 [CHANGES.md](./CHANGES.md) - 完整功能清单 + 透明披露所有改动。简短版:

- 全套新前端(timeline / cells / network / console / mobile)
- 工作流增强(导入工作台 / 重新脱水 / 软删除 / Prompt 编辑器 / 等)
- **核心记忆机制(衰减/做梦/feel/记忆桶/情感权重)跟上游完全一致**;检索/排序的命中精度做了优化(尤其中文)。配置页有"⇆ 对齐原作者版本"按钮可一键回上游 prompt

---

## 部署后的常见问题

### Render 冷启动很慢?
- 休眠的是 **免费层**(15 分钟无请求 spin down,首访要 30 秒醒)——而免费层本就没持久盘、不能用。**Starter 及以上付费实例一般不休眠。**
- 若仍遇到冷启动(或换了别的会休眠的平台): 用 [UptimeRobot](https://uptimerobot.com/) 每 5 分钟 ping 一下 `/health`,免费

### 持久盘满了?
- 默认 1GB。markdown 桶很小(200 条约 1MB),但**大头是向量库 `embeddings.db`**(3072 维,每条约 12KB)+ 脱水缓存——万条记忆光向量库约 100MB+
- 即便如此 1GB 通常能扛上万条;真满了到 Render dashboard 升级 disk size

### 想本地开发但又用云上的数据?
- 跑备份, 把私人 backup repo clone 到本地
- 把 `buckets/` 拷出来作为本地 OMBRE_BUCKETS_DIR

### 切换 LLM 不想改 .env 重启?
- 进 `/v2/console/config/` → API 配置 → 加多个 profile,一键切换不重启

### 语义 / 向量检索好像没生效?
- 向量化默认走 Gemini 的 `gemini-embedding-001`。如果你的主 `OMBRE_API_KEY` 不是 Gemini(比如填的是 DeepSeek),**且没单独设 `OMBRE_EMBED_API_KEY`**,embedding 会用那个不兼容的 key 调用失败 → **静默降级到纯关键词(fuzzy)**,你以为有语义检索其实没有。
- 解决: 单独设 `OMBRE_EMBED_API_KEY`(Gemini 的 key)和 `OMBRE_EMBED_BASE_URL`;或主 key 本就是 Gemini 则无需额外配。
