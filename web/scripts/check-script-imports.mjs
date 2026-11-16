import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export function checkScriptImports(configPath) {
  const configErrors = [];
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => configErrors.push(diagnostic),
  });
  if (!config) return { files: 0, diagnostics: configErrors };
  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: { ...config.options, noEmit: true, noUnusedLocals: false, noUnusedParameters: false },
  });
  const diagnostics = [...config.errors, ...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
  for (const fileName of config.fileNames) {
    const source = program.getSourceFile(fileName);
    const imports = source.statements.filter((statement) =>
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement));
    diagnostics.push(...program.getSyntacticDiagnostics(source));
    if (!imports.length) continue;
    diagnostics.push(...program.getSemanticDiagnostics(source).filter((diagnostic) =>
      imports.some((statement) => diagnostic.start >= statement.getStart(source) && diagnostic.start < statement.end)));
  }
  return { files: config.fileNames.length, diagnostics };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = resolve(dirname(fileURLToPath(import.meta.url)), "../tsconfig.script-imports.json");
  const { files, diagnostics } = checkScriptImports(configPath);
  if (diagnostics.length) {
    console.error(ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    }));
    process.exitCode = 1;
  } else {
    console.log(`[script-imports] ${files} 个脚本的导入和再导出检查通过。`);
  }
}
