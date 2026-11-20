export const seedSource = `
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { holdCodeLock } from "@navi/shared/code-lock";
holdCodeLock();
const { ensureSchema, db } = await import("./server/dist/db/index.js");
const { tasks, projects, sessions } = await import("./server/dist/db/schema.js");
const { spawnForRun, detachedPathsFor } = await import("./server/dist/executors/detached.js");
const { inspectProcess } = await import("./server/dist/proc.js");
const { unitTokenOf } = await import("./server/dist/executors/unit-token.js");
const { RUNS_DIR } = await import("./server/dist/paths.js");
await ensureSchema();
const fixture = process.env.FIXTURE_HOME;
const taskId = process.env.FIXTURE_TASK || "continuous";
const now = new Date().toISOString();
await db.insert(projects).values({id: "p-" + taskId, name: taskId, repoPath: fixture, createdAt: now});
await db.insert(tasks).values({id: taskId, projectId: "p-" + taskId, title: taskId, body: "", status: "running",
  mode: "single", agentType: "claude", labels: "[]", createdAt: now, updatedAt: now, autoTitle: 0, useWorktree: 0,
  activeTurnToken: "fixture-turn", activeDirectionToken: "fixture-direction"});
const sessionId = "s-" + taskId;
const runDir = join(RUNS_DIR, taskId);
mkdirSync(runDir, {recursive:true});
const paths = detachedPathsFor(runDir, sessionId, "T0");
process.env.NAVI_TEST_AGENT_BIN = process.execPath;
const child = spawnForRun(fixture, process.execPath, [join(process.cwd(), "agent-fixture.mjs")], "", {
  FIXTURE_HOME: fixture, FIXTURE_TASK: taskId, FIXTURE_ROOT: process.cwd(),
  NAVI_URL: process.env.FIXTURE_URL, NAVI_SOURCE_TASK_ID: taskId,
  NAVI_TURN_TOKEN: "fixture-turn", NAVI_DIRECTION_TOKEN: "fixture-direction",
}, paths);
if (!child.pid) throw new Error("fixture did not spawn");
await db.insert(sessions).values({id:sessionId, taskId, role:"single", agentType:"claude", executor:"claude@local",
  cwd: fixture, cliSessionId:"fixture-cli", commandLine:"fixture", startedAt:now, turnStartedAt:now, activeMs:0,
  agentPid:child.pid, agentStartedAt:inspectProcess(child.pid)?.startedAt, agentOutPath:paths.out,
  agentErrPath:paths.err, agentRcPath:paths.rc, agentOffset:0, agentUnitToken:unitTokenOf(child)});
writeFileSync(join(fixture, taskId + "-seed.json"), JSON.stringify({pid:child.pid, paths}));
process.exit(0);
`;

export const agentSource = `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const root = process.env.FIXTURE_ROOT;
const home = process.env.FIXTURE_HOME;
const task = process.env.FIXTURE_TASK;
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const child = spawn(join(root,"node/bin/node"), [join(root,"mcp/dist/index.js")], {stdio:["pipe","pipe","inherit"]});
const send = (message) => child.stdin.write(JSON.stringify(message) + "\\n");
let ready = false;
let pending = false;
createInterface({input:child.stdout}).on("line", (line) => {
  const reply = JSON.parse(line);
  if (reply.id === 1) {
    send({jsonrpc:"2.0",method:"notifications/initialized"});
    ready = true;
    writeFileSync(join(home,task + "-agent.json"),JSON.stringify({pid:process.pid,mcp:child.pid,root}));
  }
  if (reply.id === 2) {
    writeFileSync(join(home,task + "-mcp.json"),JSON.stringify(reply));
    child.stdin.end();
    if (reply.result?.isError || reply.error) process.exit(4);
    emit({type:"result",subtype:"success",session_id:"fixture-cli"});
    setTimeout(()=>process.exit(0),100);
  }
});
send({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"runtime-test",version:"1"}}});
emit({type:"system",session_id:"fixture-cli"});
let sequence = 0;
setInterval(()=>{
  emit({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:task + "-segment-" + (++sequence) + "\\n"}}});
  if (ready && !pending && existsSync(join(home, task + "-finish"))) {
    pending = true;
    send({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"complete_task",arguments:{taskId:task,directionToken:process.env.NAVI_DIRECTION_TOKEN}}});
  }
},100);
`;
