# 品牌名称与个人信息示例清查

检查日期：2026-09-08。范围：当前 Git 跟踪的源码、配置、文档、Demo、测试及文件路径；查看了任务附图。没有检索运行数据库、Git 历史或对仓库全部图片做 OCR。

## 附图中的 HARNESS

当前源码 [TaskPlaceholder.tsx](../web/src/workspace/TaskPlaceholder.tsx) 在“从任务树选择一项”上方渲染的是 `project.name`。[workspace.css](../web/src/styles/workspace.css) 的 `text-transform: uppercase` 会把项目名显示为大写。

因此，这个位置显示 HARNESS 可以来自名为 harness 的项目，并非组件中写死的品牌。[project-routes.ts](../server/src/project-routes.ts) 的项目解析接口在未指定名称时使用仓库目录末段作为名称；已有项目保持原有名称。本轮没有修改实际项目名、仓库目录或运行中的配置。

## 已清理的内容

| 内容 | 位置 | 修改 |
| --- | --- | --- |
| 旧品牌与项目示例 | `docs/demos/new-task-{editorial-demo,studio,summary-demo}.*`、`docs/handoff-location-demo.{html,js}` | harness / Harness → ash，包括 Demo 草稿存储键 |
| 旧 H 头像 | `docs/demos/task-marker-flag.html`、`docs/ui-demo2/{app.js,workflow-codex.html}`、`docs/ui-demo-workflow-claude/index.html`、`docs/ui-demo.html`、`docs/ui-demo-free-postmerge-review/index.html` | H → A |
| 个人用户名与设备名 | 接力 Demo、验收 Demo | 换为“开发者”“开发用 MacBook” |
| 个人目录示例 | `mcp/README.md`、`mobile/README.md`、`mobile/design-mockups/BRIEF*.md`、`docs/ui-demo-workflow-inline/*.html`、`docs/ui-demo.html` | 用户目录名换为 example |
| 测试和组件示例路径 | `web/scripts/fixtures/{bulk-handoff-dialog,image-preview,inspector-attachments}.tsx`、相关路径测试、`server/scripts/test-dir-picker.ts` | 输入及断言中的用户名同步换为 example |
| 解释性注释 | `server/src/{dir-picker,handoff-collect,singleton}.ts`、`web/src/lib/useHostInfo.ts`、`web/src/styles/task-tree.css` | 使用通用路径与 ash 项目名 |

共清理 34 个现有文件，另新增本报告。没有修改业务逻辑或 Windows 平台分支。

## 邮箱检查

任务给出的 `fandayrockworld@gmail.com` 在修改前的 Git 跟踪文本中没有命中；`fandayrockworld` 和 `gmail.com` 也没有命中。本报告中的引用是本轮新增的检索说明。

- 初始化表单使用 `zhangsan@ash.local`（`web/src/auth/MultiModeForm.tsx`）。
- 新建用户使用 `lisi@ash.local` 或根据姓名生成建议（`web/src/settings/UsersSettings.tsx`）。
- 账号设置使用用户目录名加 `@ash.local`（`web/src/settings/AccountSettings.tsx`）。
- 项目 Git 设置的邮箱占位符可以显示继承的真实 Git 邮箱（`web/src/settings/ProjectGitSettings.tsx`）。若这里出现私人邮箱，可能来自 Git 配置，而非硬编码示例；本轮未读取或修改该配置。

## 保留的命中

| 分类 | 位置与原因 |
| --- | --- |
| 旧安装兼容 | `HARNESS_*` 环境变量、`harness.db` 数据库迁移、`harness/*` 历史任务分支、旧 MCP 名、`harness-next:` / `harness.baseURL` 存储键及对应测试；删除会影响旧安装或历史数据读取 |
| 历史任务测试输入 | `web/scripts/test-turn-fold.mjs`、`web/scripts/fixtures/turn-fold.tsx`、`server/scripts/test-handoff-return.ts` 等仍含旧工具名或项目名，不是线上固定文案 |
| 真实记录与历史说明 | `docs/chat-mode.md`、`docs/demos/system-notice-task-demo.data.js`、`web/scripts/fixtures/legacy-*.md`、`server/src/local-open-routes.ts` 等包含历史路径；搜索性能注释包含当时的 harness 查询词 |
| 校验和 | `mobile/package-lock.json` 的完整性哈希中有大小写不敏感的 fjh 字符片段，不是用户名 |

Git 跟踪的文件和目录名称中未发现含 harness 或 fjh 的条目。当前检出所在的真实绝对路径仍含这两个名称，不属于仓库中的示例。

## 验证

- 目录解析、工具路径摘要、数据层现有测试通过。
- Web TypeScript 检查、仓库 conventions 检查通过。首次类型检查因 worktree 缺少 Web 本地依赖无法解析 Node 类型；复用主检出的 Web 依赖后通过，无依赖清单改动。
- 修改过的三个 Demo JavaScript 文件通过 `node --check`。
- 34 个清理文件不再包含 harness 或 fjh；所改代码文件均不超过 700 行；`git diff --check` 通过。
- 本轮采用源码检索和静态验证，未操作浏览器，未运行浏览器交互测试，也未部署到在线实例。
