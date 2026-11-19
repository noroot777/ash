import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { checkScriptImports } from "./check-script-imports.mjs";

const root = mkdtempSync(join(tmpdir(), "navi-script-imports-"));
try {
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "src"));
  const configPath = join(root, "tsconfig.json");
  writeFileSync(configPath, JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noUnusedLocals: true,
      allowImportingTsExtensions: true,
      allowJs: true,
      checkJs: true,
      types: [],
      skipLibCheck: true,
    },
    include: ["scripts"],
  }));
  writeFileSync(join(root, "src/api.ts"), `
    export const present = 1;
    export type Item = { text: string };
    export default present;
  `);
  writeFileSync(join(root, "scripts/valid.ts"), `
    import value, { present as alias, type Item } from "../src/api.ts";
    import * as namespace from "../src/api.ts";
    export { present as again } from "../src/api.ts";
    const incomplete: Item = {};
  `);
  assert.deepEqual(checkScriptImports(configPath).diagnostics, [], "合法导入不受未使用变量或裁剪测试数据影响");

  const broken = {
    "missing-value.tsx": 'import { missingValue } from "../src/api.ts";',
    "missing-type.ts": 'import type { MissingType } from "../src/api.ts";',
    "missing-js.mjs": 'import { missingJs } from "../src/api.ts";',
    "missing-reexport.ts": 'export { missingReexport as alias } from "../src/api.ts";',
    "missing-module.ts": 'import { anything } from "../src/absent.ts";',
  };
  for (const [fileName, source] of Object.entries(broken)) writeFileSync(join(root, "scripts", fileName), source);
  const result = checkScriptImports(configPath);
  assert.equal(result.files, 6);
  assert.deepEqual(result.diagnostics.map((item) => basename(item.file.fileName)).sort(), Object.keys(broken).sort());
  assert.ok(result.diagnostics.every((item) => [2305, 2307, 2614, 2724].includes(item.code)));

  for (const fileName of Object.keys(broken)) writeFileSync(join(root, "scripts", fileName), 'export { present } from "../src/api.ts";');
  assert.deepEqual(checkScriptImports(configPath).diagnostics, [], "迁移到有效导出后检查恢复通过");
  assert.ok(checkScriptImports(join(root, "absent.json")).diagnostics.length, "配置缺失不允许静默通过");
  console.log("✓ 测试脚本的值导入、类型导入、JS 导入、再导出和模块路径均可提前检查");
} finally {
  rmSync(root, { recursive: true, force: true });
}
