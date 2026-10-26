import type { AcceptGateFailure } from "@ash/shared/accept-gate";

export const gateStoppedSummary = (executionMode: string | null): string => executionMode === "macos-observed"
  ? "已识别进程已收尾，快照保留；不代表未观察后代全部退出" : "残留进程已收掉";

type GateFailureDetails = { command: string; summary: string; logPath: string; tail: string;
  cwd: string; sourceCwd: string; executionNotice?: string | null; failure?: AcceptGateFailure | null;
  /** 归类结论（accept-gate-miss.ts）。非空时这份 prompt 换一副面孔，见下。 */
  diagnosis?: string | null };

/**
 * 红了之后交回给 agent 的那份 prompt。
 *
 * **两副面孔，判据是 `failure === "command_missing"`，不是「有没有诊断文字」**
 * （第 1 轮审查 F2 实测）：`diagnosis` 同时承载两档结论 —— 命令点名要跑的东西不在树里
 * （entry，会改写 failure），和命令内部某一步缺了东西（inner，**不**改写 failure）。
 * 旧版本按 diagnosis 的真假值分支，于是一处由这次改动写错的 `require` 路径也被交成
 * 「测试一行都没跑、不要改任何代码」，agent 只能回头再问用户要不要跳过。
 *
 *  - command_missing → 让它去修代码是在派一件做不到的活（那条命令起跑前核过、解析不出来）。
 *    本机四次实测：执行者为此把命令在两个提交上各复跑一遍，最后还是停下来问用户。所以
 *    这一种明确告诉它不要动代码，把结论和出路转述给用户，由用户拍板。
 *
 *    **这一副面孔不许自己断言「跟本次改动无关」**（第 2 轮审查 F1 末条）：缺失推不出无关 ——
 *    这次改动删掉或改名了验收脚本，门禁一样报「命令不在树里」。核实这件事的是
 *    accept-gate-diagnosis.ts（基线上有、快照里没了 = 这次改动弄没的，那时 failure 压根不会
 *    被改写成 command_missing），所以这里只说「以那段结论为准」，不替它下判断。
 *  - 其余（含 inner） → 老样子：去重跑、定位、修掉，或者拿出「跟本次改动无关」的依据。
 *    inner 的那段观察仍然附上去，它是定位的线索，不是免修的理由。
 */
export const gateFailurePrompt = (details: GateFailureDetails) => {
  const missing = details.failure === "command_missing";
  return `【验收未通过 · ${missing ? "验收前置命令没能启动" : "验收前置命令没过"}】\n` +
  `本次验收触发了项目设置的验收前置命令，ash 在合并**之前**于独立快照 \`${details.cwd}\` 跑了它（${details.executionNotice ? "停止后快照保留，不自动删除" : "停止后快照会删除"}）。\n` +
  (details.executionNotice ? `${details.executionNotice}\n` : "") +
  `在当前任务工作区复现这条命令：\n\n    cd ${details.sourceCwd} && ${details.command}\n\n` +
  `结果：${details.summary}。所以**没有合并、没有清理**，目标分支一个字节都没动。\n\n` +
  (details.failure === "timeout" ? "这是整条命令超时，不是已经定位到某个断言失败。日志最后的成功提示只说明那一步的断言完成，不能证明浏览器、开发服务或测试进程已经退出；首次卡住的原因仍需核实。\n\n" : "") +
  (details.diagnosis ? `${details.diagnosis}\n\n` : "") +
  `完整日志在 \`${details.logPath}\`，末尾是：\n\n\`\`\`\n${details.tail.trim() || "（日志为空）"}\n\`\`\`\n\n` +
  (missing
    ? `请你来处理：\n` +
      `1. **以上面那段结论为准**。那条命令点名要跑的东西在被测快照里解析不出来（起跑前核过），所以日志里没有任何断言结果可看。`
        + `除非结论里明确写了「这是这次改动弄没的」（那种会要求你去改代码），否则**不要为这件事改任何代码**，也不要为了让它跑起来去补脚本、改项目配置；\n` +
      `2. **不要为了确认而反复复跑**：结论里写了核到哪一步、哪几件没核出来，照它说的办。要复核就只跑一次，别在多个提交上各来一遍；\n` +
      `3. 把上面那段结论连同它给的出路**转述给用户**，由他拍板。你自己既不要合分支，也不要跳过门禁 —— 那两件都是他的决定。\n\n` +
      `如果你判断上面那条结论本身是错的（命令其实跑起来了、红的是真的断言），把依据写清楚再说，不要默认它对。`
    : `请你来处理：\n` +
      `1. 在自己的工作目录里重跑这条命令，定位到底是哪一条红的；\n` +
      `2. 确属本次改动引入 → 修掉并提交，然后告诉用户可以重新点验收（验收会自动再跑一遍这条命令）；\n` +
      `3. 如果你判断它**跟本次改动无关**（基线既有的红、环境缺件、负载敏感的 flake），不要硬改：` +
      `把依据写清楚（单跑复核的结果、基线上同样红的证据），让用户决定是这次跳过门禁，还是另立一个任务去修。\n\n` +
      `不要自己去动目标分支，也不要绕过这条命令 —— 它是用户给这个项目定的放行条件。`);
};
