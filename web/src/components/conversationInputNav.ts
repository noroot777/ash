// 单键 Q：把会话左侧那条输入导航整个摊开成一张列表（每一条我说过的话一行），
// 一眼找到要的那条、点一下跳过去。分发在 workspace/useWorkspaceShortcuts.ts。
//
// 导航条挂载时登记自己，按挂载先后排成一摞，跟 Inspector 快捷键同一个口径：抽屉里套着的
// 那份会话后挂、优先。眼下看不见的（所在面板被藏起来了、被抽屉盖住了）不算数，往下找；
// 一份都没有（新建面板、设置页、还没追问过的任务）就返回 false，调用方原样放过这颗键。

export const CONVERSATION_INPUTS_SHORTCUT = "q";

type ConversationInputsTarget = {
  /**
   * 此刻看不看得见：所在面板 display:none、或者被侧边抽屉整个盖住时它还挂着，但按 Q 打开一张
   * 看不见的列表不光等于没反应，那张列表还会把键盘收走（方向键、Esc 都落到它身上）。
   */
  available: () => boolean;
  toggle: () => void;
};

const targets: ConversationInputsTarget[] = [];

export function registerConversationInputsTarget(target: ConversationInputsTarget): () => void {
  targets.push(target);
  return () => {
    const index = targets.lastIndexOf(target);
    if (index >= 0) targets.splice(index, 1);
  };
}

/** 返回 false = 眼下没有哪条会话有输入导航，调用方别吞掉那个按键。 */
export function toggleConversationInputs(): boolean {
  const target = targets.findLast((candidate) => candidate.available());
  if (!target) return false;
  target.toggle();
  return true;
}
