# RaidenShinBoot

RaidenShinBoot 是一个面向 Telegram 机器人的 TypeScript monorepo，核心人格为《原神》中的雷电真。项目使用 grammY 实现 bot，Hono 提供 typed API，PostgreSQL + Drizzle ORM + pgvector `halfvec(512)` 提供本地向量记忆检索，并包含 React 19 + Refine v4 + Tailwind CSS v4 管理后台。

## 技术栈

- `pnpm` workspace，包含 `shared`、`database`、`boot`、`bot`、`server`、`panel`
- grammY Telegram bot
- Hono 链式路由，`AppType` 通过 `hono/client` 传给管理后台
- PostgreSQL、Drizzle ORM、`pgvector` `halfvec(512)`、HNSW 向量索引
- React 19、Refine v4、Tailwind CSS v4、Vite
- Vercel AI SDK v6，兼容 OpenAI 风格 relay 的 chat、image 能力
- 本地 BGE-small-zh-v1.5 CPU embedding sidecar，提供 OpenAI-compatible `/v1/embeddings`
- `tsdown` 负责 package 构建，Vite 负责 panel 构建

## 快速启动

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres redis embedding
pnpm db:migrate
pnpm db:backfill-embeddings
ADMIN_USERNAME=owner ADMIN_PASSWORD='replace-with-a-long-password' pnpm admin:bootstrap
pnpm test:e2e
pnpm dev:server
pnpm dev:panel
pnpm dev:bot
pnpm dev:worker
```

启动 bot 前，需要在 `.env` 中填写 `BOT_TOKEN` 和 AI relay key。语言与图片任务走 relay；embedding 默认只访问本机 sidecar，不需要远程 key。`/model`、`/provider`、`/status` 只允许 `BOT_ADMIN_IDS` 中的 Telegram 用户使用。

配置 `REDIS_URL` 后会启用 BullMQ 队列、Telegram webhook 入队、异步图片/提醒/记忆任务和 L1/L2 语义响应缓存。没有 Redis 时，本地 polling 对话仍可工作，长期记忆会回退到 inline 创建；图片和提醒命令会明确返回队列不可用，webhook 入队会稳定返回 503。

webhook 模式需要设置 `BOOT_TELEGRAM_WEBHOOK_SECRET`，并在 Telegram 侧把 update 发到 `POST /api/telegram/webhook`，同时使用同一个值作为 `secret_token`。运行 `pnpm dev:worker` 消费 Telegram update、记忆、图片和提醒队列。

可以设置 `BOT_RUNTIME_MODE=polling` 或 `BOT_RUNTIME_MODE=worker` 作为启动保护，避免把错误进程启动到错误部署槽位。

本地测试管理后台时，浏览器 host 和 `VITE_API_BASE_URL` host 要保持一致。例如 `http://localhost:5173` 搭配 `http://localhost:8787`，或 `http://127.0.0.1:5173` 搭配 `http://127.0.0.1:8787`。管理后台 session cookie 绑定 host，混用 `localhost` 和 `127.0.0.1` 会导致已登录请求看起来像未授权。

远程部署时，panel 镜像构建参数 `VITE_API_BASE_URL` 必须指向浏览器可访问的 API 地址，例如 `https://api.example.com`；API 服务的 `CORS_ALLOWED_ORIGINS` 必须包含 panel 的访问源，例如 `https://panel.example.com`。多个源用英文逗号分隔。管理后台 session cookie 使用 `SameSite=Strict`，panel 和 API 应部署在同一 site 下，例如 `https://panel.example.com` 和 `https://api.example.com`；不要把两者拆到不同主域。HTTPS 生产部署必须设置 `ADMIN_SECURE_COOKIES=true`，本地 `http://localhost` 测试才保持 `false`。

首次创建管理员使用 `pnpm admin:bootstrap`。该命令需要 `ADMIN_USERNAME` 和至少 12 位的 `ADMIN_PASSWORD`，不会创建默认生产账号。

如果要在管理后台 System 页保存 relay key，必须先设置 `BOOT_SETTINGS_ENCRYPTION_KEY`。模型名和 base URL 可以不依赖该密钥管理，但 secret 类型字段会在加密存储未就绪时拒绝写入。

生产环境的 `BOOT_SETTINGS_ENCRYPTION_KEY` 必须长期稳定并备份。变更或丢失该值后，数据库中已经加密保存的 runtime secret 将无法解密，需要重新在 System 页保存对应 key。

本地 embedding 默认由 `services/embedding` 提供，模型为 `BAAI/bge-small-zh-v1.5`，输出归一化的 512 维向量。Compose 默认从 ModelScope 下载并持久化权重，也可通过 `EMBEDDING_MODEL_SOURCE=huggingface|modelscope|local` 更换获取方式。模型身份和 512 维数据库契约保持固定。

设置 `BOOT_IMAGE_BASE_URL`、`BOOT_IMAGE_API_KEY` 后，可以启用 `/api/images`、Telegram `/draw` 和自然语言生图。图片模型由 `config/models.yaml` 配置；当前允许列表只包含已经实测可用的 `gpt-image-2-codex`。只有同时出现在 YAML 允许列表和 relay `/v1/models` 目录中的图片模型才可切换。

设置 `BOOT_SEARCH_PROVIDER` 和 `BOOT_SEARCH_API_KEY` 后，可以启用 Boot `web_search` tool、`POST /api/search`，以及聊天中由机器人自主判断的联网搜索。`BOOT_SEARCH_PROVIDER=disabled` 会禁用所有外部搜索渠道，包括 Wikipedia/Moegirl 直连。Telegram 不再开放 `/search` 命令。

macOS 没有 Docker Desktop 时，可以使用 `brew install colima docker docker-compose` 加 `colima start` 启动本地 pgvector 服务。

如果其它本地 stack 已经占用了默认容器名或宿主机端口，可以在 `.env` 中覆盖 `POSTGRES_CONTAINER_NAME`、`POSTGRES_PORT`、`REDIS_CONTAINER_NAME`、`REDIS_PORT`。compose 内部服务 URL 保持不变；容器外运行本地脚本时，宿主机侧 `DATABASE_URL` 和 `REDIS_URL` 应与覆盖后的端口一致。

默认 compose 会把 Postgres/Redis 端口发布到宿主机，便于本地脚本和迁移调试。远程生产部署不要直接暴露这些端口到公网，应使用内网网络、云数据库安全组或反向代理防火墙限制访问，并替换示例数据库密码。

端口和浏览器地址对应关系：

| 配置项 | 宿主机默认端口 | 容器内地址 | 浏览器/外部访问 |
| --- | --- | --- | --- |
| `SERVER_PORT` | `8787` | `api:8787` | `VITE_API_BASE_URL` 指向的 API 地址 |
| `PANEL_PORT` | `5173` | `panel:80` | `http://localhost:5173` 或你的 panel 域名 |
| `POSTGRES_PORT` | `5432` | `postgres:5432` | 仅本机脚本需要用宿主机端口 |
| `REDIS_PORT` | `6379` | `redis:6379` | 仅本机脚本需要用宿主机端口 |
| `EMBEDDING_PORT` | `8080` | `embedding:8080` | 本机 Node 进程使用 `http://127.0.0.1:8080/v1` |

修改 `SERVER_PORT` 或使用反向代理域名时，同步修改 `VITE_API_BASE_URL`；跨域访问时同步设置 `CORS_ALLOWED_ORIGINS`。

## Docker 部署

填好 `.env` 后启动 API、panel、Postgres、Redis、迁移和本地 embedding 回填任务：

```bash
docker compose --profile app up --build
```

首次 Docker 部署完成迁移后，需要创建第一个管理员：

```bash
docker compose --profile app run --rm api pnpm admin:bootstrap
```

运行前在 `.env` 中设置 `ADMIN_USERNAME` 和至少 12 位的 `ADMIN_PASSWORD`。

`bot` 容器被放在独立 profile 中；该 profile 会同时启动 polling bot、队列 worker、本地 embedding、数据库、Redis 和迁移任务：

```bash
docker compose --profile app --profile bot up --build
```

只运行 webhook/队列 worker 时使用：

```bash
docker compose --profile app --profile worker up --build
```

webhook 模式下，Hono API 只校验 Telegram secret token 并把原始 update 入队。worker 消费 BullMQ job，并运行和 long polling 相同的 grammY middleware 栈。

`BOOT_TELEGRAM_WORKER_CONCURRENCY` 默认是 `8`。同一聊天仍由 grammY 顺序处理，而 `/stop`、`/pause`、`/resume`、`/cancel` 使用独立控制锁，可以在长回复尚未结束时及时执行。不要把该值设为 `1`，否则 webhook worker 无法并发接收控制 update。

`bot-worker` 同时消费 Telegram update、异步记忆、图片生成和提醒任务。`BOOT_MEMORY_ENRICHMENT_ASYNC_ENABLED=true` 时，对话主链路只负责入队，不等待远程记忆提炼。

只有明显包含姓名、偏好、长期资料或“请记住”等稳定信息的消息才会进入记忆提炼，普通闲聊不会额外调用记忆模型。图片和提醒任务 ID 由 Telegram 消息身份稳定派生，update 重投不会重复创建昂贵任务。

Compose 会在 API、polling bot 和 worker 启动前运行一次 `embedding-backfill`。旧的 3072 维记忆全部获得本地 512 维向量后，服务才会进入运行态，避免迁移窗口中旧记忆暂时不可检索。

## 验证

`pnpm test:e2e` 会验证 Hono API 和 grammY bot 核心路径，包括多轮用户印象记忆：第一轮创建记忆、第二轮检索记忆、注入 prompt，并在雷电真的回复中自然回忆。

常用验证命令：

```bash
pnpm check
pnpm build
pnpm test
pnpm test:e2e
pnpm --filter @raiden/bot check
pnpm --filter @raiden/server check
pnpm --filter @raiden/panel check
```

## 图片生成

图片生成入口：

- API：`POST /api/images`，body 为 `{ "prompt": "...", "size": "1024x1024", "n": 1 }`
- Telegram：`/draw 稻妻夜色里的樱花与柔和雷光`
- Telegram 自然语言：例如“帮我画一张稻妻雨夜的真”，机器人会自主选择生图工具

Telegram 图片任务进入独立 BullMQ 队列，不阻塞同一聊天的文字回复。worker 会先用 `BOOT_TOOL_MODEL` 整理提示词，再调用 YAML 当前选择的图片模型；默认值是 `gpt-image-2-codex`。任务卡支持详情和取消，活动任务收到取消请求后不会发送生成结果。

## 联网搜索

搜索入口：

- API：`POST /api/search`，body 为 `{ "query": "...", "maxResults": 5 }`
- API：`GET /api/search/tools`，查看 Boot tool registry
- Telegram 自然语言：机器人会根据消息语义自主决定是否搜索，例如时事、最新版本、价格、新闻、链接、来源核验等

## 响应缓存

- L1 exact cache：按用户隔离的标准化 query 精确匹配，不调用 embedding 或 LLM，也不会在命中后后台补 embedding。
- L2 semantic cache：Redis Stack 基于 query embedding 做向量搜索，默认阈值为 `0.92`。
- L3 cold path：完整 boot conversation pipeline；成功的独立回答会缓存 `BOOT_SEMANTIC_CACHE_TTL_SECONDS`。

响应缓存默认按用户隔离，因为回复可能包含人格、上下文、搜索结果和私有记忆。显式搜索、时事请求、上下文追问、记忆召回、记忆或画像变更请求不会进入响应缓存。缓存读写都是 best effort，并会在 `BOOT_SEMANTIC_CACHE_TIMEOUT_MS` 后 fail open。

缓存 key 还包含 conversation context fingerprint，来源包括当前模型、搜索 provider、最近消息窗口和最近记忆 metadata，避免一个对话状态下生成的回复在上下文变化后被错误复用。

## AI Relay 配置

boot 客户端支持按能力拆分 OpenAI-compatible provider：

| 能力 | Base URL | API key | 模型 | 说明 |
| --- | --- | --- | --- | --- |
| Chat | `BOOT_CHAT_BASE_URL` 或 `BOOT_BASE_URL` | `BOOT_CHAT_API_KEY` 或 `BOOT_API_KEY` | `BOOT_CHAT_MODEL`、`BOOT_SUMMARY_MODEL`、`BOOT_MEMORY_MODEL`、`BOOT_TOOL_MODEL` | 四类语言任务默认均为普通 `gpt-5.5`，可分别选择 relay 目录中通过探针的模型。 |
| Embedding | `BOOT_EMBEDDING_BASE_URL` | 通常不需要 | 固定 `BAAI/bge-small-zh-v1.5` | 本地 sidecar 返回归一化 512 维向量，数据库使用 `halfvec(512)`。 |
| Image | `BOOT_IMAGE_BASE_URL` 或 `BOOT_BASE_URL` | `BOOT_IMAGE_API_KEY` 或 `BOOT_API_KEY` | `BOOT_IMAGE_MODEL` | 当前 YAML 允许列表只开放 `gpt-image-2-codex`，并要求 relay `/v1/models` 同时可见。 |
| Web search | `BOOT_SEARCH_BASE_URL` 或 provider 默认地址 | `BOOT_SEARCH_API_KEY` | `BOOT_SEARCH_PROVIDER` | 支持 `tavily`、`brave`、`serper`，默认 `disabled`。 |

管理后台 System 页可以把这些值保存到 PostgreSQL `runtime_settings`。runtime settings 优先于 `.env`，会记录 audit，并会被 Hono API 和 grammY bot 在下一次请求中读取。secret 字段为 write-only；设置 `BOOT_SETTINGS_ENCRYPTION_KEY` 后会使用 AES-256-GCM 加密存储。System 页会显示 relay 的语言/图片模型目录、缓存状态和刷新时间；本地 embedding 模型与维度只读。

使用 `new-api` 时，在 System 页选择 `new-api` preset，并把 `BOOT_BASE_URL` 指向 gateway 的 OpenAI-compatible `/v1` endpoint，例如 `https://new-api.example.com/v1`。模型列表来自 provider `/models`；保存语言模型前会校验目录并执行轻量 chat probe，图片模型会校验图片能力，成功后才写入运行时配置和审计日志。

已验证的分离配置：

```env
BOOT_BASE_URL=https://api.example.com/v1
BOOT_CHAT_MODEL=gpt-5.5
BOOT_CHAT_API_KEY=

BOOT_SUMMARY_MODEL=gpt-5.5
BOOT_MEMORY_MODEL=gpt-5.5
BOOT_TOOL_MODEL=gpt-5.5
BOOT_EMBEDDING_BASE_URL=http://127.0.0.1:8080/v1

BOOT_IMAGE_BASE_URL=https://image.example.com/v1
BOOT_IMAGE_API_KEY=
BOOT_IMAGE_MODEL=gpt-image-2-codex

BOOT_SEARCH_PROVIDER=disabled
BOOT_SEARCH_API_KEY=
BOOT_WIKIPEDIA_API_URL=https://zh.wikipedia.org/w/api.php
BOOT_MOEGIRL_API_URL=https://zh.moegirl.org.cn/api.php
BOOT_SEARCH_MAX_RESULTS=5
BOOT_SEARCH_DEPTH=basic
BOOT_CHAT_TIMEOUT_MS=90000
BOOT_EMBEDDING_TIMEOUT_MS=30000
BOOT_IMAGE_TIMEOUT_MS=180000
BOOT_SEARCH_TIMEOUT_MS=15000
BOOT_SETTINGS_ENCRYPTION_KEY=
```

如果一个 relay key 能访问语言和图片能力，只设置 `BOOT_API_KEY` 即可，能力级 key 可以留空。本地 embedding 不使用这个 key。

已验证的单 relay 配置：

```env
BOOT_BASE_URL=https://api.example.com/v1
BOOT_CHAT_BASE_URL=
BOOT_EMBEDDING_BASE_URL=http://127.0.0.1:8080/v1
BOOT_API_KEY=
BOOT_CHAT_MODEL=gpt-5.5
BOOT_IMAGE_MODEL=gpt-image-2-codex
BOOT_SEARCH_PROVIDER=disabled
BOOT_WIKIPEDIA_API_URL=https://zh.wikipedia.org/w/api.php
BOOT_MOEGIRL_API_URL=https://zh.moegirl.org.cn/api.php
```

如果 embedding endpoint 不返回 512 维，程序会在写入数据库前拒绝结果。更换 embedding 后端时必须保持模型、归一化、查询前缀与 512 维契约一致，并重新回填现有记忆。

## Telegram 命令设计

主要用户命令：

- `/start`、`/menu`、`/help`：欢迎、功能菜单与说明
- `/draw <描述>`：创建异步图片任务
- `/memory`、`/privacy`、`/clear`：查看记忆、调整隐私、清理当前会话
- `/remind`、`/timers`、`/cancel`：创建、查看和取消提醒或图片任务
- `/stop`、`/resume`：中止当前生成并恢复新请求
- `/summary`、`/replymode`、`/quiet`、`/pause`：群聊摘要与群管理员控制

Bot 管理员命令：

- `/model`：查看或切换全局语言/图片模型
- `/provider`：刷新并查看 provider 模型目录状态
- `/status`：查看脱敏后的运行状态

群聊先经过本地互动策略：直接回复、明确 @ 和唤醒词会触发；`social` 模式可低频主动回复或 reaction；`mention_only` 和 `quiet` 抑制普通消息。普通聊天不需要先执行 `/start`。

## 当前运行边界

- `/summary` 只总结 Bot 已保存的当前 chat/thread 交互，无法覆盖被忽略或 Telegram 未投递的全部群消息。
- BullMQ 任务采用 at-least-once 执行；进程在 Telegram 发送成功后、job 完成前退出时，图片或提醒有小概率重复发送。
- `/pause` 状态和群互动冷却保存在进程内，重启后清空。
- 图片任务限制为每个用户一个活动任务，配额由 Redis 原子去重实现；完成、最终失败或取消后释放。
- `/timers` 分页扫描队列并最多展示最早的 100 条，更多结果会在回复中标明。
- Persona 当前由文件维护并热加载；管理后台编辑、版本发布和回滚仍在后续路线中。

Docker 宿主机覆盖项：

```env
POSTGRES_CONTAINER_NAME=raiden-shin-postgres
POSTGRES_PORT=5432
REDIS_CONTAINER_NAME=raiden-shin-redis
REDIS_PORT=6379
```

搜索 provider 默认地址：

- `tavily`：`https://api.tavily.com/search`，bearer token auth，使用 `BOOT_SEARCH_DEPTH`，可选 `basic` 或 `advanced`
- `brave`：`https://api.search.brave.com/res/v1/web/search`，`X-Subscription-Token` auth
- `serper`：`https://google.serper.dev/search`，`X-API-KEY` auth

## 包结构

- `packages/shared`：共享 schema、API 类型、雷电真人格 prompt、AI boot 客户端
- `packages/database`：Drizzle schema、pgvector 记忆仓储层、迁移配置
- `packages/boot`：跨入口聊天编排层，负责用户身份、消息、embedding、长期记忆、搜索和回复生成
- `packages/server`：Hono API 与 typed routes
- `packages/bot`：grammY Telegram bot
- `packages/panel`：Refine 管理后台

Boot tool 架构说明位于 `docs/boot-tools.md`。新增面向用户的 bot 能力时，应先进入 `packages/shared/src/tools.ts`，再由 API/bot adapter 暴露出去。

## 本地 Agent 约定

本仓库遵循和 `DocCopilotMonorepo` 相同的本地 agent 约定：

- 根入口文件：`AGENTS.md`、`CLAUDE.md`
- 根 skill 路由：`.agents/skills.md`、`.claude/skills.md`
- 根可复用技能：`skills/*`
- SDD plan 技能：`skills/plan-task`，`SDD模式`、`sdd:plan`、`/plan-task` 会映射到 installer 的 `plan-task` skill
- Panel 入口文件：`packages/panel/AGENTS.md`、`packages/panel/CLAUDE.md`
- Panel skill 路由：`packages/panel/.agents/skills.md`、`packages/panel/.claude/skills.md`
- Panel 可复用技能：`packages/panel/skills/*`

DocCopilot 专属技能没有复制。本项目的替代技能位于 `skills/raiden-project-*` 和 `packages/panel/skills/raiden-panel-standards`。

`product-designer` skill 也安装在 `.agents/skills/product-designer`，并通过 `skills-lock.json` 锁定，方便 Codex skill installer 兼容。

## 人格说明

雷电真被建模为温柔、敏锐、有人情味，并珍视流逝瞬间之美的角色。人格源文件位于 `personas/raiden-makoto.persona`，采用英文声明式 DSL；运行时校验大写 token 的格式并确定性编译为中文 prompt，内置 token 有自然中文释义，新 token 会按下划线拆成可读英文，因此维护者增加性格、意象或关系时无需修改 TypeScript。每个 conversation 记录人格版本与 SHA-256；文件修改可热加载，解析失败时继续使用上一个有效版本。
