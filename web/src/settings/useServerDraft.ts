import { useState } from "react";

/**
 * 跟着服务端值走的输入草稿：服务端那份变了、而用户没在改，就跟上新值；用户改过了就不动他的。
 *
 * 飞书分区的状态在后台一直轮询，「每次拿到新状态就重置输入框」会把用户打了一半的字冲掉；
 * 反过来「只在挂载时取一次」又会让别处改过的值一直显示旧的。判据是「草稿是否还等于上一次
 * 采纳的服务端值」——等于就说明用户没碰过。
 *
 * 返回 [草稿, 改草稿, 是否和服务端不同]。
 */
export function useServerDraft<T>(server: T): [T, (next: T) => void, boolean] {
  const [draft, setDraft] = useState(server);
  const [base, setBase] = useState(server);
  if (!Object.is(server, base)) {
    // 渲染期间按新的服务端值修正草稿（React 认可的「由 props 派生 state」写法，不经 effect 闪一帧）。
    setBase(server);
    if (Object.is(draft, base)) setDraft(server);
  }
  return [draft, setDraft, !Object.is(draft, server)];
}
