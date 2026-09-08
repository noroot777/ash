// 预览进程的两条生命线：ash 自己的 dev 脚本不能在拉起 vite 后因 TDZ 崩掉；
// 外层组长即使先死，preview.ts 也必须把同组的长驻子进程收干净。
// Run: npm -w server run test:preview-process
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "ash-preview-process-"));
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_DEPS_DIR = join(root, "deps");
// 这条测试会调 sweepPreviews()，而清扫会读库（「这个任务还在不在」）。指一份空库过去：
// 拿正式库跑既会打出一串 SQL 报错，也没道理让一条预览测试碰用户的数据。
process.env.ASH_DB = join(root, "ash.db");

const repo = fileURLToPath(new URL("../..", import.meta.url));
const { startPreview, stopPreview, stopPreviewOnRerun, sweepPreviews, readPreview, isPreviewStarting }
  = await import("../src/preview.js");
// 清扫要读库（「这个任务还在不在」）。建好空表就够了 —— 没有任何任务行，正是「这些
// taskId 都不在库里」的自然表达。
await (await import("../src/db/index.js")).ensureSchema();
const { PORT_ENV_ALIASES, PORT_SLOT } = await import("../src/preview-command.js");
const { db } = await import("../src/db/index.js");
const { tasks } = await import("../src/db/schema.js");

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

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
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
        const expected = `${alias.name}=${alias.template.replaceAll(PORT_SLOT, String(result.record.port))}`;
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
  // 着色过的地址不能把控制码带进 preview.json。dev server 基本都给地址着色，而
  // 「端口连得上」这条就绪判据对此毫无察觉：URL 里多了个 `\x1b[39m`，界面照样说
  // 「预览已打开」，浏览器打开的却是 `/%1B[39m` 这条 404 路径 —— 服务是好的、根页面是
  // 好的，用户看到的表现仍然是「预览打不开」。
  {
    const ESC = String.fromCharCode(27);
    // 只有根路径返回 200，别的一律 404：地址脏了就当场看得出来。
    const colorCode = [
      "const http=require('http')",
      "const s=http.createServer((q,r)=>{if(q.url==='/'){r.end('root')}else{r.statusCode=404;r.end('nope')}})",
      "s.listen(process.env.PORT,()=>console.log("
        + `'  \\u001b[32m➜  Local:\\u001b[39m  \\u001b[36mhttp://localhost:'+process.env.PORT+'/\\u001b[39m'))`,
    ].join(";");
    const step = {
      id: "ansi-preview",
      kind: "preview",
      p: { cmd: `node -e ${JSON.stringify(colorCode)}`, mode: "frontend", ready: "http200", life: "gate" },
    };
    const result = await startPreview("ansi-task", step as never, repo);
    try {
      assert.equal(result.ok, true, "着色的启动日志不该让预览判失败");
      assert.ok(result.ok);
      const raw = readFileSync(join(root, "runs", "ansi-task", "preview.log"), "utf8");
      assert.ok(raw.includes(ESC), "这一例的前提就是日志里真有 ANSI 控制码");
      assert.ok(!result.record.url?.includes(ESC), `地址里混进了控制码：${JSON.stringify(result.record.url)}`);
      assert.equal(new URL(result.record.url ?? "http://x/y").pathname, "/", "地址得指向根路径");
      assert.equal(await fetch(result.record.url ?? "").then((r) => r.status), 200, "存下来的地址得真能打开");
    } finally {
      if (result.ok) killGroup(result.record.pid);
    }
  }

  // 启动那一段（最长两分钟）必须是**看得见**的状态。preview.json 要等就绪才写，那是对的
  // ——写早了就是一句「预览已起」的谎；但界面据此把整段启动期报成「没在跑」，日志弹窗因此
  // 不开轮询，用户守着一份不再更新的快照看「处理中」，而这恰恰是 Maven 在下依赖、前端在
  // 冷编译、最该看日志的那一段。
  {
    const slowCode = [
      "const http=require('http')",
      "console.log('[test] phase-1')",
      "setTimeout(()=>console.log('[test] phase-2'),700)",
      "setTimeout(()=>http.createServer((q,r)=>r.end('slow')).listen(process.env.PORT),2000)",
    ].join(";");
    const step = {
      id: "slow-preview",
      kind: "preview",
      p: { cmd: `node -e ${JSON.stringify(slowCode)}`, mode: "frontend", ready: "port", life: "gate" },
    };
    const pending = startPreview("slow-task", step as never, repo);
    const logPath = join(root, "runs", "slow-task", "preview.log");
    const logged = (needle: string) => {
      try { return readFileSync(logPath, "utf8").includes(needle); } catch { return false; }
    };
    await waitFor(() => logged("phase-1"), "启动期的日志没落盘");
    assert.equal(readPreview("slow-task"), null, "这一例的前提：这时候还没就绪，preview.json 不存在");
    assert.equal(isPreviewStarting("slow-task"), true, "启动期必须报「正在启动」，否则日志弹窗不会续读");
    await waitFor(() => logged("phase-2"), "启动期日志还在长，界面却看不到");
    assert.equal(isPreviewStarting("slow-task"), true, "还没就绪就不算跑完");
    const result = await pending;
    try {
      assert.equal(result.ok, true, "慢启动的服务最后要算起来了");
      assert.equal(isPreviewStarting("slow-task"), false, "有了结论就不能再挂着「正在启动」");
    } finally {
      if (result.ok) killGroup(result.record.pid);
    }
  }
  // 「把主仓那份 node_modules 软链进任务工作区」——这是缺依赖时 ash 给的唯一一条不写用户
  // 项目的路。它必须**真的能把预览起起来**，否则那句建议就只是句好听的话。这里照它说的
  // 做一遍：主仓里有一份装好的依赖（.bin 里一个假的 dev server），任务工作区软链过去，
  // 然后走完整启动链。ash 会把自己的 node_modules/.bin 从 PATH 上摘掉
  // （withoutForeignNodeBins），所以这一条同时钉住「摘的时候别把项目自己那份也摘了」。
  if (process.platform !== "win32") {
    const repo = join(root, "borrow-repo");
    const front = join(repo, "front");
    const bin = join(front, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(front, "package.json"), JSON.stringify({ name: "front", scripts: { dev: "fakevite" } }));
    const serve = "require('http').createServer((q,r)=>r.end('borrowed')).listen(process.env.PORT)";
    writeFileSync(join(bin, "fakevite"), `#!/bin/sh\nexec "${process.execPath}" -e ${JSON.stringify(serve)}\n`, { mode: 0o755 });

    const wt = join(repo, ".worktrees", "borrow-wt");
    mkdirSync(join(wt, "front"), { recursive: true });
    // ash 建出来的任务 worktree 就长这样：住在 `<主仓>/.worktrees/<taskId>`，`.git` 是个
    // 文件、写着主仓在哪。位置是判据的一半 —— 只有 ash 自己建的这种目录才允许被挂
    // node_modules，用户自己的检出（哪怕也是 worktree）一律不碰，见 ashWorktree。
    writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "borrow-wt")}\n`);
    writeFileSync(join(wt, "front", "package.json"), JSON.stringify({ name: "front", scripts: { dev: "fakevite" } }));
    symlinkSync(join(front, "node_modules"), join(wt, "front", "node_modules"));

    const step = {
      id: "borrow-preview",
      kind: "preview",
      p: { cmd: "cd front && npm run dev", mode: "frontend", ready: "http200", life: "gate" },
    };
    const result = await startPreview("borrow-task", step as never, wt);
    try {
      const log = readFileSync(join(root, "runs", "borrow-task", "preview.log"), "utf8");
      assert.equal(result.ok, true, `借来的依赖没能把预览起起来：\n${log}`);
      assert.ok(result.ok);
      assert.equal(await fetch(result.record.url ?? "").then((r) => r.text()), "borrowed");
    } finally {
      if (result.ok) killGroup(result.record.pid);
    }
  }

  // 整件事的落点：**任务工作区里什么依赖都没有**，点一下预览就该能起来，而且用户的项目
  // 一个字节都不被写。ash 在起进程之前把依赖装进自己的 data/deps（这里指到临时目录），
  // 只从项目里读 package.json 和锁文件，再挂一条软链。这条用 `file:` 依赖，全程不联网 ——
  // 要证的是链路，不是 npm 会不会下包。收掉预览后那条软链也必须消失（用户敲 git status
  // 不该看见 ash 留下的东西）。
  if (process.platform !== "win32") {
    const dep = join(root, "fakedep");
    mkdirSync(dep, { recursive: true });
    writeFileSync(join(dep, "package.json"), JSON.stringify({
      name: "fakedep", version: "1.0.0", bin: { fakevite: "cli.js" },
    }));
    writeFileSync(
      join(dep, "cli.js"),
      "#!/usr/bin/env node\nrequire('http').createServer((q,r)=>r.end('installed by ash')).listen(process.env.PORT)\n",
    );

    const repo2 = join(root, "fresh-repo");
    mkdirSync(join(repo2, ".git"), { recursive: true });
    const wt2 = join(repo2, ".worktrees", "fresh-wt");
    mkdirSync(join(wt2, "front"), { recursive: true });
    writeFileSync(join(wt2, ".git"), `gitdir: ${join(repo2, ".git", "worktrees", "fresh-wt")}\n`);
    writeFileSync(join(wt2, "front", "package.json"), JSON.stringify({
      name: "front", version: "1.0.0", private: true,
      scripts: { dev: "fakevite" }, dependencies: { fakedep: `file:${dep}` },
    }));

    const step = {
      id: "fresh-preview",
      kind: "preview",
      p: { cmd: "cd front && npm run dev", mode: "frontend", ready: "http200", life: "gate" },
    };
    const result = await startPreview("fresh-task", step as never, wt2);
    try {
      const log = readFileSync(join(root, "runs", "fresh-task", "preview.log"), "utf8");
      assert.equal(result.ok, true, `干净检出没能靠 ash 备的依赖起起来：\n${log}`);
      assert.ok(result.ok);
      assert.equal(await fetch(result.record.url ?? "").then((r) => r.text()), "installed by ash");
      // 依赖装在 ash 自己的地盘，项目里只多了一条软链。
      assert.ok(readdirSync(join(root, "deps")).length > 0, "依赖没装进 ASH_DEPS_DIR");
      assert.ok(lstatSync(join(wt2, "front", "node_modules")).isSymbolicLink(), "项目里被塞了实体目录");
      assert.deepEqual(result.record.links, [join(wt2, "front", "node_modules")]);
    } finally {
      if (result.ok) killGroup(result.record.pid);
    }
    await stopPreview("fresh-task", null);
    assert.equal(existsSync(join(wt2, "front", "node_modules")), false, "收掉预览后 ash 挂的软链还在");

    // 撤软链这件事**每一条出口都要做到**，不是只有「正常停止」那一条。下面两条原来是漏的，
    // 而它们漏掉的后果比一般失败更重：链会永久留在用户的工作区里，而且没有任何线索能补撤。

    // ① 安全拒绝（日志里出现旧协议的调度器）。原来这一支是裸 return，链留下、preview.json
    //    又不会写 —— 事后 stopPreview 连该撤什么都不知道。
    const unsafeWt = join(repo2, ".worktrees", "unsafe-wt");
    mkdirSync(join(unsafeWt, "front"), { recursive: true });
    writeFileSync(join(unsafeWt, ".git"), `gitdir: ${join(repo2, ".git", "worktrees", "unsafe-wt")}\n`);
    writeFileSync(join(unsafeWt, "front", "package.json"), JSON.stringify({
      name: "front", version: "1.0.0", private: true,
      scripts: { dev: "node -e \"console.log('[ash] scheduler started');setInterval(()=>{},1000)\"" },
      dependencies: { fakedep: `file:${dep}` },
    }));
    const unsafe = await startPreview("unsafe-task", {
      id: "unsafe", kind: "preview",
      p: { cmd: "cd front && npm run dev", mode: "frontend", ready: "port", life: "gate" },
    } as never, unsafeWt);
    assert.equal(unsafe.ok, false, "旧协议的调度器必须被拒");
    assert.equal(
      existsSync(join(unsafeWt, "front", "node_modules")),
      false,
      "安全拒绝这条出口也必须把 ash 挂的软链撤掉",
    );

    // ② 起来之后服务自己退出，由清扫收尾。清扫会**删掉 preview.json**——`record.links` 是
    //    最后一份线索，那一刻不撤就永远撤不掉了。
    const exitWt = join(repo2, ".worktrees", "exit-wt");
    mkdirSync(join(exitWt, "front"), { recursive: true });
    writeFileSync(join(exitWt, ".git"), `gitdir: ${join(repo2, ".git", "worktrees", "exit-wt")}\n`);
    writeFileSync(join(exitWt, "front", "package.json"), JSON.stringify({
      name: "front", version: "1.0.0", private: true,
      scripts: {
        dev: "node -e \"const s=require('http').createServer((q,r)=>r.end('bye'))"
          + ".listen(process.env.PORT);setTimeout(()=>process.exit(0),1500)\"",
      },
      dependencies: { fakedep: `file:${dep}` },
    }));
    const selfExit = await startPreview("exit-task", {
      id: "exit", kind: "preview",
      p: { cmd: "cd front && npm run dev", mode: "frontend", ready: "port", life: "gate" },
    } as never, exitWt);
    assert.ok(selfExit.ok, "这一步要先真的起来，才谈得上「起来之后自己退出」");
    assert.deepEqual(selfExit.record.links, [join(exitWt, "front", "node_modules")]);
    await waitFor(() => readPreview("exit-task") !== null && !isAlive(selfExit.record.pid), "服务没有自行退出");
    // ③ 清扫顺手清备用依赖，**但正被活着的预览用着的那份不能碰**：自由预览是 `life: "task"`，
    //    一个任务等人验收等上三十天完全合法，而缓存只在挂链那一刻 touch 过一次。删掉之后
    //    工作区那条软链还在、只是断了，dev server 按需加载下一个模块时才炸，记录上它还跑着。
    const liveWt = join(repo2, ".worktrees", "live-wt");
    mkdirSync(join(liveWt, "front"), { recursive: true });
    writeFileSync(join(liveWt, ".git"), `gitdir: ${join(repo2, ".git", "worktrees", "live-wt")}\n`);
    writeFileSync(join(liveWt, "front", "package.json"), JSON.stringify({
      name: "front", version: "1.0.0", private: true,
      scripts: { dev: "fakevite" }, dependencies: { fakedep: `file:${dep}` },
    }));
    // 这条得让 taskGone 说「任务还在」，否则清扫会先按「任务已被删除」把预览收掉，
    // 缓存自然也就不再被谁持有 —— 那样测的就不是我们想测的东西了。
    const stamp = new Date().toISOString();
    await db.insert(tasks).values({ id: "live-task", projectId: "p", title: "live", createdAt: stamp, updatedAt: stamp });
    const live = await startPreview("live-task", {
      id: "live", kind: "preview",
      p: { cmd: "cd front && npm run dev", mode: "frontend", ready: "port", life: "task" },
    } as never, liveWt);
    assert.ok(live.ok, "这一步要先真的起来，才谈得上「跑着的时候别把它的依赖删了」");
    try {
      const liveLink = live.record.links?.[0] ?? "";
      const liveCache = dirname(realpathSync(liveLink));
      const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60_000);
      utimesSync(liveCache, longAgo, longAgo); // 预览跑到第三十一天
      await sweepPreviews();
      assert.ok(existsSync(liveCache), "清扫把活着的预览正用着的依赖删了");
      assert.ok(existsSync(join(liveLink, "fakedep")), "工作区那条软链被清成了断链");
      assert.equal(await fetch(live.record.url ?? "").then((r) => r.text()), "installed by ash");
    } finally {
      killGroup(live.record.pid);
      await stopPreview("live-task", null);
    }

    // ④ **启动那一段也必须能被摁死。** 依赖最多装 6 分钟、等就绪再 2 分钟，这八分钟里
    //    用户点「关闭预览」、或者任务续跑走 stopPreviewOnRerun，都得抓得住它。记录只在
    //    就绪时才写的话，这两条路径读不到东西、什么都不杀，原来那趟稍后照常上线：用户
    //    「关掉了」的预览自己回来了，续跑那次更糟 —— 他会对着上一版代码验新改动。
    const lateCmd = "node -e \"setTimeout(()=>{require('http').createServer((q,r)=>r.end('late'))"
      + ".listen(process.env.PORT)},1500);setInterval(()=>{},1000)\"";
    const cancelStep = {
      id: "cancel", kind: "preview",
      p: { cmd: lateCmd, mode: "frontend", ready: "port", life: "task" },
    };
    for (const [taskId, how, cancel] of [
      ["cancel-stop", "用户关闭预览", () => stopPreview("cancel-stop", "测试：启动中关闭")],
      ["cancel-rerun", "任务重新开跑", () => stopPreviewOnRerun("cancel-rerun")],
    ] as const) {
      const wtDir = join(repo2, ".worktrees", taskId);
      mkdirSync(wtDir, { recursive: true });
      const inflight = startPreview(taskId, cancelStep as never, wtDir); // 故意不 await
      await waitFor(() => existsSync(join(root, "runs", taskId, "preview.json")), `${how}：启动记录没落盘`);
      const startingRecord = JSON.parse(readFileSync(join(root, "runs", taskId, "preview.json"), "utf8"));
      assert.equal(startingRecord.state, "starting", `${how}：落盘的应当是「正在启动」`);
      await waitFor(() => JSON.parse(readFileSync(join(root, "runs", taskId, "preview.json"), "utf8")).pid > 0,
        `${how}：pid 没被记下来（记不下就杀不掉）`);
      const pid = JSON.parse(readFileSync(join(root, "runs", taskId, "preview.json"), "utf8")).pid as number;
      assert.equal(readPreview(taskId), null, `${how}：还没起来就不该被当成「在跑」`);
      assert.equal(isPreviewStarting(taskId), true, `${how}：启动中的日志应当接着续读`);
      await cancel();
      const result = await inflight;
      assert.equal(result.ok, false, `${how}：被取消的那趟不能再报成功`);
      assert.equal(readPreview(taskId), null, `${how}：取消之后又冒出一条「运行中」的记录（死灰复燃）`);
      assert.equal(existsSync(join(root, "runs", taskId, "preview.json")), false, `${how}：记录没清掉`);
      await waitFor(() => !isAlive(pid), `${how}：启动中的那个进程没被杀掉，它稍后还会上线`);
    }

    // ④a **「点开、立刻点取消」也得停得住。** 界面上那颗取消从 POST 发出那一刻就能点，
    //     而服务端可杀的记录要更晚才写：起预览先收旧的、再异步借五个端口，之前还有任务
    //     和项目查询、工作区解析、预览命令探测。取消落在这一段里时，老实现从盘上什么都
    //     读不到，回一句「预览已经不在跑了」，然后原来那趟照常写记录、照常起服务、照常
    //     上线 —— 用户按过取消，最后还是等来一个他不要的预览，而且没人再去关它。
    const earlyWt = join(repo2, ".worktrees", "early-wt");
    mkdirSync(earlyWt, { recursive: true });
    const earlyStart = startPreview("early-task", cancelStep as never, earlyWt); // 不等记录出现
    const earlyStopped = await stopPreview("early-task", "测试：刚点开就取消");
    const earlyResult = await earlyStart;
    assert.equal(earlyStopped, true, "记录还没落盘时取消，接口却说什么都没停到");
    assert.equal(earlyResult.ok, false, "取消之后那一趟还是起起来了");
    assert.equal(readPreview("early-task"), null, "取消之后又冒出一条「运行中」的记录");
    assert.equal(
      existsSync(join(root, "runs", "early-task", "preview.json")), false,
      "取消之后仍然写出了启动记录（写了就没人再去关它）",
    );

    // ④a2 **任务重新开跑那一路，同样得摁在落盘之前。** 上面那条走的是「用户点关闭」，
    //      这条走的是 stopPreviewOnRerun：任务从 done 再次开跑（自动推进、连点重跑）时，
    //      上一版的预览完全可能还在冷启动。这一路曾经拿「盘上有没有记录」当门禁，读不到
    //      就直接返回 —— 于是几十秒后那趟照常上线，用户对着上一版代码验新改动，而这正是
    //      这个函数唯一要防的事。
    const rerunWt = join(repo2, ".worktrees", "early-rerun-wt");
    mkdirSync(rerunWt, { recursive: true });
    const rerunStart = startPreview("early-rerun-task", cancelStep as never, rerunWt); // 不等记录出现
    await stopPreviewOnRerun("early-rerun-task");
    const rerunResult = await rerunStart;
    assert.equal(rerunResult.ok, false, "任务已经在改下一版代码了，上一版的预览还是起起来了");
    assert.equal(readPreview("early-rerun-task"), null, "重新开跑之后又冒出一条「运行中」的记录");
    assert.equal(
      existsSync(join(root, "runs", "early-rerun-task", "preview.json")), false,
      "重新开跑之后仍然写出了启动记录（写了就没人再去关它）",
    );

    // ④b **装依赖那一段也得摁得死。** 它能跑满六分钟，而那六分钟里 pid 不落盘的话，
    //     「关闭预览」只是删了条记录：包管理器还在后台跑，项目自己的 preinstall/postinstall
    //     （用户仓库里什么都可能有）也还在跑，任务续跑那一路更糟——新一轮已经在改同一个
    //     工作区了。软链和 node_modules 也可能在停止之后才被写出来。
    const installWt = join(repo2, ".worktrees", "install-wt");
    mkdirSync(join(installWt, "front"), { recursive: true });
    writeFileSync(join(installWt, ".git"), `gitdir: ${join(repo2, ".git", "worktrees", "install-wt")}\n`);
    writeFileSync(join(installWt, "front", "package.json"), JSON.stringify({
      name: "front", version: "1.0.0", private: true, scripts: { dev: "fakevite" },
    }));
    const slowNpm = join(root, "slow-npm");
    mkdirSync(slowNpm, { recursive: true });
    const grandchildPidFile = join(root, "install-grandchild.pid");
    // 装依赖的现场：外层是包管理器，底下还挂着生命周期脚本。只杀外层那个 pid 是不够的。
    writeFileSync(join(slowNpm, "npm"),
      `#!/bin/sh\nsleep 300 &\necho $! > ${grandchildPidFile}\nwait\n`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${slowNpm}:${savedPath ?? ""}`;
    try {
      const installing = startPreview("install-task", {
        id: "install", kind: "preview",
        p: { cmd: "cd front && npm run dev", mode: "frontend", ready: "port", life: "task" },
      } as never, installWt);
      const recordFile = join(root, "runs", "install-task", "preview.json");
      await waitFor(() => existsSync(recordFile)
        && (JSON.parse(readFileSync(recordFile, "utf8")).installPid ?? 0) > 0, "装依赖的 pid 没落进记录");
      const installPid = JSON.parse(readFileSync(recordFile, "utf8")).installPid as number;
      await waitFor(() => existsSync(grandchildPidFile), "生命周期脚本还没起来");
      const grandchild = Number(readFileSync(grandchildPidFile, "utf8").trim());
      assert.equal(await stopPreview("install-task", "测试：装依赖途中关闭"), true, "装依赖途中必须停得掉");
      await waitFor(() => !isAlive(installPid), "「已停止」之后包管理器还在跑");
      await waitFor(() => !isAlive(grandchild), "包管理器自己派生的那一层活了下来（只杀了最外面那个 pid）");
      const installResult = await installing;
      assert.equal(installResult.ok, false, "被取消的那趟不能再报成功");
      assert.equal(existsSync(recordFile), false, "取消之后记录还在");
      assert.equal(existsSync(join(installWt, "front", "node_modules")), false, "停掉之后还是把软链挂上了");
    } finally {
      process.env.PATH = savedPath;
    }

    // ④b2 **组长先退出、孩子赖着不走**，同样得收干净。补刀原来的条件是「两秒后组长还
    //      活着」，可最该补刀的现场恰恰是组长已经退了：外层 shell / 包管理器老实响应
    //      SIGTERM 退出，它派生的那个**忽略 SIGTERM** 的东西还留在原进程组里（用户仓库
    //      的 preinstall/postinstall 是任意代码，node-gyp、自己管子进程的脚本都算）。
    //      拿「组长还在吗」当「这一组还在吗」，那个进程就永远留下了 —— 而接口已经回过
    //      一句「已停止」。
    const stubbornWt = join(repo2, ".worktrees", "stubborn-wt");
    mkdirSync(join(stubbornWt, "front"), { recursive: true });
    writeFileSync(join(stubbornWt, ".git"), `gitdir: ${join(repo2, ".git", "worktrees", "stubborn-wt")}\n`);
    writeFileSync(join(stubbornWt, "front", "package.json"), JSON.stringify({
      name: "front", version: "1.0.0", private: true, scripts: { dev: "fakevite" },
    }));
    const stubbornNpm = join(root, "stubborn-npm");
    mkdirSync(stubbornNpm, { recursive: true });
    const stubbornPidFile = join(root, "stubborn-child.pid");
    // 生命周期脚本：显式忽略 SIGTERM。外层 shell 收到 SIGTERM 就走人（组长先死）。
    writeFileSync(join(stubbornNpm, "npm"),
      `#!/bin/sh\n"${process.execPath}" -e "process.on('SIGTERM',()=>{});`
      + `require('fs').writeFileSync(process.env.PIDFILE,String(process.pid));setInterval(()=>{},1000)" &\n`
      + "wait\n", { mode: 0o755 });
    const savedPath2 = process.env.PATH;
    const savedPidFile = process.env.PIDFILE;
    process.env.PATH = `${stubbornNpm}:${savedPath2 ?? ""}`;
    process.env.PIDFILE = stubbornPidFile;
    try {
      const stubbornStart = startPreview("stubborn-task", {
        id: "stubborn", kind: "preview",
        p: { cmd: "cd front && npm run dev", mode: "frontend", ready: "port", life: "task" },
      } as never, stubbornWt);
      await waitFor(() => existsSync(stubbornPidFile), "赖着不走的那个子进程还没起来");
      const stubborn = Number(readFileSync(stubbornPidFile, "utf8").trim());
      await stopPreview("stubborn-task", "测试：装依赖途中关闭（顽固子进程）");
      // 补刀在两秒后，这里给够时间。
      await waitFor(() => !isAlive(stubborn), "组长先退出之后，忽略 SIGTERM 的那个子进程活了下来", 15_000);
      assert.equal((await stubbornStart).ok, false, "被取消的那趟不能再报成功");
    } finally {
      process.env.PATH = savedPath2;
      if (savedPidFile === undefined) delete process.env.PIDFILE;
      else process.env.PIDFILE = savedPidFile;
    }

    // ④c **两代启动重叠时，别把新的那一代当成孤儿杀掉。** 自动推进那一站刚开始冷启动、
    //     用户又在线路图上点了一下「重启预览」，就是两代重叠。旧那代退出时如果按 taskId
    //     抹掉「谁在驱动」的标记，抹掉的是新那代的；清扫随后看见一条没人驱动的 starting
    //     记录，按「重启遗留的孤儿」把正在冷启动的新预览杀了。
    const overlapWt = join(repo2, ".worktrees", "overlap-wt");
    mkdirSync(overlapWt, { recursive: true });
    const overlapRecord = join(root, "runs", "overlap-task", "preview.json");
    // 记录会有一瞬间不在：第二代开跑时先 stopPreview 收掉第一代，再写自己那条。
    const genOf = (): string | null => {
      try { return JSON.parse(readFileSync(overlapRecord, "utf8")).gen as string; } catch { return null; }
    };
    const first = startPreview("overlap-task", cancelStep as never, overlapWt);
    await waitFor(() => existsSync(overlapRecord) && JSON.parse(readFileSync(overlapRecord, "utf8")).pid > 0,
      "第一代还没起来");
    const firstGen = genOf();
    const second = startPreview("overlap-task", cancelStep as never, overlapWt); // 第二代顶掉第一代
    await waitFor(() => { const gen = genOf(); return gen !== null && gen !== firstGen; }, "第二代没有把记录顶掉");
    const firstResult = await first;
    assert.equal(firstResult.ok, false, "被顶掉的那一代应当自己收摊");
    await sweepPreviews(); // 关键一刀：此刻第二代还在冷启动
    assert.equal(existsSync(overlapRecord), true, "清扫把正在冷启动的新一代当成孤儿删了");
    const secondResult = await second;
    assert.ok(secondResult.ok, `新一代应当照常起来，实际：${secondResult.ok ? "" : secondResult.reason}`);
    assert.equal(readPreview("overlap-task")?.state, "ready", "新一代没能写成「已就绪」");
    killGroup(secondResult.record.pid);
    await stopPreview("overlap-task", null);

    // ⑤ server 在启动那一段里重启：内存里那张「谁在驱动」的表没了，盘上却还留着一条
    //    「正在启动」。它的子进程是 detached 的，可能还活着，软链也还挂在工作区里 ——
    //    没人会再来收尾，只能由清扫认领。
    const orphanWt = join(repo2, ".worktrees", "orphan-wt");
    mkdirSync(orphanWt, { recursive: true });
    const orphanLink = join(orphanWt, "node_modules");
    symlinkSync(join(root, "deps"), orphanLink);
    const sleeper = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    sleeper.unref();
    mkdirSync(join(root, "runs", "orphan-task"), { recursive: true });
    writeFileSync(join(root, "runs", "orphan-task", "preview.json"), JSON.stringify({
      taskId: "orphan-task", cmd: "npm run dev", pid: sleeper.pid, url: null, port: null,
      life: "task", startedAt: new Date().toISOString(), log: "x", links: [orphanLink],
      state: "starting", gen: "from-a-previous-life",
    }));
    await sweepPreviews();
    assert.equal(existsSync(join(root, "runs", "orphan-task", "preview.json")), false, "上一条命留下的「正在启动」没被清扫认领");
    assert.equal(existsSync(orphanLink), false, "孤儿启动挂的软链留在了工作区里");
    await waitFor(() => !isAlive(sleeper.pid ?? 0), "孤儿启动的进程没被杀掉");

    await sweepPreviews();
    assert.equal(readPreview("exit-task"), null, "清扫应当把死掉的记录收走");
    assert.equal(
      existsSync(join(exitWt, "front", "node_modules")),
      false,
      "清扫删记录的同时必须撤掉 ash 挂的软链（记录一删就没有第二次机会了）",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("preview process tests passed");
