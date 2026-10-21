// 一个回合里的 `![](…)` 跟这个回合的附件怎么对上。
//
// 背景：agent 说「看这张图」时写的是**它自己机器上的路径**（`output/playwright/x.png`、
// `/Users/…/shot.png`），浏览器一个都取不到。服务端为此在收到正文的那一刻就把被引用的
// 本机图片复制了一份进 `data/uploads/`（server/src/agent-attachments.ts），作为附件挂在
// 这一回合上——那份拷贝活得过 worktree 清理，是唯一长期取得到的字节。
//
// 缺的那一环就是这里：**哪条附件对应正文里的哪一句**。服务端落盘时留住了源文件的名字
// （`<12 位 id>-wake-input-desktop.png`），所以按文件名就能配对，不必再往事件里塞字段。
// 配上了的那条就**画在正文里 agent 放它的位置**，并从那排附件卡片里拿掉——同一张图既挂
// 卡片又画正文，是在同一屏里把它说两遍。
//
// **按回合配、不按段配**：事件流里 attachment 恒在它那段 text 之后，而分段遇到附件就另起
// 一段（conversationSegments.ts），于是正文和它的附件**必然落在相邻的两段**里。按段配
// 永远配不上——这是写这一份时最容易踩进去的坑。
//
// 配不上的（历史消息：那时相对路径根本没被复制、绝对路径存成了 `agent-image-1.png`）
// 原样留在卡片排里，正文里那一句由 `isLocalImageReference` 收掉，不留裂图标。
import type { MarkdownFileResolver } from "../components/markdownPolicy.ts";
import type { AgentContentSegment } from "./conversationModel.ts";
import { attachmentView, isImagePath } from "./utils.ts";

const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\s*\)/g;

/**
 * 配对用的键：去掉目录、去掉扩展名，再过一遍服务端落盘时那套字符替换。
 *
 * 扩展名不参与比较是故意的：落盘时扩展名由 mime 定（`shot.jpeg` 存成 `.jpg`），拿它比
 * 会把本来同一张图判成两张。字符替换要跟 `uploadFileNameFor` 同一套，否则带空格的名字
 * 两边长得不一样。
 */
function imageKey(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.[^.]+$/, "");
  return stem
    .replace(/[^\w.一-龥-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase();
}

function destinationKey(destination: string): string | null {
  const raw = destination.trim().replace(/^file:\/\//i, "").split(/[?#]/)[0] ?? "";
  if (!raw || !isImagePath(raw)) return null;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* 坏转义就按原样配 */ }
  return imageKey(decoded) || null;
}

export type TurnImages = {
  /** 画进正文的那些图已经从 `attachments` 里拿掉；一条都没配上时原样返回入参。 */
  segments: AgentContentSegment[];
  /** 正文里那些目标该用哪个站内地址画。没有一条配上时为 undefined。 */
  resolveFile?: MarkdownFileResolver;
};

export function turnImages(segments: AgentContentSegment[]): TurnImages {
  // 同名的附件按出场顺序排队：正文里两处 `shot.png` 指的是两个目录下的两张图时，
  // 服务端也是按出场顺序存的，依次取才对得上。
  const queues = new Map<string, string[]>();
  const views = new Map<string, { name: string; url: string }>();
  for (const segment of segments) {
    for (const path of segment.attachments) {
      if (views.has(path)) continue;
      const view = attachmentView(path);
      if (!view.image || !view.url) continue;
      views.set(path, { name: view.name, url: view.url });
      const key = imageKey(view.name);
      if (!key) continue;
      const queue = queues.get(key);
      if (queue) queue.push(path);
      else queues.set(key, [path]);
    }
  }
  if (!views.size) return { segments };

  const byDestination = new Map<string, { name: string; url: string }>();
  const used = new Set<string>();
  const lastForKey = new Map<string, string>();
  for (const segment of segments) {
    for (const match of segment.markdown.matchAll(MARKDOWN_IMAGE)) {
      const destination = (match[1] ?? match[2] ?? "").trim();
      const key = destination && destinationKey(destination);
      if (!key || byDestination.has(destination)) continue;
      // 队列空了但这个名字配过：正文里同一张图被引用了两次（服务端按内容去重，只存了一份）。
      const path = queues.get(key)?.shift() ?? lastForKey.get(key);
      const view = path && views.get(path);
      if (!path || !view) continue;
      lastForKey.set(key, path);
      used.add(path);
      byDestination.set(destination, view);
    }
  }
  if (!byDestination.size) return { segments };

  return {
    segments: segments.map((segment) => (
      segment.attachments.some((path) => used.has(path))
        ? { ...segment, attachments: segment.attachments.filter((path) => !used.has(path)) }
        : segment
    )),
    resolveFile: (destination) => byDestination.get(destination.trim()) ?? null,
  };
}
