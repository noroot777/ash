import { GATE_FAILURE_REGRESSION_CARVE_OUT } from "@ash/shared/free-workflow";
import { summarizeAcceptGate, type AcceptGateFailure, type AcceptGateView } from "@ash/shared/accept-gate";

export const gateStoppedSummary = (executionMode: string | null): string => executionMode === "macos-observed"
  ? "已识别进程已收尾，快照保留；不代表未观察后代全部退出" : "残留进程已收掉";

type GateFailureDetails = { command: string; summary: string; logPath: string; tail: string;
  cwd: string; sourceCwd: string; executionNotice?: string | null; failure?: AcceptGateFailure | null;
  /** 入口那句话（accept-gate-entry.ts 的 gateEntryNote）：起跑前核到的事实，原样附上。 */
  entryNote?: string | null;
  /**
   * 合并预览档（AcceptGateBaseline）：快照里先合进来的那个目标分支提交。红可能只在两边合在一起
   * 之后才出现（一边改了名、一边还用旧名），在任务工作区原样复现会是绿的 —— 所以要先说破。
   */
  preview?: { branch: string; commit: string } | null };

/**
 * 红了之后交回给 agent 的那份 prompt。**只有一副面孔：去定位、去修，或者拿出「跟本次改动
 * 无关」的依据。**
 *
 * 曾经有一副「命令没能启动、不要为这件事改任何代码」的免修面孔，授权它的是跑完之后从日志里
 * 反推的归因 —— 那条路证明不了报错来自哪一层，第 10 轮审查后撤掉，2026-11 连归因一起删了。
 * 现在只附起跑前核到的那句事实（`entryNote`），它是线索，不是免修的理由。
 */
export const gateFailurePrompt = (details: GateFailureDetails) =>
  `【验收未通过 · 验收前置命令没过】\n` +
  (details.failure === "entry_missing"
    // 没起跑的那一档不许说「跑了它」：同一份输入后面还要附「命令没有起跑」那句（第 1 轮审查 N1）。
    ? `本次验收触发了项目设置的验收前置命令，ash 在合并**之前**于独立快照 \`${details.cwd}\` 核对了它的入口，没有起跑。\n`
    : `本次验收触发了项目设置的验收前置命令，ash 在合并**之前**于独立快照 \`${details.cwd}\` 跑了它（${details.executionNotice ? "停止后快照保留到任务验收、归档或删除" : "停止后快照会删除"}）。\n`) +
  (details.executionNotice ? `${details.executionNotice}\n` : "") +
  (details.preview
    ? `这个项目的门禁基准是「合并预览」：快照里先把 \`${details.preview.branch}\`@${details.preview.commit.slice(0, 8)} 合进了任务分支，`
      + `测的是合并结果。红可能来自两边改动合在一起才出现的冲突，复现前先在工作区 \`git merge ${details.preview.branch}\`。\n`
    : "") +
  `在当前任务工作区复现这条命令：\n\n    cd ${details.sourceCwd} && ${details.command}\n\n` +
  `结果：${details.summary}。所以**没有合并、没有清理**，目标分支一个字节都没动。\n\n` +
  (details.failure === "timeout"
    ? "这是整条命令超时，不是定位到了某个断言失败。回显末尾的「被收掉时的现场」给了停在哪一行、多久没输出、"
      + "整段的产出节奏：日志只证明在输出，不证明在前进；最后那句成功提示只说明那一步断言完成，"
      + "不代表浏览器、开发服务或测试进程已经退出。\n\n"
    : "") +
  (details.entryNote ? `${details.entryNote}\n\n` : "") +
  `完整日志在 \`${details.logPath}\`，末尾（含同名 \`.notes\` 进度、\`.scene\` 现场）：\n\n` +
  `\`\`\`\n${details.tail.trim() || "（日志为空）"}\n\`\`\`\n\n` +
  `${GATE_FAILURE_REGRESSION_CARVE_OUT}\n\n` +
  `请你来处理：\n` +
  `1. 在自己的工作目录里跑这条命令，定位到底是哪一条红的；\n` +
  `2. 确属本次改动引入 → 修掉并提交，然后告诉用户可以重新点验收（验收会自动再跑一遍这条命令）；\n` +
  `3. 如果你判断它**跟本次改动无关**（基线既有的红、环境缺件、负载敏感的 flake），不要硬改：` +
  `把依据写清楚（只跑那一条的复核结果、基线上同样红的证据），让用户决定是这次跳过门禁，还是另立一个任务去修。\n\n` +
  `不要自己去动目标分支，也不要绕过这条命令 —— 它是用户给这个项目定的放行条件。`;

/**
 * 一行记录的投影（`gateView`）→ 这份模板要的字段。**两条交接路（自动、验收台上手动再交）
 * 都从这里走**，所以「哪些字进得去、哪些字进不去」只有这一处说法。
 *
 * **读 view，不读 row**（第 9 轮审查 N1）：自动交接手里的 row 是结算**前**那一行，
 * failure 还空着，照它说话会跟卡片上写的不是一回事。
 */
export const gateFailureInputFor = (view: AcceptGateView, sourceCwd: string): string =>
  gateFailurePrompt({
    // 准备命令没过时要复现的是它：前置命令一行都没跑（摘要里已经说破）。
    command: view.failure === "prepare_failed" && view.prepareCommand ? view.prepareCommand : view.command, summary: summarizeAcceptGate(view), logPath: view.logPath,
    failure: view.failure, entryNote: view.entryNote ?? null,
    tail: view.logTail, cwd: view.cwd, sourceCwd, executionNotice: view.executionNotice,
    preview: view.previewBase && view.targetBranch ? { branch: view.targetBranch, commit: view.previewBase } : null,
  });
