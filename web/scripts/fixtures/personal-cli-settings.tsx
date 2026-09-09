import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PersonalCliEnv } from "@ash/shared";
import "../../src/styles/global.css";
import { PersonalCliSettings } from "../../src/settings/PersonalCliSettings.tsx";

const memories: Record<string, string> = { claude: "", codex: "" };
const skills: Record<string, Record<string, string>> = { claude: { existing: "# Existing skill\n" }, codex: {} };
const env = (agentType: string): PersonalCliEnv => ({
  agentType, supported: true, configDir: `/workspace/personal/${agentType}`,
  envVar: agentType === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME",
  memoryName: agentType === "claude" ? "CLAUDE.md" : "AGENTS.md",
  memoryFile: `/workspace/personal/${agentType}/${agentType === "claude" ? "CLAUDE.md" : "AGENTS.md"}`,
  hasMemory: !!memories[agentType], plugins: [],
  skills: Object.keys(skills[agentType]).map(name => ({ name, description: "已安装的技能" })),
  ashMcp: { configured: true, serverName: "ash", problem: null },
});
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(href, location.origin).pathname;
  if (path === "/api/me/cli-env") return reply({ mode: "multi", sharedHostCli: false, envs: [env("claude"), env("codex")] });
  const memory = path.match(/^\/api\/me\/cli-env\/(claude|codex)\/memory$/);
  if (memory) {
    if (init?.method === "PUT") memories[memory[1]] = JSON.parse(String(init.body)).body;
    return reply(init?.method === "PUT" ? { ok: true } : { body: memories[memory[1]] });
  }
  const skill = path.match(/^\/api\/me\/cli-env\/(claude|codex)\/skills\/([^/]+)$/);
  if (skill) {
    const [, agent, name] = skill;
    if (!(name in skills[agent])) return reply({ error: "技能不存在" }, 404);
    if (init?.method === "PUT") skills[agent][name] = JSON.parse(String(init.body)).body;
    if (init?.method === "DELETE") delete skills[agent][name];
    return reply(init?.method ? env(agent) : { name, body: skills[agent][name] });
  }
  if (path.startsWith("/api/")) return reply({});
  return realFetch(input, init);
};

function Fixture() {
  const [notice, setNotice] = useState("");
  const notify = useCallback((message: string) => setNotice(message), []);
  return <main className="settings-main" style={{ width: "min(100%, 1000px)", height: "auto", margin: "auto", padding: 20 }}>
    <PersonalCliSettings notify={notify} />
    <output aria-label="操作反馈">{notice}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
