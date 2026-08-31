// 新建项目那一屏的路径推导。抽成纯函数是为了能在没有真机的情况下**跑**它：
// 这一段曾经把「自动填的目录名」存进 state，于是「先打项目名、后拿到身份」的顺序下
// 目录名会永远空着（第 1 轮审查 P1），而这类顺序 bug 只有把它当函数来喂序列才验得掉。
// 回归用例：mobile/scripts/test-project-path.mjs。

/** 项目名当目录名用：路径分隔符和 Windows 不收的那几个字符换成连字符。 */
export function dirNameFromProjectName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-").trim();
}

/**
 * 输入框里该显示的目录名。**没手动改过就一直按项目名现算** —— 不存这一份，
 * 就不存在「身份回来得比用户打字晚，得再补一次同步」这回事。
 */
export function scopedTail(name: string, typedTail: string, tailTouched: boolean): string {
  return tailTouched ? typedTail : dirNameFromProjectName(name);
}

/** 家目录自己的形状说了算：`D:\ash-root\me` → `\`。手机端没有 /host 那条端点。 */
export function separatorOf(home: string): string {
  return home.includes("\\") ? "\\" : "/";
}

/**
 * 最终提交的那条路径。`home` 为 null（自用模式 / 实例管理员）时用自由输入的那份，
 * 锁前缀时目录名空着就返回空串 —— 服务端明确拒绝「目录根本身」，与其拼一条注定被拒
 * 的路径，不如当作「这次先不设目录」。
 */
export function projectPathOf(home: string | null, tail: string, freePath: string): string {
  if (!home) return freePath.trim();
  const dir = tail.trim();
  if (!dir) return "";
  return `${home.replace(/[\\/]+$/, "")}${separatorOf(home)}${dir}`;
}
