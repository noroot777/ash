import { GATE_FAILURE_REGRESSION_CARVE_OUT } from "@ash/shared/free-workflow";
import { summarizeAcceptGate, type AcceptGateFailure, type AcceptGateView } from "@ash/shared/accept-gate";

export const gateStoppedSummary = (executionMode: string | null): string => executionMode === "macos-observed"
  ? "已识别进程已收尾，快照保留；不代表未观察后代全部退出" : "残留进程已收掉";

type GateFailureDetails = { command: string; summary: string; logPath: string; tail: string;
  cwd: string; sourceCwd: string; executionNotice?: string | null; failure?: AcceptGateFailure | null;
  /** 归类结论（accept-gate-miss.ts）。线索与出路都在它里面，这份模板只负责把它附上。 */
  diagnosis?: string | null;
  /**
   * 这一次名下还存着一段**旧判据**那一代的结论（gateView 已经把它降成 legacyDiagnosis，
   * 所以上面的 `diagnosis` 不会是它）。这里只提一句失效，让 agent 别去捡时间线和日志里
   * 那段话 —— 那两处是 append-only 的历史，改不了（第 2 轮审查 F1）。
   */
  obsoleteDiagnosis?: boolean };

/**
 * 红了之后交回给 agent 的那份 prompt。**只有一副面孔：去定位、去修，或者拿出「跟本次改动
 * 无关」的依据。**
 *
 * 曾经有三副：「命令没能启动 + 不是你删的」那一副明确不许它动代码。那副面孔撤掉了
 * （第 10 轮审查 F1/F2）—— 授权它的是起跑前的纯读加日志形状，而这两样都绑不到真跑那一次的
 * 执行身份上：审查的反例里被测程序真跑了、真报了断言失败，三件授权条件却全都成立，于是一条
 * 真红被交成「不要为这件事改任何代码」。判据与已经走死的几条路见 accept-gate-miss.ts 的文件头。
 *
 * 归类结论（`diagnosis`）照旧附上去：它是定位的线索（那个名字在哪儿缺、目标分支上是什么
 * 情形、出路有哪几条），不是免修的理由。
 *
 * 第 3 条那个括号里**不列举「命令不在树里」**：真碰上那一档时，上面的 `diagnosis` 会把它
 * 连线索带出路讲完，而括号是每一次红都要付的字节（体积闸 accept/gate-failure 的余量只有
 * 个位数）。该说的话在它真的适用的那一次说。
 */
export const gateFailurePrompt = (details: GateFailureDetails) =>
  `【验收未通过 · 验收前置命令没过】\n` +
  `本次验收触发了项目设置的验收前置命令，ash 在合并**之前**于独立快照 \`${details.cwd}\` 跑了它（${details.executionNotice ? "停止后快照保留，不自动删除" : "停止后快照会删除"}）。\n` +
  (details.executionNotice ? `${details.executionNotice}\n` : "") +
  `在当前任务工作区复现这条命令：\n\n    cd ${details.sourceCwd} && ${details.command}\n\n` +
  `结果：${details.summary}。所以**没有合并、没有清理**，目标分支一个字节都没动。\n\n` +
  (details.failure === "timeout"
    ? "这是整条命令超时，不是定位到了某个断言失败。回显末尾的「被收掉时的现场」给了停在哪一行、多久没输出、"
      + "整段的产出节奏：日志只证明在输出，不证明在前进；最后那句成功提示只说明那一步断言完成，"
      + "不代表浏览器、开发服务或测试进程已经退出。\n\n"
    : "") +
  (details.diagnosis ? `${details.diagnosis}\n\n` : "") +
  (details.obsoleteDiagnosis ? "这一次名下还有一段旧版本的归类结论（时间线/日志里能翻到）：判据已撤回，别照它判断，按日志自己核。\n\n" : "") +
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
 * 两条硬规矩钉在这儿：
 *  - **读 view，不读 row**（第 9 轮审查 N1）：自动交接手里的 row 是结算**前**那一行，
 *    failure / 归因还空着，照它说话会跟卡片上写的不是一回事；
 *  - **旧判据那一代的结论不进来**（第 2 轮审查 F1）：`view.legacyDiagnosis` 只换成一句
 *    失效提醒，原文一个字都不往正式输入里带。
 */
export const gateFailureInputFor = (view: AcceptGateView, sourceCwd: string): string =>
  gateFailurePrompt({
    command: view.command, summary: summarizeAcceptGate(view), logPath: view.logPath,
    failure: view.failure, diagnosis: view.diagnosis ?? null,
    obsoleteDiagnosis: !!view.legacyDiagnosis,
    tail: view.logTail, cwd: view.cwd, sourceCwd, executionNotice: view.executionNotice,
  });
