// 子进程这一侧的登记(靠 NODE_OPTIONS --require 注进每个 Node 进程)。
//
// 发布协议与父进程那一侧(test-process-scope.mjs 的 publishRecord)**必须一字不差**:
// 文件名 `<被登记的 pid>.<发布者 pid>.json`,写临时文件再 rename。
// 名字里带发布者,两个发布者才不会抢同一个目标 —— 原先父子两边都发布成 `<pid>.json`,
// Windows 上替换别人刚建好的文件会 EPERM,而这一下发生在用户代码跑起来之前,整套测试
// 在启动阶段就中止(真机实测 `EPERM: rename <pid>-<pid>.pending -> <pid>.json`)。
// 两边是两个模块系统(ESM / CJS),没法共用一个函数,所以靠这段注释和回归钉住。
const fs = require("node:fs");
const childProcess = require("node:child_process");
const path = require("node:path");
const directory = process.env.ASH_TEST_PROCESS_SCOPE;
if (directory) {
  const stopped = path.join(directory, "stopped");
  if (fs.existsSync(stopped)) process.exit(86);
  const register = (pid, script = "") => {
    if (!pid) return;
    const target = path.join(directory, `${pid}.${process.pid}.json`);
    const temporary = `${target}.pending`;
    const stream = (descriptor) => {
      try { const stat = fs.fstatSync(descriptor); return `${stat.dev}:${stat.ino}`; } catch { return null; }
    };
    fs.writeFileSync(temporary, JSON.stringify({ pid, at: Date.now(), script,
      streams: script ? [stream(1), stream(2)] : [] }));
    try { fs.renameSync(temporary, target); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  };
  register(process.pid, process.argv[1]);
  process.once("exit", () => {
    try { fs.writeFileSync(path.join(directory, `${process.pid}.exited`), ""); } catch {}
  });
  const original = childProcess.spawn;
  childProcess.spawn = function (...args) {
    if (fs.existsSync(stopped)) throw new Error("测试执行域已停止");
    const child = original.apply(this, args);
    register(child.pid);
    return child;
  };
  require("node:module").syncBuiltinESMExports();
}
