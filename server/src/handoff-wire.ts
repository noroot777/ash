// 接力线上的产品标记。对端是另一台机器上的 Navi，**可能还是改名之前的版本**（局域网里的另一台
// 不会跟本机同一刻升级），所以这里每一项都是「旧版认得的照旧写，新旧都认」：
//
//  · ping 应答的 `service`：旧版发起方严格比对 `=== "ash"`，写成新名它就判「对端不是 Navi」。所以
//    照旧写旧值，收的时候新旧都认。拆：局域网里的对端都升级之后，改成写 "navi"。
//  · 错误应答上的可信标记（「这是对端业务层明确拒绝的，可证明没落库」）：旧版只认 `ash: true`，
//    新版再写一个 `navi: true`；收的时候认任一个。
//  · 签名头、账号 key 头：新旧两代名字各发一份（`withLegacyHeaderNames`），收的时候 `readHeader`。
import { LEGACY_HANDOFF_SERVICE } from "@navi/shared/legacy-names";
import { TASK_BRANCH_PREFIX } from "@navi/shared/task-branch";
import { expandHome, localBranchExists, resolveWorktreeBranchName } from "./git.js";

/** ping 应答里写的 `service`（见顶部第一条）。 */
export const HANDOFF_WIRE_SERVICE = LEGACY_HANDOFF_SERVICE;

/** 收到的 ping 应答是不是 Navi（任一代）。 */
export const isHandoffService = (service: unknown): boolean =>
  service === "navi" || service === LEGACY_HANDOFF_SERVICE;

/** 错误应答上的可信标记，两代各一份。展开进应答体：`{ error, ...HANDOFF_TRUSTED_MARK }`。 */
export const HANDOFF_TRUSTED_MARK = { navi: true, [LEGACY_HANDOFF_SERVICE]: true } as const;

/** 对端的错误应答带没带可信标记（任一代）。 */
export const hasHandoffTrustedMark = (payload: Record<string, unknown> | null | undefined): boolean =>
  payload?.navi === true || payload?.[LEGACY_HANDOFF_SERVICE] === true;

/**
 * 改名之前的对端认不出 `navi/` 开头的任务分支：它按 `ash/<id8>` 去找这条任务的分支，找不到就在
 * 那边新开一个空的 worktree，带过去的代码进度挂不上（只留一句「分支名不一致」的备注）。所以对端
 * 没在 ping 里报 `taskBranchPrefix`（= 改名之前的版本）、而这条任务的分支是新前缀时，**在打包之前
 * 就拒绝并说清原因**。升级之前建的任务分支还是 `ash/…`，旧版认得，照常放行。返回 null = 不拦。
 */
export async function legacyPeerBranchRefusal(
  ping: { taskBranchPrefix?: string },
  task: { id: string; useWorktree: boolean | null },
  repoPath: string,
): Promise<string | null> {
  if (ping.taskBranchPrefix || !task.useWorktree) return null;
  const branch = await resolveWorktreeBranchName(repoPath, task.id);
  if (!branch.startsWith(TASK_BRANCH_PREFIX)) return null;
  if (!(await localBranchExists(expandHome(repoPath), branch))) return null;
  return `对端还是改名之前的版本：它只认 ash/ 开头的任务分支，这条任务的分支是 ${branch}，`
    + "传过去代码进度挂不上。先把对端升级到 Navi，再接力。";
}
