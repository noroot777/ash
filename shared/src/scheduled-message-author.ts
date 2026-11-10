// 一条待发送消息是不是**用户自己写的**。前后端「引导会话」按同一个判定找队首:托盘只给
// 这一类里最早的那条挂按钮,服务端也只在这一类里排先后 —— 哨兵唤醒、审查交接、reviewer
// 答复这些代写的输入不是用户的句子,既不能被引导,也不该挡在用户消息前面。
// 两边各写一份时,哨兵事件进了同一张表、服务端却还按全表排队首,按钮点了就被 409 拒掉。
export const isUserAuthoredMessage = (message: { origin: string | null; sessionRole: string | null }): boolean =>
  !message.origin && !message.sessionRole;
