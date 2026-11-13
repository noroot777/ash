// 导入另一份 ash 的数据之前对副本做的那一遍（server/src/import-snapshot.ts）。
//
// 钉两件事：
//   · 导入不是重启 —— 副本里认不出源实例的任何进程，在飞的活按被打断落定，自动续跑的意图停用。
//     不只核对库里的值：拿一个真活着的假 agent 当源实例的进程，让真的接管入口
//     （reattachRunningTasks / reattachMonitors）对着洗过的库再认一遍，它必须一个都认不出、也不碰。
//   · 落在源数据根下的绝对路径改到新根，源数据根以外（项目目录、名字相近的兄弟目录）一个字不动。
//
// 跑法：npm -w server run test:import-snapshot
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = mkdtempSync(join(tmpdir(), "ash-import-snapshot-"));
const source = join(root, "data");
const target = join(root, "imported");
const sibling = join(root, "data2");
const project = join(root, "project");
for (const dir of [source, target, sibling, project, join(source, "runs", "t-live")]) mkdirSync(dir, { recursive: true });
// 库就建在「导入后的位置」上：先按源实例的样子填好，再原地洗，接管入口读的就是洗过的这一份。
const file = join(target, "ash.db");
process.env.ASH_DB = file;
process.env.ASH_DATA_DIR = target;

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ ${name}\n    expected ${e}\n    actual   ${a}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

// 源实例手上的 agent：活着、带进程记号，输出写在源数据根里。
const out = join(source, "runs", "t-live", "s-live.agent-out.jsonl");
const err = join(source, "runs", "t-live", "s-live.agent-err.log");
const rc = join(source, "runs", "t-live", "s-live.agent-rc");
writeFileSync(out, "");
writeFileSync(err, "");
const agent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  env: { ...process.env, ASH_MONITOR_UNIT: "unit-live" }, stdio: "ignore",
});

try {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const lstart = execFileSync("/bin/ps", ["-p", String(agent.pid), "-o", "lstart="], { encoding: "utf8" }).trim();
  const { ensureSchema, dbClient } = await import("../src/db/index.js");
  await ensureSchema();
  const at = new Date().toISOString();
  const later = new Date(Date.now() + 3_600_000).toISOString();
  const sql = async (statement: string, args: (string | number | null)[] = []) => dbClient.execute({ sql: statement, args });
  await sql("INSERT INTO projects(id,name,repo_path,created_at) VALUES('p','p',?,?)", [project, at]);
  await sql("INSERT INTO agents(id,name,type) VALUES('a','claude','claude')");
  const task = (id: string, status: string, mode = "single") => sql(
    "INSERT INTO tasks(id,project_id,title,body,status,mode,agent_type,executor_id,workflow_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    [id, "p", id, `附件 ${source}/uploads/x.png，另一处 ${sibling}/keep.txt，项目 ${project}/README.md，链接 file://${source}/runs/r.md`,
      status, mode, "claude", "a", "free", at, at]);
  await task("t-live", "running");
  await task("t-queued", "queued");
  await task("t-team", "running", "team");
  await task("t-done", "done");
  await sql("UPDATE tasks SET verify_round=2, queue_advance_request=? WHERE id='t-queued'", [JSON.stringify({ prevStatus: "backlog" })]);
  await sql(`INSERT INTO sessions(id,task_id,role,agent_type,executor,started_at,agent_pid,agent_started_at,agent_out_path,
    agent_err_path,agent_rc_path,agent_unit_token,agent_offset,cwd,worktree_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ["s-live", "t-live", "single", "claude", "claude", at, agent.pid!, lstart, out, err, rc, "unit-live", 0, project, project]);
  await sql(`INSERT INTO monitors(id,task_id,command,cwd,status,pid,pid_started_at,unit_token,log_path,started_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, ["m-live", "t-live", "sleep 100", project, "running", agent.pid!, lstart, "unit-live",
    join(source, "runs", "t-live", "m-live.log"), at, later]);
  await sql(`INSERT INTO monitors(id,task_id,command,cwd,status,pid,pid_started_at,log_path,started_at,expires_at,result_handoff_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, ["m-stopped", "t-done", "sleep 1", project, "stopped", agent.pid!, lstart,
    join(source, "runs", "t-done", "m.log"), at, later, at]);
  await sql(`INSERT INTO accept_gate_runs(id,task_id,project_id,command,cwd,status,pid,pid_started_at,process_pending,log_path,
    started_at,settlement,accept_options) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, ["g-live", "t-live", "p", "npm test", project, "running",
    agent.pid!, lstart, 1, join(source, "runs", "t-live", "gate.log"), at, JSON.stringify({ status: "passed" }), "{}"]);
  await sql(`INSERT INTO agent_cleanup_debts(unit_token,task_id,session_id,root_pid,root_started_at,out_path,state,attempts,version,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, ["unit-live", "t-live", "s-live", agent.pid!, lstart, out, "remaining", 0, 1, at]);
  await sql(`INSERT INTO monitor_reclaim_debts(monitor_id,task_id,pid,pid_started_at,command,reason,attempts,created_at)
    VALUES(?,?,?,?,?,?,?,?)`, ["m-live", "t-live", agent.pid!, lstart, "sleep 100", "stop", 0, at]);
  await sql("INSERT INTO schedules(id,task_id,kind,cron,enabled,created_at) VALUES('sch','t-done','cron','0 9 * * *',1,?)", [at]);
  await sql(`INSERT INTO scheduled_messages(id,task_id,text,attachments,mode,send_at,status,created_at,delivering_since,delivering_owner)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, ["msg-pending", "t-done", "到点再说", JSON.stringify([`${source}/uploads/a.png`]), "timed", later, "pending", at, at, "owner"]);
  await sql(`INSERT INTO scheduled_messages(id,task_id,text,mode,send_at,status,created_at,turn_taken_by) VALUES(?,?,?,?,?,?,?,?)`,
    ["msg-handed", "t-done", "交给那一轮了", "queued", at, "sent", at, "turn-1"]);
  await sql("INSERT INTO queue_advance_intents(queue_id,accepted_at) VALUES('q',?)", [at]);
  await sql("INSERT INTO regression_evidence(directory,task_id,generation,excluded_monitors) VALUES(?,?,?,'[]')", [join(source, "runs", "t-done", "review", "round-1"), "t-done", "g1"]);
  await sql("UPDATE tasks SET wait_ownership=? WHERE id='t-done'", [JSON.stringify({
    deliveredReview: { directory: join(source, "runs", "t-done", "review", "round-1"), generation: "g1", pid: agent.pid, unitToken: "unit-live", confirmedAt: at },
  })]);

  const { prepareImportedSnapshot } = await import("../src/import-snapshot.js");
  const report = prepareImportedSnapshot(file, [source], target);
  check("提示里数得出停下了什么", report.held, { tasks: 3, monitors: 1, gates: 1, schedules: 1, messages: 1 });

  const db = new DatabaseSync(file, { readOnly: true });
  const one = (statement: string, ...args: string[]) => db.prepare(statement).get(...args) as Record<string, unknown>;
  check("会话上认人的线索全清", one("SELECT agent_pid, agent_started_at, agent_unit_token FROM sessions WHERE id='s-live'"),
    { agent_pid: null, agent_started_at: null, agent_unit_token: null });
  check("会话输出改到新根", one("SELECT agent_out_path FROM sessions WHERE id='s-live'").agent_out_path, join(target, "runs", "t-live", "s-live.agent-out.jsonl"));
  check("项目目录不动", one("SELECT cwd, worktree_path FROM sessions WHERE id='s-live'"), { cwd: project, worktree_path: project });
  check("在跑、排队的任务落暂停，团队台落待命",
    db.prepare("SELECT id, status FROM tasks ORDER BY id").all().map((r) => `${r.id}=${r.status}`),
    ["t-done=done", "t-live=paused", "t-queued=paused", "t-team=idle"]);
  check("验证轮与队列推进请求清掉", one("SELECT verify_round, queue_advance_request FROM tasks WHERE id='t-queued'"),
    { verify_round: null, queue_advance_request: null });
  check("在盯的哨兵落 lost、认不出人", one("SELECT status, pid, pid_started_at, unit_token FROM monitors WHERE id='m-live'"),
    { status: "lost", pid: null, pid_started_at: null, unit_token: null });
  check("已停的哨兵也认不出人、结束通知不补发", one("SELECT status, pid, result_handoff_at FROM monitors WHERE id='m-stopped'"),
    { status: "stopped", pid: null, result_handoff_at: null });
  check("在跑的验收闸落被打断、结论和放行选项作废",
    one("SELECT status, failure, pid, process_pending, settlement, accept_options FROM accept_gate_runs WHERE id='g-live'"),
    { status: "interrupted", failure: "server_restarted", pid: null, process_pending: 0, settlement: null, accept_options: null });
  check("源实例的清理责任收档", one("SELECT count(*) AS n FROM agent_cleanup_debts WHERE closed_at IS NULL").n, 0);
  check("源实例的哨兵回收责任收档", one("SELECT count(*) AS n FROM monitor_reclaim_debts WHERE closed_at IS NULL").n, 0);
  check("定时任务停用但留着", one("SELECT enabled FROM schedules WHERE id='sch'").enabled, 0);
  check("待发消息取消、投递租约清掉", one("SELECT status, delivering_since, delivering_owner FROM scheduled_messages WHERE id='msg-pending'"),
    { status: "canceled", delivering_since: null, delivering_owner: null });
  check("回合里交出去的那条不会被退回重送", one("SELECT status, turn_taken_by FROM scheduled_messages WHERE id='msg-handed'"),
    { status: "sent", turn_taken_by: null });
  check("队列推进意图清空", one("SELECT count(*) AS n FROM queue_advance_intents").n, 0);
  const owned = JSON.parse(String(one("SELECT wait_ownership FROM tasks WHERE id='t-done'").wait_ownership));
  check("等待凭证里的 pid 与记号去掉、目录跟着改", owned.deliveredReview,
    { directory: join(target, "runs", "t-done", "review", "round-1"), generation: "g1", confirmedAt: at });
  check("证据目录主键与引用它的凭证一起改", one("SELECT directory FROM regression_evidence").directory, owned.deliveredReview.directory);
  check("正文里源根下的路径改、兄弟目录和项目路径不动", one("SELECT body FROM tasks WHERE id='t-live'").body,
    `附件 ${target}/uploads/x.png，另一处 ${sibling}/keep.txt，项目 ${project}/README.md，链接 file://${target}/runs/r.md`);
  check("附件列表跟着改", JSON.parse(String(one("SELECT attachments FROM scheduled_messages WHERE id='msg-pending'").attachments)),
    [`${target}/uploads/a.png`]);
  check("库还是好的", one("PRAGMA integrity_check").integrity_check, "ok");
  db.close();

  // 真的接管入口对着洗过的库再认一遍：源实例的进程一个都不许认领，也不许被碰到。
  const { reattachRunningTasks } = await import("../src/reattach.js");
  check("开机接管认不出源实例的 agent", [...await reattachRunningTasks()], []);
  const { reattachMonitors } = await import("../src/monitors.js");
  check("开机接回认不出源实例的哨兵", (await reattachMonitors())?.attached ?? 0, 0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  check("源实例的 agent 还活着", agent.exitCode === null && agent.signalCode === null, true);
  check("再洗一遍不改任何东西", prepareImportedSnapshot(file, [source], target), { held: {}, relocated: 0 });
} finally {
  agent.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
}

if (failures) {
  console.error(`test-import-snapshot: ${failures} failure(s)`);
  process.exit(1);
}
console.log("test-import-snapshot: ok");
process.exit(0);
