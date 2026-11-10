import type { HandoffTarget } from "./handoff.ts";
import type { AcceptClean } from "./workflow.ts";

/**
 * 输入框里「哪一下算发送」。
 *  · `enter`     回车直接发，Shift+回车换行（出厂默认）
 *  · `mod-enter` ⌘/Ctrl+回车才发，回车只换行
 *
 * 前端的单点实现在 `web/src/lib/sendKey.ts`：发送判据和提示文案都从那里取，
 * 每个输入框自己写一遍 `metaKey || ctrlKey` 的话，改了这一档必有几个框跟不上。
 */
export const COMPOSER_SEND_KEYS = ["enter", "mod-enter"] as const;
export type ComposerSendKey = (typeof COMPOSER_SEND_KEYS)[number];

/**
 * 界面配色。`system` 跟随操作系统的深浅色(出厂默认,和手机端一致),另外两档钉死。
 *
 * 前端的单点实现在 `web/src/lib/theme.ts`:它把这一档解析成页面根上的
 * `data-theme="light|dark"`,全站颜色都从 `web/src/styles/global.css` 的变量取。
 */
export const COLOR_THEMES = ["system", "light", "dark"] as const;
export type ColorTheme = (typeof COLOR_THEMES)[number];

export interface AppSettings {
  defaultWorkflowId: string;
  skillRefreshSeconds: number;
  claudeModelRefreshHours: number;
  claudeCustomModelIds: string[];
  handoffTargets: HandoffTarget[];
  handoffRequireApproval: boolean;
  handoffEncrypt: boolean;
  handoffMaxBodyMb: number;
  // 归档时连 worktree/分支一起收到什么程度（用户 2026-10-08 要求「归档也删」）。
  // 复用验收清理那三档语义与标签：all=删 worktree 和任务分支、worktree=只删
  // worktree、none=都留着（上线前的旧行为）。归档删分支前先把末端存成恢复引用，
  // 未合并的也删；worktree 不带 `--force`，有未提交改动就留着，见 task-archive-cleanup.ts。
  archiveClean: AcceptClean;
  composerSendKey: ComposerSendKey;
  colorTheme: ColorTheme;
  instanceMode: "" | "single" | "multi";
  rootDir: string;
  sharedHostCli: boolean;
  /**
   * 首启向导走完(或被跳过)的那一刻,ISO 时间串;`""` = 还没走完。
   *
   * 个人面的键(PERSONAL_SETTING_KEYS):多人模式下供应商与执行器都是一人一套,
   * 新来的人同样要被领着配一遍,所以这个标志也得一人一份。
   *
   * **它只是「用户已经表过态」的凭据,不是判据本身** —— 判据在
   * `server/src/onboarding.ts`:已经有执行器或项目的实例一律算走过,否则这一版
   * 升上去会给每台老实例糊一屏欢迎页。
   */
  onboardedAt: string;
}

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({
  defaultWorkflowId: "",
  skillRefreshSeconds: 3600,
  claudeModelRefreshHours: 6,
  claudeCustomModelIds: [],
  handoffTargets: [],
  handoffRequireApproval: true,
  handoffEncrypt: true,
  handoffMaxBodyMb: 512,
  archiveClean: "all",
  composerSendKey: "enter",
  colorTheme: "system",
  instanceMode: "",
  rootDir: "",
  sharedHostCli: false,
  onboardedAt: "",
});
