import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workspace = await readFile(new URL("../src/workspace/WorkspaceShell.tsx", import.meta.url), "utf8");
const detail = await readFile(new URL("../src/task-detail/TaskDetail.tsx", import.meta.url), "utf8");

// 钉的是**弹窗生命周期归 WorkspaceShell 管**（下面两条断言），不是这颗 state 的类型，
// 所以 Task / TaskListItem 都放行——列表行不再带正文之后这里拿到的是后者。
assert.match(workspace, /const \[handoffTarget, setHandoffTarget\] = useState<Task(?:ListItem)? \| null>\(null\)/);
assert.match(workspace, /\{handoffTarget && <HandoffDialog task=\{handoffTarget\}/);
assert.match(workspace, /<TaskDetail[^>]+onHandoff=\{setHandoffTarget\}/);

assert.doesNotMatch(detail, /handoffOpen/);
assert.doesNotMatch(detail, /<HandoffDialog/);
assert.match(detail, /onHandoff\?\.\(task\)/);

console.log("single handoff dialog lifetime regression passed");
