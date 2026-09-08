/**
 * 页面右下角那一句反馈的类型。实现在 `workspace/WorkspaceShell.tsx`。
 *
 * 多出来的 `sticky` 是给「看不完就没了」的那一类消息用的：预览起不来时后端会把认出来的
 * 每个可起服务连同各自的启动命令一起报回来，两秒多的自动消失等于让用户按第二次才知道
 * 自己错过了什么——而且那段文字本来就是要照着抄进项目设置的。常规的成功/取消提示照旧
 * 自己走，别顺手都改成常驻。
 *
 * 组件里把 `notify` 声明成这个类型才透得过 `sticky`；声明成 `(message: string) => void`
 * 的那些照旧能收到一个 `Notify`（多出来的参数它不看而已），不用一起改。
 */
export interface NotifyOptions {
  /** 不自动消失，留一颗关闭按钮由用户自己收掉。 */
  sticky?: boolean;
}

export type Notify = (message: string, options?: NotifyOptions) => void;
