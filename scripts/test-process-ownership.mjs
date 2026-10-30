// ── 所有权与清场的四条不变量 ────────────────────────────────────────────────────
// 覆盖的是审查里那四条(F3 登记发布、F1 退出证明、F2 实例绑定、N2 初始化回收),
// 判据与理由在 test-process-scope.mjs 顶部,这里只钉行为。
//
// 为什么用 python3 造「原生后代」:它 fork 之后 setsid、原父再退出,于是 preload 登记、
// 父子链、进程组三条线索同时失效 —— 这正是「扫不到就当清场」漏掉的那一类,Node 的
// child_process 造不出来(它一定走 preload)。没有 python3 的机器上这一节跳过并说明。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

// ── ④ 初始化失败不留目录 ──────────────────────────────────────────────────────
// 执行域目录是在 try 之外建的,`started` 写失败时调用方还没拿到 scope,输出目录和执行域
// 目录会双双留下(实测注入 ENOSPC)。在子进程里打桩那一次写入,直接验收回收。
{
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
const { runTestProcess } = await import(${JSON.stringify(fileURLToPath(new URL("test-process.mjs", import.meta.url)))});
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
