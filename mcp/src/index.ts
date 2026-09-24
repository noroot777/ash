#!/usr/bin/env node
// Ash MCP server — a THIN adapter that exposes the ash HTTP API as MCP
// tools so an LLM agent (Claude Code / Desktop / Cursor / a spawned `claude`)
// can orchestrate tasks natively. It holds no logic of its own: every tool just
// calls an existing endpoint on the ash server (default http://localhost:4317,
// override with ASH_URL). The Hono server stays the single source of truth.
//
// 这份文件只负责**接线**：起 server、挂两组工具、连上 stdio。工具本体按作用对象分在
// tools/ 下（orchestrate = 安排活，task-turn = 一条任务在自己回合里说的话），传输层在
// runtime.ts，共用入参形状在 schemas.ts。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BASE } from "./runtime.js";
import { registerOrchestrationTools } from "./tools/orchestrate.js";
import { registerTaskTurnTools } from "./tools/task-turn.js";

const server = new McpServer({ name: "ash", version: "0.1.0" });
registerOrchestrationTools(server);
registerTaskTurnTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[ash-mcp] connected — tools ready (ASH_URL=${BASE})`);
