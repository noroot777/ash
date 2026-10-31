// ── 测试执行域:一次 runTestProcess 创建的全部进程,以及「它们真的都停了」这个证明 ──────
//
// 这一层只回答两个问题,两个都不许靠猜:
//   ① **谁是我们创建的**(所有权)。
//   ② **它们是不是都停了**(退出证明)。扫不到 ≠ 停了 —— 把一次空扫描当成清场,正是
//      「测试显示成功、磁盘上还在写」那个形状的根子。
//
// ## 所有权:只认**来源可证明**的那几条线索
//
//   · **登记**(preload 写 `<pid>.*.json`):只覆盖 Node 进程。非 Node 程序自己 fork 出来
//     的后代不执行 preload,登记里没有它。
//   · **父子链**:后代 setsid + 原父退出之后在 POSIX 上被挂到 1 号进程,链断了。
//     (Windows 没有这套语义:ppid 字段在父进程死后仍然保留,链还在。)
//   · **进程组**:setsid 会换组,同样断;而且组号会被复用,所以**只在组长本身证明得出是我们的**
//     时候才认(见 `active`)。
//   · **边界描述符**(POSIX):每个 spawn 出来的进程都继承一个指向本域边界 inode 的 fd。
//     那个 inode **一建出来就 unlink 掉**,于是它在文件系统里没有名字 —— 想持有它只有一条路:
//     从本域继承(或者由本域经 unix socket 递过去,而这一层不做这件事)。判据是内核里的
//     (设备号, inode 号) 这对事实,不是文本,所以既伪造不了,也不随 exec / setsid / 重新挂父而丢。
//
//     **为什么非得 unlink**(第 2 轮审查第 4 条):上一版那个 boundary 是个普通的具名文件,
//     于是「谁打开着同一个路径」被当成了来源证明 —— 同用户的域外程序(看一眼这次检查的临时
//     文件的诊断工具就够了)自己 open 一下就会被 `owned.add` 收养,随后被 `stop()` 终止。
//     「继承了受监管资源」和「碰巧打开同一个文件」是两件事,而没有名字的 inode 只剩前一种。
//
// 上一版的第四条线索是**环境变量继承**(`ASH_TEST_PROCESS_SCOPE`),两处都塌了(第 4 轮审查
// F1/F2,都有实测):
//   · **它伪造得了**:判据是 `ps -E` 那一整行 `includes(标记)`,而那一行是「命令行 + 环境块」
//     拼起来的 —— 随便一个把这段文字当**普通 argv 参数**传进去的外部进程都会被认领,然后被
//     `stop()` 终止(探针实测:`adopted:true`、`outsiderAliveAfterScopeStop:false`)。
//   · **它丢得了,而且恰恰在它本来要覆盖的那一种上丢**:原生后代走 `execve(…, {})`,环境被
//     整个清空。实测那个 fork+setsid 的后代环境段里**一个标记都没有** —— 补这条线索当年声称
//     覆盖的就是这一种,实际上一次都没覆盖到。
// 所以这一版:环境这条线索留着,但判据改成「标记出现在**环境段**里」(macOS 两张 `ps` 快照
// 一减就把环境段切出来;Linux 直接读 `/proc/<pid>/environ`,NUL 分隔、整段严格相等 ——
// 两个平台各一套实现,见 test-process-probe.mjs 的 `processRows`);而「不随 exec 丢」这件事
// 交给边界描述符。**整段两侧还要收口**(第 1 轮审查 F4:裸 `includes` 会让
// `…SCOPE=/tmp/x-other` 这个另一个域的真实环境把 `/tmp/x` 的标记整段包住,于是一域的 `stop()`
// 去终止另一域正在用的进程),判据与残留见 test-process-probe.mjs 的 `environmentHasMarker`。
//
// 「此刻系统里有些什么」全在 **test-process-probe.mjs** 答(ps / lsof / CIM 的输出怎么读、
// 实例身份怎么比),这个文件只下所有权与清场的判据。
//
// ## 支持形态,以及这一层到底证明了什么
//
// **先把话说准**:成功返回时这一层证明的是
//
//   「本域创建的进程里,**可观测**的那些都已经退出 —— 可观测 = 登记 / 父子链 / 进程组 /
//    环境段 / 边界 inode 这五条线索里还命中任意一条」,
//
// 不是「这一次绝对没有任何后代活着」。差别在于:一个后代可以**主动**把五条线索一条一条丢掉
// (关掉边界 fd、`execve(…, {})` 清环境、setsid 脱组、原父退出断链)。四条做完它就不在任何
// 一次枚举里了,而从普通 Node 进程能用的 POSIX 接口里**没有一个内核级的容器**(subreaper /
// cgroup / pidns / job object 都够不着),所以这种形态下「它不存在」这件事**谁也证明不出来**
// —— 既然证明不出来,就不许写成「清场成功」这四个字(第 2 轮审查第 1 条)。
//
// 于是这一层的规矩是:**限制支持形态 + 该失败的地方明确失败**。
//
//   · **不支持**主动丢弃监管资源的 daemon 形态(fork → setsid → 清环境 → 关掉继承的 fd)。
//     这不是「不许这么写测试」,而是「这么写的话本层答的只能是证明不了」。
//   · **不支持**用 `execFile`/`exec` 建出来的 Node 后代**再往下**的非 Node 后代:那两个入口
//     不转发 stdio(实测),边界交不到它手里,所以它的非 Node 后代五条线索全不命中。那个
//     Node 后代自己照旧认得出来(登记 + NODE_OPTIONS 一路继承),交没交到边界也如实记在登记
//     里(`boundary`),不靠猜 —— 见 test-process-register.cjs 那段 patch 的说明。
//   · 查不动(ps/CIM/lsof/proc 任一条答不出来)⇒ `survey()` 走 `ok:false` 失败路径,
//     绝不退化成「没有活的」。**扫不到不算停了**这条不变量没有例外。
//   · **丢边界这件事只要落在我们看得见的地方,就当场失败**:我们自己 spawn 的那一层,fd 是
//     本层亲手交到它手里的 —— 它还活着却不再持有,就是它自己关掉了,它的后代本层从此监管不到。
//     这时 `survey()` 同样走失败路径并点名那几个号码,而不是接着往「都停了」上走
//     (见 `#escapees`)。孙子辈再往下关掉的那一种落在上面那条「不支持」里,只能靠形态约束。
//
// ## 实例身份:pid 不是身份,(pid, 出生时刻) 才是
//
// 号码会被复用。所以每一行快照都带 `born`,登记也带时刻:号码对上但出生时刻对不上的,
// 是**另一个进程**,既不认它是我们的,更不会去杀它。终止前还要再核一次(POSIX 重读出生时刻
// —— Linux 读 `/proc/<pid>/stat`、macOS 问 `ps -p`;Windows 走句柄 + GetProcessTimes),
// **发完再核第三次**:POSIX 上「核对」和「发信号」之间那截窗口关不掉(拿不到 pidfd),所以
// 只能把它压到一次系统调用,再用发后那一次核对把「可能打在陌生人身上」如实报出来 ——
// 判据与上界写在 `signalInstance`,这一层只从那一个口下刀。
//
// **核不出来是第三种答案**,不许往「已经没了」上归(第 1 轮审查 F5):那一刀不发,号码照实
// 报进 `unverified`,由 `stop()` 失败。两次读数之间也**没有时间容差** —— 同一个进程的两次
// lstart 读的是内核里同一个值,相等就该严格相等;留一秒容差换来的只是「下一秒出生的复用实例
// 照旧算同一个」,然后对它发信号(判据见 test-process-probe.mjs 的 `instanceVerdict`)。
// 容差只在**两把不同尺子**之间才有意义:秒级的 `born` 对毫秒级的 `started`,见 `#impostor`。
import { spawn, spawnSync } from "node:child_process";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsTerminateScript } from "./windows-restart.mjs";
// 「此刻系统里有些什么」全在那边答(ps / lsof / CIM 的输出、实例身份的比较),这边只下所有权
// 与清场的判据 —— 两种问题分开,见 test-process-probe.mjs 文件头。
import {
  CLOCK_SLACK_MS, birthOf, boundaryHolders, fileTime, instanceVerdict, powerShell, powerShellSync,
  processRows,
} from "./test-process-probe.mjs";

const windows = process.platform === "win32";
const registerPath = fileURLToPath(new URL("test-process-register.cjs", import.meta.url));
const cleanupPath = fileURLToPath(new URL("test-process-cleanup.mjs", import.meta.url));
const scopes = new Set();
export const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));


/**
 * 边界 inode 的三个文件名。
 *  · `BOUNDARY` —— 建它的时候短暂用一下这个名字,`open` 完立刻 unlink,之后这个名字就不存在了
 *    (见文件头:有名字 = 域外程序自己 open 一下就能被收养);
 *  · `BOUNDARY_ID` —— 那个 inode 的身份 (dev, ino)。清理助手是**另一个进程**、而 inode 已经
 *    没有名字可打开,所以它只能靠这份身份去认持有者;
 *  · `CREATOR` —— 创建者自己的号码。它一直握着那个 fd(不握就没人钉住这个 inode,号码一被
 *    回收,别人家的未链接 inode 就可能撞上同一个号),所以它必然出现在持有者里 —— 清理助手
 *    得认得出「这是创建者,不是后代」,否则会把它当域内进程一刀 SIGTERM 掉(本轮实测过这条:
 *    `test:restart` 整套 rc=143)。
 */
/**
 * 登记文件名的形状:`<被登记 pid>.<发布者 pid>.json`(协议见 `publishRecord` 与
 * test-process-register.cjs)。执行域目录里还有别的东西,所以读登记只认这个形状。
 */
const REGISTRATION = /^\d+\.\d+\.json$/;

const BOUNDARY = "boundary";
const BOUNDARY_ID = "boundary.id";
const CREATOR = "creator.id";

/**
 * 发布一条登记。**每个发布者写自己的文件名**,两个发布者永远不会抢同一个目标 ——
 * 父进程的占位登记和子进程 preload 里的自登记原先都发布成 `<pid>.json`(一个用 link、
 * 一个用 rename),Windows 上替换一个别人刚建好/正被读取的文件会 EPERM,而那一下发生在
 * 用户代码跑起来之前,于是整套测试在启动阶段就中止(真机实测)。
 *
 * 名字里带发布者 pid 之后冲突从协议上消失;写临时文件再 rename 仍然保留,是为了让读取侧
 * 永远看不到半截 JSON。rename 的目标此刻必定不存在(或者就是本发布者自己上一次写的),
 * 所以 Windows 那条「替换别人的文件」的失败路径不再成立。
 */
export function publishRecord(directory, subjectPid, payload) {
  const target = join(directory, `${subjectPid}.${process.pid}.json`);
  const temporary = `${target}.pending`;
  writeFileSync(temporary, JSON.stringify(payload));
  try { renameSync(temporary, target); }
  finally { try { rmSync(temporary, { force: true }); } catch { /* rename 成功后它本来就没了 */ } }
}

/**
 * **同一个号码上现在那一个,还是当初观察到的那一个吗。** 四档,`"same"` 之外一个都不许动手
 * (第 1 轮审查 F5;前三档的判据在 test-process-probe.mjs 的 `instanceVerdict`):
 *
 *   · `"same"` —— 出生时刻一模一样,只有这一档能动手;
 *   · `"other"` —— 号码换了主人,它本来就不是我们的;
 *   · `"gone"` —— 查到了「它不在了」,不必动手;
 *   · `"unverifiable"` —— 当初没读出出生时刻,或者这一次**查不动**(ps 不在、超时、读不懂)。
 *     不动手,而且**要报出来** —— 把「我没核出来」算成「它已经没了」正是那个事故形状。
 *     (上一版把查不动归到 `"gone"` 里悄悄咽掉了,理由是最后那次 `inspect()` 会兜住;可那次
 *     兜得住的前提恰好是进程表查得动,成因相同的两处不能互相当兜底。)
 *
 * 别去 `ps` 问一遍再拿答案当「待验证身份」用:那样必然相等(上一版的 `row.born ?? born` 就是
 * 这个形状),等于不核。Windows 不走这一套:代次核对在句柄那头(见 `signalInstance`)。
 */
function verifyInstance(row) {
  if (windows) return "same";
  if (!Number.isFinite(row.born)) return "unverifiable";
  let observed;
  try { observed = birthOf(row.pid); }
  catch { return "unverifiable"; }
  return observed === "gone" ? "gone" : instanceVerdict(row.born, observed);
}

/**
 * **按实例发一刀** —— 这一层唯一的下刀口。`row` 必须带当初观察到的身份:POSIX 是 `born`
 * (出生时刻),Windows 是 `created`(FILETIME)。返回
 * `{ pid, verdict, misfired, error }`:`verdict` 见 `verifyInstance`;`misfired` 见下。
 *
 * **窗口关不掉,所以不说大话**(第 5 轮审查 F4)。POSIX 从普通 Node 进程拿不到 pidfd / 句柄
 * 这种「钉住实例」的东西(`process.kill` 的入参只有一个号码),所以「刚刚查到出生时刻相等」
 * 证明的是**查的那一刻**它还是我们那一个,不是「这一刀一定落在它身上」。能做到的上界是两条:
 *  · 核与发之间**不 await 任何东西**(出生时刻走同步读,见 `birthOf` 为什么是同步的),
 *    窗口压到一次系统调用;
 *  · 发完**再核一次**:还是当初那个 ⇒ 这一刀确实落在它身上;**变成了另一个** ⇒ 号码在那截
 *    窗口里换了主人、这一刀可能打在陌生人身上,如实记进 `misfired`,由 `stop()` 报出来。
 *    读到「它不在了」是预期结果(我们正是要它停),这一档分不出「被我们杀掉」和「它自己先
 *    退了、号码还空着」—— 分不出就写成分不出,不许往「一定打对了」上说。
 *
 * **Windows 没有这个窗口**:`OpenProcess` 拿到的句柄本身钉住实例,代次核对(GetProcessTimes)
 * 与 `TerminateProcess` 在同一个句柄上做,见 `windowsTerminateScript`。那边「跳过」一律落
 * `"unverifiable"`:句柄开不出来、代次读不出来、代次对不上三种长得一样,分不出就不猜。
 */
export function signalInstance(row, signalName) {
  if (windows) {
    if (!row.created) return { pid: row.pid, verdict: "unverifiable", misfired: false };
    let output;
    try { output = powerShellSync(windowsTerminateScript([{ pid: row.pid, created: row.created }], { tolerant: true })); }
    catch (error) { return { pid: row.pid, verdict: "unverifiable", misfired: false, error }; }
    const skipped = output.split("\n").some((line) => new RegExp(`^ASH_RESTART_SKIPPED ${row.pid}$`).test(line.trim()));
    return { pid: row.pid, verdict: skipped ? "unverifiable" : "same", misfired: false };
  }
  const verdict = verifyInstance(row);
  if (verdict !== "same") return { pid: row.pid, verdict, misfired: false };
  let error;
  try { process.kill(row.pid, signalName); }
  catch (failure) { if (failure.code !== "ESRCH") error = failure; }
  return { pid: row.pid, verdict, misfired: verifyInstance(row) === "other", error };
}

/**
 * 停掉一个**保留下来**的进程 —— `preserveScripts` 那些:本次创建的,但按约定不由执行域终止,
 * 由调用方自己负责收尾。`instance` 就是 `runTestProcess` 返回的 `preserved` 里的那一份,
 * 里面带着在域内观察到的实例身份,所以这里既不必、也不许回头读 PID 文件现编一个号码出来
 * (第 5 轮审查 F4:裸号码终止 —— 号码换了主人就会关掉无关程序)。
 *
 * 返回 `signalInstance` 的结论,**同步**:退出钩子里的清理只能同步。调用方必须自己处理
 * `"unverifiable"`(核不出来就没有下刀,该失败的要失败)。
 */
export function terminateInstance(instance, { force = true } = {}) {
  return signalInstance(instance, force ? "SIGKILL" : "SIGTERM");
}

export class TestProcessScope {
  constructor(directory) {
    // 自己建的目录,构造失败时要自己收走:调用方这时还没拿到 scope,它的 finally 够不着
    // 这个目录(实测:started 写失败会同时留下输出目录和执行域目录两个)。
    // **别人传进来的目录不碰** —— 清理助手就是拿已有目录重建 scope 的,把它删了等于把
    // 还没清场的那一域的登记一起抹掉。
    const mine = directory === undefined;
    this.directory = directory ?? mkdtempSync(join(tmpdir(), "ash-test-scope-"));
    try {
      this.started = Number(readFileSyncSafe(join(this.directory, "started"))) || Date.now();
      writeFileSync(join(this.directory, "started"), String(this.started));
    } catch (error) {
      if (mine) rmSync(this.directory, { recursive: true, force: true });
      throw error;
    }
    this.children = [];
    /**
     * 终止时**没能核对实例身份**的那些号码 —— 宁可报出来,也不照着旧号码乱杀(第 4 轮审查 F2)。
     * 两个平台都会往这儿记:Windows 是句柄那头说「代次对不上」,POSIX 是出生时刻读不出来
     * (第 1 轮审查 F5 —— 上一版在 POSIX 上把「核不出来」当成「已经没了」咽掉了)。
     */
    this.unverified = [];
    /**
     * 「核对实例」和「发信号」之间号码换了主人的那些 —— 这一刀可能打在陌生人身上。窗口为什么
     * 关不掉、为什么只能如实报,见 `signalInstance`。
     */
    this.misfired = [];
    // 边界 inode(见文件头)。POSIX 专有:Windows 那边 ppid 在父进程死后仍然保留,父子链本身
    // 就是完整的,不需要这一条;那边也没有「谁持有这个 inode」的查法。
    /** 创建者手里那个 fd:**它钉住这个 inode**,号码不会被回收,所以身份不会被别人撞上。 */
    this.boundary = null;
    /** `{ dev, ino }` —— 认持有者就靠这对号码(那个 inode 已经没有名字了)。 */
    this.boundaryId = null;
    /** 哪个进程是创建者(它必然持有边界,得认得出来,不能当成后代去杀)。 */
    this.creator = process.pid;
    if (!windows) {
      try { this.#prepareBoundary(); }
      catch (error) {
        if (mine) rmSync(this.directory, { recursive: true, force: true });
        throw error;
      }
    }
    scopes.add(this);
  }

  /**
   * 准备边界 inode。两种入口:
   *  · **新建域** —— 建出来、open、**立刻 unlink**。从这一刻起它在文件系统里没有名字,想持有
   *    只能从本域继承(第 2 轮审查第 4 条:具名文件会被「碰巧打开它的域外程序」冒领)。身份
   *    (dev, ino) 和创建者号码各写一份,给另一个进程用。
   *  · **清理助手拿已有目录重建** —— 那个 inode 早就没名字了,它只能读那份身份;而创建者此刻
   *    还活着并握着 fd(助手是从它的 exit 钩子里 spawnSync 出来的),所以 inode 不会被回收、
   *    号码也不会被别的未链接 inode 撞上。
   *
   * 读到的身份坏了(JSON 残缺)就**抛**:这一层宁可明确失败,也不要悄悄少一条线索(文件头)。
   */
  #prepareBoundary() {
    const idPath = join(this.directory, BOUNDARY_ID);
    const existing = readFileSyncSafe(idPath);
    if (existing) {
      const { dev, ino } = JSON.parse(existing);
      this.boundaryId = { dev, ino };
      const creator = readFileSyncSafe(join(this.directory, CREATOR));
      if (creator) this.creator = JSON.parse(creator).pid;
      return;
    }
    const path = join(this.directory, BOUNDARY);
    writeFileSync(path, "");
    this.boundary = openSync(path, "r");
    unlinkSync(path);
    const stats = fstatSync(this.boundary);
    this.boundaryId = { dev: stats.dev, ino: stats.ino };
    writeFileSync(idPath, JSON.stringify(this.boundaryId));
    writeFileSync(join(this.directory, CREATOR), JSON.stringify({ pid: process.pid, at: Date.now() }));
  }

  /** 认持有者时不算在内的那两个号码(本进程、创建者)。 */
  #outsiders() {
    return new Set([process.pid, this.creator]);
  }

  spawn(commandName, args, options = {}) {
    const environment = options.env ?? process.env;
    // 边界描述符挂在 fd 3 上。它跟着 fork、exec、setsid、重新挂父一路传下去,而
    // `execve(…, {})` 清掉的只是环境、带不走描述符 —— 这正是环境那条线索塌掉的那一种
    // (文件头)。调用方自己的 stdio 原样保留,只在后面续一位。
    const stdio = options.stdio ?? ["pipe", "pipe", "pipe"];
    // **这个 fd 全程留着**:它钉住那个 unlink 掉的 inode(号码不被回收 ⇒ 身份不会被别人撞上)。
    // 于是创建者自己必然在持有者里 —— 上一版正是为了躲开这件事才「开了就马上关」,因为清理助手
    // 是**另一个进程**、只排除得掉自己那个号码,会把创建者当域内进程一刀 SIGTERM 掉(实测
    // `test:restart` 整套 rc=143)。现在创建者的号码记在 CREATOR 里,按身份排除,不靠「谁都
    // 别持有」这种巧合(见 `#outsiders`)。
    const boundary = this.boundary;
    const child = spawn(commandName, args, {
      ...options, detached: !windows, windowsHide: true,
      stdio: boundary === null ? stdio
        : [...(Array.isArray(stdio) ? stdio : [stdio, stdio, stdio]), boundary],
      env: { ...environment, ASH_TEST_PROCESS_SCOPE: this.directory,
        NODE_OPTIONS: `--require ${JSON.stringify(registerPath)} ${environment.NODE_OPTIONS ?? ""}`.trim() },
    });
    child.on("error", () => {});
    this.children.push(child);
    if (child.pid) {
      publishRecord(this.directory, child.pid, { pid: child.pid, at: Date.now(), script: "" });
      writeFileSync(join(this.directory, `${child.pid}.root`), "");
    }
    return child;
  }

  /**
   * 登记,按 pid 归并。同一个 pid 可能有两条(父进程的占位 + 它自己的自登记):
   * `script`/`streams` 只有自登记有,`at` 取晚的那一个 —— 两条都晚于出生时刻,取晚的
   * 不会把一个真正属于我们的进程判出去。
   */
  records() {
    const byPid = new Map();
    for (const name of readdirSync(this.directory)) {
      // **只认登记协议那个形状**(`<被登记 pid>.<发布者 pid>.json`),不是「目录里所有 .json」。
      // 本轮实测过这条:边界身份和创建者号码原先也写成 `.json`,于是 `creator.json` 被读成一条
      // 「pid = 创建者」的登记 —— 创建者把自己认成域内进程,`stop()` 当场把自己 SIGTERM 掉
      // (整套测试 rc=143)。执行域目录里以后还会有别的元数据,判据按协议形状写才关得住这个口。
      if (!REGISTRATION.test(name)) continue;
      let parsed;
      // 读到一半的文件不该让整轮扫描崩掉(发布是 rename,理论上看不到半截,
      // 但这层是清场的最后一道,宁可跳过一条也不要抛)。
      try { parsed = JSON.parse(readFileSync(join(this.directory, name), "utf8")); } catch { continue; }
      const previous = byPid.get(parsed.pid);
      byPid.set(parsed.pid, previous
        ? { ...previous, ...parsed, at: Math.max(previous.at ?? 0, parsed.at ?? 0),
          script: parsed.script || previous.script, streams: parsed.streams?.length ? parsed.streams : previous.streams }
        : parsed);
    }
    return [...byPid.values()];
  }

  /** 这一行是不是「号码对上、但出生时刻对不上」的另一个进程。 */
  #impostor(row, notAfter) {
    if (row.born === null || notAfter === undefined) return false;
    return row.born > notAfter || row.born < this.started - CLOCK_SLACK_MS;
  }

  /**
   * 一次完整扫描:域内**还活着**的那些行,外加**形态违规**的那几个号码(见 `#escapees`)。
   * 两样一起返回而不是分两次查:持有者那一问在 macOS 上要起一个 lsof,不该为同一个结论问两遍。
   */
  async inspect() {
    const rows = await processRows(this.directory);
    const records = this.records();
    const owned = new Set();
    const groups = new Set(readdirSync(this.directory).filter((name) => name.endsWith(".root")).map(Number.parseFloat));
    for (const record of records) {
      const row = rows.find((entry) => entry.pid === record.pid);
      if (!row || this.#impostor(row, record.at)) continue;
      owned.add(record.pid);
    }
    // **边界 inode**:持有它的一定是我们这一次创建的 —— 它没有名字,外面的进程开不出这个 fd
    // (文件头)。查不动会抛,由 `survey()` 走失败路径,绝不退化成「没有活的」。
    let holders = null;
    if (this.boundaryId !== null) {
      holders = await boundaryHolders(this.boundaryId, this.#outsiders());
      for (const pid of holders) {
        const row = rows.find((entry) => entry.pid === pid);
        if (row && !this.#impostor(row, Date.now())) owned.add(pid);
      }
    }
    // 环境段里带着本执行域的。判据是**环境段**而不是整行,不然一个把这段文字当普通参数传进来
    // 的外部进程就会被认领、被终止(第 4 轮审查 F1 实测)。
    for (const row of rows) if (row.scoped && !this.#impostor(row, Date.now())) owned.add(row.pid);
    // **进程组只在组长本身证明得出是我们的时候才作数**。号码会被复用:光凭「组号在 .root 里」
    // 认领,等于拿一个早就退了的旧组号去收养别人新建的组 —— 而那个新组出生得比本域晚,现有的
    // 出生时刻检查一条都拦不住它(第 4 轮审查 F1 同类)。组长在不在、是不是我们的,这儿查得到:
    //  · 还握着句柄没回收的那个孩子 ⇒ 这个号码不可能被复用,组号作数;
    //  · 否则要求组长那一行还在表里、而且它自己已经被上面几条线索认下来了。
    if (!windows) {
      const held = new Set(this.children
        .filter((child) => child.pid && child.exitCode === null && child.signalCode === null)
        .map((child) => child.pid));
      const provable = new Set([...groups].filter((leader) =>
        held.has(leader) || (owned.has(leader) && rows.some((row) => row.pid === leader))));
      for (const row of rows) {
        if (!provable.has(row.group) || this.#impostor(row, Date.now())) continue;
        owned.add(row.pid);
      }
    }
    let changed = true;
    // 已经不在表里的登记 pid 仍然当祖先用:Windows 上父进程死后 ppid 字段还留着,
    // 那条边是它那边唯一完整的线索。
    const ancestors = new Map([
      ...[...owned].map((pid) => [pid, rows.find((row) => row.pid === pid)?.born ?? null]),
      ...records.filter((record) => !rows.some((row) => row.pid === record.pid)).map((record) => [record.pid, record.at]),
    ]);
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (!ancestors.has(row.ppid) || ancestors.has(row.pid)) continue;
        const parentBorn = ancestors.get(row.ppid);
        // 孩子不可能比父亲早出生:这条边核不过就不是这棵树上的(父号被复用了)。
        if (row.born !== null && parentBorn !== null && row.born < parentBorn - CLOCK_SLACK_MS) continue;
        if (this.#impostor(row, Date.now())) continue;
        ancestors.set(row.pid, row.born); owned.add(row.pid); changed = true;
      }
    }
    return {
      rows: rows.filter((row) => owned.has(row.pid)),
      escaped: holders === null ? [] : await this.#escapees(rows, holders),
    };
  }

  async active() {
    return (await this.inspect()).rows;
  }

  /**
   * **我们亲手交到它手里的那个边界,它丢了**。那个 fd 是本层塞进它 stdio 的,所以「它还活着、
   * 却不再持有」只有一种解释:它自己关掉了 —— 而从这一刻起,它再 fork 出来的后代本层一条线索
   * 都认不出来(文件头「支持形态」)。这时候要的是**明确失败**,不是接着往「都停了」上走。
   *
   * **看的是「交过的那些」,不是只看自己 spawn 的那一层**(第 1 轮审查 F1)。上一版只认
   * `this.children`:根命令一正常退出,它就一个嫌疑人都挑不出来,于是「不支持的形态要明确失败」
   * 实际上只是一句注释。再往下交没交到边界**不靠推断**,按登记里那一笔算（`boundary`,由交的
   * 那一方记下,见 test-process-register.cjs）:
   *  · `spawn`/`spawnSync`/`fork` 建出来的,边界续进了 stdio ⇒ 记 `true`,它**该**持有;
   *  · `execFile`/`exec` 建出来的 Node 后代拿不到（Node 不转发 stdio,实测）⇒ 记 `false`,
   *    这一道不碰它们 —— 那是覆盖面的缺口,记在文件头「支持形态」里,不是形态违规。
   * 孙子辈再往下**原生** fork/exec 自然继承,这一道同样管不到它们自己关掉的那一种,靠形态约束。
   *
   * 会**复核一次**:取进程表和取持有者之间它可能正好在退出(内核在进程收尾时把 fd 全关掉),
   * 那种「还活着」只是还没被收尸。所以要求再查一遍仍然不持有、而且实例身份还在。
   */
  async #escapees(rows, holders) {
    /** pid → 核实例身份的上界(`null` = 句柄还在我们手里,这个号码不可能被复用)。 */
    const handed = new Map();
    for (const child of this.children) {
      if (child.pid && child.exitCode === null && child.signalCode === null) handed.set(child.pid, null);
    }
    for (const record of this.records()) {
      if (record.boundary === true && !handed.has(record.pid)) handed.set(record.pid, record.at);
    }
    const suspects = [];
    for (const [pid, notAfter] of handed) {
      const row = rows.find((entry) => entry.pid === pid);
      // 不在表里 = 已经退了;还持有 = 本来就没问题;号码换了主人 = 不是我们交过的那一个。
      if (!row || holders.has(pid)) continue;
      if (notAfter !== null && this.#impostor(row, notAfter)) continue;
      suspects.push(pid);
    }
    if (!suspects.length) return [];
    const again = await boundaryHolders(this.boundaryId, this.#outsiders());
    const confirmed = [];
    for (const pid of suspects) {
      if (again.has(pid)) continue;
      const row = rows.find((entry) => entry.pid === pid);
      if (row && verifyInstance(row) === "same") confirmed.push(pid);
    }
    return confirmed;
  }

  /**
   * 这一轮扫描**能不能作数**。两种都不许当成「没有活的」:
   *  · 扫描本身失败(ps/CIM/lsof/proc 查不动)—— 那正是「没扫描到」被当成清场的那一步;
   *  · **形态违规**(有进程把本层交给它的边界丢了)—— 它的后代本层监管不到,所以这一轮的
   *    「没有活的」证明不了任何事(文件头「支持形态」)。
   * 调用方据此决定是报失败还是接着等。
   */
  async survey() {
    try {
      const { rows, escaped } = await this.inspect();
      if (!escaped.length) return { ok: true, rows };
      return { ok: false, rows, error: new Error(`这些进程已经不持有本域的边界描述符，它们的后代本层监管不到（不支持的形态，见 scripts/test-process-scope.mjs 文件头）: ${escaped.join(",")}`) };
    } catch (error) { return { ok: false, rows: [], error }; }
  }

  async stop() {
    const errors = [];
    const attempt = async (operation) => {
      try { return await operation(); }
      catch (error) { errors.push(error); return []; }
    };
    const signal = (pid, name) => {
      try { process.kill(pid, name); }
      catch (error) { if (error.code !== "ESRCH") errors.push(error); }
    };
    /**
     * 按**实例**终止一批行:核对出生时刻之后才动手。返回**没能核对实例身份**的那些号码 ——
     * 由调用方决定是报出来(主路径,见文件尾的 `unverified`)还是不吭声(「先砍一刀」那一刀:
     * 号码既然换了主人就本来不是我们的,主路径的 `active()` 也不会去认领它)。
     */
    const terminateRows = async (rows, force) => {
      if (!windows) {
        const unverified = [];
        for (const row of rows) {
          // 核对 → 发信号 → 再核对,全在 `signalInstance` 里(那是这一层唯一的下刀口,
          // 判据不许有第二份);两件事要从它的结论里分开记:
          //  · `other` = 号码换了主人,本来就不是我们的;`gone` = 已经没了。这两种不吭声。
          //  · **`unverifiable` 要报出来**(F5):核不出代次就不动手,而「我没核出来」不许
          //    悄悄变成「它已经没了」—— 那正是这一层最不许犯的那个错。
          //  · `misfired` = 核完到发完之间号码换了主人,这一刀可能打在别人身上,同样报出来。
          const shot = signalInstance(row, force ? "SIGKILL" : "SIGTERM");
          if (shot.error) errors.push(shot.error);
          if (shot.verdict === "unverifiable") unverified.push(shot.pid);
          if (shot.misfired) this.misfired.push(shot.pid);
        }
        return unverified;
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
      this.unverified.push(...await terminateRows(rows, force));
    };

    await attempt(() => writeFileSync(join(this.directory, "stopped"), ""));
    // ── 先砍一刀 ────────────────────────────────────────────────────────────────
    // 枚举全表是要花时间的(Windows 上起一个 powershell 查 WMI,实测 ~600ms),而**清场慢一拍,
    // 被判死的后代就多出一拍去写文件**。所以在枚举之前先用**不花钱的证据**砍一刀:
    //  · POSIX:整组发信号。句柄还没回收 ⇒ 这个号码不可能被复用,所以整组是安全的 ——
    //    也只有这一处敢按组号发。
    //  · Windows:
    //     - 我们自己 spawn 的那一层按**句柄**杀。`child.kill()` 用的是 spawn 时拿到的那个句柄,
    //       根本不经过号码,比按号码杀更硬;
    //     - 它们的后代按**登记**杀。号码来自本域的登记文件(本地读,零开销),实例身份当场
    //       核(`#impostor`:出生时刻必须落在「本域创建」到「它登记那一刻」之间,一个号码被
    //       复用的陌生进程落不进这个区间)。
    //
    // **Windows 这儿原先走 `taskkill /T /F`,已经去掉**(第 4 轮审查 F1 同类)。当时的理由是
    // 「句柄没回收 ⇒ 这个号码不会被复用 ⇒ 展开出来的那棵树一定是我们的」,可那只固定了**根**的
    // 身份:`/T` 在执行那一刻按 ppid 重新展开整棵树,而 Windows 的 ppid 在父进程死后仍然留着
    // 旧号码 —— 一个号码被复用的中间节点就能把别人的进程挂进这棵树。换成上面这两条之后,砍下去
    // 的每一个都是自己证明得出来的,「及时」和「不误杀」不必二选一。
    for (const child of this.children) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      if (!windows) { signal(-child.pid, "SIGTERM"); continue; }
      try { child.kill(); } catch (error) { errors.push(error); }
    }
    if (windows) {
      await attempt(() => terminateRows(this.records()
        .filter((record) => record.pid !== process.pid && Number.isFinite(record.at))
        // 代次核成**区间**:这正是 `#impostor` 那条判据,换成句柄那头看得懂的尺子交过去 ——
        // 于是不必先起一个 powershell 查一遍进程表拿代次,这一刀只花一次。跳过的号码不往
        // `unverified` 里记:号码换了主人就本来不是我们的,后面的 `active()` 也不会认领它。
        // 上界就是 `record.at` 本身,**不加容差**(第 1 轮审查 F5):登记必然晚于出生,所以
        // 真正属于我们的那一个落在区间里;而加一秒等于把「登记之后一秒内出生的复用实例」也收
        // 进来。这样这个区间和 `#impostor` 的判据一个字都不差 —— 同一条判据不许有两个尺子。
        .map((record) => ({ pid: record.pid, created: `${fileTime(this.started - CLOCK_SLACK_MS)}-${fileTime(record.at)}` })), true));
    }
    // 下面这一段是**凭据**:前面那一刀只覆盖得到自己登记过的(非 Node 的后代不执行 preload),
    // 全表枚举才认得出靠父子链挂着的那些,而「还有没有活的」这个结论只能由它来下。
    let active = [];
    if (!windows) {
      // POSIX 先温和一轮:上面整组发的是 SIGTERM,这儿再按实例补一次,给它们机会自己收场。
      await terminate(await attempt(() => this.active()), false);
      await delay(100);
    }
    for (let round = 0; round < 3; round++) {
      try { active = await this.active(); }
      catch (error) { errors.push(error); break; }
      if (!active.length) break;
      await terminate(active, true);
      await delay(50);
    }
    // 最后这一次用 `inspect`:除了「还有没有活的」,**形态违规也要落在清理结论里** —— 一个把
    // 边界丢掉的进程若还活着,它的后代本层监管不到,这时候的「扫不到」证明不了清场(文件头)。
    const final = await attempt(() => this.inspect());
    active = Array.isArray(final) ? final : final.rows;
    if (active.length) errors.push(new Error(`测试进程未清场: ${active.map((row) => row.pid).join(",")}`));
    if (!Array.isArray(final) && final.escaped.length) {
      errors.push(new Error(`这些进程已经不持有本域的边界描述符，它们的后代本层监管不到: ${final.escaped.join(",")}`));
    }
    if (this.unverified.length) {
      errors.push(new Error(`无法核验实例身份,未终止: ${[...new Set(this.unverified)].join(",")}`));
    }
    if (this.misfired.length) {
      errors.push(new Error(`这些号码在「核对实例」与「发信号」之间换了主人，这一刀可能打在无关进程上: ${[...new Set(this.misfired)].join(",")}`));
    }
    if (errors.length) throw Object.assign(new AggregateError(errors, `测试执行域清理失败: ${this.directory}`), { directory: this.directory });
  }

  remove() {
    // 边界那个 fd 关在这儿:它一关,那个未链接的 inode 才真正释放 —— 在此之前它一直钉着,
    // 身份不会被别的未链接 inode 撞上(见 `#prepareBoundary`)。
    if (this.boundary !== null) {
      try { closeSync(this.boundary); } catch { /* 已经关了 */ }
      this.boundary = null;
    }
    rmSync(this.directory, { recursive: true, force: true });
    for (const scope of scopes) if (scope.directory === this.directory) scopes.delete(scope);
  }
}

function readFileSyncSafe(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

export function spawnTestFixture(commandName, args, options) {
  const scope = new TestProcessScope();
  const child = scope.spawn(commandName, args, options);
  child.dispose = async () => { await scope.stop(); scope.remove(); };
  return child;
}

export function preservedPids(scope, scripts, capturedStreams) {
  return new Set(scope.records().filter((record) =>
    scripts.some((script) => record.script && resolve(record.script) === resolve(script))
    && record.streams?.length === 2 && record.streams.every((stream) => stream && !capturedStreams.includes(stream))
  ).map((record) => record.pid));
}

process.once("exit", () => {
  if (process.argv[1] && resolve(process.argv[1]) === cleanupPath) return;
  if (!scopes.size) return;
  const result = spawnSync(process.execPath, [cleanupPath, ...[...scopes].map((scope) => scope.directory)], {
    stdio: "inherit", timeout: 30_000, killSignal: "SIGKILL", windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0) process.exitCode = 1;
});
