// TaskComposerPanel 的静态配料:模式表、slash 命令表、种子附件列表。
// 从主文件拆出来纯粹为了给它腾行数(全局 700 行硬限),不承载状态。
import type { AgentExecutorProfile, AgentType, TaskMode } from "@ash/shared";
import { Paperclip, Robot, ChatsCircle, UsersThree, X } from "@phosphor-icons/react";
import { PreviewableImage } from "../components/ImagePreview.tsx";
import type { SlashItem } from "../lib/useSkills.ts";
import { attachmentView } from "../task-detail/utils.ts";

export const MODES: { value: TaskMode; label: string; icon: typeof Robot }[] = [
  { value: "single", label: "单任务", icon: Robot },
  { value: "team", label: "团队", icon: UsersThree },
  { value: "duet", label: "讨论", icon: ChatsCircle },
];

// ash 自己的三条切换命令。**这张表是固定的**:主文件 changeBody 那个「敲完空格
// 就把命令从正文里吃掉」的正则只认这三个词,技能绝不能进这张表 —— 技能的 `/名字`
// 必须原样留在正文里发下去，server 才能据此注入对应 SKILL.md。
export const SLASHES = [
  { command: "/single", mode: "single" as const, label: "创建单任务" },
  { command: "/team", mode: "team" as const, label: "创建常驻团队" },
  { command: "/duet", mode: "duet" as const, label: "发起双智能体讨论" },
];
export const ASH_SLASH_ITEMS: SlashItem[] = SLASHES.map((item) => ({
  command: item.command,
  label: item.label,
  kind: "ash",
}));

export function defaultProfile(profiles: AgentExecutorProfile[], type: AgentType) {
  return profiles.find((profile) => profile.type === type && profile.isDefault)
    ?? profiles.find((profile) => profile.type === type);
}

export function SeedAttachmentList({ paths, onRemove }: { paths: string[]; onRemove: (path: string) => void }) {
  if (!paths.length) return null;
  return (
    <div className="composer-seed-attachments">
      {paths.map((path) => {
        const view = attachmentView(path);
        return (
          <div className="composer-seed-attachment" key={path}>
            {view.image && view.url ? <PreviewableImage src={view.url} alt={view.name} /> : <Paperclip size={14} aria-hidden="true" />}
            <span>{view.name}</span>
            <button type="button" onClick={() => onRemove(path)} aria-label={`移除 ${view.name}`}><X size={10} aria-hidden="true" /></button>
          </div>
        );
      })}
    </div>
  );
}
