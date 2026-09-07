// 「这个项目怎么起服务」的识别（server/src/preview-command.ts）。
//
// 这条测试钉的是一次**判断失误**的反面：预览最早只认 Node 的 package.json，于是一个
// Java 仓库点「打开预览」只能得到「工作区没有 package.json」，而唯一的出路是往 Java
// 项目里加一个 Node 的文件 —— 那不是给它做预览，是要求它先变成 Node 项目。
//
// 所以三件事必须同时成立：
//   ① 每种语言都按**它自己的**惯例被认出来（Maven 的 spring-boot:run、Gradle 的 bootRun、
//      Django 的 runserver、go run…），Node 只是其中一行。
//   ② 认出不止一个就**不猜**：前后端并排、Maven 多模块各带一个应用，猜错等于让用户对着
//      另一个服务验收自己的改动。列清单，让他指一个。
//   ③ 项目设置里填了命令永远优先，且不再看仓库长什么样。
//
// 跑法：npm -w server run test:preview-command
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPreviewCandidates, resolvePreviewCommand } from "../src/preview-command.js";

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
    console.error(`✗ ${name}\n    「${needle}」不在里面，实际是：\n${actual}`);
  } else {
    console.log(`✓ ${name}`);
  }
}
function failure(cwd: string, configured?: string | null): string {
  try {
    const resolved = resolvePreviewCommand(cwd, configured ?? null);
    failures++;
    console.error(`✗ 本该抛错却认成了 ${resolved.command}`);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const root = mkdtempSync(join(tmpdir(), "ash-preview-command-"));
const dir = (...parts: string[]) => {
  const p = join(root, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};
const file = (p: string, name: string, body = "") => writeFileSync(join(p, name), body);
const pkg = (p: string, scripts: Record<string, string>) => file(p, "package.json", JSON.stringify({ scripts }));
const BOOT_POM = "<project><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>";
const LIB_POM = "<project><artifactId>lib</artifactId></project>";
const cmds = (p: string) => detectPreviewCandidates(p).map((c) => c.command);

try {
  // —— ① 每种语言按它自己的惯例 ——
  const maven = dir("maven");
  file(maven, "pom.xml", BOOT_POM);
  check("单模块 Spring Boot：没有 wrapper 就用 mvn", cmds(maven), ["mvn spring-boot:run"]);
  const mavenW = dir("maven-wrapper");
  file(mavenW, "pom.xml", BOOT_POM);
  file(mavenW, "mvnw", "#!/bin/sh\n");
  check("有 wrapper 才写 ./mvnw", cmds(mavenW), ["./mvnw spring-boot:run"]);
  check("Java 项目根本不需要 package.json", resolvePreviewCommand(maven, null), {
    command: "mvn spring-boot:run", source: "detected",
  });

  const gradle = dir("gradle");
  file(gradle, "build.gradle.kts", "");
  check("Gradle 没 wrapper", cmds(gradle), ["gradle bootRun"]);
  const gradleW = dir("gradle-wrapper");
  file(gradleW, "build.gradle", "");
  file(gradleW, "gradlew", "#!/bin/sh\n");
  check("Gradle 有 wrapper", cmds(gradleW), ["./gradlew bootRun"]);

  const django = dir("django");
  file(django, "manage.py", "");
  check("Django 用自己的 runserver，端口走 $PORT", cmds(django), ["python manage.py runserver 0.0.0.0:$PORT"]);

  const go = dir("go");
  file(go, "go.mod", "module x\n");
  file(go, "main.go", "package main\n");
  check("Go", cmds(go), ["go run ."]);

  const rust = dir("rust");
  file(rust, "Cargo.toml", "[package]\n");
  check("Rust", cmds(rust), ["cargo run"]);

  const dotnet = dir("dotnet");
  file(dotnet, "App.csproj", "");
  check(".NET", cmds(dotnet), ["dotnet run"]);

  const laravel = dir("laravel");
  file(laravel, "artisan", "");
  check("Laravel", cmds(laravel), ["php artisan serve --port=$PORT"]);

  const rails = dir("rails");
  mkdirSync(join(rails, "bin"), { recursive: true });
  file(join(rails, "bin"), "rails", "");
  check("Rails", cmds(rails), ["bin/rails server -p $PORT"]);

  // Node 还是照旧认，只是不再是「预览」这件事的定义。
  const node = dir("node");
  pkg(node, { dev: "vite" });
  check("Node + npm", cmds(node), ["npm run dev"]);
  const pnpmNode = dir("node-pnpm");
  pkg(pnpmNode, { dev: "vite" });
  file(pnpmNode, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  check("Node + pnpm", cmds(pnpmNode), ["pnpm run dev"]);
  const yarnNode = dir("node-yarn");
  pkg(yarnNode, { start: "node server.js" });
  file(yarnNode, "yarn.lock", "");
  check("Node + yarn，没有 dev 就用 start", cmds(yarnNode), ["yarn start"]);

  // —— ② 多个候选就不猜 ——
  // 现场按 a4sms-allinone 搭：根目录什么都没有，后端是 Maven 多模块（两个能起的应用 +
  // 一个库模块），前端是并排的 vite 子目录。
  const mono = dir("mono");
  const back = dir("mono", "a4sms-back");
  file(back, "pom.xml", "<project><modules><module>a4sms-common</module><module>a4sms-icis</module><module>a4sms-wms</module></modules></project>");
  file(dir("mono", "a4sms-back", "a4sms-common"), "pom.xml", LIB_POM);
  file(dir("mono", "a4sms-back", "a4sms-icis"), "pom.xml", BOOT_POM);
  file(dir("mono", "a4sms-back", "a4sms-wms"), "pom.xml", BOOT_POM);
  const front = dir("mono", "a4sms-front");
  pkg(front, { dev: "vite" });
  file(front, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  check("多模块 + 前端：一个都不漏，库模块不算", cmds(mono).sort(), [
    "cd a4sms-back && mvn -pl a4sms-icis spring-boot:run",
    "cd a4sms-back && mvn -pl a4sms-wms spring-boot:run",
    "cd a4sms-front && pnpm run dev",
  ]);
  const monoError = failure(mono);
  checkIncludes("说清楚为什么不替你挑", monoError, "认出了 3 个能起服务的东西");
  checkIncludes("Maven 模块按 Java 的说法列", monoError, "cd a4sms-back && mvn -pl a4sms-icis spring-boot:run");
  checkIncludes("前端那条也在", monoError, "cd a4sms-front && pnpm run dev");
  checkIncludes("告诉他去哪儿填", monoError, "项目设置 → 预览命令");
  check("整段话里不提 package.json", monoError.includes("package.json"), false);
  checkIncludes("多模块首次要装依赖模块的写法也给了", monoError, "-am install -DskipTests");

  // 一个都没认出来：话里同样不能只谈 Node。
  const empty = dir("empty");
  file(empty, "README.md", "");
  const emptyError = failure(empty);
  checkIncludes("认不出来时列出找过哪些", emptyError, "spring-boot:run");
  checkIncludes("并且明说任何语言都行", emptyError, "任何语言都行");

  // —— ③ 填过的永远优先 ——
  check("填了就用填的（Java 仓库）", resolvePreviewCommand(maven, "java -jar target/app.jar"), {
    command: "java -jar target/app.jar", source: "configured",
  });
  check("填的优先于认出来的", resolvePreviewCommand(mono, "make dev").command, "make dev");
  check("首尾空白不算内容", resolvePreviewCommand(maven, "  mvn spring-boot:run  ").command, "mvn spring-boot:run");
  check("空串 = 没填", resolvePreviewCommand(maven, "   ").source, "detected");

  // —— 扫描的边角 ——
  // node_modules / target 里全是假信号（每个包都有 package.json），扫进来就会天天「多个候选」。
  const noisy = dir("noisy");
  pkg(noisy, { dev: "vite" });
  pkg(dir("noisy", "node_modules", "vite"), { dev: "vite" });
  file(dir("noisy", "target", "classes"), "pom.xml", BOOT_POM);
  pkg(dir("noisy", ".cache", "thing"), { dev: "vite" });
  check("产物/依赖目录不参与识别", cmds(noisy), ["npm run dev"]);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} 条不通过`);
  process.exit(1);
}
console.log("\npreview-command 全部通过");
