// 预览进程的两条生命线：ash 自己的 dev 脚本不能在拉起 vite 后因 TDZ 崩掉；
// 外层组长即使先死，preview.ts 也必须把同组的长驻子进程收干净。
// Run: npm -w server run test:preview-process
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "ash-preview-process-"));
process.env.ASH_RUNS_DIR = join(root, "runs");

const repo = fileURLToPath(new URL("../..", import.meta.url));
const { startPreview } = await import("../src/preview.js");
const { PORT_ENV_ALIASES } = await import("../src/preview-command.js");

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
      ASH_PREVIEW: "1",
      ASH_PREVIEW_MODE: "frontend",
      BROWSER: "none",
    },
  });
  let devOutput = "";
  dev.stdout?.on("data", (chunk) => { devOutput += chunk.toString(); });
  dev.stderr?.on("data", (chunk) => { devOutput += chunk.toString(); });
  try {
    await waitFor(
      () => reachable(`http://127.0.0.1:${devPort}/`),
      `ash 前端预览没有起来：\n${devOutput}`,
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
      ASH_PREVIEW: "1",
      ASH_PREVIEW_MODE: "frontend",
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

  // 一条命令同时起前后端：这是多模块项目的常态，而它卡住的地方不是命令怎么写，是端口
  // —— 两边都是 ash 随机借的，前端要在**启动那一刻**就知道后端落在哪。所以 ash 一次借
  // 一串：`$PORT` 给要看的那个，`$PORT2…` 给配角。这一例真起两个进程，后端只听 $PORT2，
  // 前端先连上后端再开自己的 $PORT —— 少注入一个变量它就起不来。
  if (process.platform !== "win32") {
    const backCode = "require('http').createServer((q,r)=>r.end('back')).listen(process.env.PORT2)";
    const frontCode = [
      "const http=require('http')",
      "console.log('[test] sidekick='+process.env.PORT2)",
      // 后端还没起来就重试：不靠 sleep，免得把时序写进测试里。
      // 地址用字符串拼，**不能用模板字面量**：这串最终是被 `sh -lc \"…\"` 吃进去的，
      // 反引号在双引号里是命令替换，写成模板字面量当场被 shell 拆掉。
      "const go=()=>http.get('http://127.0.0.1:'+process.env.PORT2+'/',()=>{"
        + "http.createServer((q,r)=>r.end('front')).listen(process.env.PORT)"
        + "}).on('error',()=>setTimeout(go,100))",
      "go()",
    ].join(";");
    const step = {
      id: "pair-preview",
      kind: "preview",
      p: {
        cmd: `(node -e ${JSON.stringify(backCode)} &) ; node -e ${JSON.stringify(frontCode)}`,
        mode: "frontend",
        ready: "port",
        life: "gate",
      },
    };
    const result = await startPreview("pair-task", step as never, repo);
    try {
      assert.equal(result.ok, true, "前后端一起起时预览必须认成起来了（配角端口没注入就会卡到超时）");
      assert.ok(result.ok);
      const log = readFileSync(join(root, "runs", "pair-task", "preview.log"), "utf8");
      const sidekick = Number(/\[test\] sidekick=(\d+)/.exec(log)?.[1]);
      assert.ok(sidekick > 0, "配角没拿到 $PORT2");
      assert.notEqual(sidekick, result.record.port, "借出去的端口不能重样");
      // 日志头必须照实写出注入了哪些端口变量——配角落在哪个端口只有这一行说得清。
      // 逐条按 PORT_ENV_ALIASES 对，而不是把名单抄成正则：那张表就是「各语言各自认哪个
      // 变量名」的唯一出处，抄一份进测试只会在加一门语言时一起漏掉。
      const head = log.split("\n")[0];
      assert.ok(head.startsWith("$ "), "日志头第一行得是命令回显");
      for (const alias of PORT_ENV_ALIASES) {
        const expected = `${alias.name}=${alias.template.replaceAll("$PORT", String(result.record.port))}`;
        assert.ok(head.includes(expected), `日志头缺 ${expected}`);
      }
      assert.ok(head.includes(`PORT2=${sidekick}`), "日志头缺配角端口");
      assert.ok(head.includes(`URL2=http://localhost:${sidekick}`), "日志头缺配角地址");
      assert.equal(await fetch(`http://127.0.0.1:${result.record.port}/`).then((r) => r.text()), "front");
      assert.equal(await fetch(`http://127.0.0.1:${sidekick}/`).then((r) => r.text()), "back");
    } finally {
      if (result.ok) killGroup(result.record.pid);
    }
  }

  // 一行日志都不印的服务照样得算「起来了」。从日志里认地址那条路只对肯打印、且是行缓冲
  // 打印的命令成立（Node 的 dev server 一贯如此，`python3 -m http.server` 在非 tty 下就
  // 不是，Go/Rust 写的服务可以什么都不印）。端口是 ash 借出去的，连得上就是它。
  {
    const quietCode = "require('http').createServer((q,r)=>r.end('quiet')).listen(process.env.PORT)";
    const step = {
      id: "quiet-preview",
      kind: "preview",
      p: { cmd: `node -e ${JSON.stringify(quietCode)}`, mode: "frontend", ready: "port", life: "gate" },
    };
    const result = await startPreview("quiet-task", step as never, repo);
    try {
      assert.equal(result.ok, true, "不吭声的服务被判成没起来（只认日志里的地址就会这样）");
      assert.ok(result.ok && result.record.port, "认下来的必须是 ash 借出去的那个端口");
      assert.equal(result.ok && result.record.url, `http://localhost:${result.ok && result.record.port}/`);
      assert.equal(await reachable(`http://127.0.0.1:${result.ok && result.record.port}/`), true);
    } finally {
      if (result.ok) killGroup(result.record.pid);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("preview process tests passed");
