import type { AgentEvent } from "@navi/shared";
import { persistToolResultImages, type ImageStore } from "../agent-attachments.js";

export function isComputerTool(name: string): boolean {
  return /^(?:computer(?:_use)?|mcp[._]+(?:cua|cua_repl|computer|computer_use|unified_computer_use|claude_in_chrome|playwright)[._]+\w+|(?:cua|cua_repl|computer|computer_use|unified_computer_use|claude_in_chrome|playwright)[._]+\w+)$/i.test(name);
}

export function toolImageEvents(value: unknown, seen: ImageStore, tool: string, allowBareBase64 = false): Extract<AgentEvent, { kind: "attachment" }>[] {
  return persistToolResultImages(value, seen, { allowBareBase64, includeExisting: isComputerTool(tool) }).map((path) => ({ kind: "attachment", path,
    ...(isComputerTool(tool) ? { computer: tool.slice(0, 160) } : {}) }));
}

export class ComputerToolImages {
  private calls = new Map<string, string>();

  call(block: { id: string; name: string; toolset_name?: string }): void {
    this.calls.set(block.id, block.toolset_name ? `${block.toolset_name}.${block.name}` : block.name);
    if (this.calls.size > 1000) this.calls.delete(this.calls.keys().next().value!);
  }

  result(block: { tool_use_id: string; content: unknown }, seen: ImageStore) {
    const name = this.calls.get(block.tool_use_id) ?? "";
    this.calls.delete(block.tool_use_id);
    return toolImageEvents(block.content, seen, name);
  }
}
