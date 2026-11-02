// **接管时从协议日志重放出来的状态**:同一回合的完成事实不许被较弱的证据回滚。
// 跑:npm -w server run test:undriven-turn(同一条命令里接着跑)
//
// 第 1 轮自由审查 F2(生产读取器 + 生产接管适配器实测):协议通知与请求应答会交错,
// `turn/started → turn/completed → turn/start 的应答` 这种顺序在实时协议里本来就有(适配器
// 专门处理过「通知先到、应答迟到」)。而重放那一侧不论 id 一律在「看见开始凭据」时清掉完成
// 事实,于是一个已经答完的回合在接管后只剩「已开始」:历史完成通知在 offset 之前、不会重发,
// 进展记号又是 seen(静默档不开)—— 任务一直停在进行中。
//
// 这一份不起真 CLI:读取器吃一份写好的日志,适配器接管一个「只答握手、再不说话」的进程 ——
// 跟真实现场一样,完成通知不会再来,能不能收口全看重放出来的那份状态。
if (process.platform === "win32") {
  console.log("test:adopt-replay 跳过：接管夹具是 POSIX 进程，Windows 覆盖要上真机（根 AGENTS.md）");
  process.exit(0);
}

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "ash-adopt-replay-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

const { readCodexAppServerState } = await import("../src/executors/codex-app-server-state.js");
const { openCodexAppServer } = await import("../src/executors/codex-app-server.js");
const { sleep } = await import("./stall-fixtures.js");

let failures = 0;
const ok = (line: string) => console.log(`   ✓ ${line}`);
const fail = (line: string) => { failures += 1; console.error(`   ✗ ${line}`); };
const check = (cond: boolean, line: string) => (cond ? ok(line) : fail(line));
const strays = new Set<ChildProcess>();

/** 只答握手、再不主动说话的 app-server:历史完成通知已经在 offset 之前,不会重发。 */
const quietAppServer = (): ChildProcess => {
  const child = spawn(process.execPath, ["-e", [
    "const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');",
    "let buf='';process.stdin.on('data',(c)=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){",
    "const line=buf.slice(0,i);buf=buf.slice(i+1);let m;try{m=JSON.parse(line)}catch{continue}",
    "if(m.id===undefined)continue;",
    "if(m.method==='thread/resume'||m.method==='thread/start'){send({id:m.id,result:{thread:{id:'th-replay'}}});continue}",
    "send({id:m.id,result:{}})}});setInterval(()=>{},1000);",
  ].join("")], { stdio: ["pipe", "pipe", "pipe"] });
  strays.add(child);
  return child;
};

const THREAD = "th-replay";
const TURN = "turn-replay";
const response = (turn = TURN) => ({ id: 3, result: { turn: { id: turn } } });
const started = (turn = TURN) => ({ method: "turn/started", params: { threadId: THREAD, turn: { id: turn } } });
const completed = (turn = TURN) => ({ method: "turn/completed",
  params: { threadId: THREAD, turn: { id: turn, status: "completed", error: null } } });
const replay = (name: string, lines: object[]) => {
  const path = join(root, `${name}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({ id: 1, result: {} }),
    JSON.stringify({ id: 2, result: { thread: { id: THREAD } } }),
    ...lines.map((line) => JSON.stringify(line)),
  ].join("\n") + "\n");
  return readCodexAppServerState(path, THREAD);
};

console.log("① 重放:同一回合迟到的开始凭据不许抹掉已经读到的完成事实(第 1 轮自由审查 F2)");
{
  const normal = replay("normal", [response(), started(), completed()]);
  check(normal.completedTurn?.id === TURN, "对照:应答 → 开始 → 完成,读出完成事实(这一档本来就对)");

  const lateReply = replay("late-reply", [started(), completed(), response()]);
  check(lateReply.completedTurn?.id === TURN && lateReply.completedTurn.status === "completed",
    `开始 → 完成 → 迟到的启动应答:完成事实还在(实际 ${JSON.stringify(lateReply.completedTurn ?? null)});`
    + "上一版:被同一回合的应答清掉,接管后只剩「已开始」");
  const lateStarted = replay("late-started", [response(), completed(), started()]);
  check(lateStarted.completedTurn?.id === TURN,
    "应答 → 完成 → 迟到的开始通知:同样不许回滚(两处清空写法是同一个毛病)");

  // 别把「单调」修成「永不清」:确证进入了**另一个**回合,上一轮的完成事实就不是这一轮的。
  const nextTurn = replay("next-turn", [response(), started(), completed(), response("turn-next"), started("turn-next")]);
  check(nextTurn.turnId === "turn-next" && !nextTurn.completedTurn,
    `进入另一个回合 → 上一轮的完成事实清掉(turnId=${nextTurn.turnId}, completed=${nextTurn.completedTurn?.id ?? "无"})`);
}

console.log("② 接管:重放出来的完成事实要真的让这一轮收口");
{
  const adopt = async (state: ReturnType<typeof readCodexAppServerState>) => {
    const child = quietAppServer();
    const handle = openCodexAppServer({
      bin: "codex", args: [], cwd: root, prompt: "",
      sessionId: THREAD,
      reattach: {
        threadId: THREAD, turnId: state.turnId ?? "", evidence: state.evidence,
        ...(state.completedTurn ? { completedTurn: state.completedTurn } : {}),
      },
      startProcess: () => child,
    });
    const kinds: string[] = [];
    let exitStatus: number | null = null;
    const consume = (async () => {
      for await (const event of handle.events) {
        kinds.push(event.kind);
        if (event.kind === "done") exitStatus = event.exitStatus;
      }
    })();
    await Promise.race([consume, sleep(2_000)]);
    handle.kill();
    await Promise.race([consume, sleep(2_000)]);
    return { kinds, exitStatus };
  };
  const late = await adopt(replay("adopt-late", [started(), completed(), response()]));
  check(late.kinds.includes("done") && late.exitStatus === 0,
    `开始 → 完成 → 迟到应答的那一份,接管后两秒内按成功收口(收到:${late.kinds.join(",") || "无"});`
    + "上一版:零事件、进程活着,任务一直显示进行中");
}

for (const child of strays) { try { child.kill("SIGKILL"); } catch { /* 已经没了 */ } }
if (failures) {
  console.error(`\n✗ ${failures} 项未通过`);
  process.exit(1);
}
console.log("\n✓ 接管重放全部通过");
process.exit(0);
