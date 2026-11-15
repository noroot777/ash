// 备忘面板里的一条。两种形态同住一个组件：读（带展开/收起）与改（整条换成输入框）。
//
// **长正文是这一格的主要矛盾**（用户 2026-10-28：「几百字一条的备注应该是有的」）。
// 侧栏默认 340px 宽，几百字铺下来就是二十来行 —— 三五条就把面板顶成一条长卷，谁也找不到
// 自己要的那条。所以读态默认折到 CLAMP_LINES 行，溢出才给「展开」；是不是真溢出要**量**
// （scrollHeight > clientHeight），按字数猜在不同字号/缩放下一定会错，猜短了就出现一颗
// 点了什么都没发生的「展开」。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { File as FileIcon, PencilSimple, TrashSimple } from "@phosphor-icons/react";
import { InspTool } from "../inspector/parts.tsx";
import type { TaskMemo } from "@ash/shared/task-memo";
import { ImagePreviewGroup, PreviewableImage } from "../components/ImagePreview.tsx";
import { attachmentView, formatInstant } from "../task-detail/utils.ts";
import { MemoEditor } from "./MemoEditor.tsx";
import type { TaskMemoContent } from "../lib/apiTaskMemos.ts";
import type { MemoDraft, MemoEditDraft } from "./taskMemoDrafts.ts";

/** 折起来时露几行。再少就看不出这条在说什么，再多就等于没折。 */
const CLAMP_LINES = 7;

export function TaskMemoCard({ taskId, memo, busy, highlight, draft, onDraft, onSave, onDelete }: {
  taskId: string;
  memo: TaskMemo;
  busy: boolean;
  /** 刚加进来的那条：扫一眼就知道落在哪儿了（切过来的时候列表可能已经有十几条）。 */
  highlight: boolean;
  /**
   * 这条的编辑草稿；null = 读态。**编辑态是受控的**，state 住在 task-memos/taskMemoDrafts.ts
   * —— 放在这里的话，面板被自动切走（任务 status 一变就会）时草稿跟着卸载一起没。
   */
  draft: MemoEditDraft | null;
  onDraft: (next: MemoDraft | null) => void;
  /**
   * 存这条的新正文。**退出编辑态不由这里决定** —— 草稿由共享层在写入收尾时按版本清掉
   * （存上了、而且草稿还是提交那一版才清）。所以失败会留在框里，而在这一发飞着的时候
   * 新写的那一版也不会被它顺手清走（第 3 轮 F1）。
   */
  onSave: (content: TaskMemoContent) => Promise<void>;
  onDelete: () => void;
}) {
  const editing = draft !== null;
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const body = useRef<HTMLParagraphElement>(null);
  const card = useRef<HTMLElement>(null);

  // 折叠线是按行高算的，所以量要等布局定下来（useLayoutEffect），否则第一帧会先闪一下
  // 没有「展开」的样子。面板宽度可拖，同一条正文在窄栏里溢出、拖宽了就不溢出，所以
  // 跟着尺寸一起重量。
  useLayoutEffect(() => {
    const node = body.current;
    if (!node || editing) return;
    const measure = () => setOverflowing(node.scrollHeight - node.clientHeight > 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [editing, expanded, memo.body]);

  useEffect(() => {
    if (!highlight) return;
    card.current?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  // 存上了才退出编辑态（断网 / 503 / 后端拒绝时继续留在框里，草稿一个字不动 —— 这一格
  // 的正文动辄几百字）。这里只管「没改动就直接退出」那条捷径：不发请求，也就不占在途
  // 位置；真发出去的那一发，退不退出由共享层按草稿版本判（见 onSave）。
  const save = async () => {
    if (!draft) return;
    const text = draft.text.trim();
    const attachments = [...draft.attachments];
    if (!text && !attachments.length) return;
    // 「改了哪一样」对着进编辑态那一刻的基线判，不对着 `memo`（编辑途中它会被后台重读换掉，
    // 见 taskMemoDrafts.ts 的 MemoEditDraft）。只发改了的那一样，没动的交给服务端此刻的值。
    const { base } = draft;
    const textChanged = text !== base.text.trim();
    const filesChanged = attachments.length !== base.attachments.length
      || attachments.some((path, at) => path !== base.attachments[at]);
    if (!textChanged && !filesChanged) { onDraft(null); return; }
    await onSave({ ...(textChanged ? { body: text } : {}), ...(filesChanged ? { attachments } : {}) });
  };

  const edited = memo.updatedAt !== memo.createdAt;

  return (
    <article ref={card} className={`insp-card task-memo-card${highlight ? " is-new" : ""}`}>
      {draft ? (
        <MemoEditor
          taskId={taskId}
          slot={memo.id}
          draft={draft}
          disabled={busy}
          rows={Math.min(16, Math.max(4, draft.text.split("\n").length + 1))}
          onSave={() => void save()}
          onCancel={() => onDraft(null)}
        />
      ) : (
        <>
          {memo.body && <p
            ref={body}
            className="task-memo-card__body"
            style={expanded ? undefined : { maxHeight: `calc(${CLAMP_LINES} * 1.6em)` }}
          >
            {memo.body}
          </p>}
          {(overflowing || expanded) && (
            <button type="button" className="task-memo-card__more" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "收起" : "展开全文"}
            </button>
          )}
          <MemoAttachments paths={memo.attachments} />
        </>
      )}
      {/* 底下一行：几点写的（改过就带「已编辑」），编辑、删掉两颗指到这张卡才出。 */}
      <footer className="task-memo-card__foot">
        <time dateTime={memo.updatedAt}>{formatInstant(memo.updatedAt)}{edited ? " · 已编辑" : ""}</time>
        {!editing && (
          <span className="task-memo-card__actions">
            <InspTool label="编辑这条备忘" disabled={busy} onClick={() => onDraft({ text: memo.body, attachments: memo.attachments })}>
              <PencilSimple aria-hidden="true" />
            </InspTool>
            <InspTool label="删除这条备忘" disabled={busy} onClick={onDelete}>
              <TrashSimple aria-hidden="true" />
            </InspTool>
          </span>
        )}
      </footer>
    </article>
  );
}

/**
 * 读态下的图：按侧栏宽度铺开，一张一行，点开看原图。备忘里的截图是拿来回头看的，
 * 压成回复框里那种 54px 的小方块就认不出画的是什么了。非图片的文件只留一个名字。
 */
function MemoAttachments({ paths }: { paths: readonly string[] }) {
  if (!paths.length) return null;
  return (
    <ImagePreviewGroup>
      <div className="task-memo-card__files">
        {paths.map((path) => {
          const view = attachmentView(path);
          if (view.image && view.url) return <PreviewableImage key={path} src={view.url} alt={view.name} />;
          const label = <><FileIcon size={14} aria-hidden="true" /><span>{view.name}</span></>;
          return view.url
            ? <a key={path} className="task-memo-card__file" href={view.url} target="_blank" rel="noreferrer">{label}</a>
            : <span key={path} className="task-memo-card__file">{label}</span>;
        })}
      </div>
    </ImagePreviewGroup>
  );
}
