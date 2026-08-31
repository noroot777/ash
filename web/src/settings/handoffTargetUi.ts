// 接力目标机行的公共展示逻辑。自用模式那份清单(HandoffSettings)和多人模式的按人
// 清单(UserHandoffTargets)长得一样、判据也一样,只是存储位置不同 —— 判据抄两份的话,
// 「对方已接受 / 等待对方接受」这类文案迟早在一边先漂。
import type { HandoffApprovalResult } from "@ash/shared";

export const HANDOFF_URL_RE = /^https?:\/\/\S+$/;
export const HANDOFF_PEERS_CHANGED_EVENT = "ash:handoff-peers-changed";

export const normalizeTargetUrl = (url: string): string => url.trim().replace(/\/+$/, "");

const peerStatusOf = (result?: HandoffApprovalResult) => result?.peer?.peerStatus ?? null;

export const approvalStateLabel = (result?: HandoffApprovalResult) => {
  const status = peerStatusOf(result);
  if (status === "pending") return "等待对方接受";
  if (status === "approved") return "对方已接受";
  if (status === "open") return "对方无需审批";
  if (status === "blocked") return "对方已拒绝";
  if (result) return "目标机版本过旧";
  return "申请后核对身份";
};

export const approvalStateClass = (result?: HandoffApprovalResult) => {
  const status = peerStatusOf(result);
  if (status === "pending") return "is-pending";
  if (status === "approved" || status === "open") return "is-approved";
  if (status === "blocked") return "is-blocked";
  return "is-unknown";
};

/**
 * 申请发出去了，但对端认不出这条是谁的。
 *
 * 对端是多人实例时，一条申请**该只打扰它冲着的那个人**（server 的 peerAudience）。
 * 认人靠的是「我在对端的账号 key」；没填就只能落成无主申请，推给对面全体成员处理 ——
 * 那正是「凭什么不相干的人也收到我的申请、还能替我批」的来源。申请本身不拦（人可能
 * 正要靠这一步开口要账号），但得当场说清楚。
 */
export const unclaimedHint = (result: HandoffApprovalResult): string =>
  result.unclaimed
    ? "。你还没填「我在对端的账号 key」，对方看到的会是一条无主申请（它上面每个人都会看到、都能批）；填上 key 再申请一次就只送到你名下"
    : "";

export const approvalNotice = (name: string, result: HandoffApprovalResult) => {
  const status = peerStatusOf(result);
  if (status === "pending") return `已向「${name}」发送申请，请等待对方接受后再接力${unclaimedHint(result)}`;
  if (status === "approved") return `「${name}」已接受申请，可以开始接力`;
  if (status === "open") return `「${name}」没有开启审批，可以直接接力`;
  if (status === "blocked") return `「${name}」已拒绝这台机器的接力申请`;
  return `「${name}」版本过旧，无法确认申请状态`;
};

/** 和服务端 shortFingerprint 同一套:前 20 个 hex 分 5 组,只用于展示。 */
export const shortOf = (fingerprint: string) =>
  (fingerprint.slice(0, 20).toUpperCase().match(/.{1,4}/g) ?? []).join("-");
