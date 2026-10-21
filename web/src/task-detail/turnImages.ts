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
// 曾经按「名字相似且顺序一致」猜过一版,审查第 1 轮 F1 当场证伪;改成按 `source` 配之后
// 又漏了一层:服务端把「同一来源 + 同一份拷贝」去重掉了,于是同一个路径在一轮里被重拍过
// (红→蓝→红)时队列短一条,正文写着「恢复红色」、画出来是蓝色。
//
// 第二轮审查又证伪了一层:按「来源 → 队列 → 取第一个」配,只在**展示的正文恰好就是服务端
// 扫过的那一段**时成立。而展示端有一条由代码主动支持的恢复分支(trace 与权威 .md 发散时
// 按 .md 重建分段,见 conversationSegments),重建出来的正文可能只剩最后一句:那时「这段文
// 字里的第一处引用」已经不是「服务端记录的第一条结果」—— 正文写着蓝色,画出来是红色。
//
// 所以配对不再是「按来源排队取第一个」,而是**逐目的地对账**:
//   · 把这一回合各段正文拼回去(分段只是把同一段正文按事件切开)扫一遍;
//   · 对每一个服务端记录过的目的地,比「正文里指向它的引用有几处」和「记了几条结果」;
//   · 条数相等 → 第 k 处引用恒对第 k 条结果。两边都是**文档顺序**(服务端按文档顺序逐处
//     发、这里按同一个扫描器逐处认),所以这个对应关系是算出来的,不是猜的 —— 重拍
//     (红→蓝→红)、别名、与其它目的地交错,全都对得上;
//   · 条数不等 → 展示的正文不是服务端扫过的那一段(投影重建、或者老服务端按字节去重过),
//     **这个目的地**那几处引用一律显式作废(unavailableImage,任何 resolver 都救不活它),
//     拷贝全部留在附件卡片里点得开。宁可让人自己点卡片,也不许把「修改前」那张端上来冒充
//     「修改后」。作废只牵连对不上的那个目的地:同一条消息里对得上的那些照旧画。
//   · 压根没有记录(服务端没管过这处引用)→ 退一档去工作目录取,老行为不变。
//
// 为什么判据是**逐目的地**而不是「整条消息的来源序列逐项相等」:后者要求展示的正文与记录
// 一字不差,于是老数据(2026-10-21 之前的消息没有逐处身份 `ref`)只能整批走一条宽松的
// 「按来源排队、取空了退当前文件」老路 —— 那条路恰恰是 F1 的原形。逐目的地对账对两种数据
// 同样成立(只需要「展示的正文是记录那段正文的子集」,投影重建只会丢句子、不会重排),于是
// 新老数据共用一套判据,宽松那条路可以整条删掉。
import { markdownImageRefs } from "@ash/shared/markdown-images";
import { imagePreviewTarget, taskFilePath, unavailableImage } from "../components/markdownPolicy.ts";
import { api } from "../lib/api.ts";
import type { AgentContentSegment } from "./conversationModel.ts";
import { attachmentView } from "./utils.ts";

type Edit = { start: number; end: number; text: string };

/** 服务端对**一处**引用的交代:拷贝在不在、以及没拷贝时是「丢了」还是「压根没有」。 */
type ImageRecord = { copy: string | null; lost: boolean };

/** 按 `Edit` 倒着替换 —— 从后往前改，前面那些位置才不会被挪动。 */
function applyEdits(text: string, edits: Edit[]): string {
  return edits.reduceRight((acc, edit) => acc.slice(0, edit.start) + edit.text + acc.slice(edit.end), text);
}

/** 这一回合各段正文拼回去 —— 分段只是把同一段消息按附件/工具事件切开的结果。 */
function joined(segments: AgentContentSegment[]): { text: string; offsets: number[] } {
  const offsets: number[] = [];
  let text = "";
  for (const segment of segments) {
    offsets.push(text.length);
    text += segment.markdown;
  }
  return { text, offsets };
}

/**
 * 正文认领得了的图画进正文,认领走的附件从卡片排里拿掉。
 *
 * `taskId` 给了就多一档退路:**明确没有副本**的引用改写成「现在去这个任务的工作目录里
 * 取」(`/api/tasks/:id/file/raw`)。存量消息只有这一条出路 —— 落盘是 2026-10-21 才加的,
 * 那之前说过的每一张图都没有拷贝,而文件常常还在原地(用户报的就是这一幕:正文里是裂
 * 图标,「生成物」面板里那几个文件明明在)。
 *
 * 几档的先后不能反,也不能互相顶:
 *   · 对账通过 + 有拷贝 → **只用拷贝**。那是「agent 说那句话时的那一张」,工作目录里
 *     的是「现在的那一张」;同一个路径被改过之后,后者已经不是正文在说的东西了。
 *   · 对账通过 + 没拷贝、且服务端说**字节丢了**(`lost`:当时读到了、写盘失败了)→ 显式
 *     作废。这一处那一刻的画面没人留下来,而文件后来可能已经被重拍 —— 拿现在的文件去画
 *     就是把后来的画面当成旧结论(审查第 3 轮 R1 同类位置)。
 *   · 对账通过 + 没拷贝、服务端也没有字节可存(说那句话时文件还不存在、格式不认)→ 去
 *     工作目录取。agent 先写 `![](shot.png)` 再去截图是常事,现在那张就是它说的那张;
 *     取不到会 404,由渲染点报一行小字。
 *   · 对账**没通过** → 这个目的地那几处引用一律显式作废,一个字都不画(见文件头)。
 *   · 没有记录 → 去工作目录取(存量消息唯一的出路)。
 *
 * 一条都没改写时原样返回入参(引用相等,省掉下游的重渲染)。
 */
export function turnImages(segments: AgentContentSegment[], taskId?: string): AgentContentSegment[] {
  const sources = segments.flatMap((segment) => segment.attachmentSources ?? []);
  if (!sources.length && !taskId) return segments;

  const live = (destination: string): string | null => {
    if (!taskId) return null;
    // 已经有正主的地址不许抢:验证证据(`data/runs/…`)和用户上传的附件(`data/uploads/…`)
    // 各有自己的接口,按任务工作目录去解只会解到工作目录外面、400 之后被整张收掉 ——
    // 真实数据上就撞到了这一幕(审查者在结论里引用自己的证据截图,于是什么都不显示)。
    // 原样留着,由渲染点的 imagePreviewTarget 解到那个接口上。
    if (imagePreviewTarget(destination)) return null;
    const path = taskFilePath(destination);
    // workspaceOnly:工作目录没了就得是 404,绝不能退到项目主仓解到同名的另一张图。
    return path ? api.taskFileRawUrl(taskId, path, { workspaceOnly: true }) : null;
  };

  // **整条消息一次扫**:分段不许改变解析结果。附件事件曾经把正文切成两段再分别解析,
  // 于是一对反引号被切开、里面的写法示例变成真图(审查第 2 轮 F2)。
  const { text, offsets } = joined(segments);
  const refs = markdownImageRefs(text);
  // 记录按目的地分组,每组按事件顺序(= 文档顺序)排着。
  // 同一处引用可能被递上来两次(直播那一路和刷新后重建的那一路汇到一起),`ref` 是它在这条
  // 流里的身份 —— 按「来源 + 身份」去重,否则条数翻倍,下面的对账会把整个目的地误判成配不上。
  const records = new Map<string, ImageRecord[]>();
  const delivered = new Set<string>();
  for (const entry of sources) {
    if (typeof entry.ref === "number") {
      const identity = `${entry.source}\u0000${entry.ref}`;
      if (delivered.has(identity)) continue;
      delivered.add(identity);
    }
    const copy = entry.path && attachmentView(entry.path).url ? entry.path : null;
    const record: ImageRecord = { copy, lost: !!entry.lost };
    const list = records.get(entry.source);
    if (list) list.push(record);
    else records.set(entry.source, [record]);
  }
  // 对账:正文里指向这个目的地的引用有几处。
  const counted = new Map<string, number>();
  for (const ref of refs) {
    if (records.has(ref.destination)) counted.set(ref.destination, (counted.get(ref.destination) ?? 0) + 1);
  }
  const verified = (destination: string): boolean => counted.get(destination) === records.get(destination)!.length;

  const used = new Set<string>();
  const edits = new Map<number, Edit[]>();
  const taken = new Map<string, number>();
  for (const ref of refs) {
    const list = records.get(ref.destination);
    let url: string | null;
    // 这处引用领走的那份拷贝。**改写真的落下去了才算领走**:认领的唯一后果是把卡片从
    // 附件排里拿掉,而下面还有一道「跨段改不了」的闸 —— 先认领后改写的那一版遇到跨段时
    // 两头都没了:正文留着原始碎片,卡片也被吃掉(审查第 3 轮 R2 实测 remainingAttachments=[])。
    let claim: string | null = null;
    if (!list) {
      url = live(ref.destination); /* 服务端没管过这处引用:存量消息那一档 */
    } else if (!verified(ref.destination)) {
      url = unavailableImage(ref.destination); /* 条数对不上:显式作废,不猜 */
    } else {
      const position = taken.get(ref.destination) ?? 0;
      taken.set(ref.destination, position + 1);
      const record = list[position];
      if (record?.copy) {
        claim = record.copy;
        url = attachmentView(record.copy).url;
      } else {
        // 字节丢了(写盘失败)≠ 压根没有字节可存(文件后来才生成),两者的出路不同,见上面的档位。
        url = record?.lost ? unavailableImage(ref.destination) : live(ref.destination);
      }
    }
    if (!url) continue;
    // 这处引用落在哪一段里。跨段的引用没法原地改写,跳过 —— 分段本身已经只切在顶层块
    // 边界上(见 conversationSegments 的 stableBlockBoundary),所以正常数据不会跨段;
    // 这一道兜的是人为构造的 trace 和历史落盘。
    const index = offsets.findLastIndex((offset) => offset <= ref.start);
    const base = offsets[index] ?? 0;
    const segment = segments[index];
    if (!segment || ref.end > base + segment.markdown.length) continue;
    const inSegment = edits.get(index) ?? [];
    inSegment.push({ start: ref.start - base, end: ref.end - base, text: ref.rewrite(url) });
    edits.set(index, inSegment);
    if (claim) used.add(claim);
  }
  if (!edits.size) return segments;

  const claimed = segments.map((segment, index) => {
    const list = edits.get(index);
    return list?.length ? { ...segment, markdown: applyEdits(segment.markdown, list) } : segment;
  });
  if (!used.size) return claimed;
  return claimed.map((segment) => (
    segment.attachments.some((path) => used.has(path))
      ? { ...segment, attachments: segment.attachments.filter((path) => !used.has(path)) }
      : segment
  ));
}

/**
 * 一段**不走分段模型**的正文怎么用上同一套配对(duet 讨论区就是这一路)。
 *
 * 必要性:F1 的不变量是「所有展示入口消费同一结果」。讨论区的回合不是 AgentContentSegment,
 * 但它收得到同样的附件结果,所以在这里兜一个假分段,配对规则一个字都不改 —— 否则同一张
 * 图在会话流里画的是「说那句话时的快照」,在讨论区画的是「现在的文件」,而被作废的那一处
 * 还会被讨论区的 resolver 救活(审查第 2 轮 F1)。
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
