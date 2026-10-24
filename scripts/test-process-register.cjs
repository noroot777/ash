const fs = require("node:fs");
const childProcess = require("node:child_process");
const path = require("node:path");
const directory = process.env.ASH_TEST_PROCESS_SCOPE;
if (directory) {
  const stopped = path.join(directory, "stopped");
  if (fs.existsSync(stopped)) process.exit(86);
  const register = (pid, script = "", exclusive = false) => {
    if (!pid) return;
    const temporary = path.join(directory, `${pid}-${process.pid}.pending`);
    const target = path.join(directory, `${pid}.json`);
    const stream = (descriptor) => {
      try { const stat = fs.fstatSync(descriptor); return `${stat.dev}:${stat.ino}`; } catch { return null; }
    };
    fs.writeFileSync(temporary, JSON.stringify({ pid, at: Date.now(), script,
      streams: script ? [stream(1), stream(2)] : [] }));
    try {
      if (exclusive) fs.linkSync(temporary, target);
      else fs.renameSync(temporary, target);
    } catch (error) { if (error.code !== "EEXIST") throw error; }
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
    register(child.pid, "", true);
    return child;
  };
  require("node:module").syncBuiltinESMExports();
}
