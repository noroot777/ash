// 只写了正文就建的任务先拿首行当标题，首轮由智能体起正式标题（建任务时带 autoTitle）。网页输入框和飞书 /new 共用这一份。
export function provisionalTitle(body: string, fallback = "未命名任务"): string {
  return body.trim().split(/\r?\n/)[0]!.slice(0, 42) || fallback;
}
