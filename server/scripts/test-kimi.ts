import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { reasoningEffortsFor } from "@ash/shared/cli-presets";
import { eventQueue } from "../src/executors/event-queue.js";
import { parseKimiModels } from "../src/executors/kimi-models.js";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";
import { augmentedEnv } from "../src/executors/bin-resolve.js";

const directory = mkdtempSync(join(tmpdir(), "ash-kimi-unit-"));
process.env.ASH_DB = join(directory, "test.db");
requireTmpDb("test-kimi");
const { CLI_SPEC_BY_KEY } = await import("../src/executors/catalog/index.js");
const { GenericCliExecutor } = await import("../src/executors/generic.js");
const { resumeCommandFor } = await import("../src/executors/resume.js");
const kimiSpec = CLI_SPEC_BY_KEY.kimi;

async function parse(lines: unknown[], exitStatus = 0, stderr = "", stopRequested = false): Promise<AgentEvent[]> {
  const output = lines.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n");
  const child = spawn(process.execPath, ["-e", [
    `process.stdout.write(${JSON.stringify(`${output}\n`)});`,
    `process.stderr.write(${JSON.stringify(stderr)});`,
    `process.exitCode = ${exitStatus};`,
  ].join("\n")], { stdio: ["ignore", "pipe", "pipe"] });
  const events: AgentEvent[] = [];
  for await (const event of kimiSpec.exec.parser!({
    child, bin: "kimi", label: "kimi@test", lifecycle: { stopRequested }, events: eventQueue(),
  })) events.push(event);
  assert.equal(events.filter((event) => event.kind === "done").length, 1);
  assert.deepEqual(events.at(-1), { kind: "done", exitStatus });
  return events;
}

try {
  if (process.platform !== "win32") {
    const nativeBin = join(process.env.KIMI_INSTALL_DIR || join(homedir(), ".kimi-code"), "bin");
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "";
      assert.ok(augmentedEnv().PATH?.split(delimiter).includes(nativeBin));
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  }
  const version = { role: "meta", type: "system.version", version: "2.3.1" };
  const session = { role: "meta", type: "session.resume_hint", session_id: "kimi-real-session" };
  const events = await parse([
    version,
    { role: "assistant", content: "hello", tool_calls: [{ function: { name: "Bash", arguments: '{"command":"pwd"}' } }] },
    { role: "tool", tool_call_id: "tool-1", content: "not an assistant answer" },
    { role: "assistant", content: "finished" },
    session, session,
  ]);
  assert.deepEqual(events.filter((event) => event.kind === "text"), [
    { kind: "text", text: "hello\n\n" }, { kind: "text", text: "finished\n\n" },
  ]);
  assert.deepEqual(events.find((event) => event.kind === "tool"), {
    kind: "tool", name: "Bash", detail: '{"command":"pwd"}',
  });
  assert.deepEqual(events.filter((event) => event.kind === "session"), [{ kind: "session", cliSessionId: "kimi-real-session" }]);
  assert.equal(events.some((event) => event.kind === "error"), false);
  assert.equal((await parse([{ role: "assistant", tool_calls: [{ function: { name: "Read", arguments: { path: "hello.txt" } } }] }]))
    .some((event) => event.kind === "error"), false);

  for (const lines of [[], [version], [version, session], ["null", "[]", "42", "true"], ["not json"], [{ role: "assistant", tool_calls: [null, {}] }]]) {
    assert.equal((await parse(lines)).some((event) => event.kind === "error"), true);
  }
  const structuredFailure = await parse([version, { type: "error", code: "session.occupied", message: "session busy" }], 4);
  assert.deepEqual(structuredFailure.filter((event) => event.kind === "error"), [{ kind: "error", message: "kimi@test：session busy" }]);
  const authFailure = await parse([version], 1, "provider.auth_error: 403 subscription required");
  assert.match(JSON.stringify(authFailure), /403 subscription required/);
  assert.equal((await parse([version], 143, "killed", true)).some((event) => event.kind === "error"), false);
  const missing = spawn("ash-kimi-definitely-not-installed", [], { stdio: ["ignore", "pipe", "pipe"] });
  const missingEvents: AgentEvent[] = [];
  for await (const event of kimiSpec.exec.parser!({ child: missing, bin: "kimi", label: "kimi", lifecycle: { stopRequested: false }, events: eventQueue() })) {
    missingEvents.push(event);
  }
  assert.equal(missingEvents.at(-1)?.kind, "done");
  assert.equal(missingEvents.some((event) => event.kind === "error"), true);

  const parsed = parseKimiModels(JSON.stringify({
    providers: { "managed:kimi-code": { type: "kimi", apiKey: "never-return-this" }, thirdparty: { type: "openai" } },
    models: {
      "kimi-code/K3.1-Pro": { provider: "managed:kimi-code", model: "k3.1-pro", supportEfforts: ["low", "high", "max", "max", "invalid", null] },
      "kimi-code/highspeed": { provider: "managed:kimi-code", model: "fast" },
      custom: { provider: "thirdparty", model: "other", supportEfforts: ["high"] },
      invalid: null,
    },
  }), "");
  assert.deepEqual(parsed.models, ["kimi-code/K3.1-Pro", "kimi-code/highspeed", "custom"]);
  assert.deepEqual(parsed.modelEfforts, { "kimi-code/k3.1-pro": ["low", "high", "max"], "kimi-code/highspeed": [], custom: [] });
  assert.equal(JSON.stringify(parsed).includes("never-return-this"), false);
  assert.deepEqual(reasoningEffortsFor("kimi", "kimi-code/K3.1-Pro", parsed.modelEfforts), ["low", "high", "max"]);
  assert.deepEqual(reasoningEffortsFor("kimi", "custom", parsed.modelEfforts), []);
  for (const invalid of ["no json", "null", "[]", '{"models":[]}', '{"models":"bad"}']) {
    assert.deepEqual(parseKimiModels(invalid, "").models, []);
  }
  assert.deepEqual(kimiSpec.models?.args, ["provider", "list", "--json"]);
  assert.equal(kimiSpec.exec.baseArgs?.includes("--yolo"), false);
  assert.equal(kimiSpec.exec.baseArgs?.includes("--auto"), false);
  assert.deepEqual(kimiSpec.exec.session?.resumeArgs?.("saved-session"), ["--session", "saved-session"]);
  const executor = new GenericCliExecutor(kimiSpec, { reasoningEffort: "high" });
  const fields = executor.resumeFields!("/tmp/kimi", "saved-session");
  assert.equal(fields.resumeEnv, "KIMI_MODEL_THINKING_EFFORT=high ");
  assert.match(fields.resumeCommand, /KIMI_MODEL_THINKING_EFFORT=high kimi --session saved-session/);
  assert.equal(resumeCommandFor("kimi", "/tmp/kimi", "saved-session", fields.resumeEnv), fields.resumeCommand);
  assert.equal(new GenericCliExecutor(kimiSpec).resumeFields("/tmp/kimi", "saved-session").resumeEnv, null);
  assert.match(new GenericCliExecutor(kimiSpec, { reasoningEffort: "high;bad" }).resumeCommand("/tmp/kimi", "saved-session"), /='high;bad'/);
  console.log("kimi executor tests passed");
} finally {
  await releaseTmpDb();
  rmSync(directory, { recursive: true, force: true });
}
