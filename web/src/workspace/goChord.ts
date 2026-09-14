// `G …`（go → 去哪儿）这一族两键连打：**换个地方看**，而不是对当前这个东西做什么。
//
//   G T  任务模式 ⇄ 当前项目（侧栏列表在看谁）
//   G S  项目设置
//
// 用两键连打而不是单键，是因为这一族要在**任何界面**上都按得到，而单键预算留给了列表里
// 高频的 j/k/f/c/r。前缀 g 同时是 Inspector `I G` 的第二键，两条序列因此必须互相让路，
// 判据写在 useWorkspaceShortcuts 里（谁先跑、谁清谁的半截状态）。
//
// 新增一档就往 GO_CHORD_KEYS 里加一行：键位、给用户看的标签、和 useWorkspaceShortcuts
// 里的分发从此只有这一份对照表，不会出现"提示写着 G X、按下去没反应"。

export const GO_CHORD_PREFIX = "g";

export const GO_CHORD_KEYS = {
  taskMode: "t",
  settings: "s",
} as const;

export type GoChordKey = (typeof GO_CHORD_KEYS)[keyof typeof GO_CHORD_KEYS];

const KEYS = new Set<string>(Object.values(GO_CHORD_KEYS));

export function isGoChordKey(key: string): key is GoChordKey {
  return KEYS.has(key);
}

export function goChordLabel(key: GoChordKey): string {
  return `${GO_CHORD_PREFIX.toUpperCase()} ${key.toUpperCase()}`;
}

export const TASK_MODE_SHORTCUT_LABEL = goChordLabel(GO_CHORD_KEYS.taskMode);
export const SETTINGS_SHORTCUT_LABEL = goChordLabel(GO_CHORD_KEYS.settings);
