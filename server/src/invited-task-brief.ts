// 被中途召唤的普通协作者需要任务简介；审查/验证者则从每轮 request-context.md 读取。
// 后者若再附一次原始正文，其中的 skill / 斜杠命令就会重新变成本回合 user prompt。
export function invitedTaskBrief(body: string, invited: boolean, verifying: boolean): string {
  if (!invited || verifying || !body.trim()) return "";
  return `【本任务的原始描述】（你是中途被叫进来的，这是任务最初的交代，供你了解背景）\n${body.trim()}\n\n`;
}

export function initialTaskObjective(body: string, title: string, reviewTask: boolean): string {
  return reviewTask ? "" : body.trim() || title;
}
