// 预览进程的两条生命线：harness 自己的 dev 脚本不能在拉起 vite 后因 TDZ 崩掉；
// 外层组长即使先死，preview.ts 也必须把同组的长驻子进程收干净。
// Run: npm -w server run test:preview-process
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "harness-preview-process-"));
process.env.HARNESS_RUNS_DIR = join(root, "runs");

const repo = fileURLToPath(new URL("../..", import.meta.url));
const { startPreview } = await import("../src/preview.js");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(host = "127.0.0.1"): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function reachable(url: string): Promise<boolean> {
  return await fetch(url).then(() => true).catch(() => false);
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 已经收干净 */ }
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { /* 已经收干净 */ }
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  assert.fail(message);
}

try {
  // 真跑 scripts/dev.mjs：旧实现先 spawn vite，再在 watchChildren 里访问尚未初始化的
  // tracked，外层立刻 ReferenceError。现在它必须持续存活并在借来的 IPv4 地址上可访问。
  const devPort = await freePort();
  const dev = spawn(process.execPath, [join(repo, "scripts/dev.mjs")], {
    cwd: repo,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(devPort),
      HARNESS_PREVIEW: "1",
      HARNESS_PREVIEW_MODE: "frontend",
      BROWSER: "none",
    },
  });
  let devOutput = "";
  dev.stdout?.on("data", (chunk) => { devOutput += chunk.toString(); });
  dev.stderr?.on("data", (chunk) => { devOutput += chunk.toString(); });
  try {
    await waitFor(
      () => reachable(`http://127.0.0.1:${devPort}/`),
      `harness 前端预览没有起来：\n${devOutput}`,
    );
    assert.equal(dev.exitCode, null, `dev 管理进程不该先退出：\n${devOutput}`);
    assert.doesNotMatch(devOutput, /Cannot access 'tracked' before initialization/);
    assert.match(devOutput, new RegExp(`http://127\\.0\\.0\\.1:${devPort}/`));
  } finally {
    killGroup(dev.pid);
    await sleep(300);
  }

  // strictPort 必须由 CLI 固定，而不是只靠可能随 worktree 一起消失的 vite.config.ts。
  // 占住借出的 IPv4 端口后，预览应退出，不能悄悄漂到下一个端口继续活着。
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  const address = occupied.address();
  assert.ok(address && typeof address === "object");
  const strictPort = address.port;
  const strict = spawn(process.execPath, [join(repo, "scripts/dev.mjs")], {
    cwd: repo,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(strictPort),
      HARNESS_PREVIEW: "1",
      HARNESS_PREVIEW_MODE: "frontend",
      BROWSER: "none",
    },
  });
  let strictOutput = "";
  strict.stdout?.on("data", (chunk) => { strictOutput += chunk.toString(); });
  strict.stderr?.on("data", (chunk) => { strictOutput += chunk.toString(); });
  try {
    await waitFor(
      () => strict.exitCode !== null || strict.signalCode !== null,
      `端口被占后 dev 仍在运行，说明 vite 漂到了别的端口：\n${strictOutput}`,
    );
    assert.match(strictOutput, /already in use|Port .* is in use/i);
  } finally {
    killGroup(strict.pid);
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }

  // 外层命令主动退出，HTTP 子进程继续留在原进程组。startPreview 必须返回失败，且在
  // 返回前向死去组长的 -pid 补发组信号；否则这个端口会一直被孤儿占住。
  if (process.platform !== "win32") {
    const orphanPort = await freePort();
    const childCode = [
      "const http=require('http')",
      `const s=http.createServer((q,r)=>r.end('orphan')).listen(${orphanPort},'127.0.0.1')`,
      "setTimeout(()=>s.close(),5000)",
    ].join(";");
    const parentCode = [
      "const {spawn}=require('child_process')",
      `const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'})`,
      "c.unref()",
      `console.log('ready on http://127.0.0.1:${orphanPort}/')`,
    ].join(";");
    const step = {
      id: "orphan-preview",
      kind: "preview",
      p: {
        cmd: `node -e ${JSON.stringify(parentCode)}`,
        mode: "command",
        ready: "http200",
        life: "gate",
      },
    };
    const result = await startPreview("orphan-task", step as never, repo);
    assert.equal(result.ok, false, "组长先退出时不能把孤儿误报成正常预览");
    await sleep(400);
    assert.equal(
      await reachable(`http://127.0.0.1:${orphanPort}/`),
      false,
      "组长死后仍要杀原进程组，不能留下监听端口的 Vite/Node 孤儿",
    );
  } else {
    console.log("skip POSIX orphan-group assertion on Windows (no reparented process-group kill)");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("preview process tests passed");
