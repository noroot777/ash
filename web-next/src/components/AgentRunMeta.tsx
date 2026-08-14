export function AgentRunMeta({
  run,
}: {
  run?: { model: string | null; reasoningEffort: string | null };
}) {
  if (!run) return null;
  const model = run.model || "CLI 默认";
  const effort = run.reasoningEffort || "默认";
  return (
    <small className="agent-run-meta" aria-label={`模型：${model}；智能水平：${effort}`}>
      <code>{model}</code>
      <i aria-hidden="true">·</i>
      <code>{effort}</code>
    </small>
  );
}
