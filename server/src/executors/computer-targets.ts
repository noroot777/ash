import type { ComputerUseTarget } from "@navi/shared/task-runtime";
import type { ImageStore } from "../agent-attachments.js";

type Targets = { aliases: Map<string, ComputerUseTarget>; browsers: Set<string> };
const targets = new WeakMap<ImageStore, Targets>();

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return record(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function resultText(value: unknown, depth = 0): string {
  if (depth > 4) return "";
  if (typeof value === "string") return value.slice(0, 128_000);
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => resultText(item, depth + 1)).join("\n");
  const body = record(value);
  return resultText(body.text ?? body.content ?? body.contentItems ?? body.result, depth + 1);
}

export function validComputerTarget(value: unknown): value is ComputerUseTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = record(value);
  return typeof target.application === "string" && target.application.length > 0 && target.application.length <= 4096
    && target.application.trim() === target.application && !/^[\s-]|[\x00-\x1f\x7f:]/.test(target.application)
    && (!target.application.includes("/") || (target.application.startsWith("/") && target.application.endsWith(".app")))
    && typeof target.name === "string" && target.name.trim().length > 0 && target.name.length <= 200
    && (target.windowTitle === undefined || (typeof target.windowTitle === "string" && target.windowTitle.length <= 512));
}

export function computerImageTarget(value: unknown, input: unknown, seen: ImageStore, tool: string): ComputerUseTarget | null | undefined {
  if (/(?:[._])js_reset$/i.test(tool)) { targets.delete(seen); return undefined; }
  const args = record(input);
  const code = typeof args.code === "string" ? args.code : "";
  const state = targets.get(seen) ?? { aliases: new Map<string, ComputerUseTarget>(), browsers: new Set<string>() };
  targets.set(seen, state);
  for (const assignment of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
    state.aliases.delete(assignment[1]!); state.browsers.delete(assignment[1]!);
  }
  const selection = /(?:(?:let|const|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?cua\.getApp\s*\(/.exec(code);
  const body = record(value);
  const text = resultText(value);
  if (body.isError === true || body.success === false || body.error || /(?:Invalid app:|not allowed to use the app|for safety reasons)/i.test(text)) return undefined;
  const browserSelection = /(?:(?:let|const|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?cua\.(?:getTab|getBrowser|createBrowserTab)\s*\(/.exec(code);
  if (browserSelection) {
    state.aliases.delete(browserSelection[1]!);
    state.browsers.add(browserSelection[1]!);
    if (state.browsers.size > 50) state.browsers.delete(state.browsers.values().next().value!);
  }
  const selections = [...code.matchAll(/\bcua\.getApp\(\s*(["'])([^"'\\\r\n]+)\1\s*\)/g)];
  const direct = selections.length === 1 ? selections[0] : undefined;
  const name = [...text.matchAll(/(?:^|\n)Window:[^\n]*, App:\s*([^\n]+)/g)].at(-1)?.[1]?.trim().replace(/\.$/, "");
  const windowTitle = [...text.matchAll(/(?:^|\n)Window:\s*"([^"\n]*)", App:/g)].at(-1)?.[1];
  let selected: ComputerUseTarget | undefined;
  if (direct && name) {
    const target = { application: direct[2]!, name, ...(windowTitle === undefined ? {} : { windowTitle }) };
    if (validComputerTarget(target)) {
      selected = target;
      if (selection) state.aliases.set(selection[1]!, target);
      if (state.aliases.size > 50) state.aliases.delete(state.aliases.keys().next().value!);
    }
  }
  const references = [...code.matchAll(/\b([A-Za-z_$][\w$]*)(?:\.\w+)*\.\w+\s*\(/g)]
    .map((match) => match[1]!).filter((alias) => alias !== "cua" && alias !== "nodeRepl" && alias !== "console");
  const aliases = new Set(references);
  if (!selected && (/\bcua\.(?:getTab|getBrowser|createBrowserTab)\s*\(/.test(code)
    || (aliases.size === 1 && state.browsers.has(references[0]!)))) return null;
  const target = aliases.size === 1 ? state.aliases.get(references[0]!) : aliases.size ? undefined : selected;
  if (target && windowTitle !== undefined && name === target.name) {
    const updated = { ...target, windowTitle };
    if (aliases.size === 1) state.aliases.set(references[0]!, updated);
    return updated;
  }
  return target;
}
