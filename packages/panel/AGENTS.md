# Repository Guidelines

## First Read

- `CLAUDE.md` 是 Claude 的入口文件；开始任何 `packages/panel` 工作前先读它，再回到本文件。
- Claude 需要本地技能时读取 `.claude/skills.md`；Codex CLI 读取 `.agents/skills.md`。
- `packages/panel` 的默认入口 skill 是 `skills/raiden-panel-standards/SKILL.md`。
- 如果任务跨出前端，涉及 `packages/server`、`packages/database`、`packages/shared`、bot 或根 workspace 脚本，请继续阅读父级 `AGENTS.md` 与根 `skills/`。

## Project Structure

- `src/main.tsx`: React/Refine 应用入口。
- `src/App.tsx`: 管理后台主工作台布局、数据列表和运行时状态。
- `src/components`: 面板组件、状态组件、控制台组件。
- `src/lib/apiClient.ts`: Hono typed client，类型来自 `@raiden/server/app` 的 `AppType`。
- `src/lib/dataProvider.ts`: Refine data provider，负责把 typed API 响应适配到 Refine。
- `src/styles.css`: Tailwind CSS v4 入口和全局样式。
- `vite.config.ts`, `tsconfig.json`: Vite 和 TypeScript 配置。
- `skills`: 管理后台专用技能入口。

## Skill Routing

- `skills/raiden-panel-standards/SKILL.md`
  默认入口。适用于 Refine、Hono typed client、Tailwind v4、运行时状态、空态/错态和本地验证命令。
- `skills/software-design-philosophy/SKILL.md`
  适用于组件拆分、模块边界、接口收敛和复杂度治理。
- `skills/code-review-expert/SKILL.md`
  适用于 review 当前 diff，优先报告 bug、回归风险和测试缺口。
- `skills/frontend-design/SKILL.md`
  适用于页面、组件、交互和视觉质量提升。
- `skills/product-designer/SKILL.md`
  适用于信息架构、用户路径、可用性和设计系统。
- `skills/vercel-react-best-practices/SKILL.md`
  适用于 React 性能、bundle、re-render、数据获取和渲染优化。

## Working Rules

- 运行环境以根 `package.json` 和本包 `package.json` 为准，包管理器只使用 `pnpm`。
- API 调用优先使用 `src/lib/apiClient.ts` 中的 Hono typed client，不要手写重复 fetch wrapper 或重复 DTO。
- Refine 数据入口统一经过 `src/lib/dataProvider.ts`；新增资源时同步后端路由、shared schema 和 data provider。
- UI 控件优先使用 lucide-react 图标、Tailwind v4 utility 和现有组件；不要引入新的 UI 库，除非用户明确要求。
- 管理后台是运维工具，不做营销式落地页；首屏优先呈现状态、数据、操作和反馈。
- 状态设计必须覆盖 loading、empty、error、disabled 和刷新反馈。数据库未配置、relay 未配置等环境问题要显式展示。
- 与服务端契约相关的改动必须回到根目录跑对应 server/shared 类型检查。

## Build And Verification

- 开发：`pnpm --filter @raiden/panel dev`
- 类型检查：`pnpm --filter @raiden/panel check`
- 构建：`pnpm --filter @raiden/panel build`
- 跨 API 契约变更后补跑：`pnpm --filter @raiden/server check`、`pnpm --filter @raiden/shared check`
- 视觉或布局改动后，启动 panel 并用桌面和移动 viewport 做截图检查。

## Git And Scope

- 这个目录是根 monorepo 的一个 workspace package，不是独立子模块。
- 只改 panel 时，不要顺手修改 server/database/bot；如果 API 契约需要扩展，先明确前后端边界再跨包修改。
- 最终交付要说明是否只影响 `packages/panel`，以及是否需要同步数据库迁移或环境变量。

