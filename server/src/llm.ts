// 直连大模型(HTTP fetch,不引 SDK)。仅用于把事项的自然语言解析成结构(当用户在
// 输入框选了「直连 API」而非本地 CLI 智能体时)。纯文本进出 —— 绝不用于执行(执行
// 要工具、要进仓库,只能用 CLI 智能体)。Key 存在项目上(本机用)。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";

export interface ProjectApiKeys {
  anthropic?: string;
  openai?: string;
}

const parseKeys = (raw: string | null): ProjectApiKeys => {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ProjectApiKeys;
  } catch {
    return {};
  }
};

export async function projectApiKeys(projectId: string | null): Promise<ProjectApiKeys> {
  if (!projectId) return {};
  const p = (await db.select().from(projects).where(eq(projects.id, projectId))).at(0);
  return parseKeys(p?.apiKeys ?? null);
}

// Issue parsing infers the project, so it can't know a projectId up front — fall
// back to the first key found across all projects (it's the user's own machine).
export async function anyApiKeys(): Promise<ProjectApiKeys> {
  const merged: ProjectApiKeys = {};
  for (const p of await db.select().from(projects)) {
    const k = parseKeys(p.apiKeys ?? null);
    merged.anthropic ??= k.anthropic;
    merged.openai ??= k.openai;
  }
  return merged;
}

// gpt*/o1*/o3* → OpenAI; everything else (claude*) → Anthropic.
const providerFor = (model: string): "anthropic" | "openai" =>
  /^(gpt|o\d|chatgpt|text-)/i.test(model) ? "openai" : "anthropic";

const TIMEOUT_MS = 30_000;

// Single text-completion call. Throws on missing key / non-2xx / timeout — the
// caller (parseIssue) catches and falls back to the raw text.
export async function callModel(model: string, prompt: string, keys: ProjectApiKeys): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    if (providerFor(model) === "anthropic") {
      if (!keys.anthropic) throw new Error("项目未配置 Anthropic API Key");
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": keys.anthropic,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const j = (await r.json()) as { content?: { type: string; text?: string }[] };
      return (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    }
    if (!keys.openai) throw new Error("项目未配置 OpenAI API Key");
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${keys.openai}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}
