/**
 * 端口兜底那一档里**用户自己写了停止命令**的那条路。
 *
 * 跟默认停止(test-service-ports.ts)的分界很要紧:那条路是 ash 自己动手,连杀带核验一趟做完;
 * 这条路**我们一个 kill 都不发** —— 用户写那段脚本正是不想让 ash 直接 kill。于是我们手里只有
 * 「跑之前照一张相、跑完回头比一遍」这一个办法,而相和比对各有自己的失败分支。真进程夹具与
 * 那边共用 test-service-ports-fixtures.ts(全局约定:单文件不超过 700 行)。
 *
 *   ⑭ **停止命令只收掉监听者也不算停净**:端口空了只说明监听者走了,它 fork 的工人还在跑。
 *      默认停止那条路有 stopByPorts 枚举成员顺手记下这几个,这条路只能拿停止**之前**照的
 *      成员相去比(第 5 轮审查发现 1);
 *   ⑮ **脚本自己失败时,它已经做成的那部分照样要落账**。脚本的典型形状是「先收掉监听者,
 *      再做别的收尾,然后某一步失败」—— 监听者这会儿已经死了,而它 fork 的工人还在跑。
 *      这一趟不落账,下一遍再点停止时端口已经空了,那个工人**再也不会被发现**,于是端口
 *      一空就判 verified(第 6 轮审查 E1 实测:首次 502 而 stop.kind 仍是 none;再点一次
 *      200 stopped、停止按钮消失,工人照旧活着)。
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { SERVICE_COMMAND_ID } from "@ash/shared/project-commands";
import { IS_WINDOWS } from "../src/platform.js";
import { startCommand, stopCommand } from "../src/terminal-commands.js";
import {
  alive, cleanup, cwd, daemonScript, freePort, leftoversOf, listening, pidIn, service,
  serviceSession, strays, waitFor,
} from "./test-service-ports-fixtures.js";

if (IS_WINDOWS) {
  console.log("service ports stop-script test passed (windows: 端口兜底不启用)");
  process.exit(0);
}

try {

  // ── ⑭ 停止命令只收掉监听者,也不算这次启动停净了 ────────────────────────────────
  //    脚本这条路 ash 不替用户强杀(他写那段脚本正是不想让 ash 直接 kill),于是默认停止那边
  //    「枚举同组成员」的覆盖拿不到 —— 必须拿停止**之前**照的成员相来比:端口空了只说明
  //    监听者走了,它 fork 的工人从来没进过账(发现 1)。
  {
    const scriptPort2 = await freePort();
    const litePidfile = join(cwd, "lite.pid");
    const liteWorker = join(cwd, "lite-worker.pid");
    assert.equal(
      (await startCommand("ports14", cwd, service(daemonScript(scriptPort2, litePidfile, [], liteWorker)))).status,
      201,
    );
    await waitFor("守护进程听上了端口", async () => (await listening(scriptPort2)).length > 0);
    const litePid = pidIn(litePidfile);
    strays.add(litePid);
    await waitFor("洗掉环境的工人也起来了", () => { try { return pidIn(liteWorker) > 0; } catch { return false; } });
    const liteWorkerPid = pidIn(liteWorker);
    strays.add(liteWorkerPid);
    await waitFor("启动脚本退出", () => serviceSession("ports14")?.exitCode !== null);
    // 一条**只收监听者**的停止命令:它 exit 0,端口也真的让出来了。
    const partial = await stopCommand("ports14", SERVICE_COMMAND_ID, {
      script: `kill -9 ${litePid}`, cwd, timeoutMs: 5_000,
    }, { portGraceMs: 300 });
    assert.equal(partial.status, 200);
    await waitFor("监听者被脚本收掉了", () => !alive(litePid));
    const partialBody = partial.body as { stopped: boolean; unresolved?: number[]; notice?: string };
    assert.deepEqual(partialBody.unresolved, [liteWorkerPid], "停止前在跑、现在还活着的成员要落进账");
    assert.match(partialBody.notice ?? "", /停止命令跑完了/, "要跟用户说清是他那条脚本没收干净");
    assert.deepEqual(leftoversOf("ports14"), [liteWorkerPid], "刷新回来还看得见");
    process.kill(liteWorkerPid, "SIGKILL");
    strays.delete(litePid);
    strays.delete(liteWorkerPid);
  }

  // ── ⑮ 脚本自己失败时,它已经做成的那部分照样要落账 ──────────────────────────────────
  const failPort = await freePort();
  const failPidfile = join(cwd, "fail.pid");
  const failWorker = join(cwd, "fail-worker.pid");
  assert.equal(
    (await startCommand("ports15", cwd, service(daemonScript(failPort, failPidfile, [], failWorker)))).status,
    201,
  );
  await waitFor("守护进程听上了端口", async () => (await listening(failPort)).length > 0);
  const failPid = pidIn(failPidfile);
  strays.add(failPid);
  await waitFor("洗掉环境的工人也起来了", () => { try { return pidIn(failWorker) > 0; } catch { return false; } });
  const failWorkerPid = pidIn(failWorker);
  strays.add(failWorkerPid);
  await waitFor("启动脚本退出", () => serviceSession("ports15")?.exitCode !== null);

  // 第一趟:脚本**先收掉监听者,然后自己失败**。
  const first = await stopCommand("ports15", SERVICE_COMMAND_ID, {
    script: `kill -9 ${failPid}; exit 1`, cwd, timeoutMs: 5_000,
  }, { portGraceMs: 300 });
  assert.equal(first.status, 502, "脚本失败就得如实报失败");
  await waitFor("监听者已经被那条脚本收掉", () => !alive(failPid));
  assert.ok(alive(failWorkerPid), "那个工人还活着 —— 它正是这一趟该被记下来的东西");
  // 修复前这里是 null:stop.kind 还是 none,发现跟着 502 那个 return 一起丢了。
  assert.deepEqual(leftoversOf("ports15"), [failWorkerPid], "失败出口也必须先落账");

  // 第二趟:端口这会儿已经空了,照相照不到任何人 —— 只看这一趟的话结论就是「干净」。
  // 账是单调的:上一趟记下的责任还活着,所以这次仍然不许报停净(E1 的后半)。
  const again = await stopCommand("ports15", SERVICE_COMMAND_ID, {
    script: "exit 0", cwd, timeoutMs: 5_000,
  }, { portGraceMs: 300 });
  assert.equal(again.status, 200);
  const againBody = again.body as { stopped: boolean; unresolved?: number[]; notice?: string };
  assert.deepEqual(againBody.unresolved, [failWorkerPid], "上一趟的责任还活着,这次不许说干净");
  assert.deepEqual(leftoversOf("ports15"), [failWorkerPid], "刷新回来还看得见");
  process.kill(failWorkerPid, "SIGKILL");
  strays.delete(failPid);
  strays.delete(failWorkerPid);


  console.log("service ports stop-script test passed");
} finally {
  cleanup();
}
