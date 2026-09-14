import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { CaretDown, CaretRight, File, FolderSimple, Robot } from "@phosphor-icons/react";
import type { FileMentionState } from "../lib/useFileMention.ts";
import type { MentionTreeRow } from "../lib/fileMentionTree.ts";

// 输入框敲 `@` 弹出来的那张菜单：新建任务、单飞对话框、团队对话框共用一份。
//
// 两类候选混在同一张列表里、走同一条上下键序列，是**刻意**的：用户敲 `@` 的时候心里想的
// 是「引用点什么东西」，而不是「我现在要用智能体选择器还是文件选择器」。谁排前面由候选
// 本身决定——`@cl` 那样的纯字母 token 两边都可能命中，智能体在前（它改的是「谁来干」，
// 代价大、要一眼看见）；一旦 token 里出现 `/` 或 `.`，智能体那段自然就空了。
//
// 文件那半边是**一棵树**而不是一张平铺的路径清单：一层一层列，目录能就地展开，子项缩进
// 挂在下面（形状怎么算在 lib/fileMentionTree.ts）。缩进这一条不是装饰 —— 四十条深路径
// 平铺在一起，人读到第五条就已经分不清谁跟谁是一家的了。

export type MentionRow =
  | { kind: "agent"; key: string; agent: string; detail?: string }
  | { kind: "file"; key: string; row: MentionTreeRow };

export function fileMentionRows(rows: MentionTreeRow[]): MentionRow[] {
  return rows.map((row) => ({ kind: "file", key: `file:${row.hit.path}`, row }));
}

/** 命中的那几个字标出来：子串命中常在名字中段，不标就看不出这条为什么在列表里。 */
function Highlighted({ text, token }: { text: string; token: string }) {
  const needle = token.includes("/") ? token.slice(token.lastIndexOf("/") + 1) : token;
  const at = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="mention-menu-hit">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

/** 深路径从左边截：`…/task-detail` 比 `web/src/ta…` 有用得多。 */
function tailPath(dir: string, limit = 34): string {
  if (dir.length <= limit) return dir;
  const cut = dir.slice(dir.length - limit);
  const at = cut.indexOf("/");
  return `…${at >= 0 ? cut.slice(at) : cut}`;
}

/** 一行文件/目录。缩进用 padding 给，别用空格 —— 名字要能正常省略号截断。 */
function FileRow({ row, token }: { row: MentionTreeRow; token: string }) {
  const { hit } = row;
  const isDir = hit.kind === "dir";
  return (
    <>
      {row.expandable
        ? (row.expanded
          ? <CaretDown size={11} weight="bold" className="mention-menu-caret" aria-hidden="true" />
          : <CaretRight size={11} weight="bold" className="mention-menu-caret" aria-hidden="true" />)
        : <span className="mention-menu-caret" aria-hidden="true" />}
      {isDir
        ? <FolderSimple size={14} weight="fill" aria-hidden="true" />
        : <File size={14} aria-hidden="true" />}
      <b><Highlighted text={hit.name} token={token} />{isDir && "/"}</b>
      {/* 搜索态里同名文件靠这一段分辨（三个 index.ts 长得一模一样）；浏览态不写，
          目录就摆在这一行的上面。 */}
      {row.showDir && hit.dir && <em>{tailPath(hit.dir)}/</em>}
      {row.loading && <em>展开中…</em>}
      {/* 被 .gitignore 挡着的照样能选，但得说一声：否则用户只会觉得「这条怎么排这么
          后面」，还会怀疑自己引用的是不是一个不该存在的文件。 */}
      {hit.ignored && <span className="mention-menu-tag">已忽略</span>}
    </>
  );
}

export function MentionMenu({
  className,
  ariaLabel,
  hint,
  rows,
  token,
  status,
  selectedIndex,
  onHover,
  onPick,
}: {
  className: string;
  ariaLabel: string;
  hint: string;
  rows: MentionRow[];
  /** 正在敲的 token，用来标出命中的那几个字。 */
  token: string;
  /** 「正在搜索 / 搜不到 / 读取失败」这类状态行，由调用方按自己的数据源给。 */
  status?: ReactNode;
  selectedIndex: number;
  onHover?: (index: number) => void;
  onPick: (row: MentionRow) => void;
}) {
  const firstFileIndex = rows.findIndex((row) => row.kind === "file");
  const selectedRef = useRef<HTMLButtonElement>(null);
  // 候选多到要滚时，↑↓ 走出视野的那条必须自己跟着滚进来，否则回车选中的是什么全靠猜。
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <div className={`mention-menu ${className}`} role="listbox" aria-label={ariaLabel}>
      <small>{hint}</small>
      {rows.map((row, index) => (
        <Fragment key={row.key}>
          {index === firstFileIndex && firstFileIndex > 0 && (
            <small className="mention-menu-divider">工作区文件 · 路径会写进正文</small>
          )}
          {row.kind === "file" && row.row.label ? (
            // 分组标签：搜索结果里「这几条同属这个目录」的那一行。不是选项，所以不进
            // 上下键序列，也不该被读屏当成可选项念出来。
            <small className="mention-menu-group">
              <FolderSimple size={12} weight="fill" aria-hidden="true" />
              {/* 深路径同样从左边截：右边那几段才是区分度所在。 */}
              {tailPath(row.row.hit.path, 42)}/
            </small>
          ) : (
          <button
            ref={index === selectedIndex ? selectedRef : undefined}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            aria-expanded={row.kind === "file" && row.row.expandable ? row.row.expanded : undefined}
            /* 缩进走 padding，不插占位元素：占位元素会多吃一份 flex gap，第一层就跟没
               缩进的行左右错开。 */
            style={row.kind === "file" && row.row.depth
              ? { paddingLeft: `${8 + row.row.depth * 14}px` }
              : undefined}
            onMouseEnter={() => onHover?.(index)}
            onClick={() => onPick(row)}
          >
            {row.kind === "agent" ? (
              <>
                <Robot size={14} aria-hidden="true" />
                <b>@{row.agent}</b>
                {row.detail && <em>{row.detail}</em>}
              </>
            ) : <FileRow row={row.row} token={token} />}
          </button>
          )}
        </Fragment>
      ))}
      {status && <p>{status}</p>}
    </div>
  );
}

/**
 * 只有文件、没有智能体的那几个表面（新建任务、团队调度台、派生配置卡）的成品菜单：
 * 状态文案和「回车插入路径」这套提示必须处处一样，所以收在这里，调用点只给一个标签。
 *
 * 单飞对话框不走这条 —— 它要把智能体和文件混在同一张列表里，自己拼 rows。
 */
export function FileMentionMenu({
  mention,
  label,
  className = "file-mention-menu",
}: {
  mention: FileMentionState;
  /** 这张菜单在这儿是干什么用的，进 aria-label 和提示行。 */
  label: string;
  /** 定位类（贴在哪个输入框边上）。盒子样式一律来自 .mention-menu。 */
  className?: string;
}) {
  return (
    <MentionMenu
      className={className}
      ariaLabel={label}
      hint={`${label} · ${mentionHint(mention.selected)}`}
      rows={fileMentionRows(mention.rows)}
      token={mention.token ?? ""}
      status={mention.loading && !mention.rows.length
        ? (mention.browsing ? "正在读取这个目录…" : "正在搜索工作区文件…")
        : mention.failed ? "工作区文件读取失败，仍可直接手打路径"
          : mention.rows.length === 0
            ? (mention.browsing ? "这个目录是空的" : "没有匹配的文件")
            : mention.more ? "匹配的还有更多，再敲几个字缩小范围" : null}
      selectedIndex={mention.index}
      onHover={mention.setIndex}
      onPick={(row) => { if (row.kind === "file") mention.activate(row.row); }}
    />
  );
}

/**
 * 提示行跟着**选中的那一行**改口：同一颗回车在树里做两件事（展开目录 / 插入路径），
 * 不写清楚用户按下去才知道自己刚才干了什么。
 */
export function mentionHint(selected: MentionTreeRow | undefined): string {
  if (selected?.expandable && !selected.expanded) return "↑↓ 选择，回车或 → 展开目录";
  if (selected?.expandable) return "↑↓ 选择，回车引用这个目录，← 收起";
  return "↑↓ 选择，回车插入路径，Esc 关闭";
}
