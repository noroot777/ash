// Single-instance startup guard regression test.
// Requires a built server because it validates the production entrypoint:
//   npm -w server run build && npm -w server run test:singleton
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { singletonLockFileForDb } from "../src/singleton.js";

const serverRoot = resolve(new URL("..", import.meta.url).pathname);

type StartedServer = {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
  stop: () => Promise<void>;
};

async function main() {
  const root = mkdtempSync(join(tmpdir(), "harness-singleton-"));
  console.log(`[singleton-test] temp root: ${root}`);

  try {
    await testSameDbRejected(root);
    await testDifferentDbsAllowed(root);
    await testStaleLockOverwritten(root);
    console.log("[singleton-test] all checks passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testSameDbRejected(root: string) {
  const db = join(root, "same.db");
  const firstPort = await freePort();
  const secondPort = await freePort();
  const first = await startServer(firstPort, db);
  const second = spawnServer(secondPort, db);
  try {
    const exit = await waitForExit(second.child);
    const output = second.output();
    assert.equal(exit.code, 1, "second same-DB server should exit 1");
    assert.match(output, /Refusing to start/, "same-DB rejection should be explicit");
    assert.match(output, new RegExp(`PID: ${first.child.pid}`), "message should include conflicting PID");
    assert.match(output, new RegExp(`kill ${first.child.pid}`), "message should include a copyable kill command");
    console.log(`[singleton-test] same DB rejected with exit ${exit.code}`);
    console.log(indentBlock(output.trim()));
  } finally {
    await second.stop();
    await first.stop();
  }
}

async function testDifferentDbsAllowed(root: string) {
  const first = await startServer(await freePort(), join(root, "one.db"));
  const second = await startServer(await freePort(), join(root, "two.db"));
  try {
    assert.ok(first.child.pid);
    assert.ok(second.child.pid);
    console.log("[singleton-test] different DB instances ran concurrently");
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
}

async function testStaleLockOverwritten(root: string) {
  const db = join(root, "stale.db");
  const lockFile = singletonLockFileForDb(db);
  const stalePid = findDeadPid();
  writeFileSync(
    lockFile,
    JSON.stringify(
      {
        version: 1,
        pid: stalePid,
        processStartedAt: "2000-01-01T00:00:00.000Z",
        processStartedAtMs: 946684800000,
        acquiredAt: "2000-01-01T00:00:00.000Z",
        port: 49999,
        dbFile: db,
        cwd: serverRoot,
        argv: ["node", "dist/index.js"],
        token: "stale-test-lock",
      },
      null,
      2,
    ) + "\n",
  );

  const server = spawnServer(await freePort(), db);
  try {
    await waitForOutput(server, /stale singleton lock/);
    await waitForOutput(server, /server on/);
    assert.match(server.output(), /stale singleton lock/, "stale lock should be reported");
    console.log(`[singleton-test] stale lock for dead PID ${stalePid} was overwritten`);
    console.log(indentBlock(server.output().split("\n").find((line) => line.includes("stale singleton lock")) ?? ""));
  } finally {
    await server.stop();
  }
}

function spawnServer(port: number, db: string): StartedServer {
  const chunks: string[] = [];
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: serverRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HARNESS_DB: db,
      HARNESS_ALLOW_MULTI: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => chunks.push(String(d)));
  child.stderr.on("data", (d) => chunks.push(String(d)));
  return {
    child,
    output: () => chunks.join(""),
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await waitForExit(child);
    },
  };
}

async function startServer(port: number, db: string, ready = /server on/) {
  const server = spawnServer(port, db);
  await waitForOutput(server, ready);
  return server;
}

async function waitForOutput(server: StartedServer, pattern: RegExp) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    if (pattern.test(server.output())) return;
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(`server exited before ready; output:\n${server.output()}`);
    }
    await delay(50);
  }
  await server.stop();
  throw new Error(`timed out waiting for ${pattern}; output:\n${server.output()}`);
}

function waitForExit(child: ChildProcessWithoutNullStreams) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: child.exitCode, signal: child.signalCode });
    }, 10_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function freePort() {
  return new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.equal(typeof address, "object");
      const port = address!.port;
      server.close(() => resolvePromise(port));
    });
  });
}

function findDeadPid() {
  for (let pid = 999_999; pid > 900_000; pid--) {
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
  }
  throw new Error("could not find a dead PID for stale lock test");
}

function delay(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function indentBlock(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => `  ${line}`)
    .join("\n");
}

await main();
