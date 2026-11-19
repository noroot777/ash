<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo/lockup-dark.svg">
    <img alt="Navi" src="docs/logo/lockup-light.svg" height="56">
  </picture>
</p>

<p align="center">
  本地 AI 编程智能体的调度台<br>
  派活 · 排队 · 验证 · 接力 · 合并
</p>

<p align="center">
  <a href="https://nodejs.org"><img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.16-339933?logo=nodedotjs&logoColor=fff"></a>
  <a href="#支持的执行器"><img alt="agents" src="https://img.shields.io/badge/agents-15%20CLIs-blue"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-green"></a>
</p>

<p align="center">
  <a href="#mac-客户端">Mac 客户端</a> · <a href="#快速开始">快速开始</a> · <a href="#它能干什么">它能干什么</a> · <a href="#编排方式">编排方式</a> · <a href="docs/install.md">部署文档</a>
</p>

---

<!-- 介绍片。GitHub 只给拖进评论框上传的附件出播放器,地址需独占一行。
     工程和成片在素材库 noroot777/materials 的 navi/promo 下,不进本仓库。 -->

https://github.com/user-attachments/assets/9c9c559f-bf5d-4043-913d-7b065f875a2b

Navi 管的不是某一个 AI 编程工具，而是管这些工具怎么干活。

你把任务扔给它，它分配给 Claude Code、Codex、Gemini 这些 agent CLI，让它们在隔离的 git worktree 里干，干完自动验证，验证过了合并回主干。整个过程你可以不管，也可以随时插手。

一个 Node 进程，一个端口，数据全在本地。不要你的 API key，不替代任何工具——只管调度。

## Mac 客户端

<!-- navi-mac-download -->
**[下载 Navi 0.2.0（20261119.224103）](https://github.com/noroot777/navi/releases/download/navi-mac-v0.2.0-20261119.224103/Navi-0.2.0-20261119.224103.dmg)**
<!-- /navi-mac-download -->

<!-- 标记之间由发版脚本（npm run release:mac）自动替换为 dmg 直链。 -->

自带 Node 和 Navi 本体，装好就能用。要求 Apple 芯片（M 系列）、macOS 14+。

1. 下载 dmg，把 **Navi** 拖进 **Applications**。
2. 首次打开会被系统拦——到「系统设置 → 隐私与安全性」页面底部点「仍要打开」。
3. 如果提示「已损坏」，终端跑一下：
   ```bash
   xattr -dr com.apple.quarantine /Applications/Navi.app
   ```
4. 以后从菜单「Navi → 检查更新…」升级。

> 装过旧版 **Ash.app** 的：Navi 首次打开会自动接管 Ash 的设置和数据，细节见 [desktop/macos/README.md](desktop/macos/README.md#从-ashapp-升级)。

## 快速开始

需要 Node.js >= 22.16、git，以及至少一个装好的 agent CLI。

```bash
# 装一个 agent CLI（至少一个）
npm install -g @anthropic-ai/claude-code && claude
npm install -g @openai/codex && codex
```

```bash
# 启动 Navi
git clone https://github.com/noroot777/navi.git && cd navi
npm run setup        # 检查环境 → 装依赖 → 构建 → 接入 MCP
npm start            # http://localhost:4317
```

然后：新建项目（填仓库路径或 Git URL）→ 建任务 → 选执行器 → 跑。

> [!IMPORTANT]
> **MCP 接入不能跳过。** Agent 靠 MCP 工具 `complete_task` 来交卷。没接入的话所有任务都会变成 failed。<br>
> 验证方法：`claude mcp list` 里 `navi` 那行应该是 Connected。<br>
> 手动接入见 [docs/install.md](docs/install.md)。

## 它能干什么

**随时换智能体** — 任务跑到一半觉得不对，直接换一个 agent、换一个模型，下一轮立刻生效。上下文跨 agent 共享，不会丢。

**队列** — 串行的按顺序跑，前一个完了自动启动下一个；并行的同时跑，各自在独立 worktree 里互不干扰。

**前置依赖** — A 任务依赖 B 和 C 的结果，B、C 完成后 A 自动开工。建任务时指定前置，调度的事不用你管。

**自动验证** — 任务做完了不直接算完，先跑一轮验证（可以配多轮）。没过就打回去改，改完再验证，上下文全程保留。

**一键验收** — 确认通过后自动合并代码、清理 worktree 和临时分支。有冲突会叫你处理。

**实时预览** — Agent 改了前端代码，直接在 Navi 里起预览服务看效果。支持同时开多个，端口自动分配。

**任务接力** — 一台机器上的任务可以连同代码、会话历史、附件一起迁移到另一台 Navi 继续跑。用 ed25519 密钥对做认证，首次配对验一次指纹就行。详见 [docs/handoff.md](docs/handoff.md)。

**群聊** — 项目下的持久频道，拉进不同的 agent 用 @点名。被点到的 agent 可以看代码给建议，也可以直接建任务去做。

**助手** — 侧栏打开就能跟 agent 对话，不用先建项目。搜历史任务、起草任务、往别的项目派活都行。

**全局搜索** — `⌘K` 搜任务标题、正文、会话内容，打字就出结果。

**手机端** — Expo 做的 iOS/Android 客户端，能看任务、回消息、操作队列。

**重启不丢活** — Agent 进程和 server 解耦。重启时自动检测在跑的任务：能接管的无感接管，不能的拦住不让重启。详见下面的开发章节。

## 编排方式

| 方式 | 说明 |
|---|---|
| 单任务 | 一个任务一个 agent，最基本的用法 |
| 串行队列 | 按顺序排，前一个做完自动启动下一个 |
| 并行分组 | 一批不相关的任务同时跑，各自隔离 |
| 前置依赖 | A 依赖 B 和 C，B 和 C 都过了 A 才开工 |
| 验证循环 | 实现 → 验证 → 打回 → 修复 → 再验证，循环到通过 |

## 支持的执行器

机器上装了哪些就能用哪些：

| | | | | |
|---|---|---|---|---|
| `claude` | `codex` | `gemini` | `cursor` | `copilot` |
| `opencode` | `qwen` | `grok` | `kimi` | `trae` |
| `kiro` | `kilo` | `qoder` | `antigravity` | `pi` |

每个 CLI 可以建多个 profile（固定模型和智能水平）。任务上选执行器 → 模型 → 智能水平，跑着的时候也能换。

加一个新 CLI 只要写一个 TypeScript 文件，见 [server/src/executors/catalog/README.md](server/src/executors/catalog/README.md)。

## 项目结构

```
server/   后端 — Hono, SQLite (node:sqlite), Drizzle, SSE
web/      前端 — React, Vite, Tailwind
shared/   前后端共享类型
mcp/      MCP server — agent 调用的工具集
mobile/   Expo 移动端
desktop/  Mac 客户端
scripts/  setup / restart / package 等脚本
```

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `4317` | 界面和 API 共用 |
| `NAVI_DB` | `./data/navi.db` | SQLite 数据库路径 |

数据都在 `data/` 目录（数据库、运行记录、上传的文件），不入 git。备份就拷这个目录。

## 开发

```bash
npm run dev          # 后端 :4317 + 前端 :5173（HMR，/api 代理到后端）
npm run build        # 全量构建（shared → web → server → mcp）
npm run restart      # 构建 + 后台常驻
npm run stop         # 停掉后台服务
```

前端改完只需 `npm run build`，server 从磁盘读 `web/dist`，不用重启。

### restart 的安全机制

`npm run restart` 不是无脑 kill。它先问 server「重启会打断几个任务」：

- 没任务或全部可接管 → 直接重启
- 有会被打断的 → 拒绝，列出受影响的任务
- `npm run restart -- --wait` → 等打断的跑完再重启
- `npm run restart -- --force` → 强制重启，被打断的标 failed

`npm run stop` 同一套逻辑，停完不再起新的。

### 回归测试

构建不跑测试。回归统一在验收时执行：

```bash
npm run test:accept     # 验收前置命令
npm run test:web        # 前端全量回归
```

> [!CAUTION]
> 端到端测试会启动真实的 agent CLI，消耗 API 额度。

## 常见问题

<details>
<summary>所有任务都显示 failed</summary>

MCP 没接入。跑 `claude mcp list` 看 `navi` 那行是不是 Connected。

</details>

<details>
<summary>界面空白</summary>

前端没构建。跑 `npm run build`，不用重启 server。

</details>

<details>
<summary>派任务报 ENOENT</summary>

目标 CLI 没装，或者不在 server 进程的 PATH 里。建议从终端启动 server，别从 GUI 应用里起。

</details>

<details>
<summary>claude 任务 0 秒退出，报 root/sudo 权限错误</summary>

以 root 跑 Navi 时 claude 执行器必然失败。换非 root 用户跑，或者设环境变量 `IS_SANDBOX=1`（代价是 agent 以 root 权限无确认地操作机器）。

</details>

---

<p align="center">
  <a href="docs/install.md">部署与运维</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="docs/handoff.md">任务接力</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="docs/llm-relay.md">供应商转发诊断</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="docs/incidents.md">踩坑记录</a>
</p>

## License

[MIT](LICENSE)
