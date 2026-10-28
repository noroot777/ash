// ash MCP 预检的**探测执行层**（server/src/ash-mcp-probe.ts）：进程的生死和输出的解码。
//
// 判据那一半（谁算有登记、问哪些目录、执行器上下文怎么来）在 `test-ash-mcp-reach.ts`；
// 这里一条真实 CLI 都不用，全靠假 CLI 把**结束路径**一条条摆出来 —— 它们是前后四轮审查
// 在 Windows 真机上逐个打出来的：
//
//   1. 超时：自己起的孙进程不准留下（第 2 位审查者 B3）
//   2. 包装先退出：`taskkill /T` 的父子树当场断掉（第 4 轮 B2）
//      被信号打断不是一份答案（第 4 轮 N1）；UTF-8 跨块不准解坏（第 4 轮 N2）
//   3. **正常退出也要收尾**：后代不持输出管道时，根 close 跟它没关系（第 5 轮 B1）
//   4. `ConfineRead` 三档语义照既有消费者解释：absent / unqueryable / since-enroll 的空
//      都**不构成**「已回收」（第 5 轮 B1）
//
// 跑：npm -w server run test:ash-mcp-probe
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const stage = mkdtempSync(join(tmpdir(), "ash-mcp-probe-"));
process.env.ASH_DB = join(stage, "t.db");
process.env.HARNESS_DB = process.env.ASH_DB;
const pause = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

try {
  const { probeCli, unitResidue } = await import("../src/ash-mcp-probe.js");
  const { resolveLaunch } = await import("../src/executors/bin-resolve.js");
  if (!resolveLaunch("node", [])) throw new Error("这台机器上连 node 都解析不到？");

  // ── 1. 超时之后不准把自己起的进程留在机器上 ──────────────────────────────
  // Windows 真机实测:15 秒超时到点、预检已放行,底下那个 node 查询进程还活着
  // (`hungPid=6024, childStillAlive=true`),因为 execFile 的 timeout 只向 cmd.exe 这层
  // 包装发信号。这里用一个**挂住的假 CLI**在本平台复现同一结构:壳进程 + 它起的孙进程,
  // 断言超时返回后孙进程已经不在。
  {
    const hangDir = join(stage, "hang-cli");
    mkdirSync(hangDir, { recursive: true });
    const pidFile = join(hangDir, "grandchild.pid");
    const hang = join(hangDir, "hang.mjs");
    writeFileSync(hang,
      'import { writeFileSync } from "node:fs";\n'
      + `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n`
      + 'setInterval(() => {}, 1000);\n');
    if (process.platform === "win32") {
      writeFileSync(join(hangDir, "codex.cmd"),
        `@echo off\r\nstart /b "" "${process.execPath}" "${hang}"\r\n`
        + ':wait\r\nping -n 3 127.0.0.1 >nul\r\ngoto wait\r\n');
    } else {
      const shim = join(hangDir, "codex");
      writeFileSync(shim, `#!/bin/sh\n"${process.execPath}" "${hang}" &\nwait\n`);
      chmodSync(shim, 0o755);
    }
    const pathWas = process.env.PATH;
    process.env.PATH = `${hangDir}${delimiter}${pathWas ?? ""}`;

    const started = Date.now();
    const res = await probeCli("codex", ["mcp", "list", "--json"], process.env, undefined, 1_200);
    assert.equal(res, null, "B3:超时必须回到「问不出来」(向放行开的结论不变)");
    assert.ok(Date.now() - started < 20_000, "B3:不能一直干等下去");

    const hungPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(hungPid) && hungPid > 1, "假 CLI 应该已经写下孙进程的 pid");
    let alive = true;
    try { process.kill(hungPid, 0); } catch { alive = false; }
    if (alive) { try { process.kill(hungPid, "SIGKILL"); } catch { /* 清场 */ } }
    assert.equal(alive, false, "B3:超时返回时,探测自己起的孙进程必须已经被回收");

    process.env.PATH = pathWas;
  }

  // ── 2. 包装先退出 / 信号 / 跨块解码 ─────────────────────────────────────
  {
    const dir = join(stage, "probe-cases");
    mkdirSync(dir, { recursive: true });
    const pathWas = process.env.PATH;
    process.env.PATH = `${dir}${delimiter}${pathWas ?? ""}`;
    /** 按平台写一个叫 codex 的壳；body 是壳自己的脚本内容。 */
    const shim = (posix: string, windows: string): void => {
      if (process.platform === "win32") writeFileSync(join(dir, "codex.cmd"), windows);
      else { const f = join(dir, "codex"); writeFileSync(f, posix); chmodSync(f, 0o755); }
    };
    const ask = (ms: number) => probeCli("codex", ["mcp", "list", "--json"], process.env, undefined, ms);

    // ① B2：**包装进程先退出**，它起的查询还在。真机上这正是两轮 taskkill 都打空的形状
    // （第 4 轮审查：wrapperStillAlive=false、childStillAlive=true）。判据必须是执行单元
    // 还有没有成员，而不是根进程的 close —— 后代持着管道时 close 根本不会来。
    //
    // **这条在 POSIX 上过了不等于 B2 修好了**：进程组不依赖组长活着，退回「只认 close」
    // 的旧实现在这里同样能过（实测反向验证不红）。它在这边的作用是守住「这个形状别再
    // 退化成收不回」；真正分得出高下的是 Windows（Job Object vs taskkill 打空），本机
    // 圈定弃权，跑不出来。判据本身由上面那条结构断言钉。
    const pidFile = join(dir, "hang.pid");
    const hang = join(dir, "hang.mjs");
    writeFileSync(hang,
      'import { writeFileSync } from "node:fs";\n'
      + `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n`
      + 'setInterval(() => {}, 1000);\n');
    shim(
      `#!/bin/sh\n"${process.execPath}" "${hang}" &\nexit 3\n`,
      `@echo off\r\nstart /b "" "${process.execPath}" "${hang}"\r\nexit /b 3\r\n`,
    );
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
    let res: unknown;
    try { res = await ask(1_200); } finally { console.warn = realWarn; }
    assert.equal(res, null, "B2：超时仍回到「问不出来」");
    const hungPid = Number(readFileSync(pidFile, "utf8").trim());
    let alive = true;
    try { process.kill(hungPid, 0); } catch { alive = false; }
    if (alive) { try { process.kill(hungPid, "SIGKILL"); } catch { /* 清场 */ } }
    assert.equal(alive, false, "B2：包装先退出了，它起的查询照样必须被回收");
    assert.ok(!warned.some((w) => w.includes("收不干净")),
      "B2：执行单元已经空了就该当场确认 —— 收干净了还喊收不干净，说明判据或宽限有问题");

    // ② N1：被信号打断的不是一份答案。壳先写出一份**看着像有效答案**的 stdout，再把
    // 自己杀掉；上一版 `code ?? 0` 会把它读成「成功退出 rc=0、列表为空」→ 据此硬拒。
    shim(
      `#!/bin/sh\necho '[]'\nkill -TERM $$\n`,
      `@echo off\r\necho []\r\ntaskkill /PID %^errorlevel% >nul 2>&1\r\nexit /b 1\r\n`,
    );
    if (process.platform === "win32") {
      console.log("⚠ 跳过 N1 一条：Windows 上没有自杀信号的等价写法，这条只在 POSIX 判");
    } else {
      assert.equal(await ask(8_000), null, "N1：被信号终止 → 问不出来，不准当成 rc=0 的空列表");
    }

    // ③ N2：UTF-8 字符跨在两个 data 块边界上。逐块 String(chunk) 会解出替换字符，
    // 中文路径和中文停用原因都会糊掉。
    const split = join(dir, "split.mjs");
    writeFileSync(split,
      'const buf = Buffer.from("[{\\"disabled_reason\\":\\"配置里没有这一项\\"}]", "utf8");\n'
      + 'process.stdout.write(buf.subarray(0, 25));\n'
      + 'setTimeout(() => { process.stdout.write(buf.subarray(25)); }, 80);\n');
    shim(
      `#!/bin/sh\nexec "${process.execPath}" "${split}"\n`,
      `@echo off\r\n"${process.execPath}" "${split}"\r\n`,
    );
    const got = await ask(8_000);
    assert.ok(got, "N2：这条该正常退出");
    assert.ok(!got!.stdout.includes("\uFFFD"),
      "N2：跨块的多字节字符不准解成替换字符（两个输出通道都按流设编码）");
    assert.match(got!.stdout, /配置里没有这一项/, "N2：拼回来的文本要和原文一致");

    process.env.PATH = pathWas;
  }


  // ── 3. 正常退出也要收尾：根 close 跟后代没关系 ──────────────────────────
  // 第 5 轮审查实测的形状：包装把查询用 detached + stdio=ignore 起出去（**不继承输出
  // 管道**，所以根 close 立刻就来），自己正常退出并给出完整答案。上一版只在超时分支收尾，
  // 于是 3.6 秒就返回了结论、查询还活着（NORMAL_TREE childAlive:true）。
  {
    const dir = join(stage, "normal-close");
    mkdirSync(dir, { recursive: true });
    const pathWas = process.env.PATH;
    process.env.PATH = `${dir}${delimiter}${pathWas ?? ""}`;
    const pidFile = join(dir, "orphan.pid");
    const hang = join(dir, "hang.mjs");
    writeFileSync(hang,
      'import { writeFileSync } from "node:fs";\n'
      + `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n`
      + 'setInterval(() => {}, 1000);\n');
    // 壳**等孙进程把 pid 落盘**再给答案：否则收尾可能在它写下 pid 之前就把它收掉了
    // （那说明收尾有效，但这条用例就无从核对了）。
    if (process.platform === "win32") {
      writeFileSync(join(dir, "codex.cmd"),
        `@echo off\r\nstart /b "" "${process.execPath}" "${hang}" >nul 2>nul\r\n`
        + `:wait\r\nif not exist "${pidFile}" (ping -n 2 127.0.0.1 >nul & goto wait)\r\n`
        + 'echo []\r\nexit /b 0\r\n');
    } else {
      const f = join(dir, "codex");
      writeFileSync(f,
        `#!/bin/sh\n"${process.execPath}" "${hang}" </dev/null >/dev/null 2>&1 &\n`
        + `while [ ! -f "${pidFile}" ]; do sleep 0.05; done\n`
        + "echo '[]'\nexit 0\n");
      chmodSync(f, 0o755);
    }
    // 收尾在后台跑，警告也在那之后才可能打出来，所以整段都把 console.warn 收下来。
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
    let res: Awaited<ReturnType<typeof probeCli>>;
    let gone = false;
    let orphan = 0;
    try {
      res = await probeCli("codex", ["mcp", "list", "--json"], process.env, undefined, 8_000);
      // 收尾刻意放在后台（不拖住派审请求，第 5 轮 N1），所以这里轮询等它做完。
      orphan = Number(readFileSync(pidFile, "utf8").trim());
      for (let i = 0; i < 80 && !gone; i++) {
        try { process.kill(orphan, 0); await pause(100); } catch { gone = true; }
      }
    } finally { console.warn = realWarn; }
    assert.ok(res, "正常退出要照常给出答案");
    assert.equal(res!.code, 0, "退出码是 0");
    assert.match(res!.stdout, /\[\]/, "答案本身不受收尾影响");
    assert.ok(Number.isInteger(orphan) && orphan > 1, "假 CLI 应该写下了那个孤儿的 pid");
    if (!gone) { try { process.kill(orphan, "SIGKILL"); } catch { /* 清场 */ } }
    assert.ok(gone, "正常退出路径也必须把自己起的后代收掉 —— 根 close 不代表后代结束");
    // 宽限要**真的等**。上一版 `race([closed, delay])` 在根早就 close 的情况下当场返回，
    // 两轮宽限变成两次零延迟空转：刚被 SIGKILL 的后代还没被 reap 就判成残留，于是收干净了
    // 却喊「收不干净」。这条断言钉的就是那个假警报。
    assert.ok(!warned.some((w) => w.includes("收不干净")),
      `正常退出收干净了，不准喊收不干净：${warned.join(" | ")}`);

    process.env.PATH = pathWas;
  }

  // ── 4. ConfineRead 三档照既有消费者解释，「不说话」不等于「空」 ─────────────
  // 判据抄的是 cleanup-result.ts 的 confinedResidue：absent 不说话、unqueryable 不说话、
  // 只有 whole-run 的空才构成证明。上一版把 absent 和 since-enroll 的空都读成「已回收」，
  // 于是 Windows 冷启动那次泄漏连警告都没打（第 5 轮 B1）。
  {
    const fake = (read: unknown) => ({
      id: "fake", enroll: () => true, preExecEnv: () => null,
      read: () => read, killAll: () => 1, dispose: () => {},
    }) as unknown as Parameters<typeof unitResidue>[1];

    const members = (ms: number[], coverage: string) =>
      fake({ kind: "members", members: ms.map((pid) => ({ pid, gen: null })), coverage });

    assert.equal(unitResidue(12345, fake({ kind: "absent", why: "圈没建起来" }), true), null,
      "absent = 这台设备弃权，**不是**「已经回收」；门闩也不能让它说话（圈都没有，门闩无从谈起）");
    assert.equal(unitResidue(12345, fake({ kind: "unqueryable", why: "这一刻问不到" }), true), null,
      "问不出来也不是空");
    assert.equal(unitResidue(12345, members([], "since-enroll"), false), null,
      "没门闩时 since-enroll 的空不构成证明 —— 空窗里出生又脱离的后代不在集合里");
    assert.equal(unitResidue(12345, members([], "whole-run"), false), "gone",
      "设备自己说覆盖整次运行时，空就是证明");
    // 第 6 轮审查第 3 点：`cut >= 0` 当时绕过了 coverage 判据。现在反过来 —— 判据是
    // **门闩有没有把窗口关掉**，而不是设备自报的那一档。门闩之下被 spawn 的是不生后代的
    // 壳，CLI 在圈建成之后才出生，所以这个集合对 CLI 这棵树是确定的，空构成证明。
    assert.equal(unitResidue(12345, members([], "since-enroll"), true), "gone",
      "门闩关掉了空窗：集合对 CLI 这棵树是确定的，空算证明");
    assert.equal(unitResidue(12345, members([process.pid], "since-enroll"), true), "remaining",
      "成员还活着就是还有残留");
  }

  // ── 5. 门闩：归属没建成之前，CLI 一条指令都不准执行 ────────────────────────
  // 这是第 6 轮审查 B1 的根因修复点，也是**本机唯一能真正鉴别**它的地方：门闩壳是跨平台的
  // node 代码，Windows 真机那条路（Job Object 建不成 → 收壳 → 不探测）在 macOS 上跑不出来
  // （圈定如实弃权），但「没开门就不准启动目标」这条不变量在哪都一样硬。
  //
  // 真机打中的形状是：垫片 `start /b` 起了查询就退出，守圈进程还在起（~180 ms），等它来
  // assign 时根已经没了 ⇒ 圈从头到尾没建成，那个查询谁都查不回去（readyMarkersSeen=[]）。
  // 门闩把顺序倒过来：先起一个**不生后代**的壳、确认圈建成、才放 CLI 出生。
  {
    const { prepareGate } = await import("../src/ash-mcp-gate.js");
    const dir = join(stage, "gate");
    mkdirSync(dir, { recursive: true });

    /** 一跑起来就落标记的假 CLI —— 「它有没有被执行过」靠这个文件核对。 */
    const mkCli = (ranMark: string): string => {
      const cli = join(dir, `cli-${ranMark}.mjs`);
      writeFileSync(cli,
        'import { writeFileSync } from "node:fs";\n'
        + `writeFileSync(${JSON.stringify(join(dir, ranMark))}, "1");\n`
        + 'process.stdout.write("[]");\n'
        + 'process.stderr.write("warn\\n");\n'
        + 'process.exit(7);\n');
      return cli;
    };

    // ① 不开门：等足够久，CLI 必须一次都没被执行。
    {
      const ran = "ran-never";
      const gate = prepareGate({ file: process.execPath, args: [mkCli(ran)] });
      assert.ok(gate, "门闩要铺得出来");
      const child = spawn(gate!.plan.file, gate!.plan.args, { stdio: ["ignore", "pipe", "pipe"] });
      await pause(1_500);
      assert.equal(existsSync(join(dir, ran)), false,
        "没开门就把目标起了 —— 归属还没建成，这正是第 6 轮 B1 那条谁都查不回去的后台查询");
      assert.equal(gate!.outcome(), null, "没执行过就不该有结束状态");

      // ② 放弃这次探测 = 收壳。壳没有后代，收掉它之后目标永远不会被执行。
      child.kill("SIGKILL");
      await new Promise<void>((r) => { child.once("close", () => r()); });
      await pause(400);
      assert.equal(existsSync(join(dir, ran)), false, "壳被收掉之后目标更不该跑起来");
      gate!.cleanup();
    }

    // ③ 开门之后：目标真的跑，两路输出透传，结束状态走盘而不是退出码。
    {
      const ran = "ran-opened";
      const gate = prepareGate({ file: process.execPath, args: [mkCli(ran)] });
      assert.ok(gate, "门闩要铺得出来");
      const child = spawn(gate!.plan.file, gate!.plan.args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (c: string) => { out += c; });
      child.stderr?.on("data", (c: string) => { err += c; });
      gate!.open();
      const end = await new Promise<number | null>((r) => {
        child.once("close", (code) => r(code));
      });
      assert.ok(existsSync(join(dir, ran)), "开门之后目标要真的被执行");
      assert.equal(end, 0, "壳自己的退出码恒 0 —— 语义不准挂在它身上（保留码会跟真实退出码撞）");
      const o = gate!.outcome();
      assert.ok(o, "结束状态必须落盘");
      assert.equal(o!.status, 7, "目标的真实退出码要原样带回来");
      assert.equal(o!.signal, null, "正常退出没有信号");
      assert.equal(o!.failed, null, "正常退出不算起不来");
      assert.match(out, /\[\]/, "stdout 要透传到壳继承的管道上");
      assert.match(err, /warn/, "stderr 也要透传，而且跟 stdout 分开（第 2 位审查者 F3）");
      gate!.cleanup();
    }
  }

  // ── 7. 结构约束：Windows 那条路本机跑不出来，用不变量兜住 ──────────────────
  // macOS 上圈定如实弃权，所以「圈建不成 → 不启动」「整圈刀 → 核销」这两条只能在真机上
  // 跑。断言刻意写成**否定式**（危险形状不存在）而不是某一种写法 —— 上一轮钉
  // `return gone ?? byClose` 的表达式形状，实现一换就恒红，而恒红的断言钉不住任何东西。
  {
    const src = readFileSync(new URL("../src/ash-mcp-probe.ts", import.meta.url), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(?:\/\/|\/?\*)/.test(l)).join("\n");

    assert.match(code, /if \(!confine\) return null;/,
      "Windows 上圈开不出来必须直接回「问不出来」，不准退回直接起 CLI（第 6 轮 B1）");
    assert.match(code, /confine\.read\(\)\.kind === "members"/,
      "enroll 答 true 只说明请求发出去了 —— 必须读到 members 才算圈真的建成");
    assert.match(code, /await settleUnit\([^)]*"timeout"\)/,
      "超时路径必须**等**收尾做完才说「问不出来」");
    assert.match(code, /void settleUnit\([^)]*"ended"\)/,
      "正常结束路径也必须收尾（根 close 不代表后代结束）");

    assert.ok(!/byClose/.test(code),
      "close 不准再当证据：后代不持管道时它来得更早，持管道时它根本不来（第 6 轮第 4 点）");
    assert.ok(!/finally\s*\{[\s\S]{0,200}?dispose\(/.test(code),
      "finally 里不准撤销身份：dispose 的契约是「调用方已经判空」，它自己不杀成员");
    assert.ok(!/cut >= 0\)\s*\{\s*confine\?\.dispose/.test(code),
      "整圈刀的成功只在门闩成立时等于整棵树终止 —— 不准单凭 cut 就核销（第 6 轮第 3 点）");
  }

  console.log("✅ ash MCP 探测层（结束路径 / 回收判据 / 输出解码）通过");
} finally {
  rmSync(stage, { recursive: true, force: true });
}
