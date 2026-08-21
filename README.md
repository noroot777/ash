<p align="center">
  <strong>Ash</strong>
</p>

<p align="center">
  AI 编程智能体的本地调度台<br>
  派活 · 排队 · 验证 · 合并 —— 一个进程搞定
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> · <a href="#核心能力">核心能力</a> · <a href="#编排模式">编排模式</a> · <a href="docs/install.md">部署文档</a>
</p>

---

Ash 是一个自托管的编排控制台，用来管理本地的 AI 编程智能体 CLI（Claude Code、Codex、Gemini 等）。它不替代这些工具，也不需要你的 API key —— 它负责的是**调度**：把任务分配给 agent，在隔离的 worktree 中执行，自动验证结果，最终合并回主干。

一个 Node 进程，一个端口，数据全在本地磁盘。macOS / Linux / Windows 原生支持。

## 快速开始

**前置条件**：Node.js ≥ 22.16、git，至少一个已安装并登录过的 agent CLI。

```bash
# 安装 agent CLI（至少一个）
npm install -g @anthropic-ai/claude-code && claude
npm install -g @openai/codex && codex
```

```bash
# 安装并启动 Ash
git clone https://github.com/noroot777/ash.git ash
cd ash
npm run setup        # 环境检查 → 依赖安装 → 构建 → MCP 接入
npm start            # http://localhost:4317
```

启动后：新建项目（填 git 仓库绝对路径）→ 创建任务 → 选择执行器 → 运行。

> [!IMPORTANT]
> **MCP 接入不可跳过。** agent 通过 MCP 工具 `complete_task` 提交完成状态。未接入 MCP 的 agent 无法交卷，所有任务将显示为失败。<br>验证：`claude mcp list` 中应显示 `ash: … ✔ Connected`。<br>手动接入方法见 [docs/install.md](docs/install.md)。

## 核心能力

🔀 **Worktree 隔离** — 每个任务自动创建独立的 git worktree 和分支，多任务并行互不干扰。

✅ **完成协议** — agent 必须主动调用 `complete_task` 才算完成。进程退出 ≠ 任务完成，避免半成品被推进下游队列。

🔍 **自动验证** — 任务完成后触发验证轮，在同一会话中运行。未通过则打回修复，上下文完整保留。

🔄 **重启存活** — agent 进程与 server 解耦，server 重启后自动接回正在运行的 agent。

📋 **队列编排** — 串行队列按序推进，并行分组同时运行。失败任务自动跳过，重新排队时按规则归位。

🚀 **一键验收** — 确认通过后自动合并到主干、清理 worktree 和临时分支。遇到冲突会唤醒来源任务处理。

## 支持的执行器

内置 15 个 CLI 执行器配置，机器上安装了哪些就能使用哪些：

<p>
  <code>claude</code> · <code>codex</code> · <code>gemini</code> · <code>cursor</code> · <code>copilot</code> · <code>opencode</code> · <code>qwen</code> · <code>grok</code> · <code>kimi</code> · <code>trae</code> · <code>kiro</code> · <code>kilo</code> · <code>qoder</code> · <code>antigravity</code> · <code>pi</code>
</p>

通过「设置 → 执行器」可为每个 CLI 创建 profile，固定模型与思考强度。添加新 CLI 只需一个 TypeScript 文件 — 见 [catalog/README.md](server/src/executors/catalog/README.md)。

## 编排模式

**单任务** — 一个任务指派一个 agent，最基础的使用方式。

**串行队列** — 多个任务按序编排，前一个完成后自动启动下一个，适用于有依赖关系的工作流。

**并行分组** — 一批无关联的任务同时运行，各自在独立 worktree 中工作。

**团队模式** — 指派一个 agent 担任调度台，由它自行拆分子任务、分派执行者、汇总结果。

**Duet** — 两个 agent 协作研讨同一问题，中间设有人工闸口，最终合稿输出。

**验证循环** — 实现 → 验证 → 打回 → 修复 → 再验证，循环至通过后由用户验收合并。

## 项目结构

单 Node 进程（Hono），同时承载 API、SSE 事件推送和前端页面托管。

```
server/   Hono 后端 — API、任务编排、进程管理、前端托管
web/      React + Vite + Tailwind 前端
shared/   前后端共享类型
mcp/      MCP server — 提供 25 个工具供 agent 调用
mobile/   Expo 移动端（查看任务、回复消息）
scripts/  setup / restart / package（.mjs 脚本，跨平台）
```

<details>
<summary>技术选型说明</summary>
<br>

- **SQLite** 使用 Node 22 内置的 `node:sqlite` 模块，零原生编译依赖。代价是 Node 最低版本要求 22.16。
- **Drizzle** 管理 schema，启动时自动补列，无需手动迁移。
- **SSE** 替代 WebSocket — 数据流为服务端单向推送（任务状态、输出、trace），SSE 足够且对反代透明。
- **平台差异** 收敛在 `server/src/platform.ts` 一个文件 — 进程表、进程树击杀、端口查询按平台分发实现。Windows 能力缺口在文件头部如实标注。

</details>

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `4317` | 服务端口（界面与 API 共用） |
| `ASH_DB` | `./data/ash.db` | SQLite 数据库路径 |

所有持久化数据存放在 `data/` 目录（数据库、运行记录、上传文件），该目录不入 git。备份迁移只需拷贝此目录。

> [!WARNING]
> 默认监听 `0.0.0.0` 且无鉴权。请仅在可信网络中使用，或自行在前端部署反向代理进行认证。

## 开发

```bash
npm run dev          # 后端 :4317 + 前端 :5173（HMR，/api 代理到后端）
npm run build        # 全量构建（shared → web → server → mcp）
npm run restart      # 构建 + 后台常驻
npm run package      # 生成分发包（仅入库文件，不含 data/）
```

前端修改后仅需 `npm run build`，server 从磁盘读取 `web/dist`，无需重启。

回归测试按主题拆分，独立运行：

```bash
npm -w server run test:queue          # 队列推进与排序
npm -w server run test:accept-merge   # 验收合并与冲突处理
npm -w server run test:review         # 验证轮与证据落盘
npm -w server run test:detached       # agent 重启存活
```

> [!CAUTION]
> 端到端测试会实际启动 agent CLI，消耗真实 API 额度。

## 常见问题

<details>
<summary>所有任务运行后均显示 <b>failed</b></summary>

MCP 未接入，agent 无法调用 `complete_task`。运行 `claude mcp list` 确认 ash 状态为 Connected。

</details>

<details>
<summary>界面空白或样式异常</summary>

前端产物未构建或已过期。执行 `npm run build`，无需重启 server。

</details>

<details>
<summary>派发任务时报 ENOENT</summary>

目标 CLI 未安装，或未在 server 进程的 PATH 中。建议从终端（而非 GUI 应用）启动 server。

</details>

<details>
<summary>Windows 上报 Filename too long</summary>

触发了 260 字符路径限制。需在管理员 PowerShell 中启用 `LongPathsEnabled`，并执行 `git config --global core.longpaths true`。`npm run setup` 会自动检测这两项配置。

</details>

---

<p>
  <a href="docs/install.md"><b>部署与运维</b></a> · <a href="docs/incidents.md"><b>事故与踩坑记录</b></a> · <a href="docs/windows-testing.md"><b>Windows 测试基线</b></a>
</p>
