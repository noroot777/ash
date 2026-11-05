import type { ReactNode } from "react";
import type { ExtraProps } from "react-markdown";
import { CopyButton } from "./CopyButton.tsx";

type HastElement = NonNullable<ExtraProps["node"]>;

/** hast 子树里的全部文字，按原顺序拼起来——就是 markdown 围栏里写的那段原文。 */
function hastText(node: HastElement | HastElement["children"][number]): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(hastText).join("");
  return "";
}

/**
 * markdown 里的一整块代码，右上角带一颗只复制**这一块**的按钮。
 *
 * 复制的文本取自 hast 节点而不是渲染后的 DOM：那是围栏里的原文，不受换行样式和
 * 以后可能加上的高亮标签影响。解析器会在块尾补一个换行，复制时去掉。
 *
 * 按钮挂在外层而不是 `<pre>` 里面：`<pre>` 自己横向滚动，放在里面会跟着代码一起滚走。
 */
export function CodeBlock({ node, children }: { node?: HastElement; children: ReactNode }) {
  const text = node ? hastText(node).replace(/\n$/, "") : "";
  return (
    <div className="task-code-block-wrap">
      <pre className="task-code-block">{children}</pre>
      {text && <CopyButton className="task-code-copy" value={text} ariaLabel="复制这段代码" icon />}
    </div>
  );
}
