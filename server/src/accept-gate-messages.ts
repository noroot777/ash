import type { AcceptGateFailure, AcceptGateMissAttribution } from "@ash/shared/accept-gate";

export const gateStoppedSummary = (executionMode: string | null): string => executionMode === "macos-observed"
  ? "已识别进程已收尾，快照保留；不代表未观察后代全部退出" : "残留进程已收掉";

type GateFailureDetails = { command: string; summary: string; logPath: string; tail: string;
  cwd: string; sourceCwd: string; executionNotice?: string | null; failure?: AcceptGateFailure | null;
  /** 归类结论（accept-gate-miss.ts）。 */
  diagnosis?: string | null;
  /** 「命令没解析出来」是不是这次改动造成的。免修那副面孔**只许**由 not-mine 授权。 */
  missAttribution?: AcceptGateMissAttribution | null };

/**
 * 红了之后交回给 agent 的那份 prompt。**三副面孔，判据是两件分开的事实**：
 *
 *  ① `failure === "command_missing"` —— 测试有没有启动。由起跑前那份事实授权
 *     （accept-gate-entry.ts），不看日志措辞，也不看 diagnosis 的真假值（第 1 轮审查 F2：
 *     按「有没有诊断文字」分支，会把一处 inner 的缺模块也交成「不要改任何代码」）。
 *  ② `missAttribution` —— 该不该由 agent 去改代码。
 *
 * 为什么必须是两件（第 3 轮审查 F2）：旧版本只有 ①，于是「核实过基线上也没有」和「压根
 * 没核出来」走同一个免修分支 —— 等于拿「没证明是你删的」当「证明不是你删的」。任务里误删
 * 了验收脚本、而目标 ref 又恰好读不到时，agent 就被按住不许修。
 *
 *  - command_missing + not-mine → 让它去修代码是在派一件做不到的活。本机四次实测：执行者
 *    为此把命令在两个提交上各复跑一遍，最后还是停下来问用户。这一种明确不许动代码。
 *  - command_missing + unknown  → 测试确实没启动（这一条核过），但归因没核出来。所以**先去
 *    核归因**：是这次改动弄没的就修掉，不是的话再把结论转述给用户。不发免修指令。
 *  - 其余（含 inner、以及 mine） → 老样子：去重跑、定位、修掉，或者拿出「跟本次改动无关」
 *    的依据。那段观察仍然附上去，它是定位的线索，不是免修的理由。
 */
export const gateFailurePrompt = (details: GateFailureDetails) => {
  const missing = details.failure === "command_missing";
  // 免修那副面孔只许由**核实过**的 not-mine 授权；unknown 走「先核归因」那一副。
  const exempt = missing && details.missAttribution === "not-mine";
  return `【验收未通过 · ${missing ? "验收前置命令没能启动" : "验收前置命令没过"}】\n` +
  `本次验收触发了项目设置的验收前置命令，ash 在合并**之前**于独立快照 \`${details.cwd}\` 跑了它（${details.executionNotice ? "停止后快照保留，不自动删除" : "停止后快照会删除"}）。\n` +
  (details.executionNotice ? `${details.executionNotice}\n` : "") +
  `在当前任务工作区复现这条命令：\n\n    cd ${details.sourceCwd} && ${details.command}\n\n` +
  `结果：${details.summary}。所以**没有合并、没有清理**，目标分支一个字节都没动。\n\n` +
  (details.failure === "timeout" ? "这是整条命令超时，不是已经定位到某个断言失败。日志最后的成功提示只说明那一步的断言完成，不能证明浏览器、开发服务或测试进程已经退出；首次卡住的原因仍需核实。\n\n" : "") +
  (details.diagnosis ? `${details.diagnosis}\n\n` : "") +
  `完整日志在 \`${details.logPath}\`，末尾是：\n\n\`\`\`\n${details.tail.trim() || "（日志为空）"}\n\`\`\`\n\n` +
  (exempt
    ? `请你来处理：\n` +
      `1. **以上面那段结论为准**。那条命令点名要跑的东西在被测快照里解析不出来（起跑前核过），所以日志里没有任何断言结果可看；`
        + `而它在开工基线上也没有，这一条也核过了 —— 所以**不要为这件事改任何代码**，也不要为了让它跑起来去补脚本、改项目配置；\n` +
      `2. **不要为了确认而反复复跑**：结论里写了核到哪一步、哪几件没核出来，照它说的办。要复核就只跑一次，别在多个提交上各来一遍；\n` +
      `3. 把上面那段结论连同它给的出路**转述给用户**，由他拍板。你自己既不要合分支，也不要跳过门禁 —— 那两件都是他的决定。\n\n` +
      `如果你判断上面那条结论本身是错的（命令其实跑起来了、红的是真的断言），把依据写清楚再说，不要默认它对。`
    : missing
      ? `请你来处理：\n` +
        `1. 那条命令点名要跑的东西在被测快照里解析不出来（起跑前核过），所以日志里没有断言结果可看 —— 不用去读日志找哪条测试红了；\n` +
        `2. **先核一件事：是不是你这次改动把它弄没的**（删掉、改名，或者改了项目设置里那条命令）。ash 这次没能核出来，所以不替你下结论。`
          + `是的话 → 改回来或同步改配置，提交，再告诉用户可以重新点验收；\n` +
        `3. 核下来跟这次改动无关 → 把上面那段结论连同它给的出路转述给用户，由他决定是把目标分支合进来再验收、还是这一次显式跳过门禁。那两件都是他的决定，你别自己做。\n\n` +
        `别为了「让它跑起来」去凭空补一个脚本：那是在伪造放行条件。`
      : `请你来处理：\n` +
        `1. 在自己的工作目录里重跑这条命令，定位到底是哪一条红的；\n` +
        `2. 确属本次改动引入 → 修掉并提交，然后告诉用户可以重新点验收（验收会自动再跑一遍这条命令）；\n` +
        `3. 如果你判断它**跟本次改动无关**（基线既有的红、环境缺件、负载敏感的 flake），不要硬改：` +
        `把依据写清楚（单跑复核的结果、基线上同样红的证据），让用户决定是这次跳过门禁，还是另立一个任务去修。\n\n` +
        `不要自己去动目标分支，也不要绕过这条命令 —— 它是用户给这个项目定的放行条件。`);
};
