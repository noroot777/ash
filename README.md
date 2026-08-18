# Harness

你机器上装了 Claude Code、Codex 之类的 AI 编程 CLI 对吧？它们各自干活没问题，但你想同时跑好几个、还指望它们别互相踩、跑完能自动验证、最后一键合回主干 —— 光靠开几个终端窗口是搞不定的。

Harness 就干这件事。它是个本地跑的调度台，帮你管这些 agent：派活、排队、盯进度、验证、合并。

自托管，单进程，数据在你磁盘上。macOS / Linux / Windows 都行。

## 快速开始

先确保有 Node.js ≥ 22.16 和 git，然后至少装一个 agent CLI 并登录：

```bash
npm install -g @anthropic-ai/claude-code && claude    # 装完登录一次
# 或者
npm install -g @openai/codex && codex                  # 装完登录一次
```

然后：

```bash
git clone https://github.com/noroot777/ash.git harness
cd harness
npm run setup      # 检查环境、装依赖、构建、帮你把 MCP 接好
npm start          # 开浏览器访问 http://localhost:4317
```

进去之后新建一个项目（填你要让 agent 干活的那个 git 仓库的绝对路径），建个任务，选个执行器，点跑就行了。

> **MCP 必须接上。** `npm run setup` 会自动帮你接，但如果你跳过了这步，agent 就没法"交卷"，所有任务跑完都会显示失败。检查方法：`claude mcp list` 里看到 `harness: … ✔ Connected`。详见 [docs/install.md](docs/install.md)。

## 它帮你解决什么

**不再互相踩。** 每个任务自动开一个 git worktree 和独立分支，agent 之间完全隔离。

**跑完不等于做完。** agent 必须主动调 `complete_task` 才算交卷。光是进程退出了不算 —— 报错退出也是 exit 0，这种不能当成"做完了"往下推。

**自动验证。** 任务完成后可以跑一轮验证。没通过就打回去，同一个 agent 在同一个会话里继续改，上下文不丢。

**不怕重启。** agent 进程是 detached 的，server 重启了 agent 还在跑，下次启动自动接回来。

**自动排队。** 把任务串成队列，前一个做完下一个自动开始；也可以一批并行跑，各有各的 worktree。

**一键验收。** 看完满意了，点一下：合并到主干、删掉 worktree、删掉临时分支。有冲突的话会叫醒任务去处理。

## 支持 15 个 CLI

你装了哪些，界面里就能选哪些：

Claude · Codex · Gemini · Cursor · Copilot · OpenCode · Qwen · Grok · Kimi · Trae · Kiro · Kilo · Qoder · Antigravity · Pi

可以在"设置 → 执行器"里给每个 CLI 建 profile，固定模型和思考强度。要加新的 CLI 就写一个 TS 文件，见 [catalog/README.md](server/src/executors/catalog/README.md)。

## 不只是"一个任务一个 agent"

最常用的当然是单飞 —— 建个任务，选个 agent，跑。但还有别的玩法：

- **串行队列** —— 一串任务按顺序来，上一个 done 了下一个自动开始。
- **并行分组** —— 一批不相关的任务同时开工。
- **团队** —— 一个 agent 当调度台，自己拆活派人，你只看结果。
- **Duet** —— 两个 agent 协作研讨，中间有人工闸口，最后合稿。
- **验证循环** —— 做完 → 验证 → 打回 → 再改 → 再验证，直到满意再验收。

## 项目结构

就一个 Node 进程，用 Hono 跑 API + SSE + 托管前端页面。没有 nginx，没有 Docker。

```
server/      后端：API、任务编排、进程管理
web-next/    前端：React + Vite + Tailwind
shared/      前后端共享类型
mcp/         给 agent 调的 MCP server（25 个工具）
mobile/      Expo 移动端（看任务、回消息）
scripts/     setup / restart / package（.mjs，三平台通用）
```

SQLite 数据库用的是 Node 内置的 `node:sqlite`（不是 better-sqlite3），不需要编译原生模块。Drizzle 做 ORM，启动自动补列，不用手动迁移。

## 配置

- `PORT`（默认 4317）—— 界面和 API 共用。
- `HARNESS_DB`（默认 `./data/harness.db`）—— 数据库位置。

数据都在 `data/` 目录，备份拷走就行。不入 git。

> **注意：** 默认监听 0.0.0.0，没有登录验证。只在你信任的网络里用，或者自己加反代做认证。

## 开发

```bash
npm run dev          # 后端 :4317 + 前端 :5173（HMR）
npm run build        # 全量构建
npm run restart      # 构建 + 后台常驻
npm run package      # 打分发包
```

改完前端跑 `npm run build` 就行，server 是从磁盘读 dist 的，不用重启。

端到端测试会真的拉起 agent CLI、烧真实额度：

```bash
npm -w server run test:queue          # 队列
npm -w server run test:accept-merge   # 验收合并
npm -w server run test:review         # 验证轮
npm -w server run test:detached       # 重启存活
```

## 常见问题

**所有任务跑完都是红的？** MCP 没接上。`claude mcp list` 检查一下。

**界面空白？** 前端没构建。`npm run build`。

**ENOENT？** CLI 没装或者不在 PATH 里。从终端启动 server 而不是从 GUI 应用。

**Windows 报 Filename too long？** 管理员 PowerShell 开 `LongPathsEnabled`，再 `git config --global core.longpaths true`。

## 文档

- [docs/install.md](docs/install.md) — 部署、MCP 接线、运维、排错
- [docs/incidents.md](docs/incidents.md) — 踩过的坑
- [docs/windows-testing.md](docs/windows-testing.md) — Windows 测试基线
