import { useId, useMemo } from "react";
import { Robot } from "@phosphor-icons/react";
import type { AgentType } from "@ash/shared";
import antigravity from "./agent-icons/antigravity.svg?raw";
import claude from "./agent-icons/claude.svg?raw";
import codex from "./agent-icons/codex.svg?raw";
import copilot from "./agent-icons/copilot.svg?raw";
import cursor from "./agent-icons/cursor.svg?raw";
import gemini from "./agent-icons/gemini.svg?raw";
import grok from "./agent-icons/grok.svg?raw";
import kilo from "./agent-icons/kilo.svg?raw";
import kimi from "./agent-icons/kimi.svg?raw";
import kiro from "./agent-icons/kiro.svg?raw";
import opencode from "./agent-icons/opencode.svg?raw";
import pi from "./agent-icons/pi.svg?raw";
import qoder from "./agent-icons/qoder.svg?raw";
import qwen from "./agent-icons/qwen.svg?raw";
import trae from "./agent-icons/trae.svg?raw";

// 各家的标，取自 @lobehub/icons-static-svg（MIT）。有品牌色的用彩色版，本来就是黑白的
// （cursor、grok、opencode…）用单色版、走 currentColor，深色模式跟着翻。
// 加一个智能体（shared 的 AGENT_TYPES）而这里没补，satisfies 会让编译不过。
const ICONS = {
  claude, codex, antigravity, gemini, opencode, trae, grok, kimi, cursor, qwen, qoder, copilot, kiro, kilo, pi,
} satisfies Record<AgentType, string>;

export function hasAgentIcon(agent: string | null | undefined): boolean {
  return !!agent && Object.hasOwn(ICONS, agent);
}

/** 智能体的标；认不出的（自定义执行器名之类）退回通用的机器人。 */
export function AgentIcon({ agent, size = 14, className }: { agent: string | null | undefined; size?: number; className?: string }) {
  const uid = useId().replace(/[^\w-]/g, "");
  const svg = hasAgentIcon(agent) ? ICONS[agent as AgentType] : null;
  // 渐变是按 id 引用的：同一个标在页面上画好几遍，id 撞了会引用到别处那份（那份被藏起来就整个不画）。
  const markup = useMemo(() => svg?.replaceAll("__UID__", uid) ?? null, [svg, uid]);
  if (!markup) return <Robot size={size} className={className} aria-hidden="true" />;
  return (
    <span
      className={`agent-icon${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
