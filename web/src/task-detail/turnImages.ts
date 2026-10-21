// 一个回合里 `![](…)` 和这个回合的附件怎么对上。
//
// 背景：agent 说「看这张图」时写的是**它自己机器上的路径**（`output/playwright/x.png`、
// `/Users/…/shot.png`），浏览器一个都取不到。服务端为此在收到正文的那一刻就把被引用的
// 本机图片复制了一份进 `data/uploads/`（server/src/agent-attachments.ts），作为附件挂在
// 这一回合上——那份拷贝活得过 worktree 清理，是唯一长期取得到的字节。
//
// 缺的那一环是「**哪条附件对应正文里的哪一处引用**」。答案不在文件名里，也不在出场顺序
// 里：服务端**逐处引用**各发一条结果，带着目的地（`source`）、这处引用的身份（`ref`）和
// 它那一刻的拷贝（`path`，缺省 = 这处引用确实没存下副本）。所以配对是**构造出来的**，
// 不是猜的：服务端按文档顺序逐处发、一处都不少、不按字节去重，这里按同一个扫描器重新
// 认一遍正文，于是「第 n 处指向某目的地的引用」恒对「第 n 条报这个来源的结果」。
//
// 曾经按「名字相似且顺序一致」猜过一版，审查第 1 轮 F1 当场证伪；改成按 `source` 配之后
// 又漏了一层：服务端把「同一来源 + 同一份拷贝」去重掉了，于是同一个路径在一轮里被重拍过
// （红→蓝→红）时队列短一条，正文写着「恢复红色」、画出来是蓝色。所以这里**绝不**在配不上
// 时拿上一份拷贝顶（审查第 1 轮 F1）。
//
// 配上了就**原地把这处引用改写成站内地址**：agent 把图放在正文哪一句，它就画在哪一句，
// 同时从那排附件卡片里拿掉（同一张图既挂卡片又画正文，是在同一屏里把它说两遍）。改写
// 而不是「渲染时按字符串回查」也是 F2 要的：react-markdown 会把目的地转义成
// `%E7%BB%93%E6%9E%9C%20…`、把 `file:` 整个清空，回查必然对不上。
//
// 扫描器是 `@ash/shared/markdown-images`，**跟服务端、跟真正的渲染器同一份**（它用的就是
// `react-markdown` 内部那颗解析树）。自己写正则的那一版两边一致地错：带括号的文件名被
// 截断、四空格缩进的写法示例被当成真图改写掉（审查第 1 轮 F2）。
import { markdownImageRefs } from "@ash/shared/markdown-images";
import { imagePreviewTarget, taskFilePath } from "../components/markdownPolicy.ts";
import { api } from "../lib/api.ts";
import type { AgentContentSegment } from "./conversationModel.ts";
import { attachmentView } from "./utils.ts";

type Edit = { start: number; end: number; text: string };

/** 按 `Edit` 倒着替换 —— 从后往前改，前面那些位置才不会被挪动。 */
function applyEdits(text: string, edits: Edit[]): string {
  return edits.reduceRight((acc, edit) => acc.slice(0, edit.start) + edit.text + acc.slice(edit.end), text);
}

type Pairing = {
  /** 目的地 → 这个来源的结果队列（按事件顺序）。`null` = 这处引用明确没有副本。 */
  queues: Map<string, (string | null)[]>;
  /** 这些结果带了逐处身份吗（`ref`）——带了就说明「每处引用恒有一条」这条保证成立。 */
  identified: boolean;
};

function pairing(segments: AgentContentSegment[]): Pairing {
  const queues = new Map<string, (string | null)[]>();
  let identified = false;
  for (const segment of segments) {
    for (const entry of segment.attachmentSources ?? []) {
      if (typeof entry.ref === "number") identified = true;
      // 取不出站内地址的拷贝（路径不在 uploads 里）跟「没有副本」同一档：画不出来。
      const path = entry.path && attachmentView(entry.path).url ? entry.path : null;
      const queue = queues.get(entry.source);
      if (queue) queue.push(path);
      else queues.set(entry.source, [path]);
    }
  }
  return { queues, identified };
}

/**
 * 正文认领得了的图画进正文，认领走的附件从卡片排里拿掉。
 *
 * `taskId` 给了就多一档退路：**明确没有副本**的引用改写成「现在去这个任务的工作目录里
 * 取」（`/api/tasks/:id/file/raw`）。存量消息只有这一条出路 —— 落盘是 2026-10-21 才加的，
 * 那之前说过的每一张图都没有拷贝，而文件常常还在原地（用户报的就是这一幕：正文里是裂
 * 图标，「生成物」面板里那几个文件明明在）。
 *
 * 两档的先后不能反，也不能互相顶：
 *   · 有拷贝 → **只用拷贝**。那是「agent 说那句话时的那一张」，工作目录里的是「现在的那
 *     一张」；同一个路径被改过之后，后者已经不是正文在说的东西了。关联还在就绝不退到
 *     当前文件（审查第 1 轮 F1 实测 B：已经存着正确的红图，却画了当前的蓝图）。
 *   · 明确没拷贝 / 服务端压根没管过这处引用 → 去工作目录取。取不到会 404，由渲染点收掉
 *     （见 MarkdownBody 的 MarkdownImage：一个裂图标都不许留）。
 *   · 配不上、而服务端保证过「每处引用恒有一条」（`ref` 在）→ **什么都不画**。这时候关联
 *     是不可信的（正文与落盘记录真发散），拿当前文件或上一份拷贝去补都是猜。那张图仍
 *     然留在附件卡片里，点得开。
 *
 * 一条都没改写时原样返回入参（引用相等，省掉下游的重渲染）。
 */
export function turnImages(segments: AgentContentSegment[], taskId?: string): AgentContentSegment[] {
  const { queues, identified } = pairing(segments);
  if (!queues.size && !taskId) return segments;

  const live = (destination: string): string | null => {
    if (!taskId) return null;
    // 已经有正主的地址不许抢：验证证据（`data/runs/…`）和用户上传的附件（`data/uploads/…`）
    // 各有自己的接口，按任务工作目录去解只会解到工作目录外面、400 之后被整张收掉 ——
    // 真实数据上就撞到了这一幕（审查者在结论里引用自己的证据截图，于是什么都不显示）。
    // 原样留着，由渲染点的 imagePreviewTarget 解到那个接口上。
    if (imagePreviewTarget(destination)) return null;
    const path = taskFilePath(destination);
    // workspaceOnly：工作目录没了就得是 404，绝不能退到项目主仓解到同名的另一张图。
    return path ? api.taskFileRawUrl(taskId, path, { workspaceOnly: true }) : null;
  };
  const used = new Set<string>();
  const claimed: AgentContentSegment[] = [];
  let rewrote = false;
  for (const segment of segments) {
    const edits: Edit[] = [];
    for (const ref of markdownImageRefs(segment.markdown)) {
      const queue = queues.get(ref.destination);
      let url: string | null;
      if (queue?.length) {
        const path = queue.shift()!;
        if (path) {
          used.add(path);
          url = attachmentView(path).url;
        } else {
          url = live(ref.destination); /* 明确没有副本 */
        }
      } else if (queue && identified) {
        url = null; /* 配不上,而本该有一条:不猜 */
      } else {
        url = live(ref.destination); /* 老数据 / 这处引用服务端没管过 */
      }
      if (!url) continue;
      edits.push({ start: ref.start, end: ref.end, text: ref.rewrite(url) });
    }
    rewrote = rewrote || edits.length > 0;
    claimed.push(edits.length ? { ...segment, markdown: applyEdits(segment.markdown, edits) } : segment);
  }
  if (!rewrote) return segments;
  if (!used.size) return claimed;

  return claimed.map((segment) => (
    segment.attachments.some((path) => used.has(path))
      ? { ...segment, attachments: segment.attachments.filter((path) => !used.has(path)) }
      : segment
  ));
}

/**
 * 一段**不走分段模型**的正文怎么用上同一套配对（duet 讨论区就是这一路）。
 *
 * 必要性：F1 的不变量是「所有展示入口消费同一结果」。讨论区的回合不是 AgentContentSegment，
 * 但它收得到同样的附件结果，所以在这里兜一个假分段，配对规则一个字都不改 —— 否则同一张
 * 图在会话流里画的是「说那句话时的快照」，在讨论区画的是「现在的文件」。
 */
export function turnImageMarkdown(
  markdown: string,
  sources: AgentContentSegment["attachmentSources"],
  taskId?: string,
): string {
  const [segment] = turnImages(
    [{ id: "inline", markdown, events: [], attachments: [], attachmentSources: sources }],
    taskId,
  );
  return segment?.markdown ?? markdown;
}
