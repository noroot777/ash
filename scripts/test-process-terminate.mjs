// ── 终止:**这一层唯一的下刀口,而且只有内核钉得住的绑定才算刀** ──────────────────────
//
// 判据一句话:**号码不是身份,所以号码不能授权破坏性操作。**
//
// 上一版的形状是「先读一次出生时刻核对身份,紧接着 `process.kill(号码)`」。它有两个关不掉的
// 口子(第 6 轮审查 F1):
//
//   · **核与发之间那截窗口**。同步 JS 只消掉了事件循环层的插队,内核照样可以在这两步之间让
//     原进程退出、把号码交给另一个程序,那一刀就落在陌生人身上。发完再核一次只能**事后**说
//     一句「可能打错了」,撤不回已经发出去的信号;而且后一次读到「它不在了」时,「被我们杀掉」
//     和「它自己先退了、号码还空着」长得一模一样,这一档压根分不出来。
//   · **macOS 的尺子只有秒**(`ps -o lstart=`)。同一秒内退出又被复用的那一个,**第一次核验
//     就已经认成原实例了** —— 窗口再怎么压都救不回来,因为错在尺子上。
//
// 缩短窗口、事后报告都是**诊断**,不是安全证明。所以这一版把能力面收成下面三条,每一条都
// 说得出「为什么这一下不可能落在陌生人身上」;三条都拿不出来的目标**一律不动手**,如实交回
// 调用方(`"unbindable"`),由它报成「未终止 / 无法安全终止」。
//
//   ① **句柄**(`handle`)—— 我们自己 spawn 的那一层。子进程被收尸之前内核不会把号码交给
//      别人(僵尸占着它),而 Node 的 `child.kill()` 在句柄回收之后**根本不发信号**(`_handle`
//      没了就直接返回 false)。于是「手上这个句柄还活着」本身就是实例证明,发信号与证明在
//      同一个对象上,没有窗口。
//   ② **被组长钉住的整组**(`group`)—— 组长就是 ① 那种孩子(本层 spawn 时一律 `detached`,
//      所以它自己就是组长)。它没被收尸 ⇒ 它的号码不会被回收 ⇒ **组号就是它的号码**,这个
//      组号也不可能被复用。`kill(-组号)` 一次覆盖它底下所有没自己 setsid 过的后代,同样没有
//      窗口。这是非 Node 后代唯一的绑定来源。
//   ③ **自退通道**(`quit`)—— 覆盖「`detached` 之后自己另起一组」的那种 Node 后代,而它压根
//      不是下刀:我们只在执行域目录里写下 `<号码>.quit`,**是它自己读到之后自己退的**(登记
//      preload 里那个轮询,见 test-process-register.cjs)。一个号码被复用的陌生进程不会去读
//      我们的域目录、更不会因此退出 —— 这条路连误伤的可能都没有。代价要说清:它**只对装了
//      preload 的 Node 后代成立**,而且是**请求**而非保证(进程卡死就读不到),所以「请了没退」
//      必须如实报,不许算成已经停了。
//
// Windows 不走这三条:那边 `OpenProcess` 的句柄本身钉住实例,代次核对(GetProcessTimes)与
// `TerminateProcess` 在**同一个句柄**上做(scripts/windows-restart.mjs),本来就没有这个窗口 ——
// 所以那一侧的路径留在 test-process-scope.mjs 里,不进这个文件。
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 「等几拍」。放在这一层是因为它是**下刀的一部分**:自退通道那一条是「写张纸条请它自己退」,
 * 请完必须给它时间读到并退掉,不然「请了没退」会被当成「没绑住」。
 */
export const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

/** 退出钩子里唯一能用的「等一会儿」:事件循环这时候已经不转了,只能同步阻塞。 */
export const delaySync = (milliseconds) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); };

/** 自退请求的文件名。per-pid 而不是整域一个开关:保留进程(`preserveScripts`)不能被连带带走。 */
export const quitFileName = (pid) => `${pid}.quit`;

/**
 * 句柄还活着吗 —— 这里的「活着」是**还没被收尸**(`exitCode`/`signalCode` 都还没落),
 * 而那正是「这个号码此刻不可能属于别人」的条件本身(见文件头 ①)。
 */
export function handleAlive(child) {
  return !!child?.pid && child.exitCode === null && child.signalCode === null;
}

/**
 * 请它自己退(③)。**同步**,所以退出钩子里也用得上;写不进去要如实回报,不许静默。
 * 内容带上时刻:preload 只认**自己登记之后**写下的那一份,于是目录里一张过期的 `.quit`
 * 不会让一个碰巧拿到同号码的新后代一上来就退。
 */
export function requestQuit(directory, pid) {
  try {
    writeFileSync(join(directory, quitFileName(pid)), JSON.stringify({ at: Date.now() }));
    return { ok: true };
  } catch (error) { return { ok: false, error }; }
}

/**
 * **按绑定终止**。`binding` 只能是文件头那三种之一:
 *   · `{ kind: "handle", child }`
 *   · `{ kind: "group", leader }`
 *   · `{ kind: "quit", directory, pid }`
 * 其余一切(包括 `null`)都落到 `"unbindable"`:**不发任何信号**。
 *
 * 返回 `{ kind, sent, requested, why, error }` —— `sent` 是「真的发了一刀」,`requested` 是
 * 「请它自己退了」。两者都为假时 `why` 说清为什么没动手,调用方据此报「未终止」。
 */
export function terminateBound(binding, { force = true } = {}) {
  const signalName = force ? "SIGKILL" : "SIGTERM";
  if (!binding) return { kind: "unbindable", sent: false, requested: false, why: "绑不住这个实例（见 scripts/test-process-terminate.mjs 文件头），未终止" };
  if (binding.kind === "handle") {
    // 句柄已回收 = 它已经退了(回收的前提就是收尸)。这不是失败,也不该再去碰那个号码。
    if (!handleAlive(binding.child)) return { kind: "handle", sent: false, requested: false, why: "句柄已回收，它已经结束了" };
    try { binding.child.kill(signalName); }
    catch (error) { return { kind: "handle", sent: false, requested: false, error }; }
    return { kind: "handle", sent: true, requested: false };
  }
  if (binding.kind === "group") {
    // 组长句柄一回收,组号就不再被钉住 —— 从这一刻起这一组整体失去绑定,宁可不发。
    if (!handleAlive(binding.leader)) return { kind: "group", sent: false, requested: false, why: "组长句柄已回收，组号不再被钉住" };
    try { process.kill(-binding.leader.pid, signalName); }
    catch (error) {
      // 组里一个都不剩了:预期结果,不是失败。
      if (error.code !== "ESRCH") return { kind: "group", sent: false, requested: false, error };
    }
    return { kind: "group", sent: true, requested: false };
  }
  if (binding.kind === "quit") {
    const written = requestQuit(binding.directory, binding.pid);
    return {
      kind: "quit", sent: false, requested: written.ok, error: written.error,
      why: written.ok ? undefined : "自退请求写不进去，未终止",
    };
  }
  return { kind: "unbindable", sent: false, requested: false, why: `未知的绑定种类 ${binding.kind}，未终止` };
}
