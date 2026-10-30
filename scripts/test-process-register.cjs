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
  /**
   * 继承来的那个边界描述符(fd 3),**如果**它真是本域那个 inode。
   *
   * 身份从 `boundary.id` 读,不按路径认:那个 inode 建出来就被 unlink 了,压根没有名字可开
   * (理由见 test-process-scope.mjs 文件头「边界描述符」)。没有、或者 fd 3 是别的东西,就是
   * `null` —— 这一侧只负责**接着往下传**,不负责凭空造一个。
   */
  const boundary = (() => {
    try {
      const identity = JSON.parse(fs.readFileSync(path.join(directory, "boundary.id"), "utf8"));
      const stats = fs.fstatSync(3);
      return stats.dev === identity.dev && stats.ino === identity.ino ? 3 : null;
    } catch { return null; }
  })();

  /**
   * 把边界 fd 往下一代传。**监管的完整性是执行域这一层的责任**,不该靠每个 fixture 自己记得在
   * stdio 里补一位(第 2 轮审查第 1 条:「不能由某一个测试额外记住 PID 来补洞」同一个道理)。
   * 传下去之后,再往下的原生 fork/exec 自然继承,于是那条**伪造不了也不随 exec 丢**的线索能一直
   * 跟到树底,而不是只覆盖第一层。
   *
   * 已经在 stdio 里的不再加一份;`'inherit'` 这种整体写法先摊成三位再续(Node 的规矩)。
   */
  const withBoundary = (args) => {
    if (boundary === null) return args;
    const out = [...args];
    const last = out.length - 1;
    const options = last >= 1 && out[last] && typeof out[last] === "object" && !Array.isArray(out[last])
      ? { ...out[last] } : null;
    const stdio = options?.stdio ?? ["pipe", "pipe", "pipe"];
    const list = Array.isArray(stdio) ? [...stdio] : [stdio, stdio, stdio];
    if (!list.includes(boundary)) list.push(boundary);
    const next = { ...(options ?? {}), stdio: list };
    if (options) out[last] = next; else out.push(next);
    return out;
  };

  const original = childProcess.spawn;
  childProcess.spawn = function (...args) {
    if (fs.existsSync(stopped)) throw new Error("测试执行域已停止");
    const child = original.apply(this, withBoundary(args));
    register(child.pid);
    return child;
  };
  require("node:module").syncBuiltinESMExports();
}
