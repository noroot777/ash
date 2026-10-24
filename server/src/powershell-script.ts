import { randomUUID } from "node:crypto";

export function powerShellScriptInvocation(command: string, scriptPath: string, pathEnd: number): string {
  const resultKey = randomUUID();
  const fileResultKey = randomUUID();
  const invocation = `& (__ashLoadScript ${scriptPath})${command.slice(pathEnd)}`;
  const encoded = Buffer.from(invocation, "utf16le").toString("base64");
  return [
    "& {",
    "function __ashCaptureResult([string]$source, [string]$file, [string]$key) {",
    "  $program = [scriptblock]::Create($source)",
    "  $finalizer = @'",
    "",
    "} finally {",
    "  & { [AppDomain]::CurrentDomain.SetData('__ASH_RESULT_KEY__', $args) } $? $LASTEXITCODE",
    "}",
    "'@",
    "  $finalizer = $finalizer.Replace('__ASH_RESULT_KEY__', $key)",
    "  foreach ($block in @($program.Ast.EndBlock, $program.Ast.ProcessBlock, $program.Ast.BeginBlock)) {",
    "    if ($null -eq $block) { continue }",
    "    $first = @(@($block.Statements) + @($block.Traps) | Where-Object { $null -ne $_ } | Sort-Object { $_.Extent.StartOffset })[0]",
    "    if ($null -eq $first) { continue }",
    "    $offset = $source.Length",
    "    if (-not $block.Unnamed) { $offset = $block.Extent.EndOffset - 1 }",
    '    $source = $source.Insert($offset, $finalizer).Insert($first.Extent.StartOffset, "try {`n")',
    "  }",
    "  [System.Management.Automation.Language.Parser]::ParseInput($source, $file, [ref]$null, [ref]$null).GetScriptBlock()",
    "}",
    "function __ashLoadScript([string]$path) {",
    "  $original = $ExecutionContext.InvokeCommand.GetCommand($path, [System.Management.Automation.CommandTypes]::ExternalScript)",
    "  if ($null -eq $original) { throw \"PowerShell script not found: $path\" }",
    `  $program = __ashCaptureResult $original.ScriptContents $original.Path '${fileResultKey}'`,
    "  [System.Management.Automation.ExternalScriptInfo].GetProperty('ScriptBlock').SetValue($original, $program, $null)",
    "  $original",
    "}",
    `$source = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))`,
    "$body = [scriptblock]::Create($source).Ast.EndBlock",
    "$useFileResult = $body.Statements.Count -eq 1 -and $body.Statements[0] -is [System.Management.Automation.Language.PipelineAst] -and $body.Statements[0].PipelineElements.Count -eq 1",
    `$program = __ashCaptureResult $source '' '${resultKey}'`,
    "$global:LASTEXITCODE = 0",
    "& $program",
    "& {",
    "  if ($args[2] -and $null -ne $args[4] -and $args[3][0] -and $args[3][1] -eq $args[4][1]) { $args[3] = $args[4] }",
    "  if ($null -ne $args[3]) { $args[0], $args[1] = $args[3] }",
    "  if ($args[0]) { exit 0 }",
    "  if ($args[1] -is [int] -and $args[1] -ne 0) { exit $args[1] }",
    "  exit 1",
    `} $? $LASTEXITCODE $useFileResult ([AppDomain]::CurrentDomain.GetData('${resultKey}')) ([AppDomain]::CurrentDomain.GetData('${fileResultKey}'))`,
    "}",
  ].join("\n");
}
