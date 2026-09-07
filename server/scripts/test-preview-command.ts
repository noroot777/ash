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
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPreviewCandidates, resolvePreviewCommand, PORT_ENV_ALIASES } from "../src/preview-command.js";

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
// POSIX 上 `python` 常常根本不存在（只给 python3），Windows 反过来 —— 命令里写哪个由
// 平台定，所以期望值也跟着平台算，别把某一边的答案钉死。
const PY = process.platform === "win32" ? "python" : "python3";

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
  check("Django 用自己的 runserver，端口走 $PORT", cmds(django), [`${PY} manage.py runserver 0.0.0.0:$PORT`]);

  // Django 之外的 Python 没有任何「项目文件」说明它是个 web 服务，只有源码里那句
  // `app = FastAPI()` 没有歧义 —— 而且顺带把 `模块:变量` 也说了。
  const fastapi = dir("fastapi");
  file(fastapi, "pyproject.toml", "[project]\nname='x'\n");
  file(fastapi, "main.py", "from fastapi import FastAPI\n\napp = FastAPI()\n");
  check("FastAPI 从源码里认出模块:变量", cmds(fastapi), [`${PY} -m uvicorn main:app --host 0.0.0.0 --port $PORT`]);
  const fastapiAlt = dir("fastapi-alt");
  file(fastapiAlt, "server.py", "api = FastAPI(title='x')\n");
  check("入口不叫 main.py 也认，变量名照抄", cmds(fastapiAlt), [`${PY} -m uvicorn server:api --host 0.0.0.0 --port $PORT`]);
  const flask = dir("flask");
  file(flask, "app.py", "from flask import Flask\napp = Flask(__name__)\n");
  check("Flask 用它自己的 CLI", cmds(flask), [`${PY} -m flask --app app run --host 0.0.0.0 --port $PORT`]);
  // 光有 .py 不代表是个 web 服务；认错了就是给人一条必然起不来的命令。
  const pyScript = dir("py-script");
  file(pyScript, "pyproject.toml", "[project]\nname='x'\n");
  file(pyScript, "train.py", "import torch\nprint('hi')\n");
  check("普通 Python 脚本不算能起服务的东西", cmds(pyScript), []);

  const go = dir("go");
  file(go, "go.mod", "module x\n");
  file(go, "main.go", "package main\n");
  check("Go", cmds(go), ["go run ."]);
  // `cmd/<名字>/main.go` 是 Go 里最常见的布局，根目录反而没有 main.go。
  const goCmd = dir("go-cmd");
  file(goCmd, "go.mod", "module x\n");
  file(dir("go-cmd", "cmd", "api"), "main.go", "package main\n");
  file(dir("go-cmd", "cmd", "worker"), "main.go", "package main\n");
  check("Go 的 cmd/ 布局，每个入口一条", cmds(goCmd), ["go run ./cmd/api", "go run ./cmd/worker"]);

  const rust = dir("rust");
  file(rust, "Cargo.toml", "[package]\n");
  check("Rust", cmds(rust), ["cargo run"]);

  const dotnet = dir("dotnet");
  file(dotnet, "App.csproj", "");
  check(".NET", cmds(dotnet), ["dotnet run"]);
  // ASP.NET Core 不读 PORT，它认 ASPNETCORE_URLS，而且要的是整条地址不是端口号。
  check(
    ".NET 当配角时按它自己的变量名和格式",
    detectPreviewCandidates(dotnet)[0].sidekick(3),
    "(ASPNETCORE_URLS=http://localhost:$PORT3 dotnet run &)",
  );

  const laravel = dir("laravel");
  file(laravel, "artisan", "");
  check("Laravel", cmds(laravel), ["php artisan serve --port=$PORT"]);

  const rails = dir("rails");
  mkdirSync(join(rails, "bin"), { recursive: true });
  file(join(rails, "bin"), "rails", "");
  check("Rails", cmds(rails), ["bin/rails server -p $PORT"]);

  // Node 还是照旧认，只是不再是「预览」这件事的定义。
  // 端口怎么给要看脚本里跑的是谁：**vite 不读 PORT**（vite 6 实测：`PORT=41111 vite` 起在
  // 配置里那个 3000 上），只认 `--port`；Next/CRA/Nest/Express 反过来只认 PORT，多塞一个
  // 未知参数有的直接报错退出。给错了都是「ash 借了端口、命令没吃」。
  const node = dir("node");
  pkg(node, { dev: "vite" });
  check("Node + npm + vite：端口写成参数", cmds(node), ["npm run dev -- --port $PORT"]);
  const pnpmNode = dir("node-pnpm");
  pkg(pnpmNode, { dev: "vite" });
  file(pnpmNode, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  check("Node + pnpm", cmds(pnpmNode), ["pnpm run dev -- --port $PORT"]);
  const yarnNode = dir("node-yarn");
  pkg(yarnNode, { start: "node server.js" });
  file(yarnNode, "yarn.lock", "");
  check("Node + yarn，没有 dev 就用 start；认 PORT 的不加参数", cmds(yarnNode), ["yarn start"]);
  const yarnVite = dir("node-yarn-vite");
  pkg(yarnVite, { dev: "vite --mode development" });
  file(yarnVite, "yarn.lock", "");
  check("yarn 直接透传，不要那个 --", cmds(yarnVite), ["yarn dev --port $PORT"]);
  const crossEnv = dir("node-cross-env");
  pkg(crossEnv, { dev: "cross-env NODE_ENV=development vite" });
  check("cross-env 前缀跳过去再看真正跑的是谁", cmds(crossEnv), ["npm run dev -- --port $PORT"]);
  const nextNode = dir("node-next");
  pkg(nextNode, { dev: "next dev" });
  check("Next 认 PORT，不给它塞参数", cmds(nextNode), ["npm run dev"]);
  // 复合命令里追加的 `--port` 会落到最后一条命令、或者干脆落给 concurrently 自己 ——
  // 那是一条看着像对的坏命令，宁可退回环境变量。
  const multi = dir("node-multi");
  pkg(multi, { dev: "concurrently \"vite\" \"nodemon server.js\"" });
  check("concurrently 起一排就不加参数", cmds(multi), ["npm run dev"]);
  const chained = dir("node-chained");
  pkg(chained, { dev: "npm run gen && vite" });
  check("&& 串起来的也不加", cmds(chained), ["npm run dev"]);

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
    "cd a4sms-front && pnpm run dev -- --port $PORT",
  ]);
  const monoError = failure(mono);
  checkIncludes("说清楚为什么不替你挑", monoError, "认出了 3 个能起服务的东西");
  checkIncludes("Maven 模块按 Java 的说法列", monoError, "cd a4sms-back && mvn -pl a4sms-icis spring-boot:run");
  checkIncludes("前端那条也在", monoError, "cd a4sms-front && pnpm run dev -- --port $PORT");
  checkIncludes("告诉他去哪儿填", monoError, "项目设置 → 预览命令");
  check("整段话里不提 package.json", monoError.includes("package.json"), false);
  checkIncludes("多模块首次要装依赖模块的写法也给了", monoError, "-am install -DskipTests");

  // 前后端并排时最难的不是命令怎么写，是**端口**：两边都是 ash 随机借的，前端要在启动
  // 那一刻就知道后端在哪。所以这段话里必须直接给出一条能粘的组合命令：配角丢后台吃
  // $PORT2（Spring Boot 认 SERVER_PORT），要看的那个放最后吃 $PORT。
  checkIncludes(
    "前后端一起起：后端当配角丢后台，端口吃 $PORT2",
    monoError,
    "(cd a4sms-back && SERVER_PORT=$PORT2 mvn -pl a4sms-icis spring-boot:run &)",
  );
  checkIncludes("第二个后端顺延到 $PORT3", monoError, "SERVER_PORT=$PORT3 mvn -pl a4sms-wms spring-boot:run");
  // `( … &)` 后面必须有分隔符，否则整条命令是语法错误 —— 这条是直接给人粘走的。
  checkIncludes("要看的那个放最后，吃 $PORT", monoError, "&) ; cd a4sms-front && pnpm run dev -- --port $PORT");
  checkIncludes("并说清楚前端怎么拿到后端地址", monoError, "$URL2");
  // 「像是对的」不算数：这条命令是给人直接粘走的，得真能被 shell 解析。少一个分隔符
  // 就是 `syntax error near unexpected token` —— 用户粘过去连一个字节都跑不了。
  if (process.platform !== "win32") {
    const combined = /\n {4}(\(cd .+)\n/.exec(monoError)?.[1] ?? "";
    check("组合命令不是空的", combined.length > 0, true);
    let syntaxOk = true;
    try { execFileSync("sh", ["-n", "-c", combined], { stdio: "pipe" }); }
    catch { syntaxOk = false; }
    check("给出来的组合命令 shell 解析得动", syntaxOk, true);
  }

  // 只有后端、没有前端时不硬编一条组合命令 —— 那时「要看的是哪个」本来就没有答案。
  const backOnly = dir("back-only");
  file(dir("back-only", "svc-a"), "pom.xml", BOOT_POM);
  file(dir("back-only", "svc-b"), "pom.xml", BOOT_POM);
  check("说不清主角时不编组合命令", failure(backOnly).includes("$PORT2"), false);

  // sidekick 的两种端口口径各走各的：认环境变量的换变量后面的值（名字和格式还各家不同），
  // 端口写在命令行里的换命令里的 $PORT。
  const nodeSide = detectPreviewCandidates(pnpmNode)[0];
  check("vite 配角照样走参数", nodeSide.sidekick(2), "(pnpm run dev -- --port $PORT2 &)");
  const nextSide = detectPreviewCandidates(nextNode)[0];
  check("认 PORT 的配角用 PORT=", nextSide.sidekick(2), "(PORT=$PORT2 npm run dev &)");
  const djangoSide = detectPreviewCandidates(django)[0];
  check("命令行带端口的换成 $PORT2", djangoSide.sidekick(2), `(${PY} manage.py runserver 0.0.0.0:$PORT2 &)`);

  // 一个都没认出来：话里同样不能只谈 Node。
  const empty = dir("empty");
  file(empty, "README.md", "");
  const emptyError = failure(empty);
  checkIncludes("认不出来时列出找过哪些", emptyError, "spring-boot:run");
  checkIncludes("Python 那两个也在清单里", emptyError, "FastAPI/Flask");
  checkIncludes("并且明说任何语言都行", emptyError, "任何语言都行");
  checkIncludes("自己填命令时端口怎么拿也说了", emptyError, "ASPNETCORE_URLS");

  // —— 注入的变量名必须盖住识别出来的写法 ——
  // 这两头是同一件事：识别出来的命令按哪个名字拿端口（sidekick 里那个 `NAME=`），跟
  // preview.ts 实际注入哪些名字（PORT_ENV_ALIASES）。抄成两份迟早对不上，那时的症状是
  // 「某种语言的预览永远起在写死的端口上」—— 命令在等一个没人给的变量，日志里什么都看不出。
  const names = new Set(PORT_ENV_ALIASES.map((alias) => alias.name));
  const everyDir = [maven, gradle, django, fastapi, flask, go, rust, dotnet, laravel, rails, node, nextNode];
  const missing = everyDir
    .flatMap((p) => detectPreviewCandidates(p))
    .map((c) => /^\((\w+)=/.exec(c.sidekick(2))?.[1])
    .filter((name): name is string => !!name && !names.has(name));
  check("认出来的命令要的变量名，注入时一个不缺", missing, []);

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
  check("产物/依赖目录不参与识别", cmds(noisy), ["npm run dev -- --port $PORT"]);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} 条不通过`);
  process.exit(1);
}
console.log("\npreview-command 全部通过");
