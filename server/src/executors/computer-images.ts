import type { AgentEvent } from "@navi/shared";
import { persistToolResultImages, type ImageStore } from "../agent-attachments.js";
import { computerImageTarget } from "./computer-targets.js";

export function isComputerTool(name: string): boolean {
  return /^(?:computer(?:_use)?|mcp[._]+(?:cua|cua_repl|computer|computer_use|unified_computer_use)[._]+\w+|(?:cua|cua_repl|computer|computer_use|unified_computer_use)[._]+\w+)$/i.test(name);
}

export function toolImageEvents(value: unknown, seen: ImageStore, tool: string, allowBareBase64 = false, input?: unknown): Extract<AgentEvent, { kind: "attachment" }>[] {
  const target = isComputerTool(tool) ? computerImageTarget(value, input, seen, tool) : undefined;
  const computer = isComputerTool(tool) && target !== null;
  return persistToolResultImages(value, seen, { allowBareBase64, includeExisting: computer }).map((path) => ({ kind: "attachment", path,
    ...(computer ? { computer: tool.slice(0, 160), ...(target ? { computerTarget: target } : {}) } : {}) }));
}

export class ComputerToolImages {
  private calls = new Map<string, { name: string; input?: unknown }>();

  call(block: { id: string; name: string; toolset_name?: string; input?: unknown }): void {
    this.calls.set(block.id, { name: block.toolset_name ? `${block.toolset_name}.${block.name}` : block.name, input: block.input });
    if (this.calls.size > 1000) this.calls.delete(this.calls.keys().next().value!);
  }

  result(block: { tool_use_id: string; content: unknown }, seen: ImageStore) {
    const call = this.calls.get(block.tool_use_id);
    this.calls.delete(block.tool_use_id);
    return toolImageEvents(block.content, seen, call?.name ?? "", false, call?.input);
  }
}
