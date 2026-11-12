// 新建卡片上那颗「?」：快捷键帮助。原来面板底下那行小字（/ 调用技能 · @ 引用项目文件 · 回车创建）
// 收进这里「输入」一组，其余是全应用现有的键位。键名从各自的单点取（发送键设置、G 一族、
// Inspector 的 I 前缀、输入导航的 Q），改了那边这里跟着变，不会写着一个按不出来的键。
// ⌘/（Ctrl+/）在卡片挂着时也能开合它。
import { useEffect, useState } from "react";
import { Question } from "@phosphor-icons/react";
import { CONVERSATION_INPUTS_SHORTCUT } from "../components/conversationInputNav.ts";
import { INSPECTOR_SHORTCUT_PREFIX } from "../inspector/shortcuts.ts";
import { useComposerSendKey } from "../lib/useComposerSendKey.ts";
import { GO_CHORD_KEYS, GO_CHORD_PREFIX } from "../workspace/goChord.ts";
import { workspaceModifierLabel } from "../workspace/useWorkspaceShortcuts.ts";
import { ComposerPopover } from "./ComposerPopover.tsx";

type Row = [what: string, ...keys: string[]];

function useGroups(): [string, Row[]][] {
  const sendKey = useComposerSendKey();
  const mac = workspaceModifierLabel() === "Cmd";
  const mod = (key: string) => (mac ? `⌘${key}` : `Ctrl ${key}`);
  const enter = sendKey === "enter";
  const go = (key: string): string[] => [GO_CHORD_PREFIX.toUpperCase(), key.toUpperCase()];
  return [
    ["输入", [
      ["调用技能", "/"],
      ["引用项目文件", "@"],
      ["派生团队 / 讨论任务", "/team", "/duet"],
      ["换行", enter ? "⇧↵" : "↵"],
      ["创建并运行", enter ? "↵" : mod("↵")],
    ]],
    ["任务", [["新建任务", "C"], ["运行", "R"], ["上一条 / 下一条", "K", "J"], ["任务列表", "F"]]],
    ["跳转", [["全局跳转", mod("K")], ["任务模式", ...go(GO_CHORD_KEYS.taskMode)], ["设置", ...go(GO_CHORD_KEYS.settings)],
      ["常用命令", ...go(GO_CHORD_KEYS.commands)], ["终端", ...go(GO_CHORD_KEYS.terminal)]]],
    ["面板", [["右侧面板", INSPECTOR_SHORTCUT_PREFIX.toUpperCase(), "字母"], ["会话输入导航", CONVERSATION_INPUTS_SHORTCUT.toUpperCase()],
      ["关闭", "Esc"], ["快捷键", mod("/")]]],
  ];
}

export function ComposerShortcutHelp() {
  const [open, setOpen] = useState(false);
  const groups = useGroups();
  const shortcut = workspaceModifierLabel() === "Cmd" ? "⌘/" : "Ctrl /";
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "/" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      setOpen((value) => !value);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <ComposerPopover tone="opt" iconOnly plain label="快捷键" shortcut={shortcut} open={open} onOpenChange={setOpen}
      panelClassName="composer-help" trigger={<Question size={15} />}>
      <div className="composer-help-grid">
        {groups.map(([name, rows]) => (
          <section key={name} aria-label={name}>
            <h3>{name}</h3>
            <dl>{rows.map(([what, ...keys]) => <div key={what}><dt>{what}</dt><dd>{keys.map((key) => <kbd key={key}>{key}</kbd>)}</dd></div>)}</dl>
          </section>
        ))}
      </div>
    </ComposerPopover>
  );
}
