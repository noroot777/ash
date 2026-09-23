const MODELS_URL = "https://docs.anthropic.com/en/docs/about-claude/models/overview";
const MODEL_ID = /claude-[a-z0-9]+(?:-[a-z0-9]+)*(?![a-z0-9-])/g;
const DOCUMENTED_ID = /^(?:claude-(?:opus|sonnet)-(?:\d+-\d+|\d)(?:-\d{8})?|claude-haiku-\d+-\d+(?:-\d{8})?|claude-(?:fable|mythos)-\d+(?:-\d+)*|claude-mythos-preview)$/;

export function extractClaudeDocModels(html: string): string[] {
  return [...new Set((html.match(MODEL_ID) ?? []).filter((id) => DOCUMENTED_ID.test(id)))];
}

export async function fetchClaudeDocModels(): Promise<string[]> {
  const response = await fetch(MODELS_URL, {
    headers: { "user-agent": "ash/model-catalog" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Anthropic 模型文档返回 HTTP ${response.status}`);
  const models = extractClaudeDocModels(await response.text());
  if (!models.length) throw new Error("Anthropic 模型文档未列出可识别的模型 ID");
  return models;
}
