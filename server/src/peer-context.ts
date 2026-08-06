// 同一个单飞任务里可以有多个智能体（@ 召唤出来的），但**每个 agentType 是一条
// 独立的 CLI 会话**（各自 cliSessionId，各自 --resume），彼此的对话上下文完全隔离：
// 它们只共享工作目录。于是「codex 刚在这个任务里查过什么、跟用户说过什么」对
// claude 来说是不存在的——除非它自己去考古（实测它真的会花好几个工具轮次去翻，
// 翻到的还未必是对的那份）。
//
// 而那些对话其实**已经在磁盘上**了：`data/runs/<taskId>/<sessId>.md` 就是一位智能体
// 在本任务中的完整对话，含用户对它说过的话（transcript.ts 的哨兵行）。所以这里不
// 搬运内容、不拼历史、不加状态字段，只做一件事：**把「有别人、在哪」这个事实告诉它**，
// 读不读由它自己判断。
//
// 为什么不自动把差量塞进 prompt：那要么每轮重复灌（token 白烧、还会盖过用户这轮
// 真正想说的话），要么得记「灌到哪了」的水位（新字段 + 新的一致性问题）。而审查/
// 验收类任务恰恰不该被实现者的自辩先入为主——由智能体按任务性质自行取舍，比系统
// 替它一刀切更准。
import { sessionTranscriptPath } from "./transcript.js";

export type PeerSessionRow = {
  id: string;
  agentType: string;
  startedAt: string;
  endedAt?: string | null;
  turnStartedAt?: string | null;
};

export type Peer = {
  agentType: string;
  /** 这个智能体第一次进入本任务的时刻——判定「新面孔」用它，不用它最近一轮。 */
  firstSeenAt: string;
  /** 它在本任务里的对话记录（绝对路径；一个 agentType 理论上一条会话，但不假定）。 */
  transcripts: string[];
};

// 本智能体「上一轮跑完」的时刻。新面孔判定的锚点：在这之后才出现的同伴，说明
// 上一轮告知时它还不在场，这一轮该补一次。
//
// 取 endedAt 而不是「上一次发言」：agent 那一轮可能一句正文都没写（工具跑完就结束），
// 拿发言当锚点会把同一批同伴反复告知。endedAt 在 resume 时被置 null，所以**必须在
// 更新 session 行之前**读出来（continueTask 里的 prev 正是更新前的快照）；被中断
// 没落 endedAt 时退到 turnStartedAt/startedAt，宁可多告知一次也不漏。
export function selfAnchor(prev: PeerSessionRow | undefined): string | null {
  if (!prev) return null; // 本智能体第一次被拉进来:在场的都算新面孔
  return prev.endedAt || prev.turnStartedAt || prev.startedAt || null;
}

// 把会话行按 agentType 收拢成同伴名单（不含自己），按首次出现时间排序。
export function collectPeers(
  taskId: string,
  all: PeerSessionRow[],
  self: string,
): Peer[] {
  const byType = new Map<string, Peer>();
  for (const s of all) {
    if (s.agentType === self) continue;
    const existing = byType.get(s.agentType);
    if (existing) {
      existing.transcripts.push(sessionTranscriptPath(taskId, s.id));
      if (s.startedAt < existing.firstSeenAt) existing.firstSeenAt = s.startedAt;
    } else {
      byType.set(s.agentType, {
        agentType: s.agentType,
        firstSeenAt: s.startedAt,
        transcripts: [sessionTranscriptPath(taskId, s.id)],
      });
    }
  }
  return [...byType.values()].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
}

// 有没有「上一轮之后才来的」同伴。没有新面孔就不再重复告知——它上一轮已经知道了。
export function hasNewPeer(peers: Peer[], anchor: string | null): boolean {
  if (!peers.length) return false;
  if (!anchor) return true;
  return peers.some((p) => p.firstSeenAt > anchor);
}

// 告知文案。刻意写得抽象:只陈述「有别人、上下文互相不可见、记录在这几个文件里」,
// 不规定它该怎么用、不暗示「先读它」——审查任务先读实现者的自辩再去看代码,比不读
// 更糟。列文件名是必要的:文件名是会话 id,光给目录它猜不出哪份是谁的。
export function peerNoticeText(peers: Peer[]): string {
  const lines = peers.map((p) => `- ${p.agentType}：${p.transcripts.join("、")}`);
  return (
    "〔本任务还有其他智能体参与〕这个任务不止你一个智能体在做，目前还有：\n" +
    `${lines.join("\n")}\n` +
    "你们各自持有独立的对话上下文，互相看不到对方说过什么、看到过什么。上面这些 .md 是它们在**本任务**中的完整对话记录，" +
    "包含用户对它们说过的话。\n" +
    "要不要读取由你自己判断：和它们的工作有交集、或者需要知道某处改动的来龙去脉时可以去读；能独立得出结论时不必读。" +
    "范围仅限本任务的这几个文件。\n\n"
  );
}

// 一站式:给 continueTask 用。没有同伴、或同伴都不是新面孔时返回空串。
export function peerNoticeFor(args: {
  taskId: string;
  self: string;
  all: PeerSessionRow[];
  prev: PeerSessionRow | undefined;
}): string {
  const peers = collectPeers(args.taskId, args.all, args.self);
  if (!hasNewPeer(peers, selfAnchor(args.prev))) return "";
  return peerNoticeText(peers);
}
