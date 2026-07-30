import type { CliSpec } from "./types.js";

// 本轮新增的一项,**检测和执行两半都未核实**。前 14 项的检测字段都是逐个踩坑核对
// 过的(bin 名和产品名经常对不上),这一项还没走过那一遍,所以 bins 只是占位。
export const piSpec: CliSpec = {
  key: "pi",
  name: "Pi CLI",
  description: "Inflection 的 Pi 对话 CLI",
  // 占位:按产品名猜的,**待 B 阶段核实**。产品名和终端里敲的那个词经常对不上
  // (见 trae → traecli、qoder → qodercli、kiro → kiro-cli),所以核实前别当真。
  bins: ["pi"],
  docsUrl: "https://pi.ai/",
  installCommand: "npm install -g pi-cli",
  untested: true,
  notes:
    "本轮新增的占位项,bins / docsUrl / installCommand / 全部执行参数都**待 B 阶段核实**。" +
    "先确认三件事:①官方到底有没有发 CLI、包名与 bin 名是什么;②它是编码智能体还是纯聊天" +
    "(纯聊天没有工具与文件写入能力,当执行器派任务基本跑不动实事,这点必须如实回报);" +
    "③非交互调用方式。若查实官方没有可用 CLI,就在 notes 里写清结论并告知调度者删掉这一项" +
    "(删的动作是两步:shared 的 AGENT_TYPES 去掉 \"pi\" + 删本文件与 catalog/index.ts 的那行 import)。",
  exec: {
    prompt: { via: "flag", flag: "-p" },
  },
};
