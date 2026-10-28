/**
 * 用户自己配的那条**停止命令**:怎么跑、怎么保证它在时限内落地、超时怎么连它拉起的东西一起
 * 收掉。从 terminal-commands.ts 拆出来(那份文件顶到了项目 700 行的上限),这一段跟会话表、
 * 端口归属、落账全没有耦合 —— 它只回答一件事:**那段脚本跑成了没有**。
 *
 * 「跑成了」不等于「服务停了」:终态核验在 terminal-commands.ts 的 verifyStopScript
 * (一条 `true` 也会 exit 0)。这里只负责不说谎话 —— 超时就说超时,杀没杀净照实报。
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { IS_WINDOWS } from "./platform.js";
import { groupAlive } from "./terminal-process-tree.js";
import { openConfinement, type Confinement } from "./executors/kernel-confine.js";
import { commandLaunch } from "./terminal-shell.js";
import { id } from "./util.js";

/** 停止脚本的两路输出各留这么多,够回显最后几行就行(自己截,不靠 execFile 的 maxBuffer)。 */
const STOP_OUTPUT_KEEP = 64 * 1024;

/**
 * PowerShell 的 stderr 被重定向时写的不是人话,是 CLIXML:开头一行 `#< CLIXML`,后面整坨
 * `<Objs>` XML。原样塞进给用户看的那句话里就成了「已经一起杀掉：#< CLIXML」(真机
 * 192.168.1.187 实测)。把真正的错误文字(`<S S="Error">…</S>`)抽出来,抽不到就当它没说话。
 */
function plainStderr(err: string): string {
  if (!err.includes("#< CLIXML")) return err;
  const said = [...err.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
    .map((match) => match[1].replaceAll("_x000D__x000A_", "\n").replaceAll(/&[a-z]+;/g, " ").trim())
    .filter(Boolean);
  return said.join("\n");
}

/** 停止脚本失败时给用户看的那几行:有 stderr 就说 stderr,只留最后 3 行、封顶 300 字。 */
function outputTail(out: string, err: string): string {
  const said = plainStderr(err);
  const tail = (said.trim() ? said : out)
    .split("\n").map((line) => line.trim()).filter(Boolean).slice(-3).join(" / ");
  return tail.length > 300 ? `${tail.slice(0, 299)}…` : tail;
}

const runFile = promisify(execFile);
/** 超时收尾后核验残留的时限:只是读一眼,别让它反过来把那把命令锁又占住。 */
const CLEANUP_VERIFY_MS = 5_000;

/**
 * 超时那一发,打在**整次运行**上,而不是那层壳上。
 *
 * POSIX:spawn 时 `detached` 起的独立进程组,`kill(-pid)` 覆盖它拉起的一切。
 *
 * Windows 没有进程组,单发 `child.kill()` 只杀得到 PowerShell 这层壳 —— 它正在跑的原生
 * 清理程序(docker.exe 之类)会活下来,稍后还可能把用户刚重启的服务关掉,而那一刻我们已经
 * 释放了命令锁、还跟用户说「已经一起杀掉了」(第 1 轮审查发现 4;真机 192.168.1.187 实测:
 * 壳 11608 退了、它的子程序 880 仍存活)。那边两层一起上,**顺序要紧**:
 *   ① `taskkill /T /F` **先**打:`/T` 是按 ppid 树走的,树根必须**还枚举得到**。反过来先
 *      整圈下刀,根当场就没了,这一发就只剩「找不到 PID」,逃出圈的后代谁也不收
 *      (第 2 轮审查发现 3 真机实测:根 14192 先被圈刀收掉,随后 taskkill 找不到根,
 *      圈前出生的后代 27144 活下来,而读数照旧是「集合为空」);
 *   ② **内核圈定**(executors/kernel-confine.ts 的 Job Object)补刀:ppid 树断掉的那一类
 *      (Start-Process 之后根先退、或者被 reparent)由它按内核记下的归属收。
 *
 * 然后**核验**:圈里还有成员、进程组还活着、或者**这一问本来就答不全**,都如实说出来。
 */
async function killScriptRun(child: ChildProcess, confine: Confinement | null): Promise<string> {
  const pid = child.pid;
  if (!IS_WINDOWS) {
    try { if (pid !== undefined) process.kill(-pid, "SIGKILL"); else child.kill("SIGKILL"); }
    catch { try { child.kill("SIGKILL"); } catch { /* 已经没了 */ } }
  } else {
    // ① 树根还活着的时候走 ppid 树。退非零有两种:进程已经没了(128),或者这一发没打出去
    // —— 后者要留着说,吞掉等于把一次失败做成静默。
    let treeFailed: string | null = null;
    if (pid !== undefined) {
      treeFailed = await runFile("taskkill", ["/T", "/F", "/PID", String(pid)], { timeout: CLEANUP_VERIFY_MS, windowsHide: true })
        .then(() => null)
        .catch((error: { code?: unknown; stderr?: string }) =>
          error.code === 128 ? null : `taskkill 没能按进程树收掉它（${(error.stderr ?? "").trim() || `退出码 ${String(error.code)}`}）`);
    }
    // ② 逃出 ppid 树的那一类交给圈。
    confine?.killAll("SIGKILL");
    try { child.kill("SIGKILL"); } catch { /* 已经没了 */ }
    const residue = await verifyScriptGone(child, confine);
    confine?.dispose();
    const left = [treeFailed, residue].filter(Boolean).join("；");
    return left
      ? `已经发了强杀，但${left} —— 它可能还在后台动作，必要时去系统里确认一下`
      : "已经把它和它拉起的进程一起杀掉";
  }
  const residue = await verifyScriptGone(child, confine);
  confine?.dispose();
  return residue
    ? `已经发了强杀，但${residue} —— 它可能还在后台动作，必要时去系统里确认一下`
    : "已经把它和它拉起的进程一起杀掉";
}

/**
 * 残留核验:有就返回一句人话,没有返回 null。「问不出来」不算没有,如实说问不出来。
 *
 * 两个平台手里的证据不一样。POSIX 有进程组,`groupAlive` 直接问内核;**Windows 一条都没有**
 * —— `groupAlive`/`readProcessTableSync` 在那边全是短路,唯一的来源就是 Job Object。
 *
 * 而圈的空集合**不能无条件当成「整次运行为空」**:`ConfineRead.coverage` 写明了这一问覆盖
 * 到哪儿(kernel-confine.ts 顶部),`since-enroll` 只覆盖 assign **之后**出生的后代 ——
 * 圈定那一笔是 spawn 之后才写的,它之前出生的后代从头到尾没进过集合,集合空也证明不了
 * 它们没了(第 2 轮审查发现 3 真机实测:圈前出生的 27144 活着,读数仍是空集合)。
 * `executors/cleanup-result.ts` 的 `confinedResidue` 早就是这么判的 —— 只有 `whole-run`
 * 才许从空集合推出「扫净」。新调用者不能从旁边绕过同一条契约。
 *
 * Windows 上 `preExecEnv()` 返回 null(那条路只有 cgroup 有),所以那边**永远拿不到
 * whole-run**:如实说清这一问覆盖到哪儿,而不是把 since-enroll 的空当成全净。
 */
async function verifyScriptGone(child: ChildProcess, confine: Confinement | null): Promise<string | null> {
  const deadline = Date.now() + CLEANUP_VERIFY_MS;
  for (;;) {
    const read = confine?.read();
    const members = read?.kind === "members" ? read.members.length : 0;
    const groupLeft = !IS_WINDOWS && child.pid !== undefined && groupAlive(child.pid);
    if (!members && !groupLeft) {
      if (read?.kind === "unqueryable") return `核不出它是不是真的清空了（${read.why}）`;
      // POSIX 的权威证据是进程组(上面的 groupLeft 已经问过内核),圈只是加一台设备。
      if (!IS_WINDOWS) return null;
      // Windows 只剩圈这一个来源,于是空集合必须连着 coverage 一起用。
      if (read?.kind !== "members") {
        return "这次没圈起来（Job Object 不可用），只按 ppid 树杀过一遍 —— 脱离了父子关系的后代核不到";
      }
      if (read.coverage !== "whole-run") {
        return "圈只覆盖到圈定之后出生的那些（这台平台拿不到全程覆盖），圈前就脱离父子关系的后代核不到";
      }
      return null;
    }
    if (Date.now() >= deadline) {
      return members ? `圈里还剩 ${members} 个进程没退` : "它的进程组里还有人活着";
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * 跑用户配置的停止命令,**保证在时限内落地**。方言跟启动同一套(commandLaunch:POSIX 是
 * `shell -lc`,Windows 是 PowerShell `-EncodedCommand`),但**不开 pty、不建会话**:停止没有
 * 「现场」可看,它只有成或不成 —— 新开一条会话只会搅乱会话表(那边按 commandId 认人),
 * 失败时把最后几行输出带回去就够。
 *
 * 自己计时、自己收敛,**不能用 execFile 的 timeout**:那一档到点只补发一次 SIGTERM,脚本
 * 写了 `trap '' TERM` 就彻底拖住 —— 回调绑在 stdio 的 close 上,promise 永不落地,外面那把
 * withCommandLock 跟着永远不释放,这条命令的启停全部排队到死(第 1 轮审查 E2 实锤)。
 * 同理只等 `exit`、不等 `close`:脚本把服务拉到后台、子进程继承了管道时,close 要等那个
 * 后台进程也退出才来(E3),而「停止脚本跑完了」说的是**脚本自己**退了。
 * 到点那一发打在**整次运行**上(killScriptRun:POSIX 是整个进程组,Windows 是 Job Object +
 * taskkill /T),否则只杀掉 shell、它拉起的东西继续跑;杀完**核验一眼残留**再落地,核验自带
 * 5 秒上限 —— 既不嘴硬说「已经一起杀掉了」,也不让那把锁跟着一起卡死。不等它的 exit:
 * 万一它卡在不可中断的系统调用里,exit 可能永远不来。
 */
export function runStopScript(cwd: string, script: string, timeoutMs: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  type Result = { ok: true } | { ok: false; reason: string };
  let launch: { shell: string; args: string[] };
  try { launch = commandLaunch(script); }
  catch (error) { return Promise.resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) }); }
  return new Promise<Result>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(launch.shell, launch.args, {
        cwd,
        detached: !IS_WINDOWS, // 独立进程组:超时要连它拉起的东西一起收掉
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, reason: `停止命令跑不起来（${error instanceof Error ? error.message : String(error)}）` });
      return;
    }
    // 圈定只在 Windows 用:POSIX 那边 detached 起的进程组本身就是内核级的容器,而这台设备
    // 在 macOS 上没有等价物(openConfinement 会返回 null 并打一句弃权)。
    const confine = IS_WINDOWS && child.pid !== undefined ? openConfinement(`ash-stop-${id()}`) : null;
    if (child.pid !== undefined) confine?.enroll(child.pid);
    let out = "";
    let err = "";
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: Result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(result);
    };
    const fail = (why: string) => {
      const tail = outputTail(out, err);
      settle({ ok: false, reason: tail ? `${why}：${tail}` : why });
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (text: string) => { out = (out + text).slice(-STOP_OUTPUT_KEEP); });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => { err = (err + text).slice(-STOP_OUTPUT_KEEP); });
    child.on("error", (error) => fail(`停止命令跑不起来（${error.message}）`));
    child.on("exit", (code, signal) => {
      // 超时那一路已经在收尾了:它要等残留核验完才落地,这里别抢着把结论写成「被信号中断」。
      if (timedOut) return;
      confine?.dispose();
      if (code === 0) { settle({ ok: true }); return; }
      fail(code === null ? `停止命令被信号 ${signal} 中断` : `停止命令退出码 ${code}`);
    });
    timer = setTimeout(() => {
      timedOut = true;
      void killScriptRun(child, confine).then((cleanup) => {
        fail(`停止命令超过 ${Math.round(timeoutMs / 1000)} 秒还没结束，${cleanup}`);
      });
    }, timeoutMs);
  });
}
