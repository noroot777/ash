// 飞书设置分区的 DOM 台子：把 window.fetch 换成一个记账的假服务端，断言在 test-feishu-settings.mjs。
//
// 场景由查询串选：?scenario=unconfigured（刚装好、什么都没配）/ connected（已连上、额度用了 74%）；
// &binding=code 表示「刷新前已经生成过一个码」——页面这时拿不到明文；&groups=demo 预置一个已绑的群
// 和一条已被群认领、等确认的群绑定码。
//
// 假服务端的状态挂在 window.__feishu 上，测试脚本用它模拟「飞书那头有人发来了码」（claim），
// 并且能让绑定状态的 GET 故意晚回（bindingDelay），用来钉住「写操作之前发出的轮询不许把界面拽回去」。
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FeishuBinding, FeishuGroups, FeishuStatus, ProjectView } from "@ash/shared";
import "../../src/styles/global.css";
import { FeishuSettings } from "../../src/settings/FeishuSettings.tsx";

const params = new URLSearchParams(location.search);
const configured = params.get("scenario") === "connected";
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

type Call = { method: string; path: string; token: string | null; body: unknown };

const server = {
  status: {
    canManage: true,
    multiUser: false,
    config: configured ? { appId: "cli_a1b2c3d4e5f6", domain: "feishu", updatedAt: at(-120) } : null,
    configError: null,
    connection: {
      state: configured ? "connected" : "unconfigured",
      since: configured ? at(-90) : null,
      connectedAt: configured ? at(-90) : null,
      lastEventAt: configured ? at(-3) : null,
      error: null,
      reconnectAttempts: 0,
      botName: configured ? "ash 助手" : null,
    },
    options: {
      enabled: true,
      notifyCompleted: true,
      publicBaseUrl: configured ? "https://my-mac.tailnet.ts.net:4317" : null,
      monthlyQuota: 10_000,
      titleOnlyProjectIds: [],
    },
    usage: configured
      ? { month: "2026-11", calls: 7400, quota: 10_000, level: "frugal", byKind: { send: 5200, patch: 1800, reaction: 380, token: 20 } }
      : { month: "2026-11", calls: 0, quota: 10_000, level: "normal", byKind: {} },
    instanceTag: "7F3A-91C2-0B5D",
    outbox: configured ? { pending: 2, dead: 1 } : { pending: 0, dead: 0 },
  } as FeishuStatus,
  binding: (params.get("binding") === "code"
    ? { state: "code", codeId: "code-before-refresh", expiresAt: at(7) }
    : { state: "none" }) as FeishuBinding,
  groups: (params.get("groups") === "demo"
    ? {
      groups: [{ chatId: "oc_team", name: "ash 开发群", projectId: "p-ash", boundAt: at(-600), pushCards: false, receiving: false, boundBy: "fjh", canEdit: true }],
      claims: [{ codeId: "gcode-1", projectId: "p-daily", chatId: "oc_daily", name: "日报群", claimedAt: at(-1), expiresAt: at(8) }],
    }
    : { groups: [], claims: [] }) as FeishuGroups,
  calls: [] as Call[],
  /** 保存凭证后多久「连上」：保存时先落 connecting，过了这个时刻的下一次 GET 才回 connected。 */
  connectAt: 0,
  bindingDelay: 0,
  bindingInFlight: 0,
  issued: 0,
  token: 0,
  /** 模拟飞书单聊里有人把码发给了机器人。 */
  claim(openIdTail = "a1b2c3") {
    if (server.binding.state !== "code") throw new Error(`binding is ${server.binding.state}, not code`);
    server.binding = { state: "pending", codeId: server.binding.codeId, openIdTail, claimedAt: at(0), expiresAt: server.binding.expiresAt };
  },
};
(window as unknown as { __feishu: typeof server }).__feishu = server;

const projects = [
  { id: "p-ash", name: "ash" },
  { id: "p-daily", name: "daily-report" },
] as unknown as ProjectView[];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function reply(body: unknown, status = 200, human = false) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // 真服务端的闸在每个真人动作的响应上发下一份凭据；这里照做，页面才会拿新的那份发下一次。
  if (human) headers["x-ash-human-action-token-next"] = `tok-${++server.token}`;
  return new Response(JSON.stringify(body), { status, headers });
}

const HUMAN = new Set([
  "PUT /api/im/feishu/credentials",
  "DELETE /api/im/feishu/credentials",
  "POST /api/im/feishu/binding/code",
  "POST /api/im/feishu/binding/confirm",
  "POST /api/im/feishu/groups/code",
  "POST /api/im/feishu/groups/confirm",
]);

async function handle(method: string, path: string, body: Record<string, unknown>): Promise<Response> {
  const human = HUMAN.has(`${method} ${path}`);
  const s = server.status;
  if (path === "/api/projects") return reply(projects);
  if (path === "/api/im/feishu/status") {
    if (s.connection.state === "connecting" && server.connectAt && Date.now() >= server.connectAt) {
      s.connection = { ...s.connection, state: "connected", since: at(0), connectedAt: at(0), botName: "ash 助手" };
    }
    return reply(s);
  }
  if (path === "/api/im/feishu/credentials" && method === "PUT") {
    if (!s.config && !body.appSecret) return reply({ error: "第一次配置要填 App Secret" }, 400, human);
    s.config = { appId: String(body.appId), domain: body.domain as "feishu" | "lark", updatedAt: at(0) };
    s.connection = { ...s.connection, state: "connecting", since: at(0), error: null };
    server.connectAt = Date.now() + 500;
    return reply(s, 200, human);
  }
  if (path === "/api/im/feishu/credentials" && method === "DELETE") {
    s.config = null;
    s.connection = { state: "unconfigured", since: at(0), connectedAt: null, lastEventAt: null, error: null, reconnectAttempts: 0, botName: null };
    return reply(s, 200, human);
  }
  if (path === "/api/im/feishu/options" && method === "PATCH") {
    s.options = { ...s.options, ...body };
    return reply(s);
  }
  if (path === "/api/im/feishu/binding" && method === "GET") {
    // 取快照的时刻 = 服务端处理请求的时刻；晚回只是网络慢，内容仍是发出那一刻的。
    const snapshot = clone(server.binding);
    server.bindingInFlight++;
    try {
      if (server.bindingDelay) await sleep(server.bindingDelay);
    } finally {
      server.bindingInFlight--;
    }
    return reply(snapshot);
  }
  if (path === "/api/im/feishu/binding/code") {
    const codeId = `code-${++server.issued}`;
    const expiresAt = at(10);
    server.binding = { state: "code", codeId, expiresAt };
    return reply({ codeId, code: `K7Q2-9XM${server.issued}`, expiresAt }, 200, human);
  }
  if (path === "/api/im/feishu/binding/confirm") {
    const b = server.binding;
    if (b.state !== "pending" || b.codeId !== body.codeId) return reply({ error: "这串码不在待确认状态" }, 409, human);
    server.binding = { state: "bound", appId: s.config?.appId ?? "", openIdTail: b.openIdTail, boundAt: at(0), stale: false, projectId: null };
    return reply(server.binding, 200, human);
  }
  if (path === "/api/im/feishu/binding/reject") {
    server.binding = { state: "none" };
    return reply(server.binding);
  }
  if (path === "/api/im/feishu/binding" && method === "PATCH") {
    if (server.binding.state === "bound") server.binding = { ...server.binding, projectId: (body.projectId as string | null) ?? null };
    return reply(server.binding);
  }
  if (path === "/api/im/feishu/binding" && method === "DELETE") {
    server.binding = { state: "none" };
    return reply(server.binding);
  }
  if (path === "/api/im/feishu/groups") return reply(server.groups);
  if (path === "/api/im/feishu/groups/code") {
    const codeId = `gcode-${++server.issued + 100}`;
    const expiresAt = at(10);
    server.groups.claims.push({ codeId, projectId: String(body.projectId), chatId: null, name: null, claimedAt: null, expiresAt });
    return reply({ codeId, code: `G-${codeId}`, expiresAt }, 200, human);
  }
  if (path === "/api/im/feishu/groups/confirm" || path === "/api/im/feishu/groups/reject") {
    const claim = server.groups.claims.find((item) => item.codeId === body.codeId);
    if (!claim) return reply({ error: "没有这条认领" }, 404, human);
    server.groups.claims = server.groups.claims.filter((item) => item !== claim);
    if (path.endsWith("/confirm") && claim.chatId) {
      server.groups.groups.push({ chatId: claim.chatId, name: claim.name, projectId: claim.projectId, boundAt: at(0), pushCards: false, receiving: false, boundBy: "fjh", canEdit: true });
    }
    return reply(server.groups, 200, human);
  }
  const group = path.match(/^\/api\/im\/feishu\/groups\/([^/]+)$/);
  if (group) {
    const chatId = decodeURIComponent(group[1]);
    if (method === "DELETE") server.groups.groups = server.groups.groups.filter((item) => item.chatId !== chatId);
    else server.groups.groups = server.groups.groups.map((item) => item.chatId === chatId ? { ...item, ...body, receiving: typeof body.pushCards === "boolean" ? body.pushCards : item.receiving } : item);
    return reply(server.groups);
  }
  if (path === "/api/im/feishu/test") return reply({ ok: true });
  return reply({ error: `fixture 没有这个端点：${method} ${path}` }, 404);
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(href, location.origin).pathname;
  if (!path.startsWith("/api/")) return realFetch(input, init);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
  server.calls.push({ method, path, token: headers.get("x-ash-human-action-token"), body });
  return handle(method, path, body);
};

function Fixture() {
  const [notice, setNotice] = useState("");
  const notify = useCallback((message: string) => setNotice(message), []);
  return (
    <main className="settings-main" style={{ width: "min(100%, 1000px)", height: "auto", margin: "auto", padding: 20 }}>
      <FeishuSettings notify={notify} onOpen={() => {}} />
      <output aria-label="操作反馈">{notice}</output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
