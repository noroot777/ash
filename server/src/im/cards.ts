// 各种卡片长什么样。语义层：只决定放哪些字、哪些按钮，JSON 由 feishu/cards.ts 渲染。
//
// 按钮上的 value 只放信封 id（e）和动作（op），收件人、代次、过期时间都在库里（envelopes.ts），
// 卡片 JSON 被人转发、截图、抓包都伪造不出一次有效点击。
import { hasPendingAcceptCommit, type Task } from "@ash/shared";
import type { CardBlock, CardButton, CardModel, CardTone } from "./feishu/cards.js";
import type { TaskView, Turn } from "./attention.js";
import { scrubText, scrubTitle } from "./scrub.js";

export interface CardContext {
  /** 「在 ash 中打开」的地址；没配公网/内网地址时为 null，卡片上就不放这个按钮。 */
  link: string | null;
  /** 这个项目设成了只推标题。 */
  titleOnly: boolean;
}

/** 卡片上那几句额外的事实（读起来要花时间的，由调用方查好传进来）。 */
export interface CardExtras {
  /** 失败卡：最近一回合的出错提示。 */
  failureNotice?: string | null;
  /** 闸口卡：两位讨论者的结论。 */
  conclusions?: { a: string | null; b: string | null; consensus: boolean } | null;
  /** 上面这两样这一下没读到（不是本来就没有）：卡上说一句，对账过一会儿重读、读到了改卡（reconcile.ts render）。 */
  unread?: boolean;
  /**
   * 这张卡上一下点的结局：那一下办成了，这件事却还等着人按（attention.ts awaitsPress），卡换了新信封重新给出按钮，
   * 这一句写在最上面，免得看着像什么都没发生（reconcile.ts renewed）。
   */
  lastPress?: string;
}

const EXTRAS_UNREAD = "（这张卡的补充内容这一下没读到，稍后自动补上；也可以回 ash 里看）";

export const KIND_LABEL: Record<Turn["kind"], string> = {
  question: "等你答复",
  failed: "失败了",
  dispute: "执行者驳回了审查意见",
  duet_gate: "讨论收敛，等你拍板",
  verify_failed: "独立验证没通过",
  accept: "完成了，等你验收",
};

const KIND_TONE: Record<Turn["kind"], CardTone> = {
  question: "orange",
  failed: "red",
  dispute: "purple",
  duet_gate: "blue",
  verify_failed: "red",
  accept: "green",
};

const TITLE_ONLY = "这个项目设成了只推标题：详细内容请在 ash 里看。";

export function taskLink(base: string | null, view: Pick<TaskView, "task">): string | null {
  if (!base) return null;
  return `${base}/?project=${encodeURIComponent(view.task.projectId)}&task=${encodeURIComponent(view.task.id)}`;
}

function linkButton(ctx: CardContext): CardButton[] {
  return ctx.link ? [{ text: "在 ash 中打开", url: ctx.link }] : [];
}

function header(view: TaskView, kind: Turn["kind"], tone?: CardTone, label = KIND_LABEL[kind]) {
  const project = scrubTitle(view.projectName, 30);
  return {
    title: scrubTitle(view.task.title),
    subtitle: project ? `${project} · ${label}` : label,
    tone: tone ?? KIND_TONE[kind],
  };
}

const value = (envelope: string, op: string, extra: Record<string, string | number> = {}) => ({ e: envelope, op, ...extra });

function questionBlocks(turn: Extract<Turn, { kind: "question" }>, ctx: CardContext, envelope: string): CardBlock[] {
  const blocks: CardBlock[] = [];
  const many = turn.items.length > 1;
  if (ctx.titleOnly) blocks.push({ type: "note", text: TITLE_ONLY });
  else {
    turn.items.forEach((item, index) => {
      blocks.push({ type: "text", text: `${many ? `${index + 1}. ` : ""}${scrubText(item.question, many ? 800 : 1500)}` });
    });
  }
  const options = turn.items[0]?.options ?? [];
  if (!many && options.length && !ctx.titleOnly) {
    blocks.push({
      type: "buttons",
      buttons: options.slice(0, 6).map((option, index) => ({ text: scrubTitle(option, 24), value: value(envelope, "opt", { i: index }) })),
    });
  }
  blocks.push({
    type: "form",
    name: "answer",
    inputs: turn.items.map((item, index) => ({
      name: `a${index}`,
      label: many ? `第 ${index + 1} 问` : undefined,
      placeholder: item.options?.length && !ctx.titleOnly
        ? `可选：${item.options.slice(0, 4).map((option) => scrubTitle(option, 16)).join(" / ")}，也可以自己写`
        : "写下你的答复",
      multiline: true,
    })),
    buttons: [{ text: "提交答复", style: "primary", name: "submit", value: value(envelope, "answer") }],
  });
  blocks.push({ type: "note", text: many ? "输入框最多 1000 字；写得长就直接回复这张卡片作答，按 1. 2. 分行写。" : "输入框最多 1000 字；写得长就直接回复这张卡片作答。" });
  return blocks;
}

/** 一件事刚推出来时的那张卡。 */
export function turnCard(view: TaskView, turn: Turn, ctx: CardContext, envelope: string, extras: CardExtras = {}): CardModel {
  const blocks: CardBlock[] = extras.lastPress ? [{ type: "text", text: scrubText(extras.lastPress, 800) }] : [];
  switch (turn.kind) {
    case "question":
      blocks.push(...questionBlocks(turn, ctx, envelope));
      break;
    case "failed":
      if (ctx.titleOnly) blocks.push({ type: "note", text: TITLE_ONLY });
      else if (extras.failureNotice) blocks.push({ type: "text", text: scrubText(extras.failureNotice, 800) });
      else if (extras.unread) blocks.push({ type: "note", text: EXTRAS_UNREAD });
      blocks.push({ type: "buttons", buttons: [{ text: "重试", style: "primary", value: value(envelope, "retry") }, ...linkButton(ctx)] });
      blocks.push({ type: "note", text: "重试会从中断处接着跑。要给任务捎句话，回复这张卡片时以 /reply 开头。" });
      return { ...header(view, turn.kind), blocks };
    case "dispute":
      blocks.push(ctx.titleOnly
        ? { type: "note", text: TITLE_ONLY }
        : { type: "text", text: turn.summary ? scrubText(turn.summary, 800) : "（这条驳回没有一句话摘要，请在 ash 里看完整理由）" });
      blocks.push({
        type: "buttons",
        buttons: [
          { text: "让它接着改", style: "primary", value: value(envelope, "upheld") },
          { text: "这一轮不用改了", value: value(envelope, "withdrawn") },
          ...(turn.hasDefer ? [{ text: "转为独立任务", value: value(envelope, "deferred") }] : []),
          ...linkButton(ctx),
        ],
      });
      blocks.push({ type: "note", text: "让它接着改 = 维持审查意见照改；这一轮不用改了 = 采纳执行者的说法；转为独立任务 = 认可但另开任务去改。" });
      return { ...header(view, turn.kind), blocks };
    case "duet_gate": {
      const c = extras.conclusions;
      // 「放行」认的是这张卡的版本号：这一扇门的方案没读到、或者找不到，就不给放行 —— 不能让人对着
      // 别的门的方案（或什么都没看到）按下去，放行掉一份没给他看过的。只推标题是他自己选的不在飞书里看正文，照给。
      const shown = ctx.titleOnly || (!extras.unread && !!c);
      if (ctx.titleOnly) blocks.push({ type: "note", text: TITLE_ONLY });
      else if (extras.unread) blocks.push({ type: "note", text: EXTRAS_UNREAD });
      else if (!c) blocks.push({ type: "note", text: "（这一版方案没找到，放行请到 ash 里看过方案再点）" });
      else {
        if (c.consensus && c.a) blocks.push({ type: "text", text: `共识：${scrubText(c.a, 1500)}` });
        else {
          if (c.a) blocks.push({ type: "text", text: `A：${scrubText(c.a, 900)}` });
          if (c.b) blocks.push({ type: "text", text: `B：${scrubText(c.b, 900)}` });
        }
      }
      blocks.push({
        type: "buttons",
        buttons: [
          ...(shown ? [{ text: "放行", style: "primary" as const, value: value(envelope, "approve") }] : []),
          { text: "打回终止", style: "danger", value: value(envelope, "reject"), confirm: { title: "打回终止", text: "讨论会被终止，任务记为已取消。确定吗？" } },
          ...linkButton(ctx),
        ],
      });
      blocks.push({
        type: "form",
        name: "gate",
        inputs: [{ name: "text", placeholder: "写下意见或问题", multiline: true }],
        buttons: [
          { text: "注入意见（双方回炉）", name: "inject", value: value(envelope, "inject") },
          { text: "提问（答完继续）", name: "ask", value: value(envelope, "ask") },
        ],
      });
      return { ...header(view, turn.kind), blocks };
    }
    case "verify_failed":
      blocks.push({ type: "text", text: "验证报告和「修复 / 强制通过」都在 ash 里：强制通过会一路推进到合并，不能经飞书操作。" });
      if (ctx.link) blocks.push({ type: "buttons", buttons: linkButton(ctx) });
      return { ...header(view, turn.kind), blocks };
    case "accept": {
      // 停在中途那道「等我点头」上时这一按是放行不是验收：按钮、确认框、副标题、提示一起改口，说法和网页确认框
      // 同一份（shared accept-message.ts）。只推标题的项目不把确认框里的分支名这些带出去。
      if (turn.reviewFailed) blocks.push({ type: "text", text: "注意：最近一轮审查没通过。" });
      const what = !ctx.titleOnly ? turn.confirm
        : turn.release ? "这一按只是放行这一关：不合并、不清理，这条线接着往下走。" : "这一按会合并还是只记下认可、怎么清理，在 ash 里看得到。";
      const confirm = turn.reviewFailed
        ? { title: "最近一轮审查没通过", text: `${what} 确定照样${turn.release ? "放行" : "验收"}吗？` }
        : { title: turn.release ? "放行这一关？" : "确认验收通过？", text: what };
      blocks.push({
        type: "buttons",
        buttons: [{ text: acceptLabel(turn), style: "primary", value: value(envelope, "accept"), confirm }, ...linkButton(ctx)],
      });
      blocks.push({
        type: "note",
        text: `${turn.release ? "" : "项目设了验收前置命令的话会先跑一遍（可能十几分钟），结果会更新在这张卡上。"}要给任务捎句话，回复这张卡片时以 /reply 开头。`,
      });
      return { ...header(view, turn.kind, undefined, turn.release ? "停在「等我点头」，等你放行" : undefined), blocks };
    }
  }
  if (ctx.link) blocks.push({ type: "buttons", buttons: linkButton(ctx) });
  return { ...header(view, turn.kind), blocks };
}

/** 待验收卡上那个按钮（结局里「点了哪个」也用它）：和网页验收按钮同一套说法。 */
export const acceptLabel = (turn: Pick<Extract<Turn, { kind: "accept" }>, "release">): string =>
  turn.release ? "放行，继续下一站" : "验收通过";

/**
 * 验收落下之后怎么称呼它：合并了才说「合并」（就地、只记认可、只打标签、合进工作区没提交的都不是）。
 * 「合并后不提交」那一档事后提交了，方法还记着 no_commit、提交号补上了：那时就是合并了（判据只认 shared 那一份）。
 */
export function acceptedLabel(task: { acceptedMergeMethod?: string | null; acceptedMergeCommit?: string | null }): string {
  const method = task.acceptedMergeMethod as Task["acceptedMergeMethod"];
  if (method === "tagged") return "已验收（只打了标签，没有合并）";
  if (hasPendingAcceptCommit({ acceptedMergeMethod: method, acceptedMergeCommit: task.acceptedMergeCommit })) {
    return "已验收（改动已合进目标分支工作区，还没提交）";
  }
  return method ? "已验收合并" : "已验收";
}

/** 事情已经过去了（别处处理掉、换了下一步、任务删了）：卡片收成一行说明，不留按钮。 */
export function settledCard(
  original: { title: string; subtitle?: string },
  text: string,
  ctx: Pick<CardContext, "link">,
  tone: CardTone = "grey",
): CardModel {
  return {
    title: original.title,
    subtitle: original.subtitle,
    tone,
    blocks: [{ type: "text", text }, ...(ctx.link ? [{ type: "buttons" as const, buttons: linkButton({ link: ctx.link, titleOnly: false }) }] : [])],
  };
}

/** 收件人已无权查看时改成的样子：不带任务标题、状态和链接（原卡上的正文还留在对方飞书里，得把它盖掉）。 */
/** why 是出口判定的固定措辞（scope.ts 的 deny 原因），不含业务数据。 */
export function neutralCard(why?: string): CardModel {
  return { title: "ash", tone: "grey", blocks: [{ type: "text", text: why ? `这张卡已收起：${why}。` : "这张卡已收起。" }] };
}

/** /todo 的清单正文（出口重核后有几张不能再列时，用同一个样子重排）。 */
export function todoText(titles: string[], total: number, tail: string): string {
  return [`还有 ${total} 件事等你：`, ...titles.slice(0, 15).map((title) => `· ${title}`), tail].join("\n");
}

export interface SummaryItem {
  title: string;
  kind: Turn["kind"];
  projectName: string;
}

/** 一口气要推好几张卡时（刚绑定、重启后积压），先发这一张汇总，逐张的等你要了再推。 */
export function summaryCard(items: SummaryItem[], envelope: string): CardModel {
  const shown = items.slice(0, 12);
  return {
    title: `有 ${items.length} 件事在等你`,
    tone: "orange",
    blocks: [
      ...shown.map((item): CardBlock => ({
        type: "text",
        text: `· ${scrubTitle(item.title, 40)} —— ${KIND_LABEL[item.kind]}${item.projectName ? `（${scrubTitle(item.projectName, 20)}）` : ""}`,
      })),
      ...(items.length > shown.length ? [{ type: "note" as const, text: `另有 ${items.length - shown.length} 件没列出。` }] : []),
      { type: "buttons", buttons: [{ text: "逐张推给我（每次 5 张）", style: "primary", value: value(envelope, "push") }] },
      { type: "note", text: "也可以随时发 /todo 调出。" },
    ],
  };
}

/** /project 的选单：每个项目一颗按钮，点一下就切成当前项目（按钮带的是第几个，项目 id 存在信封里）。 */
export function projectCard(current: string | null, names: string[], currentIndex: number, hidden: number, envelope: string): CardModel {
  return {
    title: "切换当前项目",
    tone: "blue",
    blocks: [
      { type: "text", text: `当前：${current ? scrubTitle(current, 40) : "未指定"}` },
      {
        type: "buttons",
        buttons: names.map((name, index) => ({
          text: scrubTitle(name, 24), ...(index === currentIndex ? { style: "primary" as const } : {}), value: value(envelope, "pick", { i: index }),
        })),
      },
      { type: "note", text: hidden ? `还有 ${hidden} 个项目没列出：发 /project 名字 切过去。` : "也可以发 /project 名字 切换。" },
    ],
  };
}

/**
 * 不带参数的 /new：选项目、填标题和要求，提交就建任务并开跑（填表、点提交本身就是确认，不再弹确认卡）。
 * 下拉框的 value 是第几个项目，项目 id 存在信封里；群里只有群绑定的那一个项目可选。
 */
export function newTaskCard(names: string[], currentIndex: number, hidden: number, envelope: string): CardModel {
  return {
    title: "建任务并开跑",
    tone: "blue",
    blocks: [{
      type: "form",
      name: "new",
      inputs: [
        {
          name: "project", placeholder: "选一个项目", required: true,
          options: names.map((name, index) => ({ text: scrubTitle(name, 40), value: String(index) })),
          ...(currentIndex >= 0 ? { initial: String(currentIndex) } : {}),
        },
        { name: "title", label: "标题", placeholder: "一句话说清要做什么", maxLength: 120, required: true },
        { name: "body", label: "要求", placeholder: "详细要求（可不填）", multiline: true },
      ],
      buttons: [{ text: "建任务并开跑", style: "primary", name: "submit", value: value(envelope, "submit") }],
    }, {
      type: "note",
      text: `${hidden ? `还有 ${hidden} 个项目没列出：先发 /project 名字 把它设成当前项目，再发 /new。` : ""}要求最多 1000 字；写得长就发 /new 标题，换行写要求。`,
    }],
  };
}

/** 需要再点一下才执行的命令（/stop、/new）。 */
export function confirmCard(title: string, text: string, envelope: string, danger: boolean): CardModel {
  return {
    title,
    tone: danger ? "red" : "blue",
    blocks: [
      { type: "text", text },
      {
        type: "buttons",
        buttons: [
          { text: "确定", style: danger ? "danger" : "primary", value: value(envelope, "confirm") },
          { text: "算了", value: value(envelope, "cancel") },
        ],
      },
    ],
  };
}
