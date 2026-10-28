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
//   5. 后代攥着输出管道时 close 永远不来，一份拿得到的答案不准丢（第 6 轮第 4 点）
//   6. 门闩：归属没建成之前 CLI 一条指令都不准执行（第 6 轮 B1）
//   7. **离组后代**：换了进程组、被 init 收养的查询照样要收掉 —— 原组的 ESRCH 推不出
//      整次运行干净（第 1 轮 B1，macOS 真机实测）
//   8. **下刀谎报成功**：`killAll` 的返回值表达不了「整圈都终止了」，核销只认读数
//      （第 2 轮 B1）
//
// 跑：npm -w server run test:ash-mcp-probe
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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

  /**
   * **测试替身**：拿进程组冒充一台归属设备，好让结束路径在本机（macOS 上圈定弃权）也能
   * 一条条跑出来 —— 否则它们只能等 Windows/Linux 真机，而前几轮正是这么漏掉问题的。
   *
   * 它**故意是弱的**：进程组一个 `setsid` 就能逃出去，正是第 1 轮 B1 点掉的那台「设备」。
   * 所以它只用来驱动「后代还在组里」的那几条路（第 1~4 块）；真正要验「离组」的第 7 块
   * 不传它，走真实的 `openConfinement`。生产代码里没有这种弱实现。
   */
  const pgroupStand = (token: string) => {
    let root = 0;
    // **要真的枚举组成员**，不能只报 root：门闩壳跑完就退出了，那时组里剩下的恰恰是它起的
    // 那些后代 —— 只报一个已死的 root，`unitResidue` 会把组读成空。`ps -eo pid=,pgid=` 在
    // 两个 POSIX 平台上都认。
    //
    // 返回 `null` = **这一问没答出来**，不是「空」。第 2 轮审查 N3 点的就是这里：上一版
    // `catch { return [] }`，把「没有 ps 可用」伪装成「圈里一个人都没有」—— 跟生产那条
    // 「不把问不出当空」的标准正好反着。
    const members = (): { pid: number; gen: null }[] | null => {
      if (!root) return [];
      try {
        return execFileSync("ps", ["-eo", "pid=,pgid="], { encoding: "utf8" })
          .split("\n")
          .map((l) => l.trim().split(/\s+/).map(Number))
          .filter(([pid, pgid]) => pgid === root && Number.isInteger(pid) && pid > 1)
          .map(([pid]) => ({ pid, gen: null }));
      } catch { return null; }
    };
    return {
      id: token,
      enroll: (pid: number) => { root = pid; return true; },
      preExecEnv: () => null,
      read: () => {
        if (!root) return { kind: "absent" as const, why: "还没 enroll" };
        const ms = members();
        if (!ms) return { kind: "unqueryable" as const, why: "ps 这一刻问不出成员" };
        return { kind: "members" as const, coverage: "since-enroll" as const, members: ms };
      },
      killAll: (sig: NodeJS.Signals) => {
        try { process.kill(-root, sig); return 1; } catch { return -1; }
      },
      dispose: () => {},
    } as unknown as NonNullable<ReturnType<NonNullable<Parameters<typeof probeCli>[5]>>>;
  };

  // **替身只在真实设备弃权的平台上用**（第 2 轮审查 N3）。Windows/Linux 上圈定不弃权，
  // 那边就该拿真实的 Job Object / cgroup 跑这几块 —— 替身在 Windows 上压根不成立（没有
  // POSIX 的 `ps`、也没有负 PID 的组语义），拿它去跑等于用一个假设备冒充验证。
  const { confineAbstention } = await import("../src/executors/kernel-confine.js");
  const abstains = !!confineAbstention();
  /** 第 1~4 块共用：弃权平台上挂替身，否则走真实设备。 */
  const probeStood = (
    args: string[], cwd: string | undefined, timeoutMs: number,
  ): ReturnType<typeof probeCli> => (abstains
    ? probeCli("codex", args, process.env, cwd, timeoutMs, pgroupStand)
    : probeCli("codex", args, process.env, cwd, timeoutMs));

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
    const res = await probeStood(["mcp", "list", "--json"], undefined, 1_200);
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
    const ask = (ms: number) => probeStood(["mcp", "list", "--json"], undefined, ms);

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
    let res: Awaited<ReturnType<typeof probeCli>> = null;
    let gone = false;
    let hungPid = 0;
    try {
      res = await ask(1_200);
      // 收尾走后台（不挡住返回），所以轮询等它做完。
      hungPid = Number(readFileSync(pidFile, "utf8").trim());
      for (let i = 0; i < 80 && !gone; i++) {
        try { process.kill(hungPid, 0); await pause(100); } catch { gone = true; }
      }
    } finally { console.warn = realWarn; }
    // 壳自己 `exit 3` 是一份**真实的结束状态**（`exit` 事件立刻就有），不是「问不出来」。
    // 判据层对非零退出同样放行（askCodex：`res.code !== 0` → unknown），所以对外结论不变；
    // 但这一层不该把一份真实的非零退出伪装成 null —— 那是第 4 轮 N1 反过来的那一半。
    assert.ok(res !== null && res.code === 3, "包装自己的退出码要如实带回，非零交给判据层去解释");
    if (!gone) { try { process.kill(hungPid, "SIGKILL"); } catch { /* 清场 */ } }
    assert.ok(gone, "B2：包装先退出了，它起的查询照样必须被回收");
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
      res = await probeStood(["mcp", "list", "--json"], undefined, 8_000);
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

  // ── 4. 后代攥着输出管道：close 永远不来，答案不能因此丢掉 ──────────────────
  // 第 6 轮真机诊断打出来的形状：垫片 `start /b` 起的后代继承了那两个管道并一直攥着，
  // 于是 CLI 早就 rc=0 正常退出、stdout 也完整了，`close` 却永远不来 —— 上一版拿 close
  // 当「结束了」，白白等到超时、把一份拿得到的答案当成「问不出来」放行（COLD_result=null
  // 而 elapsedMs=10308 > timeout=8000）。判据因此换成 `exit`（进程退出），close 只用来
  // 给输出收尾，来不来都不等。
  {
    const dir = join(stage, "pipe-held");
    mkdirSync(dir, { recursive: true });
    const pathWas = process.env.PATH;
    process.env.PATH = `${dir}${delimiter}${pathWas ?? ""}`;
    const pidFile = join(dir, "holder.pid");
    const hang = join(dir, "hang.mjs");
    writeFileSync(hang,
      'import { writeFileSync } from "node:fs";\n'
      + `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n`
      + 'setInterval(() => {}, 1000);\n');
    // 后代**不重定向**：它继承壳的 stdout/stderr 并一直活着，close 因此被无限推迟。
    if (process.platform === "win32") {
      writeFileSync(join(dir, "codex.cmd"),
        `@echo off\r\nstart /b "" "${process.execPath}" "${hang}"\r\n`
        + `:wait\r\nif not exist "${pidFile}" (ping -n 2 127.0.0.1 >nul & goto wait)\r\n`
        + 'echo []\r\nexit /b 0\r\n');
    } else {
      const f = join(dir, "codex");
      writeFileSync(f,
        `#!/bin/sh\n"${process.execPath}" "${hang}" &\n`
        + `while [ ! -f "${pidFile}" ]; do sleep 0.05; done\n`
        + "echo '[]'\nexit 0\n");
      chmodSync(f, 0o755);
    }
    const t0 = Date.now();
    const res = await probeStood(["mcp", "list", "--json"], undefined, 6_000);
    const took = Date.now() - t0;
    assert.ok(res, "进程退出了、答案也写完了，不能因为 close 不来就把它当成「问不出来」");
    assert.equal(res!.code, 0, "退出码要带回来");
    assert.match(res!.stdout, /\[\]/, "答案要完整");
    assert.ok(took < 5_000, `不该等到超时才返回（${took}ms）—— close 被攥着管道的后代推迟了`);

    // 收尾照旧要把那个攥管道的后代收掉。
    const holder = Number(readFileSync(pidFile, "utf8").trim());
    let gone = false;
    for (let i = 0; i < 80 && !gone; i++) {
      try { process.kill(holder, 0); await pause(100); } catch { gone = true; }
    }
    if (!gone) { try { process.kill(holder, "SIGKILL"); } catch { /* 清场 */ } }
    assert.ok(gone, "攥着管道的后代同样要被收掉");

    process.env.PATH = pathWas;
  }

  // ── 5. 归属读数：这台设备答得了什么，「不说话」不等于「空」 ─────────────────
  // 判据抄的是既有消费者 cleanup-result.ts 的 confinedResidue：absent 不说话、unqueryable
  // 不说话、只有 whole-run（或门闩关掉了空窗）的空才构成证明。上一版把 absent 和
  // since-enroll 的空都读成「已回收」，于是 Windows 冷启动那次泄漏连警告都没打（第 5 轮 B1）。
  {
    const fake = (read: unknown) => ({
      id: "fake", enroll: () => true, preExecEnv: () => null,
      read: () => read, killAll: () => 1, dispose: () => {},
    });
    const unit = (confine: unknown, gated: boolean) =>
      ({ confine, gated }) as Parameters<typeof unitResidue>[0];
    const members = (ms: number[], coverage: string) =>
      fake({ kind: "members", members: ms.map((pid) => ({ pid, gen: null })), coverage });

    assert.equal(unitResidue(unit(fake({ kind: "absent", why: "圈没建起来" }), true)), null,
      "absent = 这台设备弃权，**不是**「已经回收」；门闩也不能让它说话（圈都没有，门闩无从谈起）");
    assert.equal(unitResidue(unit(fake({ kind: "unqueryable", why: "这一刻问不到" }), true)), null,
      "问不出来也不是空");
    assert.equal(unitResidue(unit(members([], "since-enroll"), false)), null,
      "没门闩时 since-enroll 的空不构成证明 —— 空窗里出生又脱离的后代不在集合里");
    assert.equal(unitResidue(unit(members([], "whole-run"), false)), "gone",
      "设备自己说覆盖整次运行时，空就是证明");
    // 第 6 轮审查第 3 点：`cut >= 0` 当时绕过了 coverage 判据。现在反过来 —— 判据是
    // **门闩有没有把窗口关掉**，而不是设备自报的那一档。门闩之下被 spawn 的是不生后代的
    // 壳，CLI 在圈建成之后才出生，所以这个集合对 CLI 这棵树是确定的，空构成证明。
    assert.equal(unitResidue(unit(members([], "since-enroll"), true)), "gone",
      "门闩关掉了空窗：集合对 CLI 这棵树是确定的，空算证明");
    assert.equal(unitResidue(unit(members([process.pid], "since-enroll"), true)), "remaining",
      "成员还活着就是还有残留");
    // 一台设备都没有 ⇒ 没人能作答。这一档不许退回进程组（第 1 轮 B1）。
    assert.equal(unitResidue(unit(null, false)), null, "没有归属设备时只能答「不说话」");
  }

  // ── 6. 门闩：归属没建成之前，CLI 一条指令都不准执行 ────────────────────────
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

  // ── 7. 离组后代：换了进程组、被 init 收养的查询也必须收掉 ──────────────────
  // 第 1 轮审查 B1 在 macOS 上实测的形状：包装用 `detached + stdio=ignore` 起查询、自己
  // 正常退出 —— 原进程组**整个消失**（wrapperGroupPresent=false），查询 PPID=1、自成一组
  // 活着。上一版据「原组 ESRCH」答 `gone`、连一句警告都没打，最后是审查脚本拿自己记下的
  // pid 收的。
  //
  // 跟第 3 块的区别就在**离组**那一下：那边的后代是 `&` 起的，仍留在原组里，组刀打得到，
  // 所以旧实现也能过。这一块的鉴别力全靠「原组已经空了」那条断言 —— 没有它，这个用例
  // 对旧实现同样是绿的。归属改由**内核圈定**提供（cgroup/Job 的成员资格逃不掉，换组和
  // 被收养都还在圈里）；圈拿不到的平台不启动，所以这一块按 `abstains` 分两支。
  if (process.platform !== "win32") {
    const escDir = join(stage, "escape-cli");
    mkdirSync(escDir, { recursive: true });
    const pidFile = join(escDir, "query.pid");
    const wrapperFile = join(escDir, "wrapper.pid");
    const query = join(escDir, "query.mjs");
    const wrapper = join(escDir, "wrapper.mjs");
    writeFileSync(query,
      'import { writeFileSync } from "node:fs";\n'
      + `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n`
      + 'setInterval(() => {}, 1000);\n');
    // `detached: true` = setsid：它从此自成进程组，组刀和父子树都追不到它。
    writeFileSync(wrapper,
      'import { spawn } from "node:child_process";\n'
      + 'import { writeFileSync, existsSync } from "node:fs";\n'
      + `writeFileSync(${JSON.stringify(wrapperFile)}, String(process.pid));\n`
      + `const q = spawn(process.execPath, [${JSON.stringify(query)}], `
      + '{ detached: true, stdio: "ignore" });\n'
      + 'q.unref();\n'
      + `const poll = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) `
      + '{ clearInterval(poll); process.stdout.write("[]"); } }, 25);\n');
    const shim = join(escDir, "codex");
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${wrapper}" "$@"\n`);
    chmodSync(shim, 0o755);

    const pathWas = process.env.PATH;
    process.env.PATH = `${escDir}${delimiter}${pathWas ?? ""}`;
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
    let res: Awaited<ReturnType<typeof probeCli>>;
    let queryPid = 0;
    let gone = false;
    let groupGone = false;
    try {
      res = await // **刻意不传替身**：这一块验的就是真实设备弃权时该不该启动。
      probeCli("codex", ["mcp", "list", "--json"], process.env, undefined, 8_000);
      if (existsSync(wrapperFile)) {
        const wrapperPid = Number(readFileSync(wrapperFile, "utf8").trim());
        // **这条才是鉴别力所在**：包装那一组必须已经整个没了 —— 旧实现正是在这一刻把
        // 「原组 ESRCH」读成「整次运行已清理」的。
        try { process.kill(-wrapperPid, 0); } catch { groupGone = true; }
      }
      if (existsSync(pidFile)) {
        queryPid = Number(readFileSync(pidFile, "utf8").trim());
        for (let i = 0; i < 100 && !gone; i++) {
          try { process.kill(queryPid, 0); await pause(100); } catch { gone = true; }
        }
      }
    } finally { console.warn = realWarn; }

    if (!gone && queryPid > 1) { try { process.kill(queryPid, "SIGKILL"); } catch { /* 清场 */ } }
    process.env.PATH = pathWas;

    if (abstains) {
      // 这台机器没有内核圈定（macOS）⇒ **一条指令都不该起**。旧实现会照常起、答 gone、
      // 把那个离组查询留在机器上，所以这一支对旧实现是红的。
      assert.equal(res, null, "拿不到能核销的归属设备就不探测，直接回「问不出来」（第 1 轮 B1）");
      assert.ok(!existsSync(wrapperFile),
        "假 CLI 一次都不该被执行 —— 起了就等于留下一个谁都查不回去的后台查询");
      assert.equal(queryPid, 0, "查询进程压根不该存在");
    } else {
      // 有圈（Linux 的 cgroup）：照常探测，离组后代由整圈刀收掉。
      assert.ok(res, "答案照样要拿回来 —— 收尾的事不该影响这一问");
      assert.match(res!.stdout, /\[\]/, "答案要完整");
      assert.ok(groupGone,
        "包装的进程组应该已经整个消失 —— 没有这一条，这个用例对旧实现同样是绿的");
      assert.ok(Number.isInteger(queryPid) && queryPid > 1, "假 CLI 应该写下了那个离组查询的 pid");
      assert.ok(gone,
        "离组后代必须由探测层自己收掉：原组的 ESRCH 推不出整次运行干净（第 1 轮 B1）");
      assert.ok(!warned.some((w) => w.includes("收不干净")),
        `收干净了就不准喊收不干净：${warned.join(" | ")}`);
    }
  }

  // ── 8. 下刀谎报成功：核销只认读数，不认 killAll 的返回值 ───────────────────
  // 第 2 轮审查 B1。`killAll` 的两条实现返回值**分辨不出来**：`cgroup.kill` 那条是真原子
  // 圈刀，返回 1；<5.14 的降级路径枚举成员逐个 `killOne`，失败被咽掉照样 `sent += 1`，
  // 返回的是**尝试数**，也是 1。上一版有一句「cut >= 0 且门闩成立 ⇒ 核销」，落在降级路径
  // 上就是「一个都没杀成也当收干净了」—— 身份跟着交还，残留从此查不回去。
  //
  // 这里拿一台**谎报的设备**把它摆出来：`killAll` 恒答成功，`read()` 一直报一个真活着的
  // 成员。要的行为是两件：不核销（身份保留住，还查得回去）+ 如实喊一句「收不干净」。
  // 这条不分平台 —— 它验的是共同核销层的不变量，不是某个平台的设备。
  {
    const liar = { kills: 0, disposed: 0 };
    const liarStand = (token: string) => {
      let root = 0;
      return {
        id: token,
        enroll: (pid: number) => { root = pid; return true; },
        preExecEnv: () => null,
        // 恒报一个**真活着**的成员（这个测试进程自己），所以读数一直是 remaining。
        read: () => (root
          ? {
            kind: "members" as const,
            coverage: "since-enroll" as const,
            members: [{ pid: process.pid, gen: null }],
          }
          : { kind: "absent" as const, why: "还没 enroll" }),
        // ← 谎报：一个都没杀，照样答「成功」。这正是降级路径的返回值长相。
        killAll: () => { liar.kills++; return 1; },
        dispose: () => { liar.disposed++; },
      } as unknown as NonNullable<ReturnType<NonNullable<Parameters<typeof probeCli>[5]>>>;
    };

    const dir = join(stage, "liar-cli");
    mkdirSync(dir, { recursive: true });
    if (process.platform === "win32") {
      writeFileSync(join(dir, "codex.cmd"), "@echo off\r\n<nul set /p=[]\r\nexit /b 0\r\n");
    } else {
      const f = join(dir, "codex");
      writeFileSync(f, "#!/bin/sh\nprintf '[]'\n");
      chmodSync(f, 0o755);
    }

    const pathWas = process.env.PATH;
    process.env.PATH = `${dir}${delimiter}${pathWas ?? ""}`;
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
    let res: Awaited<ReturnType<typeof probeCli>> = null;
    try {
      // 这一块**必须**挂替身（哪个平台都挂）：谎报是替身的全部意义，真实设备不会谎报。
      res = await probeCli(
        "codex", ["mcp", "list", "--json"], process.env, undefined, 8_000, liarStand,
      );
      // 收尾在后台跑（`void settleUnit`），复核预算 REAP_GRACE_MS*2 ≈ 6 s —— 等它把话说完。
      for (let i = 0; i < 160 && !warned.some((w) => w.includes("收不干净")); i++) await pause(100);
    } finally {
      console.warn = realWarn;
      process.env.PATH = pathWas;
    }

    assert.ok(res, "答案照样要拿回来 —— 收尾的事不该影响这一问");
    assert.match(res!.stdout, /\[\]/, "答案要完整");
    assert.ok(liar.kills > 0, "该下的刀还是要下 —— 不看返回值不等于不下刀");
    assert.equal(liar.disposed, 0,
      "读数一直报着活成员 ⇒ 一次都不准核销：killAll 答的「成功」在降级路径上只是尝试数（第 2 轮 B1）");
    assert.ok(warned.some((w) => w.includes("收不干净")),
      `收不干净必须如实喊出来，否则残留连线索都不剩：${warned.join(" | ")}`);
  }

  // ── 9. 结构约束：Windows 那条路本机跑不出来，用不变量兜住 ──────────────────
  // macOS 上圈定如实弃权，所以「圈建不成 → 不启动」「整圈刀 → 核销」这两条只能在真机上
  // 跑。断言刻意写成**否定式**（危险形状不存在）而不是某一种写法 —— 上一轮钉
  // `return gone ?? byClose` 的表达式形状，实现一换就恒红，而恒红的断言钉不住任何东西。
  {
    const src = readFileSync(new URL("../src/ash-mcp-probe.ts", import.meta.url), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(?:\/\/|\/?\*)/.test(l)).join("\n");

    const fnBody = (body: string, head: string): string => {
      const at = body.indexOf(head);
      assert.ok(at >= 0, `${head} 不见了`);
      const end = body.indexOf("\n}", at);
      return body.slice(at, end > 0 ? end : undefined);
    };

    // **一台归属设备都拿不到时，一条指令都不准起。** 写成位置关系而不是某一句的形状：
    // 要的不变量是「这道闸在 spawn 之前」。
    const probeBody = fnBody(code, "export async function probeCli");
    const guardAt = probeBody.search(/if \(!confine\) return null;/);
    const spawnAt = probeBody.indexOf("spawn(launch.file");
    assert.ok(guardAt >= 0 && spawnAt > guardAt,
      "拿不到能核销的归属设备就不做这次探测 —— 不准退回直接起 CLI（第 6 轮 B1 / 第 1 轮 B1）");

    // **进程组不准再参与核销**（第 1 轮 B1）：后代一个 setsid 就出圈，原组的 ESRCH 推不出
    // 整次运行干净。组刀照留（killTree 内部那一刀在 platform.ts），但这个文件里不准再出现
    // 拿进程组**探活**的写法。
    assert.ok(!/kill\(-\s*\w+\s*,\s*0\s*\)/.test(code),
      "原组的 ESRCH 不是「整次运行已清理」的证据（第 1 轮 B1，macOS 真机实测）");
    // **追踪 fd 整台设备已经撤掉**（第 2 轮 N4/N5）。两条理由各自独立成立：
    //  · 它到不了 CLI —— 门闩那一跳是 `spawnSync(stdio: "inherit")`，只转发 0/1/2，
    //    Node 的 spawn 又把非 stdio 的 fd 都 CLOEXEC 掉（本轮实测：`lsof` 答空，而 `ps`
    //    明明看得见那个后代）。断了之后它答的正是「没人握着」—— 一个假的核销。
    //  · 就算接通也是冗余的 —— 在「圈定不完整就不启动」之下，能被 lsof 看见的后代必然
    //    已经在圈里，圈的读数本来就覆盖它。
    assert.ok(!/TrackFd|trackHolders|probeFileHolders|residueFromProbe|holdersMayExist/.test(code),
      "追踪 fd 在这条链上只会答出一个假的「空」，而且冗余 —— 不准再接回来（第 2 轮 N4/N5）");

    // **下刀的返回值不构成核销**（第 2 轮 B1）：Linux <5.14 那条降级路径枚举成员逐个
    // `killOne`，失败被咽掉照样 `sent += 1`，返回的是**尝试数** —— 跟 `cgroup.kill` 那条
    // 真原子路径返回的 1 长得一模一样，调用方分辨不出来。所以不准据它判事。
    const settleBody = fnBody(code, "async function settleUnit");
    assert.ok(!/(?:const|let|var)\s+\w+\s*=\s*[\w.?]*killAll\(/.test(settleBody),
      "killAll 的返回值不准存下来 —— 存下来就是打算拿它判事（第 2 轮 B1）");
    assert.ok(!/(?:if|while|\?\?|&&|\|\|)\s*\(?[\w.?]*killAll\(/.test(settleBody),
      "killAll 的返回值不准参与判断（降级路径返回的是尝试数，第 2 轮 B1）");
    // 正面那半：下刀之后必须回到**读数**上去证。
    assert.ok(!/killAll\([^)]*\);\s*killTree\([^)]*\);\s*discharge\(/.test(settleBody),
      "不准杀完就核销 —— 中间必须有一次读数（第 2 轮 B1）");
    assert.match(settleBody, /while \([\s\S]*?unitResidue\(unit\)[\s\S]*?\}/,
      "复核要成环地问，直到证空或者预算用完");
    // **钉函数体里有哪几件事，不钉它们写成什么样。** 这一轮和上一轮各被形状断言咬过一次：
    // 钉 `return gone ?? byClose`、钉 `confine.read().kind === …` 的那两条，实现一换写法就
    // 恒红，而恒红的断言钉不住任何东西。
    assert.match(code, /confirmHeld\(/, "开门之前必须确认归属，不能直接 open");
    const confirm = fnBody(code, "async function confirmHeld");
    assert.match(confirm, /enroll\(pid\)/, "确认归属要先 enroll");
    // enroll 写的是 Node stream，read() 内部 Atomics.wait 会把事件循环堵死 —— 中间不把那次
    // 写等出去，hold 请求根本发不出去（真机实测：第一次碰巧成功，之后是 absent）。
    assert.match(confirm, /await wait\(HOLD_FLUSH_MS\)/,
      "enroll 之后必须把那次异步写等出去（第 6 轮真机）");
    assert.match(confirm, /kind === "members"/,
      "enroll 答 true 只说明请求发出去了 —— 必须读到 members 才算圈真的建成");
    assert.match(code, /await settleUnit\([^)]*"timeout"\)/,
      "超时路径必须**等**收尾做完才说「问不出来」");
    assert.match(code, /void settleUnit\([^)]*"ended"\)/,
      "正常结束路径也必须收尾（根 close 不代表后代结束）");

    assert.ok(!/byClose/.test(code),
      "close 不准再当证据：后代不持管道时它来得更早，持管道时它根本不来（第 6 轮第 4 点）");
    assert.ok(!/finally\s*\{[\s\S]{0,200}?dispose\(/.test(code),
      "finally 里不准撤销身份：dispose 的契约是「调用方已经判空」，它自己不杀成员");
  }

  console.log("✅ ash MCP 探测层（结束路径 / 回收判据 / 输出解码）通过");
} finally {
  rmSync(stage, { recursive: true, force: true });
}
