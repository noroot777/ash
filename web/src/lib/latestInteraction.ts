// 「用户又动手了没」。两件事靠它：
//   · 异步动作判断自己有没有过期 —— 远端那种任务要先问一次持有机才打得开，迟到的那份
//     应答不许顶掉用户后来的选择；
//   · J/K 连着按时判断「上一下还是不是我按的」—— 见 sidebarNavigation 里的光标。
//
// 判据是**用户的输入**，不是「某个 state 变了没」。三个理由：
//   · 输入数得完 —— 点击、按键、浏览器前进后退，就这三样；
//   · 「改了主区」的入口有十几个（选任务、选项目、聊天、助手、新建、设置、随手记、审查、
//     Git 工作台…），挨个埋标记早晚漏一个；
//   · 而「state 变了没」会放过最要紧的那一种：用户**点回他原来那条任务** —— 指向一个字
//     都没变，可那一下点击分明是在说「算了，我还要看这条」。（ash 审查第 1 轮抓到的
//     正是这一种。）
//
// 滚动不算动手（不监听 scroll）：滚一下列表不该把正在打开的东西作废掉。
//
// 监听挂在**模块级**而不是某个 effect 里：工作区快捷键也挂在 window 的捕获阶段，而 J/K
// 的导航要在自己的 handler 里读到「含这一下」的计数 —— 挂在 effect 里就得指望组件挂载
// 顺序，顺序一变计数就差一格。

/** 用户输入的次数。只增不减。 */
let inputSeq = 0;
/** 领过的动作号。后领的作废先领的。 */
let actionSeq = 0;

if (typeof window !== "undefined") {
  const bump = () => { inputSeq += 1; };
  window.addEventListener("pointerdown", bump, true);
  window.addEventListener("keydown", bump, true);
  window.addEventListener("popstate", bump);
}

/**
 * 发起一次异步动作时领的号。两个判据合在一起：
 * `action` 管「后来又发起了一次同类动作」，`input` 管「这期间用户去做别的了」。
 */
export type ActionToken = { action: number; input: number };

export function claimAction(): ActionToken {
  actionSeq += 1;
  return { action: actionSeq, input: inputSeq };
}

/** 这个号还新鲜吗 —— 没被新的 claim 顶掉，而且领号之后用户一下手都没动过。 */
export function isActionFresh(token: ActionToken): boolean {
  return token.action === actionSeq && token.input === inputSeq;
}

/** 到此刻为止用户动过几次手。连着按的判据（见 sidebarNavigation 的光标）用它。 */
export function inputCount(): number {
  return inputSeq;
}
