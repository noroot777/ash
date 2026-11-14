// test-macos-client.mjs 的一段：安装不换正被用着的旧包（desktop/macos/scripts/install-app.sh）。
//
// 假包里放真的代码锁模块（shared/src/code-lock.ts）和照服务、MCP 那样「先拿锁、再加载本体」的入口，
// 用真的安装脚本和扫描脚本：
//   · 各种拼写拉起的进程（软链别名、相对路径、包外软链、包里的可执行文件）在用旧包就不换，说清是谁；
//   · 审查第 4 轮的复现：安装器最后一次检查之后、改名之前（用一个包着 /bin/mv 的屏障停住）起来的
//     入口，等在锁上、一行本体都没读；放开之后安装照常完成，它读到的是一整份新代码，并且锁住了新包；
//   · 进程被 kill -9 不留死登记；锁文件缺了入口不照跑；新包没有锁不装；旧版（没有锁的）包按扫描那一档换；
//   · 拷失败旧的原样不动；两个安装器排队。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function testInstall({ root, temporary, launch, children, until, delay }) {
  const install = join(root, "desktop/macos/scripts/install-app.sh");
  // 安装锁有固定位置，测试换成自己的临时目录，跑完一起清掉。
  const installEnv = { ASH_INSTALL_LOCKS: join(temporary, "install-locks") };
  // 安装目录名里带正则字符，再给它一个软链别名：从哪个拼写拉起、从哪个拼写安装都得认出是同一个包。
  const apps = join(temporary, "Apps [1]+ $x");
  const appsAlias = join(temporary, "Applications-alias");
  const fakeApp = (dir, version, { lock = true } = {}) => {
    const app = join(dir, "Contents/Resources/app");
    mkdirSync(join(app, "server/dist"), { recursive: true });
    mkdirSync(join(app, "shared/src"), { recursive: true });
    writeFileSync(join(dir, "Contents/version"), version);
    writeFileSync(join(app, "server/dist/index.js"), "setInterval(() => {}, 1000)");
    copyFileSync(join(root, "shared/src/code-lock.ts"), join(app, "shared/src/code-lock.ts"));
    if (lock) writeFileSync(join(app, ".in-use"), "");
    // 入口照 server/src/index.ts 那样：先拿锁，再加载本体；本体记下自己是哪一版。
    writeFileSync(join(app, "server/dist/entry.mjs"),
      'import { holdCodeLock } from "../../shared/src/code-lock.ts"; holdCodeLock(); await import("./body.mjs");');
    writeFileSync(join(app, "server/dist/body.mjs"),
      `import { writeFileSync } from "node:fs"; if (process.env.LOADED) writeFileSync(process.env.LOADED, ${JSON.stringify(version)}); setInterval(() => {}, 1000);`);
    writeFileSync(join(dir, "Contents/keepalive.mjs"), "setInterval(() => {}, 1000)");
  };
  const newApp = join(temporary, "build", "Ash.app");
  const newerApp = join(temporary, "build-2", "Ash.app");
  fakeApp(newApp, "new");
  fakeApp(newerApp, "newer");
  fakeApp(join(apps, "Ash.app"), "old");
  symlinkSync(apps, appsAlias);
  const installed = () => readFileSync(join(apps, "Ash.app/Contents/version"), "utf8");
  const outside = join(temporary, "outside");
  mkdirSync(outside);
  // 经包外的软链起 ash 的入口：命令行、可执行文件、工作目录都看不出它跟包有关，只有它拿着的锁。
  symlinkSync(join(apps, "Ash.app/Contents/Resources/app/server/dist/entry.mjs"), join(outside, "run.mjs"));
  const startUser = (command, args, cwd, env = {}) => {
    const user = spawn(command, args, { stdio: "ignore", cwd, env: { ...process.env, ...env } });
    children.add(user);
    return user;
  };
  const stopUser = async (user) => {
    user.kill("SIGKILL");
    if (user.exitCode === null && user.signalCode === null) await once(user, "exit");
    children.delete(user);
  };

  // 系统 node 跑包里的脚本（脚本读完就关，只有命令行认得出），和包里的「node」本身在跑（可执行文件认得出；
  // 拿一份 /bin/sleep 当它 —— 开发机上的 node 多半连着动态库，拷出来起不来）。
  const bundledNode = join(apps, "Ash.app/Contents/Resources/node");
  copyFileSync("/bin/sleep", bundledNode);
  const users = [
    ["script, started via the real path, installing via the alias", [process.execPath, join(apps, "Ash.app/Contents/Resources/app/server/dist/index.js")], appsAlias],
    ["script, started via the alias, installing via the real path", [process.execPath, join(appsAlias, "Ash.app/Contents/Resources/app/server/dist/index.js")], apps],
    // 命令行里一个 .app 都没有（相对路径起的），只能靠打开着的可执行文件认。
    ["bundled executable started by a relative path", ["./node", "600"], apps, join(appsAlias, "Ash.app/Contents/Resources")],
    // 别处的 node 按相对路径跑包里的脚本，工作目录在包外（第 3 轮审查的复现）。
    ["script by a relative path from outside the bundle", [process.execPath, "Apps [1]+ $x/Ash.app/Contents/keepalive.mjs"], appsAlias],
    ["ash entry started through a symlink outside the bundle", [process.execPath, "run.mjs"], apps, outside],
  ];
  for (const [label, [command, ...args], into, cwd = temporary] of users) {
    const user = startUser(command, args, cwd);
    await delay(600);
    const result = await launch("/bin/bash", [install, newApp, into], installEnv).done;
    assert.equal(result.status, 1, `${label}: ${result.output}`);
    assert.match(result.output, new RegExp(`${user.pid} `), `${label}: the process still using the old bundle is named`);
    assert.equal(installed(), "old", `${label}: a bundle in use is not replaced`);
    // kill -9：不跑退出钩子，锁照样随进程放掉 —— 下一次安装不会被死进程挡住。
    await stopUser(user);
  }
  rmSync(bundledNode);

  // 锁文件缺了：入口不照跑（照跑就会被当成没人在用）。
  const lockless = join(temporary, "lockless", "Ash.app");
  fakeApp(lockless, "lockless", { lock: false });
  let result = await launch(process.execPath, [join(lockless, "Contents/Resources/app/server/dist/entry.mjs")]).done;
  assert.equal(result.status, 78, result.output);
  assert.match(result.output, /拿不到代码锁/);
  result = await launch("/bin/bash", [install, lockless, apps], installEnv).done;
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /没有代码锁/, "a new bundle without the lock is not installed");
  assert.equal(installed(), "old");

  result = await launch("/bin/bash", [install, join(temporary, "build", "missing.app"), apps], installEnv).done;
  assert.equal(result.status, 1, result.output);
  assert.equal(installed(), "old", "a failed install keeps the old app");
  result = await launch("/bin/bash", [install, newApp, appsAlias], installEnv).done;
  assert.equal(result.status, 0, result.output);
  assert.equal(installed(), "new");
  assert.deepEqual(readdirSync(apps), ["Ash.app"], "no staging or replaced copy is left behind");

  // 第 4 轮审查的复现：最后一次检查做完、改名之前停住，这时从包外软链起一个入口。
  const barrier = join(temporary, "barrier");
  mkdirSync(barrier);
  const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(barrier, "mv"), `#!/bin/bash
if [[ "$1" == ${quote(join(apps, "Ash.app"))} && ! -e ${quote(join(barrier, "paused"))} ]]; then
  touch ${quote(join(barrier, "paused"))}
  while [[ ! -e ${quote(join(barrier, "release"))} ]]; do sleep 0.05; done
fi
exec /bin/mv "$@"
`);
  chmodSync(join(barrier, "mv"), 0o755);
  const loaded = join(temporary, "loaded");
  const swapping = launch("/bin/bash", [install, newerApp, apps], { ...installEnv, PATH: `${barrier}:${process.env.PATH}` });
  await until(() => existsSync(join(barrier, "paused")), `the installer never reached the swap: ${swapping.output()}`);
  const late = startUser(process.execPath, ["run.mjs"], outside, { LOADED: loaded });
  await delay(1000);
  assert.equal(existsSync(loaded), false, "an entry started during the swap waits on the lock before reading any code");
  assert.equal(late.exitCode, null, "it waits, it does not die");
  writeFileSync(join(barrier, "release"), "");
  result = await swapping.done;
  assert.equal(result.status, 0, result.output);
  assert.equal(installed(), "newer");
  await until(() => existsSync(loaded), "the waiting entry never went on");
  assert.equal(readFileSync(loaded, "utf8"), "newer", "after the swap it reads a whole new bundle, nothing of the old one");
  result = await launch("/bin/bash", [install, newApp, apps], installEnv).done;
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, new RegExp(`${late.pid} `), "and it now holds the new bundle's lock");
  assert.equal(installed(), "newer");
  await stopUser(late);

  // 两个安装器同时换同一个目录（一个经别名）：排队换，各自完整，不留嵌套的暂存包。
  const installers = [launch("/bin/bash", [install, newerApp, apps], installEnv), launch("/bin/bash", [install, newApp, appsAlias], installEnv)];
  for (const racer of installers) {
    result = await racer.done;
    assert.equal(result.status, 0, result.output);
  }
  assert.ok(["new", "newer"].includes(installed()), installed());
  assert.deepEqual(readdirSync(apps), ["Ash.app"], "racing installs leave exactly one app");
  assert.deepEqual(readdirSync(join(apps, "Ash.app")), ["Contents"], "no staging bundle nested inside the installed one");

  // 装着的是还没有代码锁的旧版：没人用时按扫描那一档照常换上。
  rmSync(join(apps, "Ash.app"), { recursive: true });
  fakeApp(join(apps, "Ash.app"), "legacy", { lock: false });
  result = await launch("/bin/bash", [install, newApp, apps], installEnv).done;
  assert.equal(result.status, 0, result.output);
  assert.equal(installed(), "new", "an older bundle without the lock is still replaced when nothing uses it");
}
