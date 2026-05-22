# Boot 工具层设计

RaidenShinBoot 不把搜索、生图等能力直接散落在 Telegram handler 或 Hono route 里，而是集中到一个小型 tool layer。bot、API 和管理后台都复用同一套工具注册表与运行时校验。

## 设计边界

- 工具规格：名称、描述、暴露方式、能力标签、输入/输出 schema。
- 工具注册表：`packages/shared/src/tools.ts` 是工具清单和执行入口。
- 工具运行时：`executeBootTool(...)` 负责输入校验、权限检查、输出预算和审计 hook。
- 展示适配层：Telegram 命令、API route、boot 对话规划器决定是否把工具能力暴露给用户。

## 当前工具

- `web_search`：根据 query 意图在 Google-style provider、Wikipedia、Moegirl 之间路由，返回统一搜索结果。
- `makoto_image`：通过固定生图模型生成图片。主对话链路会先用当前聊天模型改写图片提示词；改写失败时降级使用用户原始描述。

搜索 provider 支持：

- `tavily`
- `brave`
- `serper`

默认 `BOOT_SEARCH_PROVIDER=disabled`。该状态会禁用所有外部搜索渠道，包括 Wikipedia/Moegirl 直连，避免本地开发、测试或受限部署意外外呼。

## 模型策略

- 对话模型：`BOOT_CHAT_MODEL`，可通过管理后台或 Telegram `/model <model_id>` 切换。
- 嵌入模型：固定 `text-embedding-3-large`，用于长期记忆，必须返回 3072 维。
- 生图模型：固定 `chatgpt-image-latest`，不允许用户或后台改模型名。

`/model <model_id>` 会先读取 provider `/models`、过滤明显非聊天模型，再做一次轻量 chat probe。探测成功后才写入 runtime setting 和审计日志。

## 入口

- 工具注册表：`packages/shared/src/tools.ts`
- 搜索 provider 适配：`packages/shared/src/search.ts`
- 搜索 API：`POST /api/search`
- 工具检查 API：`GET /api/search/tools`
- Telegram 强制生图：`/draw <描述>`
- Telegram 自然语言：bot 自主判断是否调用搜索或生图
- 管理后台：Conversations 页提供聊天测试台和搜索诊断；System 页管理 provider、base URL、key 和模型状态

Telegram 不公开 `/search`、`/memory`、`/recall`、`/status`。普通聊天不需要 `/start`；`/start` 只显示欢迎信息。

## 失败策略

- 聊天链路中的搜索失败不会中断回复，会以“搜索失败”的上下文注入 prompt，让模型坦诚说明实时来源不可用。
- 直接调用 `POST /api/search` 时，配置错误或 provider 错误会返回明确状态码和错误信息。
- provider 的 401/403 会映射为上游错误，不会伪装成后台登录态失效。
- 图片提示词改写失败时继续调用生图工具；图片 provider 失败才返回生图失败。
- L1 exact cache 在工具规划和 embedding 之前查询，命中时不会再调用模型或 embedding。

## 新增工具流程

1. 在 `packages/shared/src/schemas.ts` 添加 request/response schema。
2. 在 `packages/shared/src/*` 添加 provider 或 runtime 代码。
3. 在 `packages/shared/src/tools.ts` 注册工具。
4. 只有确实需要直接入口时，才添加 API route 或 Telegram 命令。
5. 在 `scripts/e2e-smoke.ts` 增加 mock provider 路径和验收断言。

注册表是权威入口。route 和 command 应调用 `executeBootTool(...)`，不要直接绕过工具层调用 provider。
