<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/Ash-e8e8e8?style=for-the-badge&labelColor=111&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNlOGU4ZTgiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTIgMmw5IDE4SDNsMi0xOCIvPjwvc3ZnPg==">
    <img alt="Ash" src="https://img.shields.io/badge/Ash-333?style=for-the-badge&labelColor=fff&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTIgMmw5IDE4SDNsMi0xOCIvPjwvc3ZnPg==">
  </picture>
</p>

<p align="center">
  <strong>AI 编程智能体的本地调度台</strong><br>
  派活 · 排队 · 验证 · 接力 · 合并 —— 一个进程搞定
</p>

<p align="center">
  <a href="https://nodejs.org"><img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.16-339933?logo=nodedotjs&logoColor=fff"></a>
  <a href="#支持的执行器"><img alt="agents" src="https://img.shields.io/badge/agents-15%20CLIs-blue?logo=robot&logoColor=fff"></a>
  <a href="#mcp-工具"><img alt="MCP tools" src="https://img.shields.io/badge/MCP-25%20tools-8B5CF6?logo=puzzle&logoColor=fff"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey?logo=apple&logoColor=fff">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> · <a href="#核心能力">核心能力</a> · <a href="#编排模式">编排模式</a> · <a href="#任务接力">任务接力</a> · <a href="#多人模式">多人模式</a> · <a href="docs/install.md">部署文档</a>
</p>

---

Ash 是一个自托管的编排控制台，用来管理本地的 AI 编程智能体 CLI（Claude Code、Codex、Gemini 等）。它不替代这些工具，也不需要你的 API key —— 它负责的是**调度**：把任务分配给 agent，在隔离的 worktree 中执行，自动验证结果，最终合并回主干。

一个 Node 进程，一个端口，数据全在本地磁盘。

## 快速开始

> **前置条件**：Node.js >= 22.16、git，至少一个已安装并登录过的 agent CLI。

```bash
# 安装 agent CLI（至少一个）
npm install -g @anthropic-ai/claude-code && claude
npm install -g @openai/codex && codex
```

```bash
# 安装并启动 Ash
git clone https://github.com/noroot777/ash.git && cd ash
npm run setup        # 环境检查 → 依赖安装 → 构建 → MCP 接入
npm start            # http://localhost:4317
```

启动后：新建项目（填 git 仓库绝对路径，或直接从 Git URL 检出）→ 创建任务 → 选择执行器 → 运行。

> [!IMPORTANT]
> **MCP 接入不可跳过。** agent 通过 MCP 工具 `complete_task` 提交完成状态。未接入 MCP 的 agent 无法交卷，所有任务将显示为失败。<br>验证：`claude mcp list` 中应显示 `ash: … ✔ Connected`。<br>手动接入方法见 [docs/install.md](docs/install.md)。

## 核心能力

🔀 **Worktree 隔离** — 每个任务自动创建独立的 git worktree 和分支，多任务并行互不干扰。

📋 **完成协议** — agent 必须主动调用 `complete_task` 才算完成。进程退出 ≠ 任务完成，避免半成品被推进下游队列。

🔍 **自动验证** — 任务完成后触发验证轮（可配置多轮复审），在同一会话中运行。未通过则打回修复，上下文完整保留。

♻️ **重启存活** — agent 进程与 server 解耦。`npm run restart` 会自动检测在跑的任务：能接管的无感接管，不能接管的拦住不重启。**在 macOS/Linux 上，单飞任务的 agent 进程完全不受重启影响**（输出写文件而非管道）；团队调度台自动 `--resume` 接回。

> [!NOTE]
> **Windows 上重启会打断正在运行的单飞任务。** 输出落盘的 detached 机制依赖 POSIX shell 重定向（`/bin/sh -c`），Windows 上没有等价实现，因此退化为管道模式 —— server 一重启管道断开，agent 进程随之终止。被打断的任务标记为 failed，可手动重试续跑。`npm run restart` 的安全闸在 Windows 上同样生效：它会提示有多少任务将被打断，不加 `FORCE=1` 不会动手。

🔗 **队列编排** — 串行队列按序推进，并行分组同时运行。失败任务自动跳过，重新排队时按规则归位。

✅ **一键验收** — 确认通过后自动合并到主干、清理 worktree 和临时分支。遇到冲突会唤醒来源任务处理。

🔎 **全局搜索** — `⌘K` 搜任务标题、正文、会话内容，边打边出结果，毫秒级响应。

🗂️ **任务模式** — 跨项目鸟瞰所有在跑和待验收的任务，按项目分组，一键展开会话。

🖼️ **图片与附件** — 粘贴图片直接上传（带进度条），附件随任务接力迁移，agent 的对话里也能渲染用户上传的图。

📝 **随手记** — 项目级别的快速笔记，列表内直接新建，多人模式下按人隔离。

🌿 **Git 面板** — 每个项目内置分支浏览、推送、项目级 Git 身份与 HTTPS 凭证配置。

📲 **移动端** — Expo 构建的 iOS/Android 客户端，查看任务、回复消息、操作团队，随时随地。

## 支持的执行器

内置 15 个 CLI 执行器配置，机器上安装了哪些就能使用哪些：

<table>
<tr>
<td><code>claude</code></td><td><code>codex</code></td><td><code>gemini</code></td><td><code>cursor</code></td><td><code>copilot</code></td>
</tr>
<tr>
<td><code>opencode</code></td><td><code>qwen</code></td><td><code>grok</code></td><td><code>kimi</code></td><td><code>trae</code></td>
</tr>
<tr>
<td><code>kiro</code></td><td><code>kilo</code></td><td><code>qoder</code></td><td><code>antigravity</code></td><td><code>pi</code></td>
</tr>
</table>

通过「设置 → 执行器」可为每个 CLI 创建 **profile**（固定模型与思考强度）。任务级别也可以单独覆盖模型和思考强度。添加新 CLI 只需一个 TypeScript 文件 — 见 [catalog/README.md](server/src/executors/catalog/README.md)。

## MCP 工具

Ash 通过 [Model Context Protocol](https://modelcontextprotocol.io) 向 agent 暴露 **25 个工具**，覆盖任务全生命周期：

| 类别 | 工具 |
|---|---|
| 项目 / 分组 | `resolve_project` `create_group` `resolve_group` `list_groups` |
| 任务管理 | `create_task_chain` `batch_create_tasks` `get_task` `list_tasks` `patch_task` |
| 队列 | `create_queue` `get_queue` `queue_insert` `queue_remove` `queue_reorder` `requeue_task` |
| 生命周期 | `run_task` `run_group` `stop_task` `complete_task` `pause_task` `accept_task` |
| 协作 | `ask_question` `answer_question` `report_stage` `dispatch` |

## 编排模式

**单任务** — 一个任务指派一个 agent，最基础的使用方式。

**串行队列** — 多个任务按序编排，前一个完成后自动启动下一个，适用于有依赖关系的工作流。

**并行分组** — 一批无关联的任务同时运行，各自在独立 worktree 中工作。

**团队模式** — 指派一个 agent 担任调度台（常驻会话），由它自行拆分子任务、分派执行者、汇总结果。支持团队预设和执行者配置。

**Duet** — 两个 agent 协作研讨同一问题，中间设有人工闸口，最终合稿输出。可无缝转交给团队模式继续执行。

**验证循环** — 实现 → 验证 → 打回 → 修复 → 再验证，轮数可配，循环至通过后由用户验收合并。

## 任务接力

跨机器任务迁移：把一台 Ash 上的任务——连同代码进度、对话历史和附件——接力到另一台 Ash 继续。

### 接力什么

- **git 状态** — 任务分支上的提交打成增量 bundle，未提交改动先做 WIP 提交
- **CLI 会话** — claude / codex 的会话文件物理迁移，对端续跑时保留完整对话上下文
- **附件和产物** — 上传的图片、会话 trace、定时计划一并迁移，路径自动改写
- **审查历史** — 验证轮次和验收落账跟着任务走

### 怎么用

1. 设置 → 默认规则 → 添加目标机器地址（如 `http://192.168.1.50:4317`）
2. 打开任务 → 输入框上方 → 「接力到另一台机器」（支持批量接力）
3. 预检通过后确认发送，可选到达后自动续跑

### 安全

每台 Ash 实例有独立的 **ed25519 密钥对**。接力前校验目标机器指纹，首次配对核对一次即可。多人模式下接力按人授权（对端账号 key），传输可选加密。

### 退化与兜底

| 情况 | 结果 |
|---|---|
| 会话文件迁移失败 | agent 全新起跑，任务正文嵌入首条消息，git 进度仍在 |
| 对端不是 git 仓库 | 退化为共享目录运行，代码不迁移 |
| 网络中断 | 本机标记「接力未确认」，重试幂等不重复导入 |
| 目标机换了机器 | 指纹对不上，**打包之前**就拒绝 |
| 对端没批准本机 | 预检如实报出，接力按钮按住不放 |
| 需要回到本机 | 横幅 → 「在本机继续」移除标记即可 |

> 完整的流程说明与故障排查见 **[docs/handoff.md](docs/handoff.md)**。

## 多人模式

开启多人模式后，一台 Ash 可以供多人使用，各有独立的账号、CLI 环境、项目可见性和资源隔离。

- **角色体系** — 管理员 / 成员，实例级与项目级双层权限
- **CLI 额度隔离** — 可选「隔离」或「共用」两档，首次启动时选一次，设置里随时改
- **按人派发** — 跨人回合按「谁点的」跑，换执行器前显式确认
- **接力授权** — 接力凭对端账号 key 认人，不是认机器
- **可见性过滤** — 任务、随手记、搜索结果均按归属过滤

> [!WARNING]
> 默认监听 `0.0.0.0` 且无鉴权（终端 API 本身就是个 shell）。请仅在可信网络中使用，或自行在前端部署反向代理进行认证。

## 项目结构

```
server/   Hono 后端 — API、任务编排、进程管理、前端托管
web/      React + Vite + Tailwind 前端
shared/   前后端共享类型
mcp/      MCP server — 25 个工具供 agent 调用
mobile/   Expo 移动端（iOS / Android）
scripts/  setup / restart / package（.mjs，跨平台）
```

<details>
<summary>技术选型</summary>
<br>

- **SQLite** — Node 22 内置的 `node:sqlite`，零原生编译依赖。代价是 Node 最低版本要求 22.16。
- **Drizzle** — 管理 schema，启动时自动补列，无需手动迁移。
- **SSE** — 替代 WebSocket。数据流为服务端单向推送（任务状态、输出、trace），对反代透明。
- **单实例锁** — 粒度是 DB 文件路径，不是端口。锁文件（`*.ash.lock`）由 server 写入，restart 脚本读取以识别进程归属。
- **平台差异** — 收敛在 `server/src/platform.ts` 一个文件。进程表、进程树击杀、端口查询按平台分发实现。Windows 能力缺口在文件头部标注。

</details>

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `4317` | 服务端口（界面与 API 共用） |
| `ASH_DB` | `./data/ash.db` | SQLite 数据库路径 |

所有持久化数据存放在 `data/` 目录（数据库、运行记录、上传文件），该目录不入 git。备份迁移只需拷贝此目录。

## 开发

```bash
npm run dev          # 后端 :4317 + 前端 :5173（HMR，/api 代理到后端）
npm run build        # 全量构建（shared → web → server → mcp）
npm run restart      # 构建 + 后台常驻（自动检测任务安全）
npm run package      # 生成分发包（仅入库文件，不含 data/）
```

### `npm run restart` 安全机制

Restart 不是盲目的 kill + start。它会先问服务端「重启会真正打断几个任务」：

| 情况 | 行为 |
|---|---|
| 无任务 / 全部可接管 | 直接重启，全程无感 |
| 有会被打断的任务 | **拒绝重启**，列出受影响任务 |
| `WAIT=1` | 等所有任务跑完再重启 |
| `FORCE=1` | 强制重启，被打断的标 failed |
| MCP 通道被占 | 默认跳过 MCP 刷新，不掐断交卷 |

前端修改后仅需 `npm run build`，server 从磁盘读取 `web/dist`，**无需重启**。

### 回归测试

```bash
npm -w server run test:queue          # 队列推进与排序
npm -w server run test:accept-merge   # 验收合并与冲突处理
npm -w server run test:review         # 验证轮与证据落盘
npm -w server run test:detached       # agent 重启存活
npm -w server run test:handoff        # 跨机器接力
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
<summary>claude 类任务 0 秒退出，报 <code>--dangerously-skip-permissions cannot be used with root/sudo privileges</code></summary>

以 root 跑 ash 时所有 claude 执行器必然 0 秒失败。三条出路：

1. **换非 root 用户跑 ash**（推荐）
2. 启动环境设 `IS_SANDBOX=1`（代价：agent 以 root 无确认地操作整台机器）
3. 在 bubblewrap 沙箱中跑 ash

</details>

<details>
<summary>Windows 上报 Filename too long</summary>

触发 260 字符路径限制。管理员 PowerShell 中启用 `LongPathsEnabled`，并执行 `git config --global core.longpaths true`。`npm run setup` 会自动检测。

</details>

---

<p align="center">
  <a href="docs/install.md"><b>📦 部署与运维</b></a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="docs/handoff.md"><b>🔄 任务接力指南</b></a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="docs/incidents.md"><b>📋 事故与踩坑记录</b></a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="docs/windows-testing.md"><b>🪟 Windows 测试基线</b></a>
</p>
