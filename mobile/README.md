# Ash — Harness 的 iPhone 客户端

用 Expo / React Native 写的 harness 手机端：随时查看 / 新建 / 运行普通任务，看 agent
实时输出并回复会话；也支持团队任务，以及只读查看 `/duet` 的完整讨论记录与状态。

后端不动——这是 harness 的第二个前端，经 REST + 一条全局 SSE（`server/`）通信。

## 跑起来（开发，Expo Go）

前提：iPhone 与 Mac 同在 Tailscale 网络；harness 后端在 Mac 上运行。

```bash
# 1) 起后端（在 harness 根目录）
cd /Users/fjh/code/harness
npm run dev          # 或 npm run build && npm start，监听 :4317（0.0.0.0）

# 2) 起手机端
cd mobile
npm run start        # 自动清 Metro 缓存；用 iPhone 的相机 / Expo Go 扫二维码

# 无网络时使用（仍会自动清 Metro 缓存）
npm run start:offline
```

App 首次启动会进「设置」：填后端地址（如 `http://<你的-tailscale-主机或IP>:4317`）→ 测试并保存。
顶栏连接点变绿即实时连上。

## 架构

```
src/
  app/                 expo-router 路由
    _layout.tsx          根 Stack；启动读配置、起 SSE、灌数据
    index.tsx            任务列表（按 7 态分组，仅 single）
    task/[id].tsx        任务详情（流式对话 + 运行控制 + 回复）
    new.tsx              新建任务
    settings.tsx         后端地址 + 连通测试
  lib/
    config.ts            后端 baseURL 持久化（AsyncStorage）
    api.ts               REST 客户端（single 子集，baseURL 前缀）
    sse.ts               react-native-sse 连 /api/events → store
    store.ts             zustand 全局状态 + SSE 事件处理
    data.ts              初始 / 重连数据加载
    log.ts               AgentEvent → LogLine（移植自 web）
    taskActions.ts       运行按钮状态机（移植自 web）
    constants.ts         状态元数据（颜色版）
    theme.ts             暗色调色板
  components/
    ui.tsx               StatusDot / Pill / Button
    Markdown.tsx         轻量 markdown 渲染（无额外依赖）
    Conversation.tsx     LogLine[] → 气泡时间线
```

## 复用 harness 共享类型（零漂移）

`@harness/shared` 经 `file:../shared` 依赖（`node_modules/@harness/shared` 符号链接）指向
`shared/src/index.ts`，Metro 直接转译其 TS 源码 —— 无构建步骤，类型与后端永不漂移。
对应 `metro.config.js`：`watchFolders=[repo 根]` + `unstable_enableSymlinks`。

> 该 App **不并入根 npm workspaces**，保有独立 node_modules，避免与 web/server 的
> React / React-Native 在 monorepo 里发生 hoist 冲突。

## 已验证

- `npx tsc --noEmit` 类型零报错。
- `npx expo export --platform ios` 干净打包（含 `@harness/shared` 解析与转译）。
- 对照线上后端核对了 `/api/projects`、`/api/tasks`、`/api/agents`、`/api/tasks/:id/sessions`、
  `/api/sessions/:id/output`、SSE `/api/events` 的返回形态。
- **待用户在真机（Expo Go）上跑一遍**：连后端 → 列表 → 新建并运行 → 看实时流 → 回复续接。

## 安全

后端无鉴权，仅经 Tailscale 内网访问，**勿把 :4317 暴露到公网**。
