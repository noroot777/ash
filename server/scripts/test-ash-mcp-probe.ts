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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.ok(!warned.some((w) => w.includes("没能确认回收")),
      "B2：执行单元已经空了就该当场确认 —— 等满两轮宽限再喊收不回，说明判据还挂在 close 上");

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
    const res = await probeCli("codex", ["mcp", "list", "--json"], process.env, undefined, 8_000);
    assert.ok(res, "正常退出要照常给出答案");
    assert.equal(res!.code, 0, "退出码是 0");
    assert.match(res!.stdout, /\[\]/, "答案本身不受收尾影响");

    // 收尾刻意放在后台（不拖住派审请求，第 5 轮 N1），所以这里轮询等它做完。
    const orphan = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(orphan) && orphan > 1, "假 CLI 应该写下了那个孤儿的 pid");
    let gone = false;
    for (let i = 0; i < 80 && !gone; i++) {
      try { process.kill(orphan, 0); await pause(100); } catch { gone = true; }
    }
    if (!gone) { try { process.kill(orphan, "SIGKILL"); } catch { /* 清场 */ } }
    assert.ok(gone, "正常退出路径也必须把自己起的后代收掉 —— 根 close 不代表后代结束");

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

    assert.equal(unitResidue(12345, fake({ kind: "absent", why: "圈没建起来" })), null,
      "absent = 这台设备弃权，**不是**「已经回收」（冷启动时 assign 赶不上就是这一档）");
    assert.equal(unitResidue(12345, fake({ kind: "unqueryable", why: "这一刻问不到" })), null,
      "问不出来也不是空");
    assert.equal(unitResidue(12345, fake({ kind: "members", members: [], coverage: "since-enroll" })), null,
      "since-enroll 的空不构成证明 —— Windows 恒在这一档");
    assert.equal(unitResidue(12345, fake({ kind: "members", members: [], coverage: "whole-run" })), "gone",
      "只有 whole-run 的空才算证空");
    assert.equal(
      unitResidue(12345, fake({ kind: "members", members: [{ pid: process.pid, gen: null }], coverage: "whole-run" })),
      "remaining", "成员还活着就是还有残留");
  }

  // ── 5. 结构约束：撤销身份只能发生在确认收干净之后 ──────────────────────────
  {
    const src = readFileSync(new URL("../src/ash-mcp-probe.ts", import.meta.url), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(?:\/\/|\/?\*)/.test(l)).join("\n");
    assert.ok(!/finally\s*\{[\s\S]{0,200}?dispose\(/.test(code),
      "finally 里不准撤销身份：dispose 的契约是「调用方已经判空」，它自己不杀成员");
    assert.match(code, /void settleUnit\(child, unit, closed, "ended"\)/,
      "正常结束路径也必须走收尾（根 close 不代表后代结束）");
    assert.match(code, /await settleUnit\(child, unit, closed, "timeout"\)/,
      "超时路径必须**等**收尾做完才说「问不出来」");
    assert.match(code, /openConfinement\(/,
      "Windows 上内核圈定才是不依赖父存活的那个执行单元");
  }

  console.log("✅ ash MCP 探测层（结束路径 / 回收判据 / 输出解码）通过");
} finally {
  rmSync(stage, { recursive: true, force: true });
}
