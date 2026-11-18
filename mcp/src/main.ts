// Ash MCP server — a THIN adapter that exposes the ash HTTP API as MCP
// tools so an LLM agent (Claude Code / Desktop / Cursor / a spawned `claude`)
// can orchestrate tasks natively. It holds no logic of its own: every tool just
// calls an existing endpoint on the ash server (default http://localhost:4317,
// override with ASH_URL). The Hono server stays the single source of truth.
//
// 这份文件只负责**接线**：起 server、挂上各组工具、连上 stdio。工具本体按作用对象分在
// tools/ 下（orchestrate = 安排活，read-transcript = 旁观别的任务说过的话，task-turn =
// 一条任务在自己回合里说的话，monitor = 挂一条长跑命令让它来叫我），传输层在
// runtime.ts，共用入参形状在 schemas.ts。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { BASE, IDENTITY_REFUSAL } from "./runtime.js";
import { registerMonitorTools } from "./tools/monitor.js";
import { registerOrchestrationTools } from "./tools/orchestrate.js";
import { registerReadTranscriptTools } from "./tools/read-transcript.js";
import { registerTaskTurnTools } from "./tools/task-turn.js";

// 回合身份对不上 ash 注入的指纹:不连。连上了 CLI 就报 connected、工具一样不少,带的却是别的回合
// 的令牌,要到交卷才被拒;退出则 CLI 当场报 ash 没接上,ash 据此留一条诊断(见 turn-identity.ts)。
if (IDENTITY_REFUSAL) {
  console.error(`[navi-mcp] ${IDENTITY_REFUSAL}`);
  process.exit(1);
}

const server = new McpServer({ name: ASH_MCP_SERVER_NAME, version: "0.1.0" });
registerOrchestrationTools(server);
registerReadTranscriptTools(server);
registerTaskTurnTools(server);
registerMonitorTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[navi-mcp] connected — tools ready (NAVI_URL=${BASE})`);
