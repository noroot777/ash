import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("SKIP: macOS installation shutdown census");
  process.exit(0);
}

const stage = realpathSync(mkdtempSync(join(tmpdir(), "navi-shutdown-census-")));
mkdirSync(join(stage, "home"));
process.env.HOME = join(stage, "home");
process.env.NAVI_DATA_DIR = stage;
process.env.NAVI_DB = join(stage, "test.db");
process.env.NAVI_RUNS_DIR = join(stage, "runs");
const { ensureSchema } = await import("../src/db/index.js");
await ensureSchema();
const { removeTmpStage } = await import("./tmp-db.js");
const { registerShutdownCleanup, shutdownResources } = await import("../src/shutdown-resources.js");
const { terminalSessions } = await import("../src/terminal.js");
const { trialPreviewScript } = await import("../src/preview-trial.js");
const { api } = await import("../src/routes.js");

async function waitFor(check: () => boolean | Promise<boolean>, message: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(message);
}

async function impact() {
  const response = await api.request("/restart-impact?shutdown=1");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.survives, []);
  assert.deepEqual(body.resumes, []);
  assert.deepEqual(body.interrupted, []);
  assert.equal(body.shutdown.version, 1);
  return body.shutdown.resources as Awaited<ReturnType<typeof shutdownResources>>["resources"];
}

let daemonPid: number | undefined;
let cancelTrial = false;
let trial: ReturnType<typeof trialPreviewScript> | undefined;
try {
  assert.deepEqual(await impact(), []);
  const normal = await api.request("/restart-impact");
  assert.equal(normal.status, 200);
  assert.equal((await normal.json()).shutdown, undefined);

  const reservation = terminalSessions.reserveCommand("creating-project", "service");
  try {
    assert.ok((await impact()).some((resource) => resource.kind === "terminal-start" && resource.projectId === "creating-project"));
  } finally { reservation.release(); }
  assert.deepEqual(await impact(), []);
  console.log("✓ shutdown census preserves the existing task contract and includes pending terminal creations");

  const shell = await terminalSessions.createAsync("interactive-project", stage, { shell: "/bin/sh", shellArgs: [] });
  assert.ok((await impact()).some((resource) => resource.kind === "terminal" && resource.id === shell.id));
  assert.equal((await terminalSessions.destroy(shell.id, "interactive-project")).ok, true);
  assert.deepEqual(await impact(), []);
  console.log("✓ live interactive terminals are reported and disappear after verified destruction");

  const ready = join(stage, "daemon.json");
  const daemon = join(stage, "daemon.py");
  writeFileSync(daemon, `import json, os, socket, sys, time
ready = ${JSON.stringify(ready)}
first = os.fork()
if first:
    os.waitpid(first, 0)
    for attempt in range(150):
        if os.path.exists(ready):
            with open(ready) as source:
                port = json.load(source)["port"]
            print("Local: http://localhost:" + str(port), flush=True)
            sys.exit(0)
        time.sleep(0.05)
    sys.exit(1)
os.setsid()
if os.fork():
    os._exit(0)
null = os.open(os.devnull, os.O_RDWR)
for descriptor in range(3):
    os.dup2(null, descriptor)
server = socket.socket()
server.bind(("127.0.0.1", 0))
server.listen(1)
with open(ready, "w") as output:
    json.dump({"pid": os.getpid(), "port": server.getsockname()[1]}, output)
while True:
    time.sleep(1)
`);
  const command = await terminalSessions.createAsync("daemon-project", stage, {
    command: { id: "service", name: "守护化开发服务", script: `python3 '${daemon}'` },
  });
  await waitFor(() => existsSync(ready), "daemon did not listen");
  const running = JSON.parse(readFileSync(ready, "utf8"));
  daemonPid = running.pid;
  await waitFor(() => {
    const session = terminalSessions.get(command.id, "daemon-project");
    return session?.exitCode === 0 && session.groupAlive === false && session.ports.includes(running.port);
  }, "the launch shell must exit while the daemon survives");
  assert.equal(Number(execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(daemonPid)], { encoding: "utf8" }).trim()), 1);
  const resource = (await impact()).find((item) => item.id === command.id);
  assert.equal(resource?.kind, "terminal");
  assert.equal(resource?.label, "守护化开发服务");
  assert.deepEqual(resource?.ports, [running.port]);
  process.kill(daemonPid!, 0);
  assert.equal((await terminalSessions.destroy(command.id, "daemon-project")).ok, true);
  assert.deepEqual(await impact(), []);
  console.log("✓ a real double-forked daemon outside the server process tree remains in the shutdown census by its owned port");

  trial = trialPreviewScript({ cwd: stage, script: "sleep 30", mode: "frontend", timeoutMs: 8000, canceled: () => cancelTrial });
  await waitFor(async () => (await impact()).some((item) => item.kind === "preview-trial"), "trial missing from shutdown census");
  cancelTrial = true;
  await trial;
  assert.deepEqual(await impact(), []);
  console.log("✓ preview trials are reported throughout execution and removed after cleanup");

  const { db } = await import("../src/db/index.js");
  const { projects } = await import("../src/db/schema.js");
  const { setInstanceMode } = await import("../src/auth/mode.js");
  const { CLI_SPEC_BY_KEY } = await import("../src/executors/catalog/index.js");
  const { invokeChat } = await import("../src/chat/execution.js");
  await setInstanceMode("single", stage);
  await db.insert(projects).values({ id: "chat-project", name: "chat", repoPath: stage, createdAt: new Date().toISOString() });
  const original = CLI_SPEC_BY_KEY.claude.factory;
  let finishChat = () => {};
  const chatGate = new Promise<void>((resolve) => { finishChat = resolve; });
  let killed = false;
  CLI_SPEC_BY_KEY.claude.factory = () => ({
    type: "claude", label: "fixture", resumeCommand: () => "",
    run: () => ({
      kill: () => { killed = true; finishChat(); },
      events: (async function* () {
        await chatGate;
        yield { kind: "text" as const, text: "fixture" };
        yield { kind: "done" as const, exitStatus: 0 };
      })(),
    }),
  });
  let chat: ReturnType<typeof invokeChat> | undefined;
  try {
    chat = invokeChat({ id: "chat-member", name: "fixture", agentType: "claude", executorId: null, model: null, reasoningEffort: null },
      null, "fixture", new AbortController().signal, "chat-project", { purpose: "assistant" });
    await waitFor(async () => (await impact()).some((item) => item.kind === "chat" && item.id === "chat-member"), "chat missing from census");
    finishChat();
    await chat;
    assert.equal(killed, true);
    assert.deepEqual(await impact(), []);
  } finally {
    finishChat();
    await chat;
    CLI_SPEC_BY_KEY.claude.factory = original;
  }
  console.log("✓ live chat execution is reported by the real invocation path and removed after completion");

  const resourceFile = fileURLToPath(new URL("../src/shutdown-resources.ts", import.meta.url));
  const worker = join(stage, "cleanup-worker.mts");
  const proof = join(stage, "cleanup-proof");
  writeFileSync(worker, `import { writeFileSync } from "node:fs";
import { registerShutdownCleanup, shutdownResources } from ${JSON.stringify(resourceFile)};
const release = registerShutdownCleanup(() => [{ kind: "chat", id: "released", label: "released" }], () => { throw new Error("released cleanup ran"); });
release();
registerShutdownCleanup(() => [{ kind: "chat", id: "active", label: "active" }], () => writeFileSync(${JSON.stringify(proof)}, "cleaned"));
console.log(JSON.stringify(await shutdownResources()));
`);
  const child = spawnSync(process.execPath, [...process.execArgv, worker], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), { version: 1, resources: [{ kind: "chat", id: "active", label: "active" }] });
  assert.equal(readFileSync(proof, "utf8"), "cleaned");
  const releaseFailure = registerShutdownCleanup(() => { throw new Error("census unavailable"); }, () => {});
  try { await assert.rejects(shutdownResources(), /census unavailable/); }
  finally { releaseFailure(); }
  assert.deepEqual(await impact(), []);
  console.log("✓ resource reporting and actual exit cleanup share registrations; release removes both and reporting errors propagate");
} finally {
  cancelTrial = true;
  await trial;
  terminalSessions.shutdown();
  if (daemonPid) { try { process.kill(daemonPid, "SIGKILL"); } catch {} }
  await removeTmpStage(stage);
}
process.exit(0);
