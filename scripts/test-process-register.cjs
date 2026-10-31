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
  /**
   * 继承来的那个边界描述符**在哪一位上**,如果它真是本域那个 inode。
   *
   * 身份从 `boundary.id` 读,不按路径认:那个 inode 建出来就被 unlink 了,压根没有名字可开
   * (理由见 test-process-scope.mjs 文件头「边界描述符」)。
   *
   * **按号码扫,不写死 fd 3**(第 1 轮审查 F1):fd 的位置等于它在 stdio 数组里的下标,而
   * 上一级是「在调用方自己的 stdio 后面续一位」—— 调用方带 IPC(`fork`)或者多开了一位,它
   * 就落在 fd 4、fd 5 上(本机实测:`stdio:[pipe,pipe,pipe,ipc,fd]` 的孩子在 fd 4 上看到
   * 它)。写死 3 的那一版在这种形态下读成 `null`,于是**它自己手里明明有、却不往下传**,
   * 那条伪造不了的线索就在这一层断掉了。
   */
  const boundary = (() => {
    let identity;
    try { identity = JSON.parse(fs.readFileSync(path.join(directory, "boundary.id"), "utf8")); }
    catch { return null; }
    // 0/1/2 是标准流,不会是边界;上界给足:下标受 stdio 数组长度约束,到不了这么大。
    for (let descriptor = 3; descriptor < 64; descriptor += 1) {
      try {
        const stats = fs.fstatSync(descriptor);
        // `nlink === 0`(未链接)跟那边认持有者同一道附加判据:还有名字的 inode 不是我们这个。
        if (stats.dev === identity.dev && stats.ino === identity.ino && stats.nlink === 0) return descriptor;
      } catch { /* 这一位没开着 */ }
    }
    return null;
  })();

  /**
   * `boundary` 那一笔记的是「**这个号码,边界确实交到它手里了**」:给自己登记时它是「我手里
   * 有」,给孩子登记时它是「我把它续进了孩子的 stdio」。两处同义,所以同一个字段。
   *
   * 为什么要落到登记里(第 1 轮审查 F1):清场那一侧要检查「我们交过边界的那些后代是不是还
   * 握着」,而那一侧只认得自己 spawn 的那一层 —— 再往下交没交到,只有交的人知道。靠推断不行:
   * `execFile`/`exec` 走的是 Node 内部那个 spawn 引用、patch 不到,而且**它压根不转发 stdio**
   * (本机实测:孩子在任何 fd 上都看不到那个 inode),所以那两个入口的 Node 后代确实拿不到
   * 边界 —— 这件事要如实记成 `false`,不许让清场那边假设「凡是后代都该持有」。
   */
  const register = (pid, script = "", gave = boundary !== null) => {
    if (!pid) return;
    const target = path.join(directory, `${pid}.${process.pid}.json`);
    const temporary = `${target}.pending`;
    const stream = (descriptor) => {
      try { const stat = fs.fstatSync(descriptor); return `${stat.dev}:${stat.ino}`; } catch { return null; }
    };
    fs.writeFileSync(temporary, JSON.stringify({ pid, at: Date.now(), script, boundary: gave,
      streams: script ? [stream(1), stream(2)] : [] }));
    try { fs.renameSync(temporary, target); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  };
  register(process.pid, process.argv[1]);
  process.once("exit", () => {
    try { fs.writeFileSync(path.join(directory, `${process.pid}.exited`), ""); } catch {}
  });
  /**
   * 把边界 fd 往下一代传。**监管的完整性是执行域这一层的责任**,不该靠每个 fixture 自己记得在
   * stdio 里补一位(第 2 轮审查第 1 条:「不能由某一个测试额外记住 PID 来补洞」同一个道理)。
   * 传下去之后,再往下的原生 fork/exec 自然继承,于是那条**伪造不了也不随 exec 丢**的线索能一直
   * 跟到树底,而不是只覆盖第一层。
   *
   * 已经在 stdio 里的不再加一份;`'inherit'` 这种整体写法先摊成三位再续(Node 的规矩)。
   * `fork` 的 stdio **必须带 `'ipc'`**,所以摊开的时候要把它补上(本机实测:`fork` 转发
   * stdio、边界落在 fd 4 上、IPC 通道照常可用)。
   */
  const withBoundary = (args, ipc) => {
    if (boundary === null) return args;
    const out = [...args];
    // 回调排在最后(`execFile` 那一族的形状),options 要插在它前面。
    let at = out.length - 1;
    while (at >= 0 && typeof out[at] === "function") at -= 1;
    const options = at >= 1 && out[at] && typeof out[at] === "object" && !Array.isArray(out[at])
      ? { ...out[at] } : null;
    const base = ipc ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"];
    const stdio = options?.stdio ?? base;
    const list = Array.isArray(stdio) ? [...stdio]
      : ipc ? [stdio, stdio, stdio, "ipc"] : [stdio, stdio, stdio];
    if (!list.includes(boundary)) list.push(boundary);
    const next = { ...(options ?? {}), stdio: list };
    if (options) out[at] = next; else out.splice(at + 1, 0, next);
    return out;
  };

  /**
   * 四个创建入口里**转发 stdio 的那三个**都接上(第 1 轮审查 F1)。上一版只 patch 了 `spawn`,
   * 于是走 `fork`/`spawnSync` 建出来的后代一律拿不到边界 —— 而清场那一侧的「它该持有」是按
   * 「我们交过」算的,交没交到就是这一层说的话。
   *
   * **`execFile`/`exec` 接不上,如实留着**:它们不走 `childProcess.spawn` 这个引用(Node 内部
   * 另有一份),而且**压根不转发 `options.stdio`**(本机实测:显式传 fd,孩子在任何 fd 上都
   * 找不到那个 inode)。所以那两个入口的 Node 后代登记里写 `boundary:false`,清场那边不会把
   * 它们当成「丢了边界」,代价是它们自己的**非 Node** 后代这一层认不出来 —— 和「主动丢弃监管
   * 资源的 daemon 形态」同一类,记在 test-process-scope.mjs 文件头「支持形态」里。
   */
  const patch = (name, ipc) => {
    const original = childProcess[name];
    if (typeof original !== "function") return;
    childProcess[name] = function (...args) {
      if (fs.existsSync(stopped)) throw new Error("测试执行域已停止");
      const child = original.apply(this, withBoundary(args, ipc));
      register(child?.pid);
      return child;
    };
  };
  patch("spawn", false);
  patch("spawnSync", false);
  patch("fork", true);
  require("node:module").syncBuiltinESMExports();
}
