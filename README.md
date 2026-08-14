# Harness

编排本地 / 远程编程智能体（claude / codex / …）的控制台。

## 技术栈

单后端进程（Hono）托管 Vite + React + Tailwind 构建的 SPA；SQLite（libsql 驱动）+ Drizzle；SSE 实时；一体单仓。

```
shared/   前后端共享类型
server/   Hono 后端：API + SSE + 编排单例 + 托管前端
web-next/ React + Vite + Tailwind 前端
```

## 开发

```bash
npm install
npm run dev      # 后端 :4317 + Vite :5173（代理 /api 到后端）
```

浏览器开 http://localhost:5173 。

## 构建 + 运行（生产 / 自托管常驻）

```bash
npm run build    # 构建 shared + web-next + server + mcp
npm start        # 后端在 :4317 同时托管前端 dist 与 API
```

环境变量：`PORT`（默认 4317）、`HARNESS_DB`（默认 `./data/harness.db`）。

## 装到别的机器 / 发给别人

```bash
npm run package    # 打出 dist-package/harness-<日期>-<sha>.tar.gz（只含入库文件，不含 data/）
```

对方解包后 `node scripts/setup.mjs` 一条命令装完（依赖 → 构建 → 接上 harness MCP）。
前置、MCP 为什么不能省、备份、排错见 [docs/install.md](docs/install.md)。

## 里程碑

M0 项目骨架 ✅ → M1 单 agent 垂直切片。
