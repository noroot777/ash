/**
 * 第 4 轮审查发现 2 的现场,**独立进程**那一半:ps 问不出话时,归属探测必须说「核不上」,
 * 不许塌成「端口空了」。
 *
 * 为什么非得另起一个进程:`PS_PATH` 是 terminal-process-tree.ts 在**模块加载时**从 PATH
 * 解析出来的 const。同一个进程里改完 PATH 再 import 一次,ESM 给的还是缓存里那份(换
 * query 串只能让 service-ports 自己重载,它依赖的 terminal-process-tree 仍是旧实例)。
 * 所以故障注入只能在进程边界上做:由 test-service-ports.ts spawn,PATH 最前面挂一个
 * 只让 `ps -E` 退非零、其余原样透传给真 ps 的包装器。
 *
 * 入参:端口、这次启动的记号。端口上应当坐着一个**带着那枚记号**的真进程 —— 没有故障时
 * 答案是 ours(由父进程先行核对),有故障时唯一可接受的答案是 unknown。
 */
import assert from "node:assert/strict";
import { probeOwnedPorts } from "../src/service-ports.js";

const [portArg, token] = process.argv.slice(2);
const probe = await probeOwnedPorts([Number(portArg)], token);
assert.equal(probe.state, "unknown", `ps 失灵时只能说「核不上」,实际 ${JSON.stringify(probe)}`);
assert.match(probe.why ?? "", /问不出它的进程环境/, "而且要说清是问不出来,不是「不是我们的」");
console.log(`PS_FAILURE_PROBE_OK ${JSON.stringify(probe)}`);
