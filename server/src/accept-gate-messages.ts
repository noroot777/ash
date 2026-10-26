export const gateStoppedSummary = (executionMode: string | null): string => executionMode === "macos-observed"
  ? "已识别进程已收尾，快照保留；不代表未观察后代全部退出" : "残留进程已收掉";

export const gateFailurePrompt = (details: { command: string; summary: string; logPath: string; tail: string;
  cwd: string; sourceCwd: string; executionNotice?: string | null; failure?: AcceptGateFailure | null }) =>
  `【验收未通过 · 验收前置命令没过】\n` +
  `本次验收触发了项目设置的验收前置命令，ash 在合并**之前**于独立快照 \`${details.cwd}\` 跑了它（${details.executionNotice ? "停止后快照保留，不自动删除" : "停止后快照会删除"}）。\n` +
  (details.executionNotice ? `${details.executionNotice}\n` : "") +
  `在当前任务工作区复现这条命令：\n\n    cd ${details.sourceCwd} && ${details.command}\n\n` +
  `结果：${details.summary}。所以**没有合并、没有清理**，目标分支一个字节都没动。\n\n` +
  (details.failure === "timeout" ? "这是整条命令超时，不是已经定位到某个断言失败。日志最后的成功提示只说明那一步的断言完成，不能证明浏览器、开发服务或测试进程已经退出；首次卡住的原因仍需核实。\n\n" : "") +
  `完整日志在 \`${details.logPath}\`，末尾是：\n\n\`\`\`\n${details.tail.trim() || "（日志为空）"}\n\`\`\`\n\n` +
  `请你来处理：\n` +
  `1. 在自己的工作目录里重跑这条命令，定位到底是哪一条红的；\n` +
  `2. 确属本次改动引入 → 修掉并提交，然后告诉用户可以重新点验收（验收会自动再跑一遍这条命令）；\n` +
  `3. 如果你判断它**跟本次改动无关**（基线既有的红、环境缺件、负载敏感的 flake），不要硬改：` +
  `把依据写清楚（单跑复核的结果、基线上同样红的证据），让用户决定是这次跳过门禁，还是另立一个任务去修。\n\n` +
  `不要自己去动目标分支，也不要绕过这条命令 —— 它是用户给这个项目定的放行条件。`;
import type { AcceptGateFailure } from "@ash/shared/accept-gate";
