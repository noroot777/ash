# @ash/mcp

把 ash 的 HTTP API 包成 **MCP 工具**，让智能体（Claude Code / Desktop / Cursor，或被 ash 拉起的 `claude`）能原生编排任务，而不用在 prompt 里教它 curl。

这是一层**薄适配器**：本身不含逻辑，每个工具只转调 ash server 的现有接口。真源始终是 Hono server。

## 工具

| 工具 | 作用 | 对应接口 |
|------|------|----------|
| `resolve_project` | 按 repoPath 找到/创建项目（幂等） | `POST /projects/resolve` |
| `create_group` | 在项目里建分组（projectId 或 repoPath 定位） | `POST /groups` |
| `batch_create_tasks` | 往已有分组批量建任务（`chain` 串依赖、`run` 开跑） | `POST /groups/:id/tasks/batch` |
| `run_group` | 运行分组（按 groupId） | `POST /groups/:id/run` |
| `list_groups` | 列分组（按 project/repoPath，含任务状态汇总） | `GET /groups` |
| `list_tasks` | 列任务（可按 project/group 过滤） | `GET /tasks` |
| `get_task` | 查单个任务 | `GET /tasks/:id` |
| `create_task_chain` | **一步到位**：resolve → group → 链式 batch | 上面三个组合 |

## 前置

```bash
npm run build          # 含 mcp 的构建（产出 mcp/dist/index.js）
npm start              # 起 ash server（默认 :4317）
```

MCP 进程通过 `ASH_URL` 找 server，默认 `http://localhost:4317`。

## 接入 Claude Code

```bash
# 当前项目可用（local 作用域）
claude mcp add ash -e ASH_URL=http://localhost:4317 -- node /Users/fjh/code/ash/mcp/dist/index.js

# 或所有项目都可用（user 作用域）—— 推荐，编排别的仓库时也能用
claude mcp add ash --scope user -e ASH_URL=http://localhost:4317 -- node /Users/fjh/code/ash/mcp/dist/index.js
```

或提交进仓库、团队共享（项目根 `.mcp.json`）：

```json
{
  "mcpServers": {
    "ash": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PROJECT_DIR}/mcp/dist/index.js"],
      "env": { "ASH_URL": "http://localhost:4317" }
    }
  }
}
```

验证：会话里 `/mcp` 看连接状态与工具数；CLI 用 `claude mcp list` / `claude mcp get ash`。重建后开新会话即可（stdio 进程下次调用时重连）。

> Claude Desktop / Cursor 用同样的 `mcpServers` JSON，填到各自的配置文件即可。

## 接入 Codex

同一个 server 通用。Codex 的 `mcp add` 里**服务名是必填位置参数**，env 用 `--env`：

```bash
codex mcp add ash --env ASH_URL=http://localhost:4317 -- node /Users/fjh/code/ash/mcp/dist/index.js
```

查看 `codex mcp list` / `codex mcp get ash`；删除 `codex mcp remove ash`。写进 `~/.codex/config.toml`：

```toml
[mcp_servers.ash]
command = "node"
args = ["/Users/fjh/code/ash/mcp/dist/index.js"]
env = { ASH_URL = "http://localhost:4317" }
```

## 给智能体的话术示例

> 用 ash 在 `/Users/fjh/code/ash` 建一组依赖任务：先写测试、再实现、最后跑校验，三步串起来（A 完成才做 B），都用 claude，建完就开跑。

智能体会调 `create_task_chain(repoPath, tasks:[…], agentType:"claude", run:true)` 一次搞定。

## 注意

- stdio server 的 **stdout 只能走 MCP 协议**；本服务所有日志都打到 stderr，勿改成 `console.log`。
- 依赖链当前只保证**顺序**（A→B→C 的调度先后），不保证「A 成功才做 B」——失败门控是另一个 server 侧的活儿（见 DESIGN/路线）。
