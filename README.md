# RaidenShinBoot

RaidenShinBoot 是一个面向 Telegram 机器人的 TypeScript monorepo，核心人格为《原神》中的雷电真。项目使用 grammY 实现 bot，Hono 提供 typed API，PostgreSQL + Drizzle ORM + pgvector `halfvec(3072)` 提供长期记忆检索，并包含 React 19 + Refine v4 + Tailwind CSS v4 管理后台。

## 技术栈

- `pnpm` workspace，包含 `shared`、`database`、`boot`、`bot`、`server`、`panel`
- grammY Telegram bot
- Hono 链式路由，`AppType` 通过 `hono/client` 传给管理后台
- PostgreSQL、Drizzle ORM、`pgvector` `halfvec(3072)`、HNSW 向量索引
- React 19、Refine v4、Tailwind CSS v4、Vite
- Vercel AI SDK v6，兼容 OpenAI 风格 relay 的 chat、embedding、image 能力
- `tsdown` 负责 package 构建，Vite 负责 panel 构建

## 快速启动

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres
docker compose up -d redis
pnpm db:generate
pnpm db:migrate
ADMIN_USERNAME=owner ADMIN_PASSWORD='replace-with-a-long-password' pnpm admin:bootstrap
pnpm test:e2e
pnpm dev:server
pnpm dev:panel
pnpm dev:bot
```

启动 bot 前，需要在 `.env` 中填写 `BOT_TOKEN` 和 AI relay key。如果 chat 与 embedding 使用不同服务，分别配置 `BOOT_CHAT_API_KEY` 和 `BOOT_EMBEDDING_API_KEY`。

配置 `REDIS_URL` 后会启用 BullMQ 队列、Telegram webhook 入队、L1/L2 语义响应缓存。没有 Redis 时，本地 polling 仍可工作，长期记忆会回退到原来的 inline 创建路径；webhook 入队会在 `BOOT_QUEUE_ENQUEUE_TIMEOUT_MS` 后稳定返回 503。

webhook 模式需要设置 `BOOT_TELEGRAM_WEBHOOK_SECRET`，并在 Telegram 侧把 update 发到 `POST /api/telegram/webhook`，同时使用同一个值作为 `secret_token`。如需异步记忆增强，设置 `BOOT_MEMORY_ENRICHMENT_ASYNC_ENABLED=true`，并运行 `pnpm --filter @raiden/bot dev:worker`。

可以设置 `BOT_RUNTIME_MODE=polling` 或 `BOT_RUNTIME_MODE=worker` 作为启动保护，避免把错误进程启动到错误部署槽位。

本地测试管理后台时，浏览器 host 和 `VITE_API_BASE_URL` host 要保持一致。例如 `http://localhost:5173` 搭配 `http://localhost:8787`，或 `http://127.0.0.1:5173` 搭配 `http://127.0.0.1:8787`。管理后台 session cookie 绑定 host，混用 `localhost` 和 `127.0.0.1` 会导致已登录请求看起来像未授权。

远程部署时，panel 镜像构建参数 `VITE_API_BASE_URL` 必须指向浏览器可访问的 API 地址，例如 `https://api.example.com`；API 服务的 `CORS_ALLOWED_ORIGINS` 必须包含 panel 的访问源，例如 `https://panel.example.com`。多个源用英文逗号分隔。管理后台 session cookie 使用 `SameSite=Strict`，panel 和 API 应部署在同一 site 下，例如 `https://panel.example.com` 和 `https://api.example.com`；不要把两者拆到不同主域。HTTPS 生产部署必须设置 `ADMIN_SECURE_COOKIES=true`，本地 `http://localhost` 测试才保持 `false`。

首次创建管理员使用 `pnpm admin:bootstrap`。该命令需要 `ADMIN_USERNAME` 和至少 12 位的 `ADMIN_PASSWORD`，不会创建默认生产账号。

如果要在管理后台 System 页保存 relay key，必须先设置 `BOOT_SETTINGS_ENCRYPTION_KEY`。模型名和 base URL 可以不依赖该密钥管理，但 secret 类型字段会在加密存储未就绪时拒绝写入。

生产环境的 `BOOT_SETTINGS_ENCRYPTION_KEY` 必须长期稳定并备份。变更或丢失该值后，数据库中已经加密保存的 runtime secret 将无法解密，需要重新在 System 页保存对应 key。

如果 chat relay 不提供 3072 维 embedding，需要设置 `BOOT_EMBEDDING_BASE_URL` 和 `BOOT_EMBEDDING_API_KEY` 指向兼容 provider。嵌入模型名固定为 `text-embedding-3-large`，必须返回 3072 维，否则长期记忆写入和检索会失败。

设置 `BOOT_IMAGE_BASE_URL`、`BOOT_IMAGE_API_KEY` 后，可以启用 `/api/images`、Telegram `/draw` 和自然语言自主生图。生图模型固定为 `chatgpt-image-latest`，不对用户开放自定义。

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

修改 `SERVER_PORT` 或使用反向代理域名时，同步修改 `VITE_API_BASE_URL`；跨域访问时同步设置 `CORS_ALLOWED_ORIGINS`。

## Docker 部署

填好 `.env` 后启动 API、panel、Postgres、Redis 和迁移任务：

```bash
docker compose --profile app up --build
```

首次 Docker 部署完成迁移后，需要创建第一个管理员：

```bash
docker compose --profile app run --rm api pnpm admin:bootstrap
```

运行前在 `.env` 中设置 `ADMIN_USERNAME` 和至少 12 位的 `ADMIN_PASSWORD`。

`bot` 容器被放在独立 profile 中，方便没有 Telegram token 时只跑本地服务：

```bash
docker compose --profile app --profile bot up --build
```

webhook worker 使用 `bot-worker` 服务：

```bash
docker compose --profile app --profile worker up --build
```

webhook 模式下，Hono API 只校验 Telegram secret token 并把原始 update 入队。worker 消费 BullMQ job，并运行和 long polling 相同的 grammY middleware 栈。

`worker` profile 会启用异步记忆增强；本地 polling 默认 inline 创建记忆，除非显式设置 `BOOT_MEMORY_ENRICHMENT_ASYNC_ENABLED=true`。

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

实际生图模型固定为 `chatgpt-image-latest`。机器人会先用当前对话模型生成更适合图片模型的提示词，再调用生图工具。

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
| Chat | `BOOT_CHAT_BASE_URL` 或 `BOOT_BASE_URL` | `BOOT_CHAT_API_KEY` 或 `BOOT_API_KEY` | `BOOT_CHAT_MODEL` | 默认对话模型为 `gpt-5.5`；可在后台或 Telegram 隐藏命令 `/model` 切换。 |
| Embedding | `BOOT_EMBEDDING_BASE_URL` 或 `BOOT_BASE_URL` | `BOOT_EMBEDDING_API_KEY` 或 `BOOT_API_KEY` | 固定 `text-embedding-3-large` | 必须返回 3072 维，因为长期记忆存储为 `halfvec(3072)`。 |
| Image | `BOOT_IMAGE_BASE_URL` 或 `BOOT_BASE_URL` | `BOOT_IMAGE_API_KEY` 或 `BOOT_API_KEY` | 固定 `chatgpt-image-latest` | 用于 `POST /api/images`、Telegram `/draw` 和自然语言自主生图，返回 base64 图片。 |
| Web search | `BOOT_SEARCH_BASE_URL` 或 provider 默认地址 | `BOOT_SEARCH_API_KEY` | `BOOT_SEARCH_PROVIDER` | 支持 `tavily`、`brave`、`serper`，默认 `disabled`。 |

管理后台 System 页可以把这些值保存到 PostgreSQL `runtime_settings`。runtime settings 优先于 `.env`，会记录 audit，并会被 Hono API 和 grammY bot 在下一次请求中读取。secret 字段为 write-only；设置 `BOOT_SETTINGS_ENCRYPTION_KEY` 后会使用 AES-256-GCM 加密存储。嵌入模型和生图模型在运行时强制固定，后台只展示只读状态。

使用 `new-api` 时，在 System 页选择 `new-api` preset，并把 `BOOT_BASE_URL` 指向 gateway 的 OpenAI-compatible `/v1` endpoint，例如 `https://new-api.example.com/v1`。对话模型列表来自 provider `/models`；`/model <model_id>` 会先校验模型存在并做一次轻量 chat probe，成功后才在同一事务内写入运行时配置和审计日志。

已验证的分离配置：

```env
BOOT_BASE_URL=https://api.example.com/v1
BOOT_CHAT_MODEL=gpt-5.5
BOOT_CHAT_API_KEY=

BOOT_EMBEDDING_BASE_URL=https://embedding.example.com/v1
BOOT_EMBEDDING_MODEL=text-embedding-3-large
BOOT_EMBEDDING_API_KEY=

BOOT_IMAGE_BASE_URL=https://image.example.com/v1
BOOT_IMAGE_MODEL=chatgpt-image-latest
BOOT_IMAGE_API_KEY=

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

如果一个 relay key 能访问全部能力，只设置 `BOOT_API_KEY` 即可，能力级 key 可以留空。

已验证的单 relay 配置：

```env
BOOT_BASE_URL=https://api.example.com/v1
BOOT_CHAT_BASE_URL=
BOOT_EMBEDDING_BASE_URL=
BOOT_API_KEY=
BOOT_CHAT_MODEL=gpt-5.5
BOOT_EMBEDDING_MODEL=text-embedding-3-large
BOOT_SEARCH_PROVIDER=disabled
BOOT_WIKIPEDIA_API_URL=https://zh.wikipedia.org/w/api.php
BOOT_MOEGIRL_API_URL=https://zh.moegirl.org.cn/api.php
```

如果 embedding endpoint 不返回 3072 维，pgvector 写入和长期记忆检索会失败；此时应更换 embedding base URL/key，而不是更换模型名。

## Telegram 命令设计

公开命令保持精简：

- `/start`：显示欢迎信息；不是开始聊天的前置条件
- `/help`：显示帮助
- `/draw <描述>`：强制直接生图

隐藏但可用命令：

- `/model`：查看当前对话模型
- `/model list`：查看 provider `/models` 返回的可用模型
- `/model <model_id>`：切换全局对话模型；所有已获准聊天的用户都可以使用，会写入审计日志。该命令不会注册到 Telegram 命令菜单，也不会被后台命令权限规则禁用。

不再公开 `/memory`、`/recall`、`/search`、`/status`。长期记忆浏览、语义召回、运行状态、模型和工具配置都在 Web 管理后台处理。普通聊天不需要 `/start`；机器人会在对话中自主决定是否调用搜索或绘图工具。

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

雷电真被建模为温柔、敏锐、有人情味，并珍视流逝瞬间之美的角色。prompt 有意避开雷电影偏严肃的永恒观，更贴近真所理解的永恒：记忆、关怀，以及每一个当下的价值。
