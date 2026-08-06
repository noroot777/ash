// 「本任务还有其他智能体参与」的告知规则（server/src/peer-context.ts）。
//
// 起因（2026-08-04 现场）：一个单飞任务里先跑 claude、中途 @ 了 codex 做审查，
// 再回头叫 claude 时，claude 完全不知道 codex 存在——它花了好几个工具轮次自己去
// 考古，才推断出「刚才在本任务里跑过一轮 codex 会话」。根因是每个 agentType 一条
// 独立 CLI 会话，跨 agent 只共享工作目录。
//
// 这份测试钉住的是**触发条件**：把它挂在「这个智能体第一次被召唤」上会恰好漏掉
// 那个现场——任务的原生 agent 从没被召唤过，所以一次都收不到。正确口径是「上一轮
// 跑完之后有没有新面孔进来」。
//
// 跑法：npm -w server run test:peer-context
import { collectPeers, hasNewPeer, peerNoticeFor, peerNoticeText, selfAnchor } from "../src/peer-context.js";
import type { PeerSessionRow } from "../src/peer-context.js";

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

const TASK = "Sh2BRa8dmONn";
const row = (o: Partial<PeerSessionRow> & { id: string; agentType: string; startedAt: string }): PeerSessionRow => o;

// 复刻那个现场的时间线：claude 03:03 起跑（原生），codex 14:25 被 @ 进来跑完，
// 用户 14:39 回头叫 claude。
const claude = row({ id: "i-416urmm4WD", agentType: "claude", startedAt: "2026-08-04T03:03:20Z", endedAt: "2026-08-04T14:14:02Z" });
const codex = row({ id: "Zv1E0VUjPrBj", agentType: "codex", startedAt: "2026-08-04T14:25:40Z", endedAt: "2026-08-04T14:37:18Z" });

// ── collectPeers：只列别人，按首次出现排序，路径是绝对的 ─────────────────────
check("同伴名单不含自己", collectPeers(TASK, [claude, codex], "claude").map((p) => p.agentType), ["codex"]);
check("反过来看也一样", collectPeers(TASK, [claude, codex], "codex").map((p) => p.agentType), ["claude"]);
check("只有自己时没有同伴", collectPeers(TASK, [claude], "claude"), []);
check(
  "记录路径落在本任务目录下且以会话 id 命名",
  collectPeers(TASK, [claude, codex], "claude")[0]!.transcripts[0]!.endsWith(`/${TASK}/Zv1E0VUjPrBj.md`),
  true,
);
// 同一个 agentType 万一有多条会话行（fresh 会话没拿到 cliSessionId 时会再开一行），
// 名单只收一条、但把它的记录都列出来，首次出现时间取最早的那条。
const codex2 = row({ id: "Zzz2ndSession", agentType: "codex", startedAt: "2026-08-04T16:00:00Z" });
const multi = collectPeers(TASK, [claude, codex, codex2], "claude");
check("同类型多条会话收拢成一个同伴", multi.length, 1);
check("但记录文件全都列出", multi[0]!.transcripts.length, 2);
check("首次出现取最早那条", multi[0]!.firstSeenAt, "2026-08-04T14:25:40Z");

// ── selfAnchor：锚点取「上一轮跑完」，不是「上一次发言」 ──────────────────────
check("没跑过就没有锚点（在场的都算新面孔）", selfAnchor(undefined), null);
check("正常取 endedAt", selfAnchor(claude), "2026-08-04T14:14:02Z");
check(
  "被中断没落 endedAt 时退到本轮起点（宁可多告知一次）",
  selfAnchor(row({ id: "x", agentType: "claude", startedAt: "2026-08-04T03:03:20Z", endedAt: null, turnStartedAt: "2026-08-04T13:00:00Z" })),
  "2026-08-04T13:00:00Z",
);

// ── hasNewPeer：本议题的核心口径 ────────────────────────────────────────────
const peersOfClaude = collectPeers(TASK, [claude, codex], "claude");
check("codex 是在 claude 上一轮之后进来的 → 是新面孔", hasNewPeer(peersOfClaude, selfAnchor(claude)), true);
check("同一批同伴不会被反复告知", hasNewPeer(peersOfClaude, "2026-08-04T15:20:42Z"), false);
check("首次入场时在场的都算新面孔", hasNewPeer(peersOfClaude, null), true);
check("没有同伴就没有新面孔", hasNewPeer([], null), false);

// ── peerNoticeFor：端到端走一遍那个现场 ─────────────────────────────────────
// ① claude 第一轮：任务里只有它自己 → 不给（没有别人可列）
check(
  "原生 agent 第一轮：不给",
  peerNoticeFor({ taskId: TASK, self: "claude", all: [claude], prev: claude }),
  "",
);
// ② codex 被 @ 进来：claude 早就在场，它是首次入场 → 给
check(
  "被召唤者首次入场：给",
  peerNoticeFor({ taskId: TASK, self: "codex", all: [claude], prev: undefined }).includes("claude"),
  true,
);
// ③ 用户回头叫 claude：codex 是新面孔 → 给。**这一条就是原来漏掉的那个场景**：
//    claude 从没被召唤过，挂在 invited 上时它一次都收不到。
const back = peerNoticeFor({ taskId: TASK, self: "claude", all: [claude, codex], prev: claude });
check("原生 agent 后来遇到新同伴：给", back.includes("codex"), true);
check("给的时候带上记录文件名", back.includes("Zv1E0VUjPrBj.md"), true);
check("明说上下文互相不可见", back.includes("互相看不到"), true);
check("读不读交给它自己判断（不是命令它先读）", back.includes("由你自己判断"), true);
// ④ 再叫一次 claude：codex 已经不是新面孔 → 不给
check(
  "同一个同伴不会每轮重复告知",
  peerNoticeFor({
    taskId: TASK,
    self: "claude",
    all: [claude, codex],
    prev: row({ ...claude, endedAt: "2026-08-04T15:44:35Z" }),
  }),
  "",
);
// ⑤ 又来了第三个 → 再给一次，且名单是**全量**最新的，不只有新来的那个
const kimi = row({ id: "Kmi3rdSession", agentType: "kimi", startedAt: "2026-08-04T17:00:00Z" });
const third = peerNoticeFor({
  taskId: TASK,
  self: "claude",
  all: [claude, codex, kimi],
  prev: row({ ...claude, endedAt: "2026-08-04T15:44:35Z" }),
});
check("第三个同伴进来会重新告知", third !== "", true);
check("重新告知时给的是全量名单（老同伴也在）", third.includes("codex") && third.includes("kimi"), true);

// ── 文案：智能体名字一律来自数据，不写死 ────────────────────────────────────
const text = peerNoticeText([{ agentType: "grok", firstSeenAt: "x", transcripts: ["/tmp/a.md"] }]);
check("名单按实际参与者渲染", text.includes("grok：/tmp/a.md"), true);
check("没写死 codex", peerNoticeText([{ agentType: "kimi", firstSeenAt: "x", transcripts: ["/tmp/b.md"] }]).includes("codex"), false);

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
