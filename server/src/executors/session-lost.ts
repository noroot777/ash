/**
 * 「CLI 说这条会话它不认识」的识别。
 *
 * ash 每一轮续跑都把上一轮记下的 `sessions.cli_session_id` 拼成 `--resume <id>`。
 * 那个 id 是 ash 在**起跑那一刻**自己发的（`generic.ts` 的 `session()`：claude 一类
 * 带 `newIdFlag` 的 CLI 由 ash 指定 id），落库时机是 spawn 成功、还没等到 CLI 说话。
 * 于是有一类死循环：**第一轮 CLI 根本没建起会话就退出了**（2026-08-21 的现场是
 * root 身份下 `--dangerously-skip-permissions` 被拒，0 字节 stdout），id 照样落了库；
 * 之后每一次重试都 `--resume` 一个从未存在过的会话，稳定失败，且失败原因跟第一次
 * 完全不同 —— 用户修好了真正的病因，任务却还是红的，看不出关系。
 *
 * 同一个坑还有别的入口：`~/.claude` 被清过、把库从另一台机器搬过来、worktree 换了
 * 路径（claude 的会话按 cwd 分库）。所以修法不是「别落那个 id」，而是**认出 CLI 的
 * 这声否认，把失效的 id 清掉**，让下一次运行老老实实开一条新会话。
 *
 * 只收**实测见过原文**的 CLI。猜一条正则的代价是误清一条本来能续的会话，
 * 不值当 —— 认不出来时的退化行为（照旧报错、id 留着）本来就是今天的行为。
 */

import { SESSION_LOST_NOTE, SESSION_POISONED_NOTE } from "@ash/shared/session-notes";
import type { ResumeFields } from "./types.js";

/** 各 CLI 拒绝恢复会话时的原文。加一条前先在真机上跑出那句话。 */
const LOST_PATTERNS: readonly RegExp[] = [
  // Claude Code 2.1.x：`claude --resume <uuid>` 找不到 transcript 时打在 stderr，
  // 同时把同一句塞进 stream-json 的 `result.errors[]`。
  /no conversation found with session id/i,
];

/** 这条错误信息是不是「你给的会话 id 不存在」。 */
export function isSessionLost(message: string): boolean {
  return LOST_PATTERNS.some((re) => re.test(message));
}

const CODEX_POISON_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /ignored world-state patch without a full snapshot\b/i,
    reason: "Codex stderr 出现 `ignored world-state patch without a full snapshot`，恢复 thread 缺少工具所需的完整 world-state。",
  },
  {
    pattern: /dropping turn-scoped item for unknown turn id\b/i,
    reason: "Codex stderr 出现 `dropping turn-scoped item for unknown turn id`，恢复 thread 已无法对应旧回合。",
  },
  {
    pattern: /failed to flush rollout after emitting terminal turn event:\s*thread\b[^\r\n]*\bnot found\b/i,
    reason: "Codex stderr 出现 `failed to flush rollout after emitting terminal turn event: thread … not found`，这条 thread 的 rollout 已出现恢复风险。",
  },
];

/** 真机要求 ash 作废恢复 thread 的 stderr 指纹。 */
export function codexSessionPoisonReason(message: string): string | null {
  return CODEX_POISON_PATTERNS.find(({ pattern }) => pattern.test(message))?.reason ?? null;
}

export function isCodexSessionPoisoned(message: string): boolean {
  return codexSessionPoisonReason(message) !== null;
}

export type SessionResumeFault = "lost" | "poisoned";

/** poisoned 优先：它即使伴随 exit 0 / turn.completed 也必须作废恢复字段。 */
export function sessionResumeFault(message: string): SessionResumeFault | null {
  if (isCodexSessionPoisoned(message)) return "poisoned";
  if (isSessionLost(message)) return "lost";
  return null;
}

/** 多条 error 事件合并时 poisoned 不能被更早的普通 lost 覆盖。 */
export function mergeSessionResumeFault(
  current: SessionResumeFault | null,
  message: string,
): SessionResumeFault | null {
  const next = sessionResumeFault(message);
  if (current === "poisoned" || next === null) return current;
  return next;
}

export function shouldDropSession(fault: SessionResumeFault | null, exitStatus: number): boolean {
  return fault === "poisoned" || (fault === "lost" && exitStatus !== 0);
}

/**
 * 清一条失效会话时要抹掉的全部字段。
 *
 * 光清 `cli_session_id` 不够:三件套恢复命令(`resume_command` / `relay_env` /
 * `resume_args`)是**由那个 id 派生**的,留着就会在界面上继续给用户一条复制粘贴就撞墙
 * 的命令。类型写成 `keyof ResumeFields` 映射,是为了让「以后给 ResumeFields 加了第四
 * 列却忘了在这儿清」变成编译错误,而不是又一次要靠人记得的约定。
 */
export const LOST_SESSION_PATCH: { cliSessionId: null } & { [K in keyof ResumeFields]: null } = {
  cliSessionId: null,
  resumeCommand: null,
  resumeEnv: null,
  resumeArgs: null,
};

/**
 * 清掉失效 id 之后写给用户的那两句话。
 *
 * 正文住在 `@ash/shared/session-notes` —— 前端 `noteTone` 要拿同一份文本判「这是会话
 * 轮换，不是执行失败」，两边各写一份就会漂移（那头一红，一个 exit 0 的正常回合在用户
 * 眼里就成了异常）。这里只做转发，服务端各处照旧从这个模块引。
 */
export { SESSION_LOST_NOTE, SESSION_POISONED_NOTE };

export const SESSION_DROP_PERSISTENCE_FAILED_NOTE =
  "ash 已停止本次进程继续使用这条失效的 CLI 会话；但恢复字段写入数据库失败，"
  + "下一次重新开台时可能再次尝试旧会话。";

export function sessionResumeFaultNote(fault: SessionResumeFault): string {
  return fault === "poisoned" ? SESSION_POISONED_NOTE : SESSION_LOST_NOTE;
}
