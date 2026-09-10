import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ambiguousMessage, detectPreviewCandidates, resolvePreviewCommand } from "../src/preview-command.js";
import { previewShell } from "../src/preview-shell.js";
import { userShellLaunch } from "../src/platform.js";

const root = mkdtempSync(join(tmpdir(), "ash-preview-static-"));
const html = (body = "static artifact") => `<!doctype html><html><head></head><body>${body}</body></html>`;
const dir = (rel: string) => { const path = join(root, rel); mkdirSync(path, { recursive: true }); return path; };
const file = (rel: string, body: string) => {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
};
const detect = (rel: string) => detectPreviewCandidates(join(root, rel));
const directories = (rel: string) => detect(rel).map((c) => c.directory);

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function request(port: number, path = "/"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path, timeout: 700 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("HTTP timeout")));
    req.on("error", reject);
  });
}

async function launchAndRead(rel: string, page: string, expected: string | RegExp) {
  const candidates = detect(rel);
  assert.equal(candidates.length, 1);
  const command = candidates[0].command;
  const port = await freePort();
  const launch = userShellLaunch(command);
  const child = spawn(launch.file, launch.args, {
    cwd: join(root, rel), env: { ...process.env, PORT: String(port) },
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
    windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  try {
    let response: Awaited<ReturnType<typeof request>> | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && child.exitCode === null) {
      try { response = await request(port, page); break; } catch { /* 尚未监听。 */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(response?.status, 200, `启动失败：${command}\n${logs}`);
    if (typeof expected === "string") assert.equal(response.body, expected);
    else assert.match(response.body, expected);
    console.log(`✓ ${process.platform} 真实启动并 HTTP 200：${command}`);
  } finally {
    if (child.pid && child.exitCode === null) {
      if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      else process.kill(-child.pid, "SIGTERM");
    }
    await exited;
    await assert.rejects(request(port), "测试服务退出后端口应已关闭");
    console.log(`✓ 已关闭测试服务及端口 ${port}`);
  }
}

try {
  file("vite/package.json", JSON.stringify({ scripts: { dev: "vite" } }));
  file("vite/index.html", html('<script type="module" src="/src/main.ts"></script>'));
  file("vite/src/main.ts", "export {};");
  file("vite/dist/index.html", html("old build"));
  assert.equal(detect("vite").length, 1);
  assert.match(detect("vite")[0].command, /^npm run dev/);
  assert.equal(detect("vite")[0].requiresSelection, undefined);
  file("vite/package.json", JSON.stringify({ devDependencies: { vite: "*" } }));
  assert.deepEqual(directories("vite"), ["dist"]);
  assert.match(detect("vite")[0].label, /可能过期/);
  rmSync(join(root, "vite/dist"), { recursive: true });
  assert.deepEqual(detect("vite"), []);

  file("source-entry/index.html", html('<script type="module" src="/src/main.ts"></script>'));
  file("source-entry/src/main.ts", "export {};");
  assert.deepEqual(detect("source-entry"), []);
  file("vite-config/index.html", html());
  file("vite-config/vite.config.js", "export default {};");
  assert.deepEqual(detect("vite-config"), []);
  file("fragment/index.html", "<div>fragment</div>");
  assert.deepEqual(detect("fragment"), []);
  file("unbuilt/index.html", html('<script type="module">import React from "react"</script>'));
  assert.deepEqual(detect("unbuilt"), []);
  file("broken/index.html", html('<script src="missing.js"></script>'));
  assert.deepEqual(detect("broken"), []);
  file("template/index.html", html("{{ content }}"));
  assert.deepEqual(detect("template"), []);

  file("standalone/index.html", html());
  assert.deepEqual(directories("standalone"), ["."]);
  assert.throws(() => resolvePreviewCommand(join(root, "standalone"), null), /尚未启动/);
  assert.equal(resolvePreviewCommand(join(root, "standalone"), "custom serve").command, "custom serve");
  file("multi/first/home.html", html());
  file("multi/second/about.htm", html());
  assert.deepEqual(directories("multi"), ["first", "second"]);
  assert.throws(() => resolvePreviewCommand(join(root, "multi"), null), /2 个静态 HTML/);
  assert.match(ambiguousMessage(detect("multi")), /没有 index.html 时会显示文件列表/);
  file("multi/backend/manage.py", "");
  assert.deepEqual(directories("multi"), ["backend"]);

  file("built/package.json", JSON.stringify({ scripts: { build: "vite build" } }));
  file("built/dist/index.html", html("old build"));
  file("built/out/index.html", html("other build"));
  assert.deepEqual(directories("built"), ["dist", "out"]);
  assert.throws(() => resolvePreviewCommand(join(root, "built"), null), /已有构建可能过期/);
  file("nested/packages/site/dist/index.html", html());
  assert.deepEqual(detectPreviewCandidates(join(root, "nested"), undefined, 3).map((c) => c.directory), ["packages/site/dist"]);

  const runtime = dir("runtime");
  const page = html('<link rel="stylesheet" href="style.css"><script src="app.js"></script>中文 & static');
  file("runtime/静态 pages & demo/index.html", page);
  file("runtime/静态 pages & demo/style.css", "body { color: navy; }");
  file("runtime/静态 pages & demo/app.js", "console.log('ready');");
  const cmd = detectPreviewCandidates(runtime, previewShell("win32"))[0];
  assert.equal(cmd.command, 'cd /d "静态 pages & demo" && python -u -m http.server %PORT% --bind 0.0.0.0');
  assert.equal(cmd.sidekick(2), null);
  file("percent/100%/index.html", html());
  assert.deepEqual(detectPreviewCandidates(join(root, "percent"), previewShell("win32")), []);
  console.log("✓ 框架优先、源码排除、独立 HTML、旧构建提示、多候选选择与 shell 方言");
  await launchAndRead("runtime", "/", page);
  await launchAndRead("runtime", "/style.css", "body { color: navy; }");
  await launchAndRead("standalone", "/", html());
  file("no-index/overview.html", html("overview"));
  await launchAndRead("no-index", "/", /href="overview.html"/);
  await launchAndRead("no-index", "/overview.html", html("overview"));
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("preview-static 全部通过；临时目录已清理");
