// 预览进程的两条生命线：ash 自己的 dev 脚本不能在拉起 vite 后因 TDZ 崩掉；
// 外层组长即使先死，preview.ts 也必须把同组的长驻子进程收干净。
// Run: npm -w server run test:preview-process
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "ash-preview-process-"));
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_DEPS_DIR = join(root, "deps");
// 这条测试会调 sweepPreviews()，而清扫会读库（「这个任务还在不在」）。指一份空库过去：
// 拿正式库跑既会打出一串 SQL 报错，也没道理让一条预览测试碰用户的数据。
process.env.ASH_DB = join(root, "ash.db");

const repo = fileURLToPath(new URL("../..", import.meta.url));
const { startPreview, stopPreview, sweepPreviews, readPreview, isPreviewStarting } = await import("../src/preview.js");
// 清扫要读库（「这个任务还在不在」）。建好空表就够了 —— 没有任何任务行，正是「这些
// taskId 都不在库里」的自然表达。
await (await import("../src/db/index.js")).ensureSchema();
const { PORT_ENV_ALIASES, PORT_SLOT } = await import("../src/preview-command.js");

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

    const wt = join(root, "borrow-wt");
    mkdirSync(join(wt, "front"), { recursive: true });
    // git 的 worktree 就长这样：`.git` 是个文件，写着主仓在哪（preview-deps.ts 靠它找主仓）。
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
    const wt2 = join(root, "fresh-wt");
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
    const unsafeWt = join(root, "unsafe-wt");
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
    const exitWt = join(root, "exit-wt");
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
