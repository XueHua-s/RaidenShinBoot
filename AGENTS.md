# Repository Guidelines

## First Read

- `CLAUDE.md` 是 Claude 的入口文件；开始任何工作前先读它，再回到本文件。
- Claude 需要仓库内技能时，读取 `.claude/skills.md`；Codex CLI 读取 `.agents/skills.md`，都只加载当前任务真正需要的 skill。
- 任务涉及 `packages/panel` 时，必须继续阅读 `packages/panel/AGENTS.md`，并优先使用 `packages/panel/skills/` 下的技能文档。
- 路径不确定时，先执行 `rg --files packages scripts .agents .claude skills` 做目录自检，不要凭记忆盲改。

## Project Structure

- `packages/shared`: 共享 Zod schema、人格 prompt、Vercel AI SDK v6 boot 客户端。
- `packages/database`: PostgreSQL + Drizzle schema、pgvector `halfvec(3072)`、HNSW 索引和仓储层。
- `packages/server`: Hono API、链式路由、`AppType` 导出和聊天服务编排。
- `packages/bot`: grammY Telegram bot，复用同一套人格、长期记忆和数据库逻辑。
- `packages/panel`: React 19 + Refine v4 + Tailwind CSS v4 管理后台；等价于本项目的 web 工作区。
- `docker-compose.yml`: 本地 pgvector PostgreSQL 服务。
- `skills/*`: 根仓库技能，负责结构导航、跨包规范、设计和 review。
- `.agents/*`, `.claude/*`: agent 入口说明，不承载业务代码。

## Skill Routing

- `skills/raiden-project-structure/SKILL.md`
  用于入口定位、package 边界、脚本选择、依赖落点和验证命令选择。
- `skills/raiden-project-spec/SKILL.md`
  用于跨 `shared`、`database`、`server`、`bot`、`panel` 的改造、接口边界、长期记忆链路和验收门禁。
- `skills/software-design-philosophy/SKILL.md`
  用于模块设计、复杂度治理、信息隐藏和接口收敛。
- `skills/code-review-expert/SKILL.md`
  用于 review 当前 diff，优先报告 bug、风险和测试缺口。
- `skills/frontend-design/SKILL.md`
  用于管理后台 UI、页面、组件和视觉质量提升；纯 `packages/panel` 任务优先切到 panel 本地技能。
- `skills/product-designer/SKILL.md`
  用于产品设计、信息架构、用户路径、可用性和设计系统。

## Working Rules

- 运行环境以根 `package.json` 为准：Node 22+，包管理器只使用 `pnpm`。
- 安装依赖先在根目录执行 `pnpm install`；不要混用 `npm` 或 `yarn`。
- 新增依赖前先检查目标 `package.json`、现有 `packages/*` 封装和本地工具，优先复用已有实现。
- Hono API 的前后端类型契约必须通过 `packages/server/src/app.ts` 导出的 `AppType` 传递给前端，不要手写重复 API 类型。
- 数据库结构变更必须同步 `packages/database/src/schema.ts` 和 Drizzle 迁移；涉及向量记忆时确认 `halfvec(3072)`、embedding 模型维度和 HNSW 索引一致。
- bot 与 server 的聊天主链路应复用同一套 shared/database 能力，不要在两端分叉实现人格、记忆或 embedding 逻辑。
- 不要手改 `dist/`、缓存目录、构建产物或 node_modules。
- 不要提交真实密钥、Telegram token、数据库密码、relay key 或敏感环境变量。

## Build And Verification

- 安装：`pnpm install`
- 全量类型检查：`pnpm check`
- 全量构建：`pnpm build`
- 数据库迁移生成：`pnpm db:generate`
- 数据库迁移执行：`pnpm db:migrate`
- API 开发：`pnpm dev:server`
- Bot 开发：`pnpm dev:bot`
- Panel 开发：`pnpm dev:panel`
- Panel 局部验证：`pnpm --filter @raiden/panel check`、`pnpm --filter @raiden/panel build`

## Cross-Package Notes

- 只改管理后台时，不要顺手修改 bot/server/database，除非 typed API 或数据契约确实需要同步。
- 只改 bot 命令时，先确认是否应复用 `packages/server/src/services/conversation.ts` 或抽到 shared/database，避免行为分叉。
- 跨包改动最终交付时，要明确说明改动涉及哪些 package，以及跑过哪些验证命令。

