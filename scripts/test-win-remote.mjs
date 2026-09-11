import assert from "node:assert/strict";
import { hiddenProcessLaunchLine } from "./win-remote/transport.mjs";

const plain = hiddenProcessLaunchLine();
assert.match(plain, /-WindowStyle Hidden(?:\s|$)/, "远程后台命令必须隐藏控制台窗口");
assert.doesNotMatch(plain, /-NoNewWindow(?:\s|$)/, "NoNewWindow 无法阻止无控制台后代闪窗");
assert.doesNotMatch(plain, /-WorkingDirectory/, "未指定 cwd 时不应注入工作目录");

const withCwd = hiddenProcessLaunchLine(true);
assert.match(withCwd, /-WorkingDirectory \$__d$/, "指定 cwd 时应传给隐藏进程");

console.log("win-remote 后台进程使用隐藏控制台");
