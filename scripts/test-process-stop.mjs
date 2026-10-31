// ── 收场:一次 `stop()` 的全过程,以及最后那份「到底清没清干净」的结论 ──────────────────
//
// 从 test-process-scope.mjs 拆出来的一半。那边答的是**谁在、是谁的**(所有权与枚举),这边答
// **怎么收**:按什么顺序下刀、每一刀的绑定从哪来、等几拍、哪些情况必须失败。两件事的判据不
// 一样 —— 所有权可以靠「取样那一刻」的证据下结论,破坏性操作不行(见 test-process-terminate.mjs
// 文件头)—— 混在一个文件里读起来总会把两套尺子串线。
//
// 入口只有两个,都挂在 `TestProcessScope` 上转发:
//   · `stopScope(scope)` —— 异步的正道。
//   · `strikeBoundSync(scope)` —— 退出钩子专用:事件循环已经停了,只能同步。
//
// 这里只用 scope 的**公开**面(`directory` / `children` / `creator` / `started` / `unverified` /
// `unbindable` / `records()` / `active()` / `inspect()`),所以两个文件的边界是一份接口,不是
// 「把代码搬开」而已。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { windowsTerminateScript } from "./windows-restart.mjs";
import { CLOCK_SLACK_MS, fileTime, powerShell } from "./test-process-probe.mjs";
import { delay, delaySync, handleAlive, requestQuit, terminateBound } from "./test-process-terminate.mjs";

const windows = process.platform === "win32";

/**
 * **这一行的绑定从哪来** —— 答案只有三种,一种都没有就返回 `null`(于是一个信号都不发)。
 * 理由与「为什么不能按号码发」写在 test-process-terminate.mjs 文件头。
 *
 * 顺序是**从硬到软**:自己的活句柄 → 被活组长钉住的整组 → 它自己的自退通道。
 * `quitable` 由调用方一次算好(读一遍登记),别在循环里重复读目录。
 *
 * 清理助手(另一个进程拿已有目录重建 scope)手上**没有任何句柄**,所以它只剩自退通道这一条
 * —— 这正是「detached 的 Node 后代」在那条路径上唯一绑得住的办法,也是为什么自退通道必须是
 * 一张写在域目录里的纸条、而不是一条只有创建者才握得住的连接。
 */
function bindingFor(scope, row, quitable) {
  const live = scope.children.filter((child) => handleAlive(child));
  const own = live.find((child) => child.pid === row.pid);
  if (own) return { kind: "handle", child: own };
  const leader = live.find((child) => child.pid === row.group);
  if (leader) return { kind: "group", leader };
  if (quitable.has(row.pid)) return { kind: "quit", directory: scope.directory, pid: row.pid };
  return null;
}

/**
 * **退出钩子专用:趁手上还握着句柄,把绑得住的那些同步带走。**
 *
 * 清理助手是**另一个进程**:本进程一退,这些孩子的句柄就随之消失,助手那边**永远绑不住**
 * 它们(它既没有句柄、也没有被活组长钉住的组号)。所以这一下必须在这儿做 —— 这是最后一个
 * 「绑定还在手上」的时刻(第 6 轮审查 F1)。
 *
 * 顺序同 `stop()`:先递纸条让每一层用自己的句柄把自己那一层带走,等一拍,再按句柄 + 整组
 * 补刀。等待只能同步(事件循环已经停了)。
 */
export function strikeBoundSync(scope) {
  if (!windows) {
    let asked = false;
    for (const record of scope.records()) {
      if (record.quit !== true || record.pid === process.pid || record.pid === scope.creator) continue;
      if (requestQuit(scope.directory, record.pid).ok) asked = true;
    }
    if (asked) delaySync(120);
  }
  for (const child of scope.children) {
    if (!handleAlive(child)) continue;
    terminateBound({ kind: "handle", child }, { force: true });
    if (!windows) terminateBound({ kind: "group", leader: child }, { force: true });
  }
}

/**
 * 收场的全过程。失败时抛 `AggregateError`,顶层那一句自带每条理由(调用方常常只拼
 * `error.message`)。
 */
export async function stopScope(scope) {
  const errors = [];
  /** 上一轮里**有没有任何一行是绑得住的**。一行都没有就不必再转圈(见下面那个循环)。 */
  let actionable = false;
  const attempt = async (operation) => {
    try { return await operation(); }
    catch (error) { errors.push(error); return []; }
  };
  /**
   * 按**绑定**终止一批行。POSIX 上一个号码都不直接发信号 —— 每一行先问「这一下的绑定从哪来」
   * (`bindingFor`),三条绑定见 test-process-terminate.mjs 文件头;一条都拿不出来就**不动手**,
   * 号码记进 `unbindable` 由本函数结尾如实报出来。返回**没能核对实例身份**的那些号码
   * (Windows 专用:那边句柄说「代次对不上」)。
   */
  const terminateRows = async (rows, force) => {
    if (!windows) {
      const quitable = new Set(scope.records().filter((record) => record.quit === true).map((record) => record.pid));
      actionable = false;
      for (const row of rows) {
        const binding = bindingFor(scope, row, quitable);
        if (binding) actionable = true;
        const shot = terminateBound(binding, { force });
        if (shot.error) errors.push(shot.error);
        if (!shot.sent && !shot.requested) scope.unbindable.push(row.pid);
      }
      return [];
    }
    // 句柄 + GetProcessTimes 代次核对,和生产重启同一套(scripts/windows-restart.mjs)。
    // 不用 `taskkill /T`:它在执行那一刻重新展开进程树,杀的可能是我们查完之后才挂上去
    // 的、别人的进程。
    //
    // **整批一次**,代次对不上的那几个由那段脚本自己跳过并报号码(`tolerant`)。两件事都要:
    // 起一个 powershell 要 ~400ms,一行一个串着跑,第一刀就落到 2s 开外,而被判死的后代多活
    // 一拍就多写一次文件(真机实测:`test-test-process` 从超时到那次写只留了不到 1s,串行
    // 那一版它写出来了);而默认那种「任一代次对不上就整批抛」,会让一个号码换了主人的旧行
    // 把其余真该停的一起拦下。
    const targets = rows.filter((row) => row.created);
    const unverified = rows.filter((row) => !row.created).map((row) => row.pid);
    if (targets.length) {
      try {
        const output = await powerShell(windowsTerminateScript(targets, { tolerant: true }));
        // 跳过的那些:这个号码在查到和动手之间换了主人,不是我们的那一个。不杀,记一笔。
        for (const line of output.split("\n")) {
          const skipped = /^ASH_RESTART_SKIPPED (\d+)/.exec(line.trim());
          if (skipped) unverified.push(Number(skipped[1]));
        }
      } catch (error) { errors.push(error); }
    }
    return unverified;
  };
  const terminate = async (rows, force) => {
    scope.unverified.push(...await terminateRows(rows, force));
  };

  await attempt(() => writeFileSync(join(scope.directory, "stopped"), ""));
  // ── 先让有自退通道的那些自己收场(**顺序要紧**)────────────────────────────────
  // 纸条要排在下面那一刀**前面**:收到纸条的那一层会先用自己手上的句柄把它自己的孩子带走
  // (preload 的 `takeChildrenDown` —— 那是「detached 之后另起一组」「卡死读不到纸条」这两种
  // 后代唯一绑得住的终止能力)。反过来先按句柄把这一层打掉,它就没机会往下传,它的后代从此
  // 谁也绑不住,只能报「无法安全终止」—— 清场能力会白白掉一大块(第 6 轮审查 F1)。
  if (!windows) {
    for (const record of scope.records()) {
      if (record.quit !== true || record.pid === process.pid || record.pid === scope.creator) continue;
      const asked = requestQuit(scope.directory, record.pid);
      if (!asked.ok) errors.push(asked.error);
    }
    // 给它们一拍:轮询 50ms 一次,这一拍够它读到纸条、把自己那一层带走、再自己退。
    await delay(120);
  }
  // ── 先砍一刀 ────────────────────────────────────────────────────────────────
  // 枚举全表是要花时间的(Windows 上起一个 powershell 查 WMI,实测 ~600ms),而**清场慢一拍,
  // 被判死的后代就多出一拍去写文件**。所以在枚举之前先用**不花钱的证据**砍一刀:
  //  · POSIX:整组发信号。句柄还没回收 ⇒ 这个号码不可能被复用,所以整组是安全的 ——
  //    也只有这一处敢按组号发。
  //  · Windows:
  //     - 我们自己 spawn 的那一层按**句柄**杀。`child.kill()` 用的是 spawn 时拿到的那个句柄,
  //       根本不经过号码,比按号码杀更硬;
  //     - 它们的后代按**登记**杀。号码来自本域的登记文件(本地读,零开销),实例身份当场
  //       核(test-process-scope.mjs 的 `#impostor`:出生时刻必须落在「本域创建」到「它登记那一刻」之间,一个号码被
  //       复用的陌生进程落不进这个区间)。
  //
  // **Windows 这儿原先走 `taskkill /T /F`,已经去掉**(第 4 轮审查 F1 同类)。当时的理由是
  // 「句柄没回收 ⇒ 这个号码不会被复用 ⇒ 展开出来的那棵树一定是我们的」,可那只固定了**根**的
  // 身份:`/T` 在执行那一刻按 ppid 重新展开整棵树,而 Windows 的 ppid 在父进程死后仍然留着
  // 旧号码 —— 一个号码被复用的中间节点就能把别人的进程挂进这棵树。换成上面这两条之后,砍下去
  // 的每一个都是自己证明得出来的,「及时」和「不误杀」不必二选一。
  for (const child of scope.children) {
    if (!handleAlive(child)) continue;
    // POSIX:整组一刀。组长就是这个孩子(本层 spawn 一律 detached),它的句柄还活着 ⇒ 组号
    // 不可能被复用 —— 这一刀覆盖它底下所有没自己 setsid 过的后代,包括非 Node 的那些。
    const shot = terminateBound(windows ? { kind: "handle", child } : { kind: "group", leader: child }, { force: windows });
    if (shot.error) errors.push(shot.error);
  }
  if (windows) {
    await attempt(() => terminateRows(scope.records()
      .filter((record) => record.pid !== process.pid && Number.isFinite(record.at))
      // 代次核成**区间**:这正是 `#impostor` 那条判据,换成句柄那头看得懂的尺子交过去 ——
      // 于是不必先起一个 powershell 查一遍进程表拿代次,这一刀只花一次。跳过的号码不往
      // `unverified` 里记:号码换了主人就本来不是我们的,后面的 `active()` 也不会认领它。
      // 上界就是 `record.at` 本身,**不加容差**(第 1 轮审查 F5):登记必然晚于出生,所以
      // 真正属于我们的那一个落在区间里;而加一秒等于把「登记之后一秒内出生的复用实例」也收
      // 进来。这样这个区间和 `#impostor` 的判据一个字都不差 —— 同一条判据不许有两个尺子。
      .map((record) => ({ pid: record.pid, created: `${fileTime(scope.started - CLOCK_SLACK_MS)}-${fileTime(record.at)}` })), true));
  }
  // 下面这一段是**凭据**:前面那一刀只覆盖得到自己登记过的(非 Node 的后代不执行 preload),
  // 全表枚举才认得出靠父子链挂着的那些,而「还有没有活的」这个结论只能由它来下。
  let active = [];
  if (!windows) {
    // POSIX 先温和一轮:上面整组发的是 SIGTERM,这儿再按绑定补一次(该请自退的也在这一轮
    // 递出纸条),给它们机会自己收场。
    await terminate(await attempt(() => scope.active()), false);
    await delay(100);
  }
  // **自退那条路要给它几拍**:它是后代自己每 50ms 看一眼纸条、然后自己退(见
  // test-process-terminate.mjs ③),不像信号那样当场生效。信号能覆盖的那些照旧一轮就没了,
  // 这个循环在它们身上第一次复查就退出,不多花时间;而多等这几拍,换来的是不必拿号码去赌。
  const rounds = windows ? 3 : 12;
  for (let round = 0; round < rounds; round++) {
    try { active = await scope.active(); }
    catch (error) { errors.push(error); break; }
    if (!active.length) break;
    // 绑不住的那些每一轮都会往 `unbindable` 里记一笔,结尾去重后只报一次号码。
    await terminate(active, true);
    // **一行都绑不住就别再转圈了**:再转十轮也还是一刀都不会发(第 6 轮审查 F1),白等几秒
    // 不如早点把结论交给下面那段如实报出来。绑得住的那些(尤其是等自退的)照旧多等几拍。
    if (!windows && !actionable) break;
    await delay(windows ? 50 : 60);
  }
  // 最后这一次用 `inspect`:除了「还有没有活的」,**形态违规也要落在清理结论里** —— 一个把
  // 边界丢掉的进程若还活着,它的后代本层监管不到,这时候的「扫不到」证明不了清场(文件头)。
  const final = await attempt(() => scope.inspect());
  active = Array.isArray(final) ? final : final.rows;
  if (active.length) errors.push(new Error(`测试进程未清场: ${active.map((row) => row.pid).join(",")}`));
  if (!Array.isArray(final) && final.escaped.length) {
    errors.push(new Error(`这些进程已经不持有本域的边界描述符，它们的后代本层监管不到: ${final.escaped.join(",")}`));
  }
  if (scope.unverified.length) {
    errors.push(new Error(`无法核验实例身份,未终止: ${[...new Set(scope.unverified)].join(",")}`));
  }
  if (scope.unbindable.length) {
    // 还活着、而本层绑不住 ⇒ **没发任何信号**,如实说「没终止」。调用方(测试)据此失败,
    // 而不是让一次按号码的赌博把这句话变成「已清场」(第 6 轮审查 F1)。
    errors.push(new Error(`这些进程本层无法安全终止（没有活句柄、不在被钉住的组里、也没有自退通道），一个信号都没发: ${[...new Set(scope.unbindable)].join(",")}`));
  }
  // 理由也要进**顶层那一句**:嵌套 error 只在堆栈里展开,而调用方(和它的报告)常常只拼
  // `error.message` —— 「清理失败」三个字说不出是没清干净、还是绑不住没敢动手(第 6 轮审查 F1
  // 要求把「未终止/无法安全终止」交回调用方,交回的得是**看得见**的那一份)。
  if (errors.length) {
    throw Object.assign(
      new AggregateError(errors, `测试执行域清理失败: ${scope.directory}\n${errors.map((error) => error.message).join("\n")}`),
      { directory: scope.directory },
    );
  }
}
