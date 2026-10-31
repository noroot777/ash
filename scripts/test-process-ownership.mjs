// ── 所有权与清场的四条不变量 ────────────────────────────────────────────────────
// 覆盖的是审查里那四条(F3 登记发布、F1 退出证明、F2 实例绑定、N2 初始化回收),
// 判据与理由在 test-process-scope.mjs 顶部,这里只钉行为。
//
// 为什么用 python3 造「原生后代」:它 fork 之后 setsid、原父再退出,于是 preload 登记、
// 父子链、进程组三条线索同时失效 —— 这正是「扫不到就当清场」漏掉的那一类,Node 的
// child_process 造不出来(它一定走 preload)。没有 python3 的机器上这一节跳过并说明。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TestProcessScope, delay } from "./test-process-scope.mjs";
import { runTestProcess } from "./test-process.mjs";

const windows = process.platform === "win32";
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const tempDirs = () => new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("ash-test-")));
const python = (() => {
  try { return execFileSync(process.platform === "win32" ? "where" : "/bin/sh", windows ? ["python3"] : ["-c", "command -v python3"], { encoding: "utf8" }).trim().split("\n")[0]; }
  catch { return ""; }
})();

// ── ① 登记发布:两个发布者永远不写同一个文件名 ────────────────────────────────
// 旧协议父子两边都发布成 `<pid>.json`(一个 link、一个 rename),Windows 上替换别人刚
// 建好的文件报 EPERM,而那一下在用户代码之前,整套测试启动即中止。
{
  const scope = new TestProcessScope();
  // 走真实脚本而不是 `-e`:自登记记的是 `process.argv[1]`,`-e` 下它是空的,
  // 「保住自登记那一条」就无从验起(而保留服务的判据正是靠这个 script)。
  const stage = mkdtempSync(join(tmpdir(), "ash-probe-"));
  const sleeper = join(stage, "sleeper.mjs");
  writeFileSync(sleeper, "setTimeout(() => {}, 1500);\n");
  const child = scope.spawn(process.execPath, [sleeper], { stdio: "ignore" });
  await delay(600); // 等子进程的 preload 把自登记写出来
  const names = readdirSync(scope.directory).filter((name) => name.endsWith(".json"));
  const mine = names.filter((name) => name.startsWith(`${child.pid}.`));
  assert.equal(mine.length, 2, `同一个 pid 该有两条登记(父进程占位 + 自登记),实际:${names.join(",")}`);
  assert.equal(new Set(mine).size, 2, "两个发布者必须写各自的文件名,不许抢同一个目标");
  for (const name of mine) {
    assert.match(name, /^\d+\.\d+\.json$/, "文件名形状是 <被登记 pid>.<发布者 pid>.json");
  }
  assert.ok(!names.some((name) => name.endsWith(".pending")), "临时文件不许留下");
  const records = scope.records();
  const record = records.find((row) => row.pid === child.pid);
  assert.ok(record, "两条登记要按 pid 归并成一条");
  assert.ok(record.script, "归并要保住自登记那一条才有的 script");
  assert.equal(records.filter((row) => row.pid === child.pid).length, 1, "归并之后同一个 pid 只剩一条");
  assert.equal(resolve(record.script), resolve(sleeper), "自登记记的是那条真实脚本");
  await scope.stop();
  scope.remove();
  rmSync(stage, { recursive: true, force: true });
  console.log("✓ 登记发布:父子两个发布者各写各的名字,归并后仍是一条完整记录");
}

// ── ② 退出证明:原生后代脱离三条线索之后仍必须被认出来、被停掉 ────────────────
if (!python || windows) {
  console.log(`- 跳过原生后代一节(${windows ? "Windows 没有 fork/setsid 语义" : "本机没有 python3"})`);
} else {
  const directory = mkdtempSync(join(tmpdir(), "ash-native-probe-"));
  try {
    for (const timed of [false, true]) {
      const pidPath = join(directory, `child-${timed}.pid`);
      const marker = join(directory, `late-${timed}`);
      // 后代:setsid → 写下自己的 pid → 跟父进程握手 → 睡 1.5 秒再写标记。
      // 父进程在握手之后立刻退出(timed 档改成长睡,等被超时杀掉)。
      const script = `import os,time\nreader,writer=os.pipe()\nchild=os.fork()\nif child == 0:\n os.close(reader)\n os.setsid()\n open(${JSON.stringify(pidPath)},'w').write(str(os.getpid()))\n os.write(writer,b'r')\n os.close(writer)\n time.sleep(1.5)\n open(${JSON.stringify(marker)},'w').write('late')\n time.sleep(4)\n os._exit(0)\nelse:\n os.close(writer)\n os.read(reader,1)\n os.close(reader)\n print('PARENT_READY',flush=True)\n ${timed ? "time.sleep(20)" : "os._exit(0)"}\n`;
      let failure;
      try { await runTestProcess(python, ["-c", script], { timeout: timed ? 300 : 3_000 }); }
      catch (error) { failure = error; }
      const pid = Number(readFileSync(pidPath, "utf8"));
      assert.ok(failure, `${timed ? "超时" : "正常退出"}档:留下还在跑的后代时不许返回成功`);
      assert.ok(!alive(pid), `${timed ? "超时" : "正常退出"}档:返回之前必须已经把后代停掉(pid=${pid})`);
      if (!timed) {
        assert.equal(failure.code, "ESTRANDED", `正常退出档要如实报遗留,实际:${failure.code}\n${failure.message}`);
        assert.match(failure.message, /仍在运行/);
      }
      const before = existsSync(marker);
      await delay(1_800);
      assert.equal(existsSync(marker), before, "返回之后后代不许再写出任何东西");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
  console.log("✓ 退出证明:原生后代脱离登记/父子链/进程组之后仍被认出、停掉,并如实报失败");
}

// ── ②b 退出证明:后代**把环境清空**之后仍必须被认出来 ────────────────────────────
// ②那一节的后代是 fork 出来的,`os.environ` 原样继承 —— 所以当年「环境变量继承」那条线索
// 认得出它。第 4 轮审查 F2 换成 `os.execve(…, {})`:环境被整个清空,于是登记、父子链、进程组、
// 环境四条线索**同时**失效,扫描结果变空又被当成清场的证明(实测 helper 返回 0、后代随后还在
// 往磁盘写)。现在认它的是**边界描述符**:fd 跟着 exec 传下去,清环境带不走它(文件头)。
if (!python || windows) {
  console.log(`- 跳过清空环境一节(${windows ? "Windows 走父子链" : "本机没有 python3"})`);
} else {
  const directory = mkdtempSync(join(tmpdir(), "ash-native-env-probe-"));
  try {
    const pidPath = join(directory, "child.pid");
    const marker = join(directory, "late");
    // 后代:fork → setsid → execve(空环境)。被 exec 掉的那一段只认 argv,所以 pid 文件和
    // 标记路径都写在命令行里;父进程等 pid 文件出现就退出。
    const descendant = `import os,time;open(${JSON.stringify(pidPath)},'w').write(str(os.getpid()));time.sleep(1.2);open(${JSON.stringify(marker)},'w').write('late');time.sleep(6)`;
    const script = `import os,time\nc=os.fork()\nif c==0:\n os.setsid()\n os.execve(${JSON.stringify(python)},[${JSON.stringify(python)},'-c',${JSON.stringify(descendant)}],{})\nelse:\n while not os.path.exists(${JSON.stringify(pidPath)}): time.sleep(.01)\n print('PARENT_DONE',flush=True)\n os._exit(0)`;
    let failure;
    try { await runTestProcess(python, ["-c", script], { timeout: 4_000 }); }
    catch (error) { failure = error; }
    const pid = Number(readFileSync(pidPath, "utf8"));
    assert.ok(failure, "后代清空环境之后照样是遗留,不许返回成功");
    assert.equal(failure.code, "ESTRANDED", `要如实报遗留,实际:${failure.code}\n${failure.message}`);
    assert.ok(!alive(pid), `返回之前必须已经把它停掉(pid=${pid})`);
    const before = existsSync(marker);
    await delay(1_600);
    assert.equal(existsSync(marker), before, "返回之后不许再写出任何东西");
  } finally { rmSync(directory, { recursive: true, force: true }); }
  console.log("✓ 退出证明:后代把环境整个清空之后仍被认出、停掉,并如实报遗留");
}

// ── ②c 所有权:**命令行里有那段文字不等于它是我们的** ─────────────────────────────
// 第 4 轮审查 F1 的直接复现。判据原先是 `ps -E` 那一整行 `includes(标记)`,而那一行是「命令行
// + 环境块」拼起来的 —— 于是把这段文字当普通参数传进去的外部进程被认领、被 `stop()` 终止
// (探针实测 `adopted:true` / `outsiderAliveAfterScopeStop:false`)。那就是「结束一次检查时,
// 另一个独立运行的程序也被关掉」。
if (windows) {
  console.log("- 跳过 argv 假归属一节(POSIX 专属:Windows 读不到别人的环境块,判据里没有这条线索)");
} else {
  const scope = new TestProcessScope();
  // 标记只出现在 argv 里:既没有这个环境变量,也没有继承那个边界 fd。
  // 用 node 而不是 `sleep`:多给一个参数时 `sleep` 自己就按「时间间隔非法」退掉了,那样这一条
  // 验的就不是「没被杀」而是「它自己死了」。
  const outsider = spawn(process.execPath,
    ["-e", "setTimeout(() => {}, 5000)", `ASH_TEST_PROCESS_SCOPE=${scope.directory}`], { stdio: "ignore" });
  await delay(300);
  const owned = await scope.active();
  assert.ok(!owned.some((row) => row.pid === outsider.pid),
    "命令行里有那段文字只说明它打了这几个字,不是归属证明,不许认领");
  await scope.stop();
  scope.remove();
  assert.ok(alive(outsider.pid), "没认领的进程更不许被杀 —— 那就是把用户另外的活关掉");
  outsider.kill("SIGKILL");
  console.log("✓ 所有权:标记只在 argv 里的外部进程既不认领也不终止");
}

// ── ②d 所有权:**碰巧打开同一个文件 ≠ 继承了受监管资源** ──────────────────────────
// 第 2 轮审查第 4 条。上一版的 boundary 是个普通的具名文件,判据是「谁打开着这个路径」——
// 于是同用户的域外程序(看一眼这次检查的临时文件的诊断工具就够了)自己 open 一下就被收养,
// 随后被 `stop()` 终止。现在那个 inode 建出来就 unlink 掉:**没有名字可打开**,持有它只有
// 「从本域继承」一条路。
if (windows) {
  console.log("- 跳过边界冒领一节(POSIX 专属:Windows 侧走句柄 + 父子链)");
} else {
  const scope = new TestProcessScope();
  const boundaryPath = join(scope.directory, "boundary");
  assert.ok(!existsSync(boundaryPath),
    "边界 inode 不许留下名字 —— 有名字就等于把「冒领它」的门开着");
  const stage = mkdtempSync(join(tmpdir(), "ash-probe-"));
  const grabber = join(stage, "grab.mjs");
  // 域外程序:**按名字**去抓那个边界,抓到就一直握着。它既不是本域的后代,也没有本域的环境。
  writeFileSync(grabber, `
import { openSync } from "node:fs";
let held = null;
try { held = openSync(process.argv[2], "r"); } catch {}
console.log(JSON.stringify({ opened: held !== null }));
setTimeout(() => {}, 5000);
`);
  const outsider = spawn(process.execPath, [grabber, boundaryPath], { stdio: ["ignore", "pipe", "ignore"] });
  let said = "";
  outsider.stdout.on("data", (chunk) => { said += chunk; });
  await delay(500);
  assert.deepEqual(JSON.parse(said.trim() || "{}"), { opened: false },
    "那个 inode 已经没有名字,外面压根开不出来");
  const owned = await scope.active();
  assert.ok(!owned.some((row) => row.pid === outsider.pid),
    "打开同一个文件只说明它开了个文件,不是来源证明,不许认领");
  await scope.stop();
  scope.remove();
  assert.ok(alive(outsider.pid), "没认领的进程更不许被杀 —— 那就是「结束一次检查时把别人的程序也关掉」");
  outsider.kill("SIGKILL");
  rmSync(stage, { recursive: true, force: true });
  console.log("✓ 所有权:边界 inode 没有名字,按路径冒领它的域外程序既不认领也不终止");
}

// ── ②e 退出证明:**把本层交给它的边界丢掉 ⇒ 明确失败,不许走成「都停了」** ──────────
// 第 2 轮审查第 1 条。那个 fd 是执行域亲手塞进它 stdio 的,所以「它还活着、却不再持有」只有
// 一种解释:它自己关掉了 —— 从这一刻起它再 fork 出来的后代本层一条线索都认不出来。这种形态
// 不在支持范围里(文件头),判据要当场点名失败,而不是接着往「扫不到 = 清场了」上走。
if (windows) {
  console.log("- 跳过丢边界一节(POSIX 专属)");
} else {
  const scope = new TestProcessScope();
  // `exec 3>&-` 把继承来的那一位关掉,然后继续活着。
  const child = scope.spawn("/bin/sh", ["-c", "exec 3>&-; sleep 5"], { stdio: "ignore" });
  await delay(500);
  const survey = await scope.survey();
  assert.equal(survey.ok, false, "有进程把边界丢了,这一轮扫描证明不了任何事,不许作数");
  assert.match(String(survey.error?.message), new RegExp(String(child.pid)),
    `失败要点名是哪个号码,实际:${survey.error?.message}`);
  assert.match(String(survey.error?.message), /边界描述符/);
  // 它仍然是我们的(登记在),所以照旧要被停掉 —— 「证明不了」说的是它的**后代**。
  let failure;
  try { await scope.stop(); } catch (error) { failure = error; }
  scope.remove();
  assert.ok(!alive(child.pid), `认领得出的那一个照旧要停掉(pid=${child.pid})`);
  console.log("✓ 退出证明:丢掉边界的进程当场点名失败,不混成「清场成功」");
  if (failure) assert.ok(failure instanceof AggregateError, "清理失败要如实聚合抛出");
}

// ── ②f 所有权:**名字相邻的另一个执行域,一个进程都不许碰** ────────────────────────
// 第 1 轮审查 F4 的直接复现。判据原先是 `environment.includes(标记)`,而另一个域的**真实**
// 环境 `ASH_TEST_PROCESS_SCOPE=<我这个>-other` 把我这一段整段包住 —— 于是 A 的 `stop()` 会对
// B 正在用的进程发终止信号。并行跑同一套测试、目录名按用途加后缀,这是常态而不是巧合输入。
if (windows) {
  console.log("- 跳过相邻执行域一节(POSIX 专属:判据里的环境段线索)");
} else {
  const scope = new TestProcessScope();
  const sibling = new TestProcessScope((() => {
    const directory = `${scope.directory}-other`;
    mkdirSync(directory);
    return directory;
  })());
  const theirs = sibling.spawn("/bin/sleep", ["5"], { stdio: "ignore" });
  await delay(400);
  const owned = await scope.active();
  assert.ok(!owned.some((row) => row.pid === theirs.pid),
    "另一个执行域的进程不是我们创建的 —— 目录名把我这段包住不构成来源证明");
  await scope.stop();
  scope.remove();
  assert.ok(alive(theirs.pid), "更不许被我们的 stop() 杀掉:那是把别人正在跑的检查整个关掉");
  await sibling.stop();
  sibling.remove();
  console.log("✓ 所有权:目录名把本域整段包住的另一个执行域,既不认领也不终止");
}

// ── ②g 所有权:环境段的判据按**整个 KEY=VALUE** 收口,但这条线索本身要留着 ────────────
// 两个方向一起钉:别的变量的值里嵌着这段文字不算(F4 的另一半),而**真有这个变量**的仍然要
// 认得出来 —— 把这条线索删掉也能让上面那几条绿,所以正向这一条是它的对照组。默认的
// `subprocess.Popen(close_fds=True)` 关掉继承的 fd、又换了会话,环境是那种形态下唯一还认得出
// 它的线索(见 `environmentHasMarker` 的说明)。
if (windows) {
  console.log("- 跳过环境段收口一节(POSIX 专属)");
} else {
  const scope = new TestProcessScope();
  const sleeper = ["-e", "setTimeout(() => {}, 5000)"];
  // 反向:标记原样嵌在**另一个变量的值**里(左边没有收口)。
  const outsider = spawn(process.execPath, sleeper,
    { stdio: "ignore", env: { OTHER: `prefix-ASH_TEST_PROCESS_SCOPE=${scope.directory}` } });
  // 正向:真的带着这个变量(没有 NODE_OPTIONS ⇒ 没有登记,认它的只能是环境段这一条)。
  const descendant = spawn(process.execPath, sleeper,
    { stdio: "ignore", env: { ASH_TEST_PROCESS_SCOPE: scope.directory } });
  await delay(400);
  const owned = await scope.active();
  assert.ok(!owned.some((row) => row.pid === outsider.pid),
    "标记嵌在别的变量的值里 = 没有这个变量,不许认领");
  assert.ok(owned.some((row) => row.pid === descendant.pid),
    "真带着这个变量的要认得出来 —— 收口不等于把这条线索删掉");
  await scope.stop();
  scope.remove();
  assert.ok(alive(outsider.pid), "没认领的进程更不许被杀");
  assert.ok(!alive(descendant.pid), "认领得出的要停掉");
  outsider.kill("SIGKILL");
  descendant.kill("SIGKILL");
  console.log("✓ 所有权:环境段按整个 KEY=VALUE 收口,嵌在别的值里的不算、真有这个变量的照旧认得出");
}

// ── ②h 退出证明:**边界不在 fd 3 上时也要往下传** ────────────────────────────────
// 第 1 轮审查 F1 的两个子缺陷一起验:preload 那一侧原先写死 `fstatSync(3)`,而执行域是「在
// 调用方自己的 stdio 后面续一位」—— 调用方要了一个 IPC 通道,边界就落在 fd 4(本机实测)。
// 于是那个 Node 后代**手里明明有、却读成 null**,再往下一个都传不到;另外原先只 patch 了
// `spawn`,走 `spawnSync`/`fork` 的那一代也拿不到。
//
// 这一节造的后代把**登记、父子链、进程组、环境**四条线索同时丢掉(fork → setsid → execve 空
// 环境),所以认得出它的只剩边界那一条:边界没传到,它就是个遗留。
if (!python || windows) {
  console.log(`- 跳过边界位置一节(${windows ? "Windows 没有 fork/setsid 语义" : "本机没有 python3"})`);
} else {
  const stage = mkdtempSync(join(tmpdir(), "ash-probe-"));
  const scope = new TestProcessScope();
  try {
    const pidPath = join(stage, "grandchild.pid");
    const grandchild = `import os,time;open(${JSON.stringify(pidPath)},'w').write(str(os.getpid()));time.sleep(6)`;
    const forker = `import os,time\nc=os.fork()\nif c==0:\n os.setsid()\n os.execve(${JSON.stringify(python)},[${JSON.stringify(python)},'-c',${JSON.stringify(grandchild)}],{})\nelse:\n while not os.path.exists(${JSON.stringify(pidPath)}): time.sleep(.01)\n os._exit(0)`;
    const relay = join(stage, "relay.mjs");
    // 中转那一层走 `spawnSync`:它和 `fork` 一样原先没被 patch,顺带一起钉住。
    writeFileSync(relay, `
import { spawnSync } from "node:child_process";
spawnSync(${JSON.stringify(python)}, ["-c", ${JSON.stringify(forker)}], { stdio: "ignore" });
setTimeout(() => {}, 5000);
`);
    // 要一个 IPC 通道 ⇒ 执行域把边界续在它后面,孩子那边它就在 fd 4 上。
    scope.spawn(process.execPath, [relay], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const deadline = Date.now() + 8_000;
    while (!existsSync(pidPath) && Date.now() < deadline) await delay(50);
    assert.ok(existsSync(pidPath), "那个原生后代没起来,这一节的前提就不成立");
    const pid = Number(readFileSync(pidPath, "utf8"));
    const owned = await scope.active();
    assert.ok(owned.some((row) => row.pid === pid),
      `边界落在 fd 4 上时也要被读出来、往下传:只有它认得出这个后代(pid=${pid})`);
    await scope.stop();
    assert.ok(!alive(pid), `认出来了就要停掉(pid=${pid})`);
  } finally {
    scope.remove();
    rmSync(stage, { recursive: true, force: true });
  }
  console.log("✓ 退出证明:边界不在 fd 3 上(带 IPC)也照样读出来并往下传,spawnSync 那一代同样接上");
}

// ── ③ 实例绑定:号码对上但出生时刻对不上的,既不认领也不终止 ────────────────────
if (windows) {
  console.log("- 跳过实例绑定一节(POSIX 专属;Windows 侧走句柄 + GetProcessTimes)");
} else {
  const outsider = spawn("/bin/sleep", ["5"], { stdio: "ignore" });
  await delay(300);
  const scope = new TestProcessScope();
  // 伪造一条「早于它出生」的登记:正是 pid 被复用之后旧登记的样子。
  writeFileSync(join(scope.directory, `${outsider.pid}.${process.pid}.json`),
    JSON.stringify({ pid: outsider.pid, at: Date.now() - 600_000, script: "" }));
  const owned = await scope.active();
  assert.ok(!owned.some((row) => row.pid === outsider.pid),
    "登记时刻早于进程出生时刻 = 号码被复用了,不许认领");
  await scope.stop();
  scope.remove();
  assert.ok(alive(outsider.pid), "没认领的进程更不许被杀 —— 那就是「把用户另外的活关掉」");
  outsider.kill("SIGKILL");
  console.log("✓ 实例绑定:出生时刻对不上的号码既不认领也不终止");
}

// ── ③b 实例绑定:**组长证明不出是我们的,组号就不作数** ───────────────────────────
// 同一条「号码会被复用」的规矩,原先漏在进程组这一侧:`.root` 文件里有那个号码就按组认领,
// 而注释声称的「组长还是我们的」实现里压根没核(第 4 轮审查 F1 同类)。旧组长退了、号码被
// 复用之后,新组出生得比本域**晚**,现有的出生时刻检查一条都拦不住它。
if (windows) {
  console.log("- 跳过组号复用一节(POSIX 专属)");
} else {
  // 另起一个会话 ⇒ 它自己是组长,组号 = 它自己的 pid(这正是本域孩子的形状)。
  const outsider = spawn("/bin/sleep", ["5"], { stdio: "ignore", detached: true });
  outsider.unref();
  await delay(300);
  const scope = new TestProcessScope();
  // 伪造一条「这个号码是本域某个根」的凭据 —— 旧组长退掉、号码被复用之后留下的就是这个样子。
  writeFileSync(join(scope.directory, `${outsider.pid}.root`), "");
  const owned = await scope.active();
  assert.ok(!owned.some((row) => row.pid === outsider.pid),
    "组长不在本域的登记里 = 这个组号是复用来的,不许按组收养");
  await scope.stop();
  scope.remove();
  assert.ok(alive(outsider.pid), "没认领的进程更不许被杀");
  outsider.kill("SIGKILL");
  console.log("✓ 实例绑定:组长证明不出是我们的,组号不作数");
}

// ── ④ 初始化失败不留目录 ──────────────────────────────────────────────────────
// 执行域目录是在 try 之外建的,`started` 写失败时调用方还没拿到 scope,输出目录和执行域
// 目录会双双留下(实测注入 ENOSPC)。在子进程里打桩那一次写入,直接验收回收。
{
  // 动态 import 的说明符必须是 **file:// URL**:Windows 上 `D:\...` 这种绝对路径不是合法
  // URL,ESM 加载器直接 ERR_UNSUPPORTED_ESM_URL_SCHEME(真机实测)。
  const probe = join(mkdtempSync(join(tmpdir(), "ash-probe-")), "probe.mjs");
  writeFileSync(probe, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.writeFileSync;
fs.writeFileSync = (path, ...rest) => {
  if (String(path).endsWith("started")) throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
  return original(path, ...rest);
};
syncBuiltinESMExports();
const { runTestProcess } = await import(${JSON.stringify(new URL("test-process.mjs", import.meta.url).href)});
let failed = false;
try { await runTestProcess(process.execPath, ["-e", "0"]); } catch (error) { failed = error.code === "ENOSPC" || /ENOSPC/.test(String(error)); }
console.log(JSON.stringify({ failed }));
`);
  const before = tempDirs();
  const out = execFileSync(process.execPath, [probe], { encoding: "utf8" });
  rmSync(join(probe, ".."), { recursive: true, force: true });
  assert.deepEqual(JSON.parse(out.trim().split("\n").at(-1)), { failed: true }, "初始化失败要如实抛出");
  const leaked = [...tempDirs()].filter((name) => !before.has(name));
  assert.deepEqual(leaked, [], `初始化失败不许留下临时目录,实际留下:${leaked.join(",")}`);
  console.log("✓ 初始化失败:输出目录与执行域目录都不留下");
}

console.log("process ownership regressions ok");
