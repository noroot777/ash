// 一个回合里 `![](…)` 和这个回合的附件怎么对上。
//
// 背景：agent 说「看这张图」时写的是**它自己机器上的路径**（`output/playwright/x.png`、
// `/Users/…/shot.png`），浏览器一个都取不到。服务端为此在收到正文的那一刻就把被引用的
// 本机图片复制了一份进 `data/uploads/`（server/src/agent-attachments.ts），作为附件挂在
// 这一回合上——那份拷贝活得过 worktree 清理，是唯一长期取得到的字节。
//
// 缺的那一环是「**哪条附件对应正文里的哪一句**」。答案不在文件名里，也不在出场顺序里：
// 服务端在附件事件上直接标了 `source`（引用的目的地原文），这里按它配。曾经按「名字相似
// 且顺序一致」猜过一版，审查第 1 轮 F1 当场证伪——同一个路径在一轮里被重拍过时（先截
// 「修改前」、改完再截「修改后」），猜出来的恰好是错的那张，而「结论说修改后、画出来是
// 修改前」比不画更坏。
//
// 配上了就**原地把目的地改写成站内地址**：agent 把图放在正文哪一句，它就画在哪一句，
// 同时从那排附件卡片里拿掉（同一张图既挂卡片又画正文，是在同一屏里把它说两遍）。改写
// 而不是「渲染时按字符串回查」也是 F2 要的：react-markdown 会把目的地转义成
// `%E7%BB%93%E6%9E%9C%20…`、把 `file:` 整个清空，回查必然对不上。
//
// 扫描器是 `@ash/shared/markdown-images`，**跟服务端同一份**：两边各写一份正则，就会出现
// 一边存了一边配不上（图没了）、或者一边认领了一边没存（卡片被吃掉、正文又什么都不画）。
// 它不认的写法（引用式、缩进代码块）两边一致地不认，所以顶多不显示，不会显示成另一张图。
import { markdownImageRefs } from "@ash/shared/markdown-images";
import type { AgentContentSegment } from "./conversationModel.ts";
import { attachmentView } from "./utils.ts";

type Edit = { start: number; end: number; url: string };

/** 按 `Edit` 倒着替换 —— 从后往前改，前面那些位置才不会被挪动。 */
function applyEdits(text: string, edits: Edit[]): string {
  return edits.reduceRight((acc, edit) => acc.slice(0, edit.start) + edit.url + acc.slice(edit.end), text);
}

/**
 * 正文认领得了的图画进正文，认领走的附件从卡片排里拿掉。
 *
 * 一条都没配上时原样返回入参（引用相等，省掉下游的重渲染）。
 */
export function turnImages(segments: AgentContentSegment[]): AgentContentSegment[] {
  // 同一处目的地可能对着好几份拷贝（被重拍过），按事件顺序排队，正文里第 n 次引用取第 n 份。
  const queues = new Map<string, string[]>();
  for (const segment of segments) {
    for (const { path, source } of segment.attachmentSources ?? []) {
      if (!attachmentView(path).url) continue;
      const queue = queues.get(source);
      if (queue) queue.push(path);
      else queues.set(source, [path]);
    }
  }
  if (!queues.size) return segments;

  const used = new Set<string>();
  // 队列空了但这个来源配过：正文里同一张图被引用了两次（服务端按内容去重，只存了一份）。
  const reuse = new Map<string, string>();
  const claimed: AgentContentSegment[] = [];
  for (const segment of segments) {
    const edits: Edit[] = [];
    for (const ref of markdownImageRefs(segment.markdown)) {
      const path = queues.get(ref.destination)?.shift() ?? reuse.get(ref.destination);
      const url = path ? attachmentView(path).url : null;
      if (!path || !url) continue;
      reuse.set(ref.destination, path);
      used.add(path);
      edits.push({ start: ref.start, end: ref.end, url });
    }
    claimed.push(edits.length ? { ...segment, markdown: applyEdits(segment.markdown, edits) } : segment);
  }
  if (!used.size) return segments;

  return claimed.map((segment) => (
    segment.attachments.some((path) => used.has(path))
      ? { ...segment, attachments: segment.attachments.filter((path) => !used.has(path)) }
      : segment
  ));
}
