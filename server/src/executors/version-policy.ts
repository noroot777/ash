const SEMVER = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\D|$)/;

export function isAffectedCodexVersion(version: string | null | undefined): boolean {
  if (!version) return false;
  const match = version.match(SEMVER);
  return !!match && Number(match[1]) === 0 && Number(match[2]) === 147;
}

export function affectedCodexSessionWarning(version: string | null | undefined): string | undefined {
  if (!isAffectedCodexVersion(version)) return undefined;
  return `这条 Codex 会话由受影响的 ${version} 创建，旧会话里的工具清单可能已经损坏。`
    + "下次运行时 ash 会停止续用它，改从任务正文开启全新会话；旧的对话与执行记录仍会保留。";
}

export function affectedCodexSessionReplacementNote(version: string | null | undefined): string | undefined {
  if (!isAffectedCodexVersion(version)) return undefined;
  return `这条 Codex 会话由受影响的 ${version} 创建，旧会话里的工具清单可能已经损坏。`
    + "ash 已判定本轮不再续用它，将从任务正文开启全新会话；旧的对话与执行记录仍会保留。";
}
