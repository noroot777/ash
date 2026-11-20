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
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Agent, fetch } from "undici";
const direct = new Agent();
const root = process.env.FIXTURE_ROOT;
const home = process.env.FIXTURE_HOME;
const task = process.env.FIXTURE_TASK;
const settingsAt = process.argv.lastIndexOf('--settings');
const rawSettings = settingsAt >= 0 ? process.argv[settingsAt + 1] : '{}';
const settings = JSON.parse(rawSettings.startsWith('{') ? rawSettings : readFileSync(rawSettings, 'utf8'));
const hooks = settings.hooks?.PreToolUse?.find(entry => entry.matcher === 'Monitor')?.hooks;
const monitor = hooks?.find(hook => hook.type === 'http');
if (monitor && !hooks.some(hook => hook.type === 'command' && hook.command.includes('--deny-monitor'))) throw new Error('missing fail-closed Monitor guard');
const hookHeaders = Object.fromEntries(Object.entries(monitor?.headers ?? {}).map(([name,value]) => [name, value.startsWith('$') ? process.env[value.slice(1)] : value]));
let hooking = false;
setInterval(async () => {
  if (!monitor || hooking) return;
  hooking = true;
  try {
    const response = await fetch(monitor.url, { dispatcher:direct, method:'POST', headers:{...hookHeaders,'content-type':'application/json'},
      body:JSON.stringify({tool_name:'Monitor',tool_input:{}}) });
    const body = await response.json();
    appendFileSync(join(home,task+'-hooks.jsonl'), JSON.stringify({status:response.status,decision:body.hookSpecificOutput?.permissionDecision})+'\\n');
  } catch(error) { appendFileSync(join(home,task+'-hooks.jsonl'), JSON.stringify({error:String(error)})+'\\n'); }
  finally { hooking = false; }
},200);
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
    writeFileSync(join(home,task + "-agent.json"),JSON.stringify({pid:process.pid,mcp:child.pid,root,monitorUrl:monitor?.url}));
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

export const codexSource = `
import { existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const inline=process.argv.findLast(value=>value.startsWith('mcp_servers.navi='));
if (!inline || !process.argv.includes('app-server')) { console.log('codex fixture 1'); process.exit(0); }
const script=JSON.parse(inline.match(/args=\\[("(?:[^"\\\\]|\\\\.)*")/)[1]);
const root=dirname(dirname(dirname(script)));
const {scanCodexToml}=await import(root+'/server/dist/codex-toml.js');
const config=scanCodexToml(inline).servers.get('navi').spec;
const fingerprint=inline.match(/NAVI_TURN_FINGERPRINT=("(?:[^"\\\\]|\\\\.)*")/);
if (!config.naviUrl || !fingerprint || !process.env.FIXTURE_HOME) throw new Error('incomplete isolated Codex MCP configuration');
process.env.NAVI_URL=config.naviUrl;
process.env.NAVI_TURN_FINGERPRINT=JSON.parse(fingerprint[1]);
const home=process.env.FIXTURE_HOME, task=process.env.NAVI_TASK_ID, thread='thread-'+task, turn='turn-'+task;
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const notify=(method,params)=>emit({method,params:{threadId:thread,...params}});
const mcp=spawn(config.command,config.args,{stdio:['pipe','pipe','inherit']});
const send=value=>mcp.stdin.write(JSON.stringify(value)+'\\n');
let active=false, ready=false, pending=false, tools={}, sequence=0;
createInterface({input:mcp.stdout}).on('line',line=>{
  const reply=JSON.parse(line);
  if(reply.id===1){send({jsonrpc:'2.0',method:'notifications/initialized'});send({jsonrpc:'2.0',id:3,method:'tools/list'});}
  if(reply.id===3){
    tools=Object.fromEntries(reply.result.tools.map(tool=>[tool.name,tool]));ready=true;
    writeFileSync(join(home,task+'-agent.json'),JSON.stringify({pid:process.pid,mcp:mcp.pid,root}));
    notify('mcpServer/startupStatus/updated',{name:'navi',status:'ready'});
  }
  if(reply.id===2){
    writeFileSync(join(home,task+'-mcp.json'),JSON.stringify(reply));mcp.stdin.end();active=false;
    notify('turn/completed',{turn:{id:turn,status:reply.error||reply.result?.isError?'failed':'completed'}});
  }
});
send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'codex-runtime-test',version:'1'}}});
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line); if(request.id===undefined)return;
 let result={};
 if(request.method.startsWith('thread/'))result={thread:{id:thread}};
 if(request.method==='turn/start'){result={turn:{id:turn,status:'inProgress'}};active=true;notify('turn/started',{turn:result.turn});}
 if(request.method==='mcpServerStatus/list')result={data:[{name:'navi',tools}],nextCursor:null};
 if(request.method==='thread/read')result={thread:{id:thread,turns:[{id:turn,status:'inProgress'}]}};
 emit({id:request.id,result});
});
setInterval(()=>{
 if(active)notify('item/agentMessage/delta',{turnId:turn,itemId:'message',delta:task+'-segment-'+(++sequence)+'\\n'});
 if(active&&ready&&!pending&&existsSync(join(home,task+'-finish'))){pending=true;send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'complete_task',arguments:{taskId:task,directionToken:process.env.NAVI_DIRECTION_TOKEN}}});}
},100);
`;
