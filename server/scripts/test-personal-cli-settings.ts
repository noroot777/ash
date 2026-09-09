import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-personal-cli-settings-"));
process.env.ASH_DB = join(stage, "test.db");
requireTmpDb("test-personal-cli-settings");
const { mountPersonalCliRoutes } = await import("../src/auth/personal-routes.js");
const { USER_CLI_ROOT, userCliDir, writePersonalSkill } = await import("../src/auth/user-cli.js");
const { setActor } = await import("../src/auth/context.js");
const userId = `test-personal-cli-${randomUUID()}`;
const userRoot = join(USER_CLI_ROOT, userId);
const api = new Hono();
api.use("*", async (c, next) => {
  setActor(c, { kind: "user", userId, role: "member", name: "Test" });
  await next();
});
mountPersonalCliRoutes(api);
const update = (agent: string, name: string, body: string) => api.request(`/me/cli-env/${agent}/skills/${name}`, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }),
});

try {
  for (const agent of ["claude", "codex"] as const) {
    const dir = userCliDir(userId, agent);
    assert.equal((await update(agent, "missing", "# New skill")).status, 404);
    assert.equal(existsSync(dir), false, "a save request must not initialize a missing skill environment");
    const skillDir = join(dir, "skills", "existing");
    mkdirSync(skillDir, { recursive: true });
    const file = join(skillDir, "SKILL.md");
    writeFileSync(file, "# Existing skill\nOriginal content that is longer than the replacement.\n");
    if (agent === "claude") writeFileSync(join(dir, ".claude.json"), JSON.stringify({ mcpServers: { ash: { command: "node", args: [] } } }));
    else writeFileSync(join(dir, "config.toml"), '[mcp_servers.ash]\ncommand = "node"\nargs = []\n');

    for (const body of ["# 已修改\n", "# Updated\n" + "更多内容。\n".repeat(20)]) {
      assert.equal((await update(agent, "existing", body)).status, 200);
      assert.equal(readFileSync(file, "utf8"), body, "updates must preserve UTF-8 and remove the previous tail");
    }
    const saved = readFileSync(file, "utf8");
    assert.equal((await update(agent, "existing", " ")).status, 400);
    assert.equal(readFileSync(file, "utf8"), saved);
    assert.equal((await update(agent, "missing", "# New skill")).status, 404);
    assert.equal(existsSync(join(dir, "skills", "missing")), false);
    mkdirSync(join(dir, "skills", "empty"));
    assert.equal((await update(agent, "empty", "# New skill")).status, 404);
    assert.equal(existsSync(join(dir, "skills", "empty", "SKILL.md")), false);

    const removed = await api.request(`/me/cli-env/${agent}/skills/existing`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal((await update(agent, "existing", saved)).status, 404, "a stale editor must not recreate a deleted skill");
    assert.equal(existsSync(skillDir), false);
    writePersonalSkill(userId, agent, "imported", "# Imported skill\n");
    assert.equal((await update(agent, "imported", "# Edited imported skill\n")).status, 200);
  }
  console.log("personal CLI settings: existing skill updates and removal pass; skill creation through save is unavailable");
} finally {
  await releaseTmpDb();
  rmSync(userRoot, { recursive: true, force: true });
  rmSync(stage, { recursive: true, force: true });
}
