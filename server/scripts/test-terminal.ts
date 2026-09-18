import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { IS_WINDOWS } from "../src/platform.js";
import { resolveTerminalDirectory, TerminalSessionManager } from "../src/terminal.js";

// realpath 一次:Windows 的 %TEMP% 常常是 8.3 短名(`C:\Users\RUNNER~1\…`),而
// cmd 的 `cd` 回的是长名 —— 不展开的话下面那句 output.includes(cwd) 永远不成立。
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ash-terminal-")));
const manager = new TerminalSessionManager();

// 起一个**确定的** shell(不走 shellCommand() 的回退链):这条测试要验的是会话管理
// 与 ConPTY/pty 的收发,不是「这台机器上默认该用哪个 shell」。探针命令跟着 shell 走 ——
// cmd 里 `printf`/`pwd` 都不存在,得换成 `echo` 和 `cd`(cmd 的 `cd` 不带参数就是打印当前目录)。
const shell = IS_WINDOWS ? "cmd.exe" : "/bin/sh";
const probeCommand = IS_WINDOWS
  ? "echo __ASH_TERMINAL_OK__& cd\r\n"
  : "printf '__ASH_TERMINAL_OK__\\n'; pwd\n";

try {
  assert.equal(resolveTerminalDirectory("~"), homedir());
  const session = manager.create("project-test", cwd, {
    shell,
    shellArgs: [],
    cols: 80,
    rows: 20,
  });
  let output = "";
  let unsubscribe: (() => void) | null = null;
  const received = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`terminal output timed out: ${JSON.stringify(output)}`));
    }, 5000);
    unsubscribe = manager.subscribe(session.id, "project-test", (event) => {
      if (event.type !== "data") return;
      output += event.data;
      if (output.includes("__ASH_TERMINAL_OK__") && output.includes(cwd)) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  assert.ok(unsubscribe);
  assert.equal(manager.get(session.id, "wrong-project"), null);
  assert.equal(manager.resize(session.id, "project-test", 110, 32), true);
  assert.equal(manager.write(session.id, "project-test", probeCommand), true);
  await received;
  assert.ok(manager.eventsAfter(session.id, "project-test", 0)?.length);
  assert.equal(manager.sweepIdleSessions(Date.now() + 31 * 60 * 1000), 0);
  assert.ok(manager.get(session.id, "project-test"));
  unsubscribe();
  // 交互 shell 是持久终端:没人订阅(抽屉收起)也不回收,活着就一直在。
  assert.equal(manager.sweepIdleSessions(Date.now() + 31 * 60 * 1000), 0);
  assert.ok(manager.get(session.id, "project-test"));
  // shell 自己退出(整组死透)后,退出记录才回到闲置回收轨道。
  const exited = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("shell did not exit in time")), 8000);
    const stop = manager.subscribe(session.id, "project-test", (event) => {
      if (event.type !== "exit") return;
      clearTimeout(timeout);
      stop?.();
      resolve();
    });
    if (!stop) { clearTimeout(timeout); reject(new Error("session not found")); }
  });
  manager.write(session.id, "project-test", IS_WINDOWS ? "exit\r\n" : "exit\n");
  await exited;
  assert.equal(manager.sweepIdleSessions(Date.now() + 31 * 60 * 1000), 1);
  assert.equal(manager.get(session.id), null);

  // destroy = tab ✕「结束会话」:进程组级确认杀净才移除。探针是 shell 里 fork 一个
  // **忽略 TERM/HUP** 的后台作业 —— close() 只对组长单发一次信号,它会被 PID 1 收养
  // 继续跑(第 1 轮自由审查实锤);destroy 必须整组清掉。Windows 没有进程组,只跑 POSIX。
  if (!IS_WINDOWS) {
    const victim = manager.create("project-destroy", cwd, { shell, shellArgs: [], cols: 80, rows: 20 });
    let pidOutput = "";
    const orphanPid = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`orphan pid output timed out: ${JSON.stringify(pidOutput)}`));
      }, 5000);
      const stop = manager.subscribe(victim.id, "project-destroy", (event) => {
        if (event.type !== "data") return;
        pidOutput += event.data;
        const match = pidOutput.match(/__ASH_PID_(\d+)__/);
        if (match) {
          clearTimeout(timeout);
          stop?.();
          resolve(Number(match[1]));
        }
      });
      // 先关掉 history expansion(交互态 bash 会把双引号里的 `$!__` 当历史引用炸掉;
      // 必须单独一行 —— 展开发生在整行执行之前,同一行里 set +H 救不了自己)。
      manager.write(victim.id, "project-destroy", "set +H 2>/dev/null\n");
      manager.write(victim.id, "project-destroy", "trap '' TERM HUP; sleep 300 & echo \"__ASH_PID_$!__\"\n");
    });
    const destroyed = await manager.destroy(victim.id, "project-destroy", { termMs: 250, killMs: 2000 });
    assert.equal(destroyed.ok, true, "destroy 应确认整组清空");
    assert.equal(manager.get(victim.id), null, "destroy 成功后会话应被移除");
    // 后台作业可能短暂停留在僵尸态等 PID 1 收尸,轮询到 ESRCH 为止。
    const deadline = Date.now() + 3000;
    for (;;) {
      try { process.kill(orphanPid, 0); } catch { break; }
      assert.ok(Date.now() < deadline, "忽略 TERM/HUP 的后台作业应随 destroy 一起被杀掉");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // destroyProject = 删项目前的清场:该项目全部会话(交互 shell + 常用命令)一把清掉,
    // 别的项目一个不动。
    const keep = manager.create("project-keep", cwd, { shell, shellArgs: [], cols: 80, rows: 20 });
    manager.create("project-doomed", cwd, { shell, shellArgs: [], cols: 80, rows: 20 });
    manager.create("project-doomed", cwd, { shell, command: { id: "dev", name: "dev", script: "sleep 300" } });
    assert.equal(manager.listForProject("project-doomed").length, 2);
    const cleared = await manager.destroyProject("project-doomed");
    assert.equal(cleared.ok, true, "destroyProject 应确认全部清空");
    assert.equal(manager.listForProject("project-doomed").length, 0, "项目的会话应全部移除");
    assert.ok(manager.get(keep.id, "project-keep"), "别的项目的会话不能被殃及");
    const keptCleared = await manager.destroy(keep.id, "project-keep");
    assert.equal(keptCleared.ok, true);

    // ── 第 2/3 轮:job-control 后台作业(独立进程组)的清场路径 ──────────────────────
    // `set -m` 让每个 `&` 后台作业进**自己的**进程组(pgid == 作业 pid),忽略 TERM/HUP。
    // shell 先退出后原组已空,只看组长会把仍活的作业谎报成「已清空」—— 靠会话存续期累积
    // 的 descendantPgids 兜住。第 3 轮审查要求:测试**不得**手动调扫描(它已改私有),必须
    // 让**真实定时器**在 shell 还活着时跑完一轮累积,再按**真实退出时序**关 shell、清场。
    // 因此用小间隔 manager + 真实 sleep(> 间隔)等真定时器落一轮。
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const SCAN_MS = 120;
    const spawnJobControlOrphan = async (mgr: TerminalSessionManager, projectId: string) => {
      const s = mgr.create(projectId, cwd, { shell, shellArgs: [], cols: 80, rows: 20 });
      let buf = "";
      const pid = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`job pid timed out: ${JSON.stringify(buf)}`)), 6000);
        const stop = mgr.subscribe(s.id, projectId, (event) => {
          if (event.type !== "data") return;
          buf += event.data;
          const match = buf.match(/__JOB_(\d+)__/);
          if (match) { clearTimeout(timeout); stop?.(); resolve(Number(match[1])); }
        });
        mgr.write(s.id, projectId, "set +H 2>/dev/null\n"); // 关 history expansion(见上文)
        mgr.write(s.id, projectId, "set -m\n");             // 开 job control → 独立进程组
        mgr.write(s.id, projectId, "trap '' TERM HUP\n");
        mgr.write(s.id, projectId, "sleep 300 & echo __JOB_$!__\n");
      });
      // 证明作业确实在独立组里(pgid == 自身 pid),否则这条测试就没打到 round-2 的痛点
      const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)]).toString().trim());
      assert.equal(pgid, pid, "后台作业应在自己的独立进程组(set -m job control)");
      // 不手动扫描:等真实周期定时器在 shell 还活着时跑完至少一轮,把独立组 pgid 记进会话。
      await sleep(SCAN_MS * 3);
      return { session: s, pid };
    };
    const waitDead = async (pid: number, label: string) => {
      const deadline = Date.now() + 3000;
      for (;;) {
        try { process.kill(pid, 0); } catch { return; }
        assert.ok(Date.now() < deadline, label);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    // [P1] shell 先 exit,再 destroy:实时快照已抓不到(树断),只能靠真实定时器累积的 pgid 杀净。
    {
      const jobMgr = new TerminalSessionManager({ descendantScanMs: SCAN_MS });
      try {
        const { session: s, pid } = await spawnJobControlOrphan(jobMgr, "project-exit-orphan");
        const exited = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("orphan shell did not exit")), 6000);
          const stop = jobMgr.subscribe(s.id, "project-exit-orphan", (event) => {
            if (event.type !== "exit") return;
            clearTimeout(timeout); stop?.(); resolve();
          });
        });
        // disown 让 shell 别把作业算进「还有运行中的任务」而拒绝退出(交互态 bash 会拦一次)。
        jobMgr.write(s.id, "project-exit-orphan", "disown\n");
        jobMgr.write(s.id, "project-exit-orphan", "exit\n");
        await exited;
        const res = await jobMgr.destroy(s.id, "project-exit-orphan", { termMs: 250, killMs: 2000 });
        assert.equal(res.ok, true, "shell 已退出时 destroy 仍应确认独立组后台作业被杀净");
        await waitDead(pid, "shell 退出后的独立组后台作业应随 destroy 被杀掉");
      } finally {
        jobMgr.shutdown();
      }
    }

    // [P1] shutdown 同步清场:不能 await ps,靠同步 ps 补抓 + 真实定时器累积的 pgid 杀独立组。
    {
      const doomed = new TerminalSessionManager({ descendantScanMs: SCAN_MS });
      const { pid } = await spawnJobControlOrphan(doomed, "project-shutdown");
      doomed.shutdown();
      await waitDead(pid, "shutdown 应用累积/实时的独立组 pgid 杀掉 job-control 后台作业");
    }

    // [P2] 删除态互斥:进入 shutdown 态后拒绝新建该项目会话,删失败(deleted=false)退出后恢复。
    {
      manager.beginProjectShutdown("project-locked");
      assert.throws(
        () => manager.create("project-locked", cwd, { shell, shellArgs: [] }),
        /正在删除/,
        "项目删除态应拒绝新建终端会话",
      );
      manager.endProjectShutdown("project-locked"); // deleted 默认 false:删失败放行重试
      const reopened = manager.create("project-locked", cwd, { shell, shellArgs: [] });
      assert.ok(reopened, "删失败退出删除态后应能新建");
      const done = await manager.destroy(reopened.id, "project-locked");
      assert.equal(done.ok, true);
    }

    // [P1] 删除完成后的**永久墓碑**:删除开始前已进入创建路由、删除完成撤销执行期标记后才
    // 走到 create 的在途慢请求,只靠执行期布尔 Set 拦不住 —— 永久墓碑让它永远拿不到创建资格
    // (第 3 轮自由审查实锤)。endProjectShutdown(pid, true) 模拟「删库成功」。
    {
      manager.beginProjectShutdown("project-deleted");
      manager.endProjectShutdown("project-deleted", true); // deleted=true:转永久墓碑
      assert.throws(
        () => manager.create("project-deleted", cwd, { shell, shellArgs: [] }),
        /已删除/,
        "删除完成后(永久墓碑)应永远拒绝新建,封死删除后到达的在途慢请求",
      );
    }
  }
  console.log("terminal session test passed");
} finally {
  manager.shutdown();
  rmSync(cwd, { recursive: true, force: true });
}
