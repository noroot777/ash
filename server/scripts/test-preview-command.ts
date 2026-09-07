// 预览命令的来源（server/src/preview-command.ts）。
//
// 这条测试钉的是一件在 2026-09-07 之前**做错了的事**：预览命令只认 Node 项目根目录的
// package.json，于是一个 Java 仓库（pom.xml + 并排的前端子目录）点「打开预览」永远只能
// 得到一句「工作区没有 package.json」，而界面上没有任何地方能告诉 ash 该跑什么。
//
// 所以两件事必须同时成立，缺一条就退回原样：
//   ① 项目设置里填过命令 → 一个字不改地用它，不再看有没有 package.json（任何语言都能预览）。
//   ② 没填而且推导不出来 → 报错里得带着「这个仓库里其实有什么」和「去哪儿填」，
//      而不是一句「没有 package.json」让人对着一个 Java 仓库干瞪眼。
//
// 跑法：npm -w server run test:preview-command
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePreviewCommand } from "../src/preview-command.js";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ ${name}\n    expected ${e}\n    actual   ${a}`);
  } else {
    console.log(`✓ ${name}`);
  }
}
function checkIncludes(name: string, actual: string, needle: string) {
  if (!actual.includes(needle)) {
    failures++;
    console.error(`✗ ${name}\n    「${needle}」不在报错里，实际是：\n${actual}`);
  } else {
    console.log(`✓ ${name}`);
  }
}
function failure(cwd: string, configured?: string | null): string {
  try {
    const resolved = resolvePreviewCommand(cwd, configured ?? null);
    failures++;
    console.error(`✗ 本该抛错却推出了 ${resolved.command}`);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const root = mkdtempSync(join(tmpdir(), "ash-preview-command-"));
const pkg = (dir: string, scripts: Record<string, string>) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }));
};

try {
  // —— ① 填过就用填的那条，压根不看仓库长什么样 ——
  const java = join(root, "java");
  mkdirSync(java, { recursive: true });
  writeFileSync(join(java, "pom.xml"), "<project/>");
  check(
    "填过的命令原样用（Java 仓库，根本没有 package.json）",
    resolvePreviewCommand(java, "./mvnw spring-boot:run"),
    { command: "./mvnw spring-boot:run", source: "configured" },
  );
  check("首尾空白不算内容", resolvePreviewCommand(java, "  ./mvnw spring-boot:run  ").command, "./mvnw spring-boot:run");
  check(
    "填过的优先于推导（根目录明明有 dev 脚本也听用户的）",
    resolvePreviewCommand((() => { const d = join(root, "node-configured"); pkg(d, { dev: "vite" }); return d; })(), "npm run start:custom"),
    { command: "npm run start:custom", source: "configured" },
  );

  // —— ② 没填时的自动推导：跟改造前一模一样，别把老行为弄坏 ——
  const npmProject = join(root, "npm-project");
  pkg(npmProject, { dev: "vite" });
  check("npm + dev", resolvePreviewCommand(npmProject, null), { command: "npm run dev", source: "derived" });
  const pnpmProject = join(root, "pnpm-project");
  pkg(pnpmProject, { dev: "vite" });
  writeFileSync(join(pnpmProject, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  check("认 pnpm-lock", resolvePreviewCommand(pnpmProject, null).command, "pnpm run dev");
  const yarnProject = join(root, "yarn-project");
  pkg(yarnProject, { start: "node server.js" });
  writeFileSync(join(yarnProject, "yarn.lock"), "");
  check("认 yarn.lock，没有 dev 就用 start", resolvePreviewCommand(yarnProject, null).command, "yarn start");
  check("空串 = 没填，照旧推导", resolvePreviewCommand(npmProject, "   ").source, "derived");

  // —— ③ 推导不出来时那段话得真能照着做 ——
  // 现场按 a4sms-allinone 的样子搭：Java 后端 + 并排的前端子目录 + 根目录啥都没有。
  const mixed = join(root, "mixed");
  mkdirSync(mixed, { recursive: true });
  writeFileSync(join(mixed, "pom.xml"), "<project/>");
  pkg(join(mixed, "web-front"), { dev: "vite" });
  writeFileSync(join(mixed, "web-front", "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  mkdirSync(join(mixed, "back"), { recursive: true });
  const mixedError = failure(mixed);
  checkIncludes("说清楚为什么推不出来", mixedError, "工作区根目录没有 package.json");
  checkIncludes("指出子目录里其实跑得起来", mixedError, "cd web-front && pnpm run dev");
  checkIncludes("认出这是 Maven 项目并给示例", mixedError, "./mvnw spring-boot:run");
  checkIncludes("告诉他去哪儿填", mixedError, "项目设置 → 预览命令");

  // 纯 Node 但没有 dev/start：原因得说准，不能也报成「没有 package.json」。
  const scriptless = join(root, "scriptless");
  pkg(scriptless, { build: "tsc" });
  checkIncludes("没有 dev/start 的说法不一样", failure(scriptless), "没有 dev 或 start 脚本");

  // 隐藏目录和 node_modules 不许出现在建议里：那里面的 package.json 不是项目本体。
  const noisy = join(root, "noisy");
  mkdirSync(noisy, { recursive: true });
  pkg(join(noisy, "node_modules", "vite"), { dev: "vite" });
  pkg(join(noisy, ".cache", "thing"), { dev: "vite" });
  const noisyError = failure(noisy);
  check("node_modules 不进建议", noisyError.includes("node_modules"), false);
  check(".cache 不进建议", noisyError.includes(".cache"), false);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} 条不通过`);
  process.exit(1);
}
console.log("\npreview-command 全部通过");
