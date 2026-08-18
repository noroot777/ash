# Harness

把 Claude Code、Codex 这些 AI 编程智能体的命令行，变成一支你能派活、能盯进度、能验收合并的团队。

一个端口，一个进程，数据全在你自己的磁盘上。macOS、Linux、Windows 都能跑。

---

## 为什么要这个

你机器上装了 `claude`、`codex` 这些 CLI，它们各自能干活。但你打开几个终端窗口同时跑，就会遇到这些事：

- **改动互相踩。** 两个 agent 同时改一个仓库，合并的时候冲突一堆。
- **跑完了不知道到底行不行。** 它说做完了，但你还得自己去看。
- **关掉终端就全没了。** 重启电脑，刚跑到一半的任务就丢了。
- **多个任务的先后顺序全靠脑子记。** A 要等 B 做完才能开始，你得自己盯着。

Harness 把这些事接管了：

**隔离** —— 每个任务自动开一个 git worktree + 独立分支，agent 之间互不干扰。
**交卷制** —— agent 必须主动说"我做完了"（调一个叫 `complete_task` 的工具），不然就算没完成。退出不代表做完，这样才不会把半成品推给下游。
**自动验证** —— 任务完成后可以自动跑一轮验证。没通过就打回去让同一个 agent 继续改，上下文不丢。
**不怕断** —— agent 进程跟 server 进程是分离的。你重启 server，agent 还在跑；下次启动自动接回来。
**排队** —— 可以把任务串成队列：上一个做完，下一个自动开始。也可以一批任务并行跑。
**验收合并** —— 看完觉得行，一键把改动合回主干、删掉临时分支，全自动。有冲突就叫醒来源任务去修。

Harness 自己不写代码，也不需要你的 API key。干活的是那些 CLI 自己的登录态。

---

## 快速开始

你需要：Node.js ≥ 22.16、git，以及至少一个 agent CLI（装好并登录过）。

```bash
# 装一个 agent CLI（至少装一个）
npm install -g @anthropic-ai/claude-code  &&  claude   # 登录一次
npm install -g @openai/codex              &&  codex    # 登录一次
```

```bash
# 装 Harness
git clone https://github.com/noroot777/ash.git harness
cd harness
npm run setup     # 检查环境 → 装依赖 → 构建 → 接上 MCP → 列出可用的 CLI
npm start         # 浏览器打开 http://localhost:4317
```

打开之后：新建项目（填一个 git 仓库的绝对路径）→ 新建任务 → 选一个执行器 → 点"跑"。

> **setup 里的 MCP 那步不能省。** agent 是靠 MCP 工具来交卷的。MCP 没接上，agent 就没有交卷的手段，每个任务跑完都会显示失败。验证方法：`claude mcp list` 能看到 `harness: … ✔ Connected` 就对了。手动接法见 [docs/install.md](docs/install.md)。

---

## 支持的执行器

内置 15 个 CLI 的配置。你机器上装了哪些，界面里就能选哪些：

Claude · Codex · Gemini · Cursor · Copilot · OpenCode · Qwen · Grok · Kimi · Trae · Kiro · Kilo · Qoder · Antigravity · Pi

在"设置 → 执行器"里可以建 profile，固定某个 CLI 用哪个模型、多高的思考强度。

想加一个新的 CLI？写一个 TypeScript 文件就行，见 [`server/src/executors/catalog/README.md`](server/src/executors/catalog/README.md)。

---

## 几种用法

**最常用的：一个任务一个 agent。** 写清楚你要什么，选个执行器，跑。

**串行队列：** 把几个任务排成一条链，前一个做完自动跑下一个。适合有先后依赖的活。

**并行分组：** 一批互不相干的任务同时开工。每个任务有自己的 worktree，不会互相踩。

**团队模式：** 派一个 agent 当调度台，它自己拆活、自己派执行者出去、自己收口。你只管看结果。

**验证流程：** 任务做完后自动跑验证轮。验证不通过就打回去，同一个 agent 在同一个会话里继续改。反复来回直到你觉得行了，一键验收合并。

---

## 项目结构

一个 Node 进程（Hono），同时跑 API、推送事件（SSE）、托管前端页面。没有 nginx，没有 Docker，没有第二个服务。

```
server/     后端：API、编排、进程管理、托管前端
web-next/   前端：React + Vite + Tailwind
shared/     前后端共享的类型定义
mcp/        给 agent 用的 MCP server（25 个工具）
mobile/     Expo 移动端（看任务、回消息）
scripts/    setup / restart / package，.mjs 脚本，三平台通用
```

数据库是 SQLite，用的是 Node 22 内置的 `node:sqlite`，不需要编译原生模块。ORM 是 Drizzle，启动时自动补列，不用手动跑迁移。

---

## 配置

通过环境变量配置：

- **`PORT`**（默认 4317）—— 界面和 API 是同一个端口。
- **`HARNESS_DB`**（默认 `./data/harness.db`）—— 数据库文件位置。

所有数据都在仓库里的 `data/` 目录下。备份就备份这个目录，换机器整个拷过去就行。这个目录不入 git。

> **安全提醒：** 默认监听所有网卡（0.0.0.0），没有任何登录验证。谁能连到这个端口，谁就能派任务、读代码、在你机器上跑命令。只在你信任的网络里用，或者自己在前面加一层反代做认证。

---

## 开发

```bash
npm run dev        # 后端 :4317 + 前端 :5173（代理 /api 到后端），改前端有热更新
npm run build      # 构建所有模块
npm run restart    # 构建 + 后台常驻（关掉终端也活着）
npm run package    # 打分发包，只含入库文件
```

前端改完跑一次 `npm run build` 就够了，server 是从磁盘读前端构建产物的，不用重启。

测试按主题拆开，每个单独跑：

```bash
npm -w server run test:queue          # 队列推进
npm -w server run test:accept-merge   # 验收合并
npm -w server run test:review         # 验证轮
npm -w server run test:detached       # agent 重启存活
```

注意：这些端到端测试会真的拉起 agent CLI，会消耗真实的 API 额度。

---

## 常见问题

**任务跑完全是红的，日志里没报错？**
MCP 没接上。跑 `claude mcp list`，看 harness 是不是 Connected。

**界面打开了，但一片空白？**
前端没构建或者过期了。跑 `npm run build`，不用重启 server。

**派任务立刻报 ENOENT？**
那个 CLI 没装，或者不在 server 进程能找到的 PATH 里。用终端（而不是从 GUI 应用）起 server 通常就好了。

**Windows 上报 Filename too long？**
撞了 260 字符路径上限。管理员 PowerShell 里开 `LongPathsEnabled`，再跑 `git config --global core.longpaths true`。`npm run setup` 会帮你检查这两条。

---

## 更多文档

- [docs/install.md](docs/install.md) —— 装到别的机器、MCP 接线、日常运维、排错
- [docs/incidents.md](docs/incidents.md) —— 踩过的坑、被证伪的路线
- [docs/windows-testing.md](docs/windows-testing.md) —— Windows 上的测试基线
