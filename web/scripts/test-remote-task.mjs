import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const machines = readFileSync(new URL("../src/workspace/HandoffMachines.tsx", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/workspace/WorkspaceShell.tsx", import.meta.url), "utf8");
const detail = readFileSync(new URL("../src/remote-task/RemoteTaskDetail.tsx", import.meta.url), "utf8");
const rows = readFileSync(new URL("../src/workspace/TaskTreeRows.tsx", import.meta.url), "utf8");

assert.doesNotMatch(machines, /target="_blank"/, "远程任务不应再打开新的远端浏览器标签");
assert.match(machines, /onClick=\{\(\) => onRemoteTask\(task, target\)\}/, "远程任务行应交给工作区内联选择");
assert.match(machines, /is-selected/, "远程任务行应有与普通侧栏一致的选中反馈");
assert.match(shell, /<RemoteTaskDetail/, "工作区主区应渲染远程任务代理视图");
assert.match(detail, /上下文从该机器同步，回复也由该机器继续执行/, "远程位置与路由必须持续可见");
assert.match(detail, /api\.remoteTaskReply/, "回复必须经本机代理发往远端");
assert.match(detail, /snapshot\?\.returnAvailable/, "只有远端确认存在安全返回目标时才显示移回入口");
assert.match(rows, /task\.handoff\?\.direction === "out"/, "当前在本机持有的转入或移回任务不应显示位置徽标");
assert.doesNotMatch(rows, /aria-label=.*已移回/, "移回后的本机任务不应保留特殊行标");

console.log("remote task proxy UI tests passed");
