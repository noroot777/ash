// 原始输出文件的回收。
//
// 解绑重启的代价是每轮多出三个落盘文件（executors/detached.ts 的 out/err/rc）。
// 它们是**纯传输介质**：唯一用途是「server 重启后能从上次读到的位置接着读」，
// 任务一结束就再没有人会看第二眼——正文早已提炼进 data/runs/<task>/<sess>.md，
// 网页读的也是那份。所以留着只是占地方。
//
// 刻意**不碰** codex-events.jsonl / stderr.log：那是 server/CLAUDE.md 明文规定
// 的「Codex 单任务失败证据链」，删除属于政策变更，不该由这个清理器顺手决定。
// （实测那批文件是目前 data/runs 的大头，要不要设保留期得单独拍板。）
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { RUNS_DIR } from "./paths.js";

// 只认这三种后缀 —— 白名单而不是黑名单：这个目录里还躺着 .md 正文、审查证据、
// 用户上传的图片，误删任何一样都是不可逆的。
const SUFFIXES = [".agent-out.jsonl", ".agent-err.log", ".agent-rc"];

// 默认保留一天。跑完就没用了，留一天纯粹是给「任务刚挂、想翻原始输出查一眼」
// 留窗口。ASH_RUNLOG_KEEP_H 可调，0 = 结束即删。
const KEEP_HOURS = Number(process.env.ASH_RUNLOG_KEEP_H ?? 24);

export async function sweepRunLogs(): Promise<{ removed: number; bytes: number }> {
  const cutoff = Date.now() - KEEP_HOURS * 3600_000;

  // 正在被使用的那几个绝不能删：有 agent_pid 且这一轮还没结束 = 此刻可能正有
  // 一个 agent 在往里写，而重启后的接管也要靠它。一个跑了两天的 agent，它的
  // 文件早就「超龄」了——只按时间判会当场把它读的东西删掉。
  const live = new Set<string>();
  for (const s of await db.select().from(sessions).where(isNull(sessions.endedAt))) {
    if (!s.agentPid) continue;
    for (const p of [s.agentOutPath, s.agentErrPath, s.agentRcPath]) if (p) live.add(p);
  }

  let removed = 0;
  let bytes = 0;
  let taskDirs: string[];
  try {
    taskDirs = readdirSync(RUNS_DIR);
  } catch {
    return { removed, bytes }; // 还没有 runs 目录
  }
  for (const taskId of taskDirs) {
    const dir = join(RUNS_DIR, taskId);
    let entries: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!SUFFIXES.some((sfx) => name.endsWith(sfx))) continue;
      const full = join(dir, name);
      if (live.has(full)) continue;
      try {
        const st = statSync(full);
        if (st.mtimeMs > cutoff) continue;
        unlinkSync(full);
        removed++;
        bytes += st.size;
      } catch {
        /* 已经没了 / 没权限：跳过，清理永远不该拦住启动 */
      }
    }
  }
  return { removed, bytes };
}
