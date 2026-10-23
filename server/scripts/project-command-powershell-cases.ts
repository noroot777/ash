export function powerShellCommandCases(node: string): {
  name: string;
  script: string;
  exitCode: number;
  output?: string;
  error?: boolean;
}[] {
  const native = (exitCode: number) => `& '${node.replace(/'/g, "''")}' -e 'process.exit(${exitCode})'`;
  return [
    { name: "using", script: "using namespace System.Text\n[Encoding]::UTF8.WebName", exitCode: 0, output: "utf-8" },
    { name: "param", script: 'param([string]$name="DEFAULT_OK")\nWrite-Output "NAME=$name"', exitCode: 0, output: "NAME=DEFAULT_OK" },
    {
      name: "advanced-param",
      script: 'using namespace System.Text\n[CmdletBinding()]\nparam([string]$name="DECLARED_OK")\nWrite-Output "$name $([Encoding]::UTF8.WebName)"',
      exitCode: 0,
      output: "DECLARED_OK utf-8",
    },
    ...["ReadOnly", "Constant", "ReadOnly,AllScope"].map((option) => ({
      name: `variables-${option}`,
      script: ["ok", "code", "source", "epilogue", "body", "lastBlock", "offset", "program"]
        .map((name) => `Set-Variable -Name ${name} -Value $false -Option ${option}`).join("\n")
        + '\nWrite-Output "SUCCESS"',
      exitCode: 0,
      output: "SUCCESS",
    })),
    { name: "named-blocks", script: 'param([string]$name="BLOCK_OK")\nbegin { Write-Output "BEGIN" }\nprocess { Write-Output $name }\nend { Write-Output "END" }', exitCode: 0, output: "END" },
    { name: "process-only", script: 'process { Write-Output "PROCESS_OK" }', exitCode: 0, output: "PROCESS_OK" },
    { name: "begin-only", script: 'begin { Write-Output "BEGIN_OK" }', exitCode: 0, output: "BEGIN_OK" },
    { name: "class", script: 'class ScriptResult { [string] GetName() { return "CLASS_OK" } }\n([ScriptResult]::new()).GetName()', exitCode: 0, output: "CLASS_OK" },
    { name: "requires", script: '#requires -Version 3.0\nWrite-Output "REQUIRES_OK"', exitCode: 0, output: "REQUIRES_OK" },
    { name: "unicode-offset", script: '# 中文😀\nend { Write-Output "UNICODE_OK" }', exitCode: 0, output: "UNICODE_OK" },
    { name: "trailing-comment", script: 'Write-Output "COMMENT_OK" # no final newline', exitCode: 0, output: "COMMENT_OK" },
    { name: "native-failure", script: native(7), exitCode: 7 },
    { name: "native-success", script: native(0), exitCode: 0 },
    { name: "recovered-cmdlet", script: `${native(7)}\nWrite-Output "RECOVERED"`, exitCode: 0, output: "RECOVERED" },
    { name: "recovered-native", script: `${native(7)}\n${native(0)}`, exitCode: 0 },
    { name: "named-native-failure", script: `end { ${native(7)} }`, exitCode: 7 },
    { name: "cmdlet-failure", script: 'Write-Error "EXPECTED_FAILURE"', exitCode: 1, error: true },
    { name: "throw", script: 'throw "EXPECTED_FAILURE"', exitCode: 1, error: true },
    { name: "parse-error", script: 'param(', exitCode: 1, error: true },
    { name: "explicit-exit", script: "exit 3", exitCode: 3 },
  ];
}
