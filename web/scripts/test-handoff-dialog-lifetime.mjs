import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workspace = await readFile(new URL("../src/workspace/WorkspaceShell.tsx", import.meta.url), "utf8");
const detail = await readFile(new URL("../src/task-detail/TaskDetail.tsx", import.meta.url), "utf8");

assert.match(workspace, /const \[handoffTarget, setHandoffTarget\] = useState<Task \| null>\(null\)/);
assert.match(workspace, /\{handoffTarget && <HandoffDialog task=\{handoffTarget\}/);
assert.match(workspace, /<TaskDetail[^>]+onHandoff=\{setHandoffTarget\}/);

assert.doesNotMatch(detail, /handoffOpen/);
assert.doesNotMatch(detail, /<HandoffDialog/);
assert.match(detail, /onHandoff\?\.\(task\)/);

console.log("single handoff dialog lifetime regression passed");
