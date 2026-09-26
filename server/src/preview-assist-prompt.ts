// AI 协助填预览脚本的提示词。单独一份，理由是它要说的三件事各有各的出处，混在流程代码
// 里迟早会跟出处漂开：
//   ① 端口怎么进到命令里 —— 跟界面上那句小字同源（shared 的 previewPortRuleText）；
//   ② ash 怎么判定「起来了」—— 跟 preview-trial.ts 的判据同源（进程活着 + 端口有响应）；
//   ③ 不许动用户的仓库 —— 跟 preview-deps.ts 顶部那条线同源。
//
// 结论格式只有一种写法（PREVIEW_ASSIST_MARKER + 围栏块），解析器就认它，见
// shared/src/preview-assist.ts 的 parseAssistScript。
import { PREVIEW_ASSIST_MARKER } from "@ash/shared/preview-assist";
import { PREVIEW_MODE_LABELS, previewPortDialect, previewPortRuleText, previewPortRef, type PreviewMode } from "@ash/shared/preview";

/** 每一档 `$ASH_PREVIEW_MODE` 对脚本作者的意思。四档只有认这个变量的脚本才有区别。 */
const MODE_NOTE: Record<PreviewMode, string> = {
  command: "按项目自己的启动命令来，ash 不额外要求起什么。",
  frontend: "只起前端；这一档的脚本通常把 /api 打回正在跑的这台 ash（地址在 $ASH_HOST_API）。",
  full: "前后端都要起，后端用一个独立的新库，别碰用户正在用的数据。",
  test: "前后端都要起，后端用测试库快照。",
};

const dialect = () => previewPortDialect(process.platform);
const ref = (name: string) => previewPortRef(name, dialect());

export function assistOpeningPrompt(opts: {
  repoPath: string;
  mode: PreviewMode;
  currentScript: string;
}): string {
  const shell = process.platform === "win32" ? "cmd" : "sh -lc（登录 shell）";
  return [
    "你在帮 ash 的「预览」功能判断一件事：**这个项目该用什么命令，起一个能在浏览器里打开的开发服务**。",
    "",
    `项目目录（你已经在里面）：${opts.repoPath}`,
    opts.currentScript.trim()
      ? `用户目前填的脚本（起不起得来未知，可参考也可推翻）：\n\`\`\`sh\n${opts.currentScript.trim()}\n\`\`\``
      : "用户还没填过启动脚本。",
    "",
    "## 硬约束",
    `1. 端口不是你定的。${previewPortRuleText(dialect())}`,
    `2. 脚本在项目根目录执行（${shell}），可以多行、可以 cd 进子目录。`,
    "3. 必须是**前台**常驻进程：不要 `&`、`nohup`、`docker compose up -d` 这类起完就退的写法 —— ash 靠「进程还活着 + 借出去的端口上有响应」判定成功，退出即判失败。",
    "4. 优先 dev server（热更新那种）。只有项目确实没有 dev server 时才退而求其次 build + serve。",
    `5. 要起好几个服务就用一条脚本全起：配角用 ${ref("PORT2")}～${ref("PORT5")}、地址用 ${ref("URL2")}～${ref("URL5")}，配角丢后台，主角最后前台跑。`,
    `6. ash 会把 ASH_PREVIEW_MODE=${opts.mode}（${PREVIEW_MODE_LABELS[opts.mode]}）递给脚本：${MODE_NOTE[opts.mode]}`,
    "7. **这是用户的工作仓库，一个字节都不要改**：不改代码、不改锁文件、不 git 提交、不装依赖、不删缓存。缺依赖导致起不来就如实说，由用户自己决定装不装。",
    "8. 你可以自己挑个空闲端口试跑确认（推荐），但结束前**必须把你起的所有进程停干净**。",
    "",
    "## 交付物",
    `最后一段按这个格式给结论，ash 只认这个格式，会原样拿去真跑一遍：`,
    "",
    `${PREVIEW_ASSIST_MARKER}：`,
    "```sh",
    "<可以直接粘进预览设置的脚本>",
    "```",
    "",
    "围栏块里**只放脚本本身**：不要把你试跑的终端回显（`$ …`、`> …`、退出码）粘进去。",
    `判断这个项目**根本起不起来**（没有 dev server、缺依赖、要先起外部服务…）时，就说清楚原因，**不要写「${PREVIEW_ASSIST_MARKER}」那一段** —— 给一条你自己都不信的命令，只会让 ash 再白跑一轮。`,
    "",
    "别给「大概是这个」的答案：ash 拿到后会借一个真端口在这个目录里真跑一遍，起不来我会把失败原因和日志甩回来让你再来一轮。",
  ].filter(Boolean).join("\n");
}

export function assistRetryPrompt(opts: {
  script: string;
  reason: string;
  log: string;
  round: number;
  maxRounds: number;
}): string {
  return [
    `ash 照你给的脚本真跑了一遍，**没起来**（第 ${opts.round - 1} 轮）。`,
    "",
    "脚本：",
    "```sh",
    opts.script,
    "```",
    `失败原因：${opts.reason}`,
    "",
    "日志尾巴：",
    "```",
    opts.log.slice(-4000),
    "```",
    "",
    opts.round >= opts.maxRounds
      ? "这是最后一轮，修正后仍按原格式给出结论。"
      : "请据此修正（必要时再读读项目、自己试一下），仍按原格式给出结论。",
    "仓库照旧一个字节都不要改。",
  ].join("\n");
}
