import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_APP_SETTINGS } from "@ash/shared";
import type { AppSettings, HandoffTarget } from "@ash/shared";
import type { HandoffSourceAddress } from "@ash/shared/handoff";
import { SettingsPage } from "../../src/settings/SettingsPage.tsx";
import type { SettingsSection } from "../../src/settings/SettingsPage.tsx";
import { HandoffReturnView } from "../../src/task-detail/HandoffReturnView.tsx";
import "../../src/styles/global.css";

const STORAGE_KEY = "ash:fixture:handoff-source-address";
const FINGERPRINT = "a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0011223344556677";
const ORIGINAL_URL = "http://192.168.1.51:4317";

type FixtureWindow = Window & typeof globalThis & {
  __handoffFixture?: {
    calls: Array<{ method: string; url: string; body: unknown }>;
    unhandled: string[];
    storedUrl: () => string;
  };
};

const fixtureWindow = window as FixtureWindow;
const calls: Array<{ method: string; url: string; body: unknown }> = [];
const unhandled: string[] = [];
const storedUrl = () => localStorage.getItem(STORAGE_KEY) ?? ORIGINAL_URL;
fixtureWindow.__handoffFixture = { calls, unhandled, storedUrl };

const targets = (): HandoffTarget[] => [{
  name: "书房 Windows",
  url: storedUrl(),
  peerFp: FINGERPRINT,
  hasKey: false,
}];

const settings = (): AppSettings => ({
  ...DEFAULT_APP_SETTINGS,
  instanceMode: "single",
  handoffTargets: targets(),
});

const nativeFetch = window.fetch.bind(window);
const response = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, window.location.href).pathname;
  if (!path.startsWith("/api/")) {
    return nativeFetch(input as RequestInfo, init);
  }

  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
  calls.push({ method, url: path, body });
  await new Promise((resolve) => setTimeout(resolve, 80));

  if (path === "/api/settings" && method === "GET") return response(200, settings());
  if (path === "/api/workflows" && method === "GET") return response(200, []);
  if (path === "/api/projects" && method === "GET") return response(200, []);
  if (path === "/api/skills/overview" && method === "GET") {
    return response(200, { cwd: "", scannedAt: "2026-09-08T00:00:00.000Z", rows: [] });
  }
  if (path === "/api/handoff/identity" && method === "GET") {
    return response(200, { fingerprint: "f".repeat(64), short: "FFFF-FFFF-FFFF-FFFF-FFFF", host: "fixture-mac" });
  }
  if (path === "/api/handoff/peers" && method === "GET") return response(200, { peers: [] });
  if (path === "/api/handoff/return-grants" && method === "GET") return response(200, { grants: [] });
  if (path === "/api/handoff/targets" && method === "GET") return response(200, { targets: targets() });
  if (path === "/api/handoff/targets/sources" && method === "GET") {
    const sources: HandoffSourceAddress[] = [{
      fingerprint: FINGERPRINT,
      name: "书房 Windows",
      url: storedUrl(),
    }];
    return response(200, { sources });
  }

  if (path === "/api/handoff/targets/source-address" && method === "PUT") {
    const payload = body as { fingerprint?: string; url?: string } | null;
    if (payload?.fingerprint !== FINGERPRINT) return response(404, { error: "来源机记录不存在" });
    if (payload.url === "http://wrong-machine:4317") {
      return response(409, { error: "地址背后的机器指纹不一致，未保存" });
    }
    localStorage.setItem(STORAGE_KEY, payload?.url ?? ORIGINAL_URL);
    return response(200, { targets: targets() });
  }

  unhandled.push(`${method} ${path}`);
  return response(500, { error: `fixture 未处理 API：${method} ${path}` });
}) as typeof window.fetch;

function SettingsFixture() {
  const [section, setSection] = useState<SettingsSection>("defaults");
  const [notices, setNotices] = useState<string[]>([]);
  return (
    <>
      <SettingsPage
        section={section}
        project={null}
        tasks={[]}
        groups={[]}
        onSection={setSection}
        onBack={() => {}}
        onProjectUpdated={() => {}}
        onProjectDeleted={() => {}}
        onTaskUpdated={() => {}}
        onGroupsChanged={() => {}}
        notify={(message) => setNotices((current) => [...current, message])}
      />
      <output data-testid="fixture-notices" hidden>{JSON.stringify(notices)}</output>
    </>
  );
}

function TaskFixture() {
  return (
    <main style={{ width: 680, margin: "40px auto" }}>
      <header className="settings-heading">
        <div><h1>把任务移回来源机</h1><p>模拟任务详情里的移回预检失败状态。</p></div>
      </header>
      <section className="settings-card" style={{ padding: 18 }}>
        <HandoffReturnView
          phase="unreachable"
          fallbackNotice={null}
          peerName="书房 Windows"
          peerUrl={ORIGINAL_URL}
          peer={null}
          taskScopedReturn={true}
          running={false}
          notes={[]}
          errorMessage={`连不上对端 ash（${ORIGINAL_URL}）：fetch failed`}
          identityMissing={false}
          autoResume={false}
          autoResumeLocked={false}
          accepted={false}
          replay={false}
          busy={false}
          onAutoResumeChange={() => {}}
        />
      </section>
    </main>
  );
}

const showingSettings = new URLSearchParams(window.location.search).get("settings") === "defaults";
createRoot(document.getElementById("root")!).render(
  <StrictMode>{showingSettings ? <SettingsFixture /> : <TaskFixture />}</StrictMode>,
);
