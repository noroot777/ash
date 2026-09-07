export function claudeChatArgs(model?: string, effort?: string, settings: string | null = null): string[] {
  const args = [
    "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--safe-mode", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence",
  ];
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (settings) args.push("--settings", settings);
  return args;
}
