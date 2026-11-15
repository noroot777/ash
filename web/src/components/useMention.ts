import { useEffect, useState, type KeyboardEvent } from "react";
import type { DraftHandle } from "../lib/DraftStore.tsx";
import { fileMentionToken } from "../lib/fileMention.ts";
import { firstSelectable, stepIndex } from "../lib/fileMentionTree.ts";
import { useFileMention, type FileMentionScope } from "../lib/useFileMention.ts";
import { useNoteMention } from "../lib/useNoteMention.ts";
import { applyNoteMention, matchNotes, noteExcerpt } from "../lib/noteMention.ts";
import { appendAttachments, attachmentsFromPaths } from "../task-detail/withdrawDraft.ts";
import { fileMentionRows, mentionHint, TREE_UNSUPPORTED, type MentionRow } from "./MentionMenu.tsx";

/**
 * 输入框里那一个 `@` 的全部状态：智能体（只有单飞对话框有）、随手记、工作区文件三类候选
 * 合并成一张列表，走同一条上下键。新建任务、单飞对话框、团队对话框共用这一份 ——
 * 「@ 出来的是什么、选完正文变成什么」处处一样，用户不必记哪个框能 @ 什么。
 *
 * 排序：智能体 → 随手记 → 文件。智能体换的是「谁来干」，代价最大，要一眼看见；随手记是
 * 用户自己写下的那几条，条数少、意图明确，排在动辄几十条的文件前面才不会被淹掉。token
 * 里一出现 `/`，前两段都让位（见各自的匹配规则），回车不会在敲路径时选中别的东西。
 *
 * 选中随手记是把**内容带进来**，跟文件不一样：正文替换掉 `@token`，附件并进这份草稿的
 * 附件栏。所以它要的是整份草稿（一次改正文和附件），不只是 setValue。`linkNotes` 的表面
 * （新建任务）还把它记进草稿的随手记回链，任务建好后那条随手记就显示「已转」—— 跟在随手记
 * 面板里点「转为新任务」是同一件事；对话框是往已有任务里补一段话，不算转任务，不回链。
 */
export function useMention({
  value,
  setValue,
  draft,
  scope,
  projectId,
  linkNotes = false,
  disabled,
  label,
  agents,
  emptyStatus,
  onPicked,
}: {
  value: string;
  setValue: (next: string) => void;
  draft: Pick<DraftHandle, "update">;
  scope: FileMentionScope;
  projectId: string;
  linkNotes?: boolean;
  /** 这会儿根本不该弹。 */
  disabled?: boolean;
  /** 这张菜单在这儿是干什么用的，进提示行。 */
  label: string;
  /** 智能体那一段：按 token 给候选，选中由调用方接着走（单飞对话框弹「选模型」）。 */
  agents?: { match: (token: string) => string[]; onPick: (agent: string) => void };
  /** 三类都没有候选时说什么；缺省按「随手记或文件」说。 */
  emptyStatus?: string;
  onPicked?: () => void;
}) {
  // 选中项按**身份**（行的 key）记，不按位置：这张列表由三路数据拼成，随手记、文件各自
  // 异步到货，晚到的那一段插在前面就会把同一个下标指到另一条上 —— 用户看着 README.md
  // 高亮，回车插进去的却是一段随手记（第 1 轮审查实测）。null = 还没落在哪一条上。
  const [chosen, setChosen] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const raw = disabled || dismissed ? null : fileMentionToken(value);
  const token = raw ?? "";
  const open = raw !== null;
  const files = useFileMention({
    value, setValue, scope, disabled: !open,
    onPicked: () => { reset(); onPicked?.(); },
  });
  const notes = useNoteMention({ projectId, active: open });
  const agentHits = open && agents ? agents.match(token) : [];
  const noteHits = open ? matchNotes(notes.notes, token) : [];
  const rows: MentionRow[] = [
    ...agentHits.map((agent) => ({ kind: "agent" as const, key: `agent:${agent}`, agent })),
    ...noteHits.map((note) => ({ kind: "note" as const, key: `note:${note.id}`, note, excerpt: noteExcerpt(note.body, token) })),
    ...fileMentionRows(files.rows),
  ];
  const fileOffset = agentHits.length + noteHits.length;
  const selectableRow = (row: MentionRow | undefined) => !!row && (row.kind !== "file" || !row.row.label);
  const selectable = (at: number) => selectableRow(rows[at]);
  const held = chosen === null ? -1 : rows.findIndex((row) => row.key === chosen && selectableRow(row));
  // 选中的那条不在了（筛掉了、被删了）才另选，落回第一条能选的。
  const selectedIndex = held >= 0 ? held : firstSelectable(rows.length, selectable);
  const selected = rows[selectedIndex];
  // 默认高亮的那一条（没按过方向键、没指过）也要钉住：用户看着它高亮就会按回车，后到的
  // 候选不能把高亮从它身上挪走。
  const selectedKey = open ? selected?.key ?? null : null;
  useEffect(() => {
    if (selectedKey !== null && selectedKey !== chosen) setChosen(selectedKey);
  }, [chosen, selectedKey]);
  const setIndex = (at: number) => {
    const row = rows[at];
    if (selectableRow(row)) setChosen(row!.key);
  };
  // 文件那半边还没回来时要说一句，否则「@ 了一下什么都没有」看着像功能坏了。
  const status = files.treeUnsupported ? TREE_UNSUPPORTED
    : files.loading && !files.rows.length
      ? (files.browsing ? "正在读取这个目录…" : "正在搜索工作区文件…")
      : files.failed ? "工作区文件读取失败，仍可直接手打路径"
        : rows.length === 0
          ? (notes.status === "loading" ? "正在读取随手记…"
            // 随手记没读出来就不能说「没有匹配」：那是没查成，不是查了没有。
            : notes.status === "failed" ? "随手记读取失败，其余也没有匹配的"
              : emptyStatus ?? (files.browsing ? "这个目录是空的" : "没有匹配的随手记或文件"))
          : notes.status === "failed"
            ? (notes.notes.length ? "随手记没能刷新，列的是上一次读到的" : "随手记读取失败，其余照常可选")
            : files.more ? "匹配的文件还有更多，再敲几个字缩小范围" : null;

  const reset = () => {
    setChosen(null);
    setDismissed(false);
  };

  const pick = (row: MentionRow) => {
    if (row.kind === "agent") {
      agents?.onPick(row.agent);
      return;
    }
    if (row.kind === "file") {
      files.activate(row.row);
      return;
    }
    const { note } = row;
    // 选择记号在 updater 外面备好：StrictMode 会重放 updater，里面生成的话两遍不一样。
    const added = attachmentsFromPaths(note.attachments);
    draft.update((current) => ({
      ...current,
      text: applyNoteMention(current.text, note.body),
      attachments: added.length ? appendAttachments(current.attachments, added) : current.attachments,
      noteIds: linkNotes && !current.noteIds.includes(note.id) ? [...current.noteIds, note.id] : current.noteIds,
    }));
    reset();
    onPicked?.();
  };

  /** 接在 textarea 的 onChange 里：正文一变就重新判断要不要弹。 */
  const onValueChange = () => {
    reset();
    files.onValueChange();
  };

  /** 返回 true = 这个按键已经被菜单吃掉了，调用方不要再处理。 */
  const onKeyDown = (event: KeyboardEvent): boolean => {
    if (!open) return false;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && rows.length) {
      event.preventDefault();
      setIndex(stepIndex(rows.length, selectedIndex, event.key === "ArrowDown" ? 1 : -1, selectable));
      return true;
    }
    // 树的左右键（展开 / 收起 / 跳回上一层）只对文件那半边有意义。文件行在合并列表里
    // 整体后移了 fileOffset 格，下标要两边换算。
    if (selected?.kind === "file"
      && files.onTreeKey(event, selectedIndex - fileOffset, (next) => setIndex(fileOffset + next))) {
      return true;
    }
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      // 菜单开着时回车一律归菜单，哪怕文件那半边还没到货：放它去插换行会把 `@token` 顶到
      // 非行尾，菜单当场收起，用户还得退回来重敲。
      event.preventDefault();
      if (selected) pick(selected);
      return true;
    }
    if (event.key === "Escape") {
      // 只关菜单：外层多半挂着「Esc 关掉整个面板」，别让它一起吃了。
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
      return true;
    }
    return false;
  };

  // 提示行跟着**选中的那一行**改口：同一颗回车在这张列表里做好几件事，不写清楚用户按下去
  // 才知道自己刚才干了什么。
  const action = selected?.kind === "agent" ? "↑↓ 选择，回车后继续选模型"
    : selected?.kind === "note" ? "↑↓ 选择，回车带入正文和附件"
      : mentionHint(selected?.kind === "file" ? selected.row : undefined);

  return {
    open,
    rows,
    token,
    status,
    index: selectedIndex,
    setIndex,
    hint: `${label} · ${action}`,
    pick,
    onKeyDown,
    onValueChange,
    reset,
  };
}

export type MentionState = ReturnType<typeof useMention>;
