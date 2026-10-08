import { useEffect, useMemo, useRef } from "react";

// 「用户又动手了没」的序号，给**异步动作判断自己有没有过期**用：发起时 `next()` 领一个号，
// 应答回来时 `current()` 跟它不一样，就说明这期间用户已经去做别的事了，这次动作该整个作废
// （别把他后来那次选择顶掉）。
//
// 判据是**用户的输入**，不是「某个 state 变了没」。三个理由：
//   · 输入数得完 —— 点击、按键、浏览器前进后退，就这三样；
//   · 「改了主区」的入口有十几个（选任务、选项目、聊天、助手、新建、设置、随手记、审查、
//     Git 工作台…），挨个埋标记早晚漏一个；
//   · 而「state 变了没」会放过最要紧的那一种：用户**点回他原来那条任务** —— 指向一个字
//     都没变，可那一下点击分明是在说「算了，我还要看这条」。（ash 审查第 1 轮抓到的
//     正是这一种：按 K 去看另一台机器上那条，没打开就点回本机那条，主区过一会儿自己
//     又跳成远端那条。先按「指向变了没」改过一版，这一种照样漏。）
//
// 滚动不算动手（不监听 scroll）：滚一下列表不该把正在打开的东西作废掉。
export type LatestInteraction = {
  /** 发起一次异步动作：领一个号，同时把计数推一格（于是此前在途的同类动作一并作废）。 */
  next: () => number;
  current: () => number;
};

export function useLatestInteraction(): LatestInteraction {
  const seq = useRef(0);
  useEffect(() => {
    const bump = () => { seq.current += 1; };
    // 挂捕获阶段，但不依赖「谁先注册」—— 发起方自己也会 next() 推一格，所以同一次输入
    // 被数两次也不影响判断。
    window.addEventListener("pointerdown", bump, true);
    window.addEventListener("keydown", bump, true);
    window.addEventListener("popstate", bump);
    return () => {
      window.removeEventListener("pointerdown", bump, true);
      window.removeEventListener("keydown", bump, true);
      window.removeEventListener("popstate", bump);
    };
  }, []);
  return useMemo(() => ({
    next: () => (seq.current += 1),
    current: () => seq.current,
  }), []);
}
