# Harness

编排本地 / 远程编程智能体（claude / codex / …）的控制台。设计见 [DESIGN.md](./DESIGN.md)。

## 技术栈（DESIGN.md §11）

单后端进程（Hono）托管 Vite + React + Tailwind 构建的 SPA；SQLite（libsql 驱动）+ Drizzle；SSE 实时；一体单仓。

```
shared/   前后端共享类型
server/   Hono 后端：API + SSE + 编排单例 + 托管前端
web/      React + Vite + Tailwind 前端
```

## 开发

```bash
npm install
npm run dev      # 后端 :4317 + Vite :5173（代理 /api 到后端）
```

浏览器开 http://localhost:5173 。

## 构建 + 运行（生产 / 自托管常驻）

```bash
npm run build    # 构建 shared + web + server
npm start        # 后端在 :4317 同时托管前端 dist 与 API
```

环境变量：`PORT`（默认 4317）、`HARNESS_DB`（默认 `./data/harness.db`）。

## 里程碑

见 DESIGN.md §14。当前：**M0 项目骨架** ✅ → M1 单 agent 垂直切片。
