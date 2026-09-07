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
import { detectPreviewCandidates, resolvePreviewCommand, ambiguousMessage, PORT_ENV_ALIASES } from "../src/preview-command.js";
import { previewShell } from "../src/preview-shell.js";

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
  // pom 里出现过 `spring-boot-maven-plugin` 的地方还有两处，两处都起不来：
  //   · 注释；
  //   · `<pluginManagement>` —— 那只是「谁要用这个插件，版本按我说的来」，父 pom 几乎
  //     一定有。对着这种 pom 跑 `mvn spring-boot:run` 实测是 No plugin found for prefix。
  // 外加一条独立否决：`<packaging>pom</packaging>` 本来就没有可运行产物。
  const mavenManaged = dir("maven-managed");
  file(mavenManaged, "pom.xml", "<project><packaging>pom</packaging><build><pluginManagement><plugins>"
    + "<plugin><artifactId>spring-boot-maven-plugin</artifactId><version>3.2.0</version></plugin>"
    + "</plugins></pluginManagement></build></project>");
  check("pluginManagement 里的插件不算挂上了", cmds(mavenManaged), []);
  const mavenComment = dir("maven-comment");
  file(mavenComment, "pom.xml", "<project><!-- 本模块没有 spring-boot-maven-plugin --><artifactId>lib</artifactId></project>");
  check("注释里提到插件不算", cmds(mavenComment), []);
  const mavenPomPackaging = dir("maven-pom-packaging");
  file(mavenPomPackaging, "pom.xml", "<project><packaging>pom</packaging><build><plugins>"
    + "<plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>");
  check("packaging=pom 的聚合/父模块起不来", cmds(mavenPomPackaging), []);

  // 「有 build.gradle」不等于「能起服务」：库、Android、纯 Java 工具全都有这个文件，
  // 而 bootRun 只有挂了 Spring Boot 插件的才有。认错了不是少省一次事 —— 只有一个候选时
  // 会被**自动选中**，用户拿到的就是一次自信的失败，而不是「认不出来，请配置命令」。
  const gradle = dir("gradle");
  file(gradle, "build.gradle.kts", "plugins { id(\"org.springframework.boot\") version \"3.2.0\" }\n");
  check("Gradle 没 wrapper", cmds(gradle), ["gradle bootRun"]);
  const gradleW = dir("gradle-wrapper");
  file(gradleW, "build.gradle", "plugins { id 'org.springframework.boot' }\n");
  file(gradleW, "gradlew", "#!/bin/sh\n");
  check("Gradle 有 wrapper", cmds(gradleW), ["./gradlew bootRun"]);
  const gradleApp = dir("gradle-app");
  file(gradleApp, "build.gradle", "plugins { id 'application' }\nmainClass = 'x.Main'\n");
  check("挂 application 插件的按 gradle run 认", cmds(gradleApp), ["gradle run"]);
  const gradleLib = dir("gradle-lib");
  file(gradleLib, "build.gradle", "plugins { id 'java-library' }\ndependencies { }\n");
  check("普通 Gradle 库不算能起服务的东西", cmds(gradleLib), []);
  // 「文件里出现过这个词」不是判据。注释里的那句话含义常常正好是**反的**，而依赖坐标
  // （`spring-boot-starter-web`）在库模块里天天有 —— 两种都会让一个起不来的模块变成
  // 「唯一候选」，于是被自动选中，用户拿到一次自信的失败。
  const gradleComment = dir("gradle-comment");
  file(gradleComment, "build.gradle", "plugins { id 'java-library' }\n// bootRun is unavailable here\n/* org.springframework.boot 没挂 */\n");
  check("注释里提到 bootRun 不算", cmds(gradleComment), []);
  const gradleCommentApp = dir("gradle-comment-app");
  file(gradleCommentApp, "build.gradle", "plugins { id 'java-library' }\n// application plugin not applied\n");
  check("注释里提到 application 不算", cmds(gradleCommentApp), []);
  const gradleDep = dir("gradle-dep");
  file(gradleDep, "build.gradle", "plugins { id 'java-library' }\ndependencies {\n  api 'org.springframework.boot:spring-boot-starter-web:3.2.0'\n}\n");
  check("依赖坐标里带 org.springframework.boot 不算挂了插件", cmds(gradleDep), []);
  const gradleApply = dir("gradle-apply");
  file(gradleApply, "build.gradle", "apply plugin: 'org.springframework.boot'\n");
  check("老写法 apply plugin 照认", cmds(gradleApply), ["gradle bootRun"]);
  const gradleTask = dir("gradle-task");
  file(gradleTask, "build.gradle.kts", "tasks.register(\"bootRun\") {\n  doLast { }\n}\n");
  check("脚本自己定义了 bootRun task 也认", cmds(gradleTask), ["gradle bootRun"]);

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

  // 库 crate 也有 Cargo.toml，但它没有可执行目标，`cargo run` 只会得到
  // "a bin target must be available"。
  const rust = dir("rust");
  file(rust, "Cargo.toml", "[package]\nname='x'\n");
  file(dir("rust", "src"), "main.rs", "fn main() {}\n");
  check("Rust", cmds(rust), ["cargo run"]);
  const rustBin = dir("rust-bin");
  file(rustBin, "Cargo.toml", "[package]\nname='x'\n\n[[bin]]\nname='srv'\n");
  check("显式 [[bin]] 也算", cmds(rustBin), ["cargo run"]);
  const rustLib = dir("rust-lib");
  file(rustLib, "Cargo.toml", "[package]\nname='x'\n");
  file(dir("rust-lib", "src"), "lib.rs", "");
  check("库 crate 不算", cmds(rustLib), []);

  // .csproj 同理：类库、测试项目都是 .csproj。「这是个 web 应用」在 .NET 里有明确声明。
  const dotnet = dir("dotnet");
  file(dotnet, "App.csproj", "<Project Sdk=\"Microsoft.NET.Sdk.Web\"></Project>");
  check(".NET", cmds(dotnet), ["dotnet run"]);
  const dotnetLib = dir("dotnet-lib");
  file(dotnetLib, "Lib.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>");
  check(".NET 类库不算", cmds(dotnetLib), []);
  // Web SDK 有两种合法写法，MSBuild 两种都认。只认双引号属性会把一半 ASP.NET Core 项目
  // 判成「认不出来」——它们明明就是 web 应用。
  const dotnetSingle = dir("dotnet-single-quote");
  file(dotnetSingle, "App.csproj", "<Project Sdk='Microsoft.NET.Sdk.Web'></Project>");
  check(".NET 单引号属性同样是 Web SDK", cmds(dotnetSingle), ["dotnet run"]);
  const dotnetElement = dir("dotnet-sdk-element");
  file(dotnetElement, "App.fsproj", "<Project>\n  <Sdk Name=\"Microsoft.NET.Sdk.Web\" />\n</Project>");
  check(".NET 的 <Sdk Name=…> 元素写法也认", cmds(dotnetElement), ["dotnet run"]);
  const dotnetCommented = dir("dotnet-commented");
  file(dotnetCommented, "Lib.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <!-- 以前是 Sdk=\"Microsoft.NET.Sdk.Web\" -->\n</Project>");
  check(".NET 注释里的 Web SDK 不算", cmds(dotnetCommented), []);
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
    .map((c) => /^\((\w+)=/.exec(c.sidekick(2) ?? "")?.[1])
    .filter((name): name is string => !!name && !names.has(name));
  check("认出来的命令要的变量名，注入时一个不缺", missing, []);

  // —— 目录名不是标识符 ——
  // `cd ${rel}` 直接拼的话，一个带空格的目录名就是 `cd web app` → "too many arguments"。
  // 这条命令是要么被自动跑、要么被用户粘走的，两条路都当场失败。
  const spaced = dir("spaced");
  const spacedFront = dir("spaced", "web app");
  pkg(spacedFront, { dev: "vite" });
  check("目录名带空格就引起来", cmds(spaced), ["cd 'web app' && npm run dev -- --port $PORT"]);
  if (process.platform !== "win32") {
    let ok = true;
    try { execFileSync("sh", ["-n", "-c", cmds(spaced)[0]], { stdio: "pipe" }); } catch { ok = false; }
    check("带空格的那条 shell 也解析得动", ok, true);
  }
  const spacedModule = dir("spaced-mvn");
  file(spacedModule, "pom.xml", "<project><modules><module>my svc</module></modules></project>");
  file(dir("spaced-mvn", "my svc"), "pom.xml", BOOT_POM);
  check("Maven 模块名同理", cmds(spacedModule)[0], "mvn -pl 'my svc' spring-boot:run");

  // —— Windows 是另一门 shell ——
  // 预览命令在 Windows 上交给 `cmd.exe /d /s /c` 跑（platform.ts 的 userShellLaunch），
  // cmd 只认 `%PORT%`；`$PORT` 在那边是个**字面量**。后台 `&`、分隔符 `;`、`FOO=1 cmd`
  // 也全是 POSIX 的写法。所以生成命令时一行 shell 语法都不能写死。
  const win = previewShell("win32");
  const winCmds = (p: string) => detectPreviewCandidates(p, win).map((c) => c.command);
  check("Windows 上端口是 %PORT%", winCmds(pnpmNode), ["pnpm run dev -- --port %PORT%"]);
  check("Django 同理", winCmds(django), ["python manage.py runserver 0.0.0.0:%PORT%"]);
  check("Windows 上 python 就叫 python", winCmds(django)[0].startsWith("python "), true);
  check("Rails 的路径分隔符也跟着换", winCmds(rails), ["bin\\rails server -p %PORT%"]);
  check("进子目录用 cd /d", winCmds(mono).includes("cd /d a4sms-front && pnpm run dev -- --port %PORT%"), true);
  check("带空格的目录用双引号", winCmds(spaced), ["cd /d \"web app\" && npm run dev -- --port %PORT%"]);
  check(
    "配角开独立 cmd 会话，免得 cd/set 漏给主角",
    detectPreviewCandidates(maven, win)[0].sidekick(2),
    "start \"\" /b cmd /c \"set SERVER_PORT=%PORT2%&&mvn spring-boot:run\"",
  );
  const winMono = ambiguousMessage(detectPreviewCandidates(mono, win), win);
  checkIncludes("Windows 的组合示例用 start /b 和 &", winMono, "start \"\" /b cmd /c \"cd /d a4sms-back && set SERVER_PORT=%PORT2%");
  checkIncludes("要看的那个仍在最后", winMono, "& cd /d a4sms-front && pnpm run dev -- --port %PORT%");
  check("整段 Windows 文案里不出现 $PORT", /\$PORT/.test(winMono), false);
  // 内层再套引号 cmd 没有可靠写法：那种情况宁可不给示例，也不给一条粘过去就坏的。
  const winSpacedBack = dir("win-spaced");
  pkg(dir("win-spaced", "front"), { dev: "vite" });
  file(dir("win-spaced", "back end"), "pom.xml", BOOT_POM);
  check("写不出安全的后台写法就不给组合示例", ambiguousMessage(detectPreviewCandidates(winSpacedBack, win), win).includes("%PORT2%"), false);
  check("同一份仓库在 POSIX 上照常给", ambiguousMessage(detectPreviewCandidates(winSpacedBack)).includes("$PORT2"), true);
  // cmd 的 `%VAR%` 展开**在双引号里照样发生**，而 `%` 是合法的 Windows 文件名字符：
  // `cd /d "front%PORT%"` 会被展开成 `cd /d front43123`（预览跑起来时 PORT 恰恰有值），
  // 当场找不到目录。命令行上没有可靠的 `%` 转义写法，所以这种名字就是写不出来 ——
  // 写不出来就别生成，让它走「认不出来，请填命令」那条安全路径。
  const percent = dir("percent");
  pkg(dir("percent", "front%PORT%"), { dev: "vite" });
  check("cmd 上目录名带 % 就不生成候选", winCmds(percent), []);
  check("POSIX 上单引号能把 % 变成字面量，照常给", cmds(percent), ["cd 'front%PORT%' && npm run dev -- --port $PORT"]);
  const percentModule = dir("percent-mvn");
  file(dir("percent-mvn", "back"), "pom.xml", "<project><modules><module>svc%PATH%</module><module>svc-ok</module></modules></project>");
  file(dir("percent-mvn", "back", "svc%PATH%"), "pom.xml", BOOT_POM);
  file(dir("percent-mvn", "back", "svc-ok"), "pom.xml", BOOT_POM);
  check("Maven 模块名同理（`-pl` 上的字面量）", winCmds(percentModule), ["cd /d back && mvn -pl svc-ok spring-boot:run"]);
  check("POSIX 上两个模块都在", cmds(percentModule).sort(), [
    "cd back && mvn -pl 'svc%PATH%' spring-boot:run",
    "cd back && mvn -pl svc-ok spring-boot:run",
  ]);

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
