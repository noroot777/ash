export function powerShellCommandCases(node: string): {
  name: string;
  script: string;
  exitCode: number;
  output?: string;
  absentOutput?: string;
  error?: boolean;
  minimumVersion?: number;
}[] {
  const native = (exitCode: number) => `& '${node.replace(/'/g, "''")}' -e 'process.exit(${exitCode})'`;
  return [
    { name: "using", script: "using namespace System.Text\n[Encoding]::UTF8.WebName", exitCode: 0, output: "utf-8" },
    { name: "param", script: 'param([string]$name="DEFAULT_OK")\nWrite-Output "NAME=$name"', exitCode: 0, output: "NAME=DEFAULT_OK" },
    { name: "param-only", script: 'param([string]$name="DEFAULT_OK")', exitCode: 0 },
    { name: "using-only", script: "using namespace System.Text", exitCode: 0 },
    { name: "dynamicparam-only", script: "dynamicparam { [System.Management.Automation.RuntimeDefinedParameterDictionary]::new() }", exitCode: 0 },
    { name: "clean-only", script: 'clean { [Console]::WriteLine("CLEAN_OK") }', exitCode: 0, minimumVersion: 703 },
    { name: "end-clean", script: 'end { Write-Output "END_OK" }\nclean { [Console]::WriteLine("CLEAN_OK") }', exitCode: 0, output: "CLEAN_OK", minimumVersion: 703 },
    { name: "native-clean", script: `end { ${native(7)} }\nclean { [Console]::WriteLine("CLEAN_OK") }`, exitCode: 7, output: "CLEAN_OK", minimumVersion: 703 },
    {
      name: "advanced-param",
      script: 'using namespace System.Text\n[CmdletBinding()]\nparam([string]$name="DECLARED_OK")\nWrite-Output "$name $([Encoding]::UTF8.WebName)"',
      exitCode: 0,
      output: "DECLARED_OK utf-8",
    },
    ...["ReadOnly", "Constant", "ReadOnly,AllScope"].flatMap((option) => ["Local", "Global"].map((scope) => ({
      name: `variables-${scope}-${option}`,
      script: ["ok", "code", "source", "epilogue", "body", "lastBlock", "offset", "program", "finalizer", "block", "first", "succeeded", "exitState"]
        .map((name) => `Set-Variable -Name ${name} -Value $false -Option ${option} -Scope ${scope}`).join("\n")
        + '\nWrite-Output "SUCCESS"',
      exitCode: 0,
      output: "SUCCESS",
    }))),
    { name: "named-blocks", script: 'param([string]$name="BLOCK_OK")\nbegin { Write-Output "BEGIN" }\nprocess { Write-Output $name }\nend { Write-Output "END" }', exitCode: 0, output: "BLOCK_OK" },
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
    { name: "native-return", script: `${native(7)}\nif (-not $?) { return }\nWrite-Output ("SHOULD_" + "NOT_RUN")`, exitCode: 7, absentOutput: "SHOULD_NOT_RUN" },
    { name: "cmdlet-return", script: 'Write-Error "EXPECTED_FAILURE"\nreturn\nWrite-Output ("SHOULD_" + "NOT_RUN")', exitCode: 1, error: true, absentOutput: "SHOULD_NOT_RUN" },
    ...["begin", "process", "end"].flatMap((block) => [
      { name: `${block}-native-return`, script: `${block} { ${native(7)}\nif (-not $?) { return }\nWrite-Output ("SHOULD_" + "NOT_RUN") }`, exitCode: 7, absentOutput: "SHOULD_NOT_RUN" },
      { name: `${block}-cmdlet-return`, script: `${block} { Write-Error "EXPECTED_FAILURE"\nreturn\nWrite-Output ("SHOULD_" + "NOT_RUN") }`, exitCode: 1, error: true, absentOutput: "SHOULD_NOT_RUN" },
      { name: `${block}-throw`, script: `${block} { throw "EXPECTED_FAILURE" }`, exitCode: 1, error: true },
    ]),
    { name: "success-return", script: 'return "RETURN_OK"\nthrow "SHOULD_NOT_RUN"', exitCode: 0, output: "RETURN_OK" },
    { name: "recovered-return", script: `${native(7)}\nWrite-Output "RECOVERED"\nreturn\nthrow "SHOULD_NOT_RUN"`, exitCode: 0, output: "RECOVERED" },
    { name: "return-native", script: `return ${native(7)}`, exitCode: 7 },
    { name: "return-cmdlet", script: 'return Write-Error "EXPECTED_FAILURE"', exitCode: 1, error: true },
    { name: "return-function", script: 'function Get-Result { return "FUNCTION_OK" }\nreturn Get-Result', exitCode: 0, output: "FUNCTION_OK" },
    { name: "trap-recovery", script: 'trap { Write-Output "TRAPPED"; continue }\nthrow "EXPECTED_FAILURE"\nWrite-Output "TRAP_OK"', exitCode: 0, output: "TRAP_OK" },
    { name: "recovered-blocks", script: `begin { ${native(7)}\nreturn }\nprocess { Write-Output "PROCESS_OK" }\nend { Write-Output "END_OK" }`, exitCode: 0, output: "PROCESS_OK" },
    { name: "native-return-clean", script: `end { ${native(7)}\nreturn }\nclean { [Console]::WriteLine("CLEAN_OK") }`, exitCode: 7, output: "CLEAN_OK", minimumVersion: 703 },
    { name: "explicit-native-exit", script: `${native(7)}\nexit $LASTEXITCODE`, exitCode: 7 },
    { name: "explicit-zero-exit", script: `${native(7)}\nexit 0`, exitCode: 0 },
    { name: "cmdlet-failure", script: 'Write-Error "EXPECTED_FAILURE"', exitCode: 1, error: true },
    { name: "throw", script: 'throw "EXPECTED_FAILURE"', exitCode: 1, error: true },
    { name: "parse-error", script: 'param(', exitCode: 1, error: true },
    { name: "explicit-exit", script: "exit 3", exitCode: 3 },
  ];
}
