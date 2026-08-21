// 跨平台的**路径安全边界**（platform.ts 的 boundaryKey / isInsidePath /
// windowsPathRejection，以及吃它们的两个端点：file-browser、local-open-routes）。
//
// 为什么单独钉一条：这三个函数是「用户可控的一段路径能不能落到 fs 调用上」的唯一
// 判据，错了两个方向都很贵——
//   · 松了 = 任意文件读取 / 任意本机文件被系统程序打开（open-local 那条更狠：
//     它把路径交给系统默认程序**执行式地**打开）；
//   · 紧了 = Windows 用户换个盘符大小写就被判越界，只能看到「打不开」。
// 而 Windows 分支在开发机上永远走不到，只能靠伪造 process.platform 跑真分支。
//
// 覆盖：
//   1. 纯函数：NTFS 大小写不敏感、兄弟目录前缀不算界内、UNC/8.3 拒绝面
//   2. file-browser.resolveTarget：大小写不同的绝对路径要放行，兄弟目录要拒
//   3. local-open-routes.resolveAllowedLocalPath：同上，外加白名单根的大小写
//   4. 真实存在的 8.3 短名目录：realpath 展不开它，必须在界内也照拒
//   5. 长路径提示：git 撞 MAX_PATH 时补的那段排查说明（不是安全边界，但同属
//      「Windows 上一段路径能不能落地」，而且同住 platform.ts）
// 跑：npm -w server run test:path-boundary
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在 import 任何 src 模块之前翻平台：IS_WINDOWS 是模块加载期算的。
Object.defineProperty(process, "platform", { value: "win32", configurable: true });

// realpath 一次再用：macOS 的 /var → /private/var，Windows 的 tmp 常常是
// `C:\Users\RUNNER~1\…` 这种 8.3 短名——不展开的话第 4 节的短名判据会把整个舞台
// 都判成越界，测出来的全是假红。
const stage = realpathSync(mkdtempSync(join(tmpdir(), "ash-boundary-")));
process.env.ASH_DB = join(stage, "ash.db");

const status = (error: unknown) => (error as { status?: number }).status;

try {
  const repo = join(stage, "Repo"); // 大写开头：下面用小写去访问它
  const sibling = join(stage, "Repo-evil"); // 前缀相同的兄弟目录
  const shortName = join(repo, "PROGRA~1"); // 真的建一个 8.3 形态的目录
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(sibling, { recursive: true });
  mkdirSync(shortName, { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "export const x = 1;\n");
  writeFileSync(join(sibling, "secret.txt"), "不该被读到");
  writeFileSync(join(shortName, "note.txt"), "短名目录里的文件");

  // 本机文件系统区不区分大小写，决定第 2/3 节能不能端到端地跑。区分的（多数
  // Linux）就只跑纯函数那一节——**不是跳过检查，是那台机器上根本构造不出这个
  // 场景**：realpath 会先一步 ENOENT。
  const caseInsensitiveFs = existsSync(join(stage, "repo", "src", "app.ts"));
  // 用 join 拼替换目标，别自己拼分隔符：真 Windows 上 stage 是 `C:\…\ash-boundary-xxx`，
  // 写死 `/` 的目标串一次都命中不了，`lower()` 会原样返回，第 2/3 节送进去的还是原大小写 ——
  // 断言照样绿，但它压根没在测大小写不敏感这件事。
  const lower = (p: string) => p.replace(join(stage, "Repo"), join(stage, "repo"));
  assert.notEqual(lower(join(stage, "Repo", "src", "app.ts")), join(stage, "Repo", "src", "app.ts"), "lower() 必须真的改到路径");

  const { boundaryKey, isInsidePath, windowsLongPathHint, windowsPathRejection } = await import("../src/platform.js");

  // ── 1. 纯函数 ──────────────────────────────────────────────────────────────
  assert.equal(boundaryKey("C:\\Repo\\Src"), "c:\\repo\\src", "Windows 上比较前统一小写");

  assert.equal(isInsidePath("C:\\repo", "C:\\Repo\\src\\a.ts", "\\"), true, "只有大小写不同 = 同一个目录");
  assert.equal(isInsidePath("C:\\Repo", "c:\\repo", "\\"), true, "等于根本身也算界内");
  assert.equal(isInsidePath("C:\\Repo\\", "c:\\repo\\a", "\\"), true, "根自带结尾分隔符不能多拼一个");
  assert.equal(
    isInsidePath("C:\\repo", "C:\\repo-evil\\secret.txt", "\\"),
    false,
    "前缀相同的兄弟目录不是界内——这正是必须比到分隔符的原因",
  );
  assert.equal(isInsidePath("C:\\repo", "C:\\repos", "\\"), false);

  assert.equal(windowsPathRejection("C:\\repo\\src\\a.ts"), null, "普通本地路径要放行");
  for (const bad of [
    "\\\\server\\share\\x",   // UNC
    "//server/share/x",       // 正斜杠写法同样是 UNC
    "\\\\?\\C:\\repo\\x",     // 扩展长度前缀：能绕过朴素的前缀比较
    "\\\\.\\pipe\\x",         // 设备命名空间
    "C:\\PROGRA~1\\x",        // 没展开的 8.3 短名
    "C:\\repo\\LONGNA~2",     // 结尾也要拦
  ]) {
    assert.ok(windowsPathRejection(bad), `必须拒绝：${bad}`);
  }
  // 带 `~` 但不是短名形态的正常文件名别误伤（`~` 在 POSIX 文件名里很常见）
  assert.equal(windowsPathRejection("C:\\repo\\draft~backup.txt"), null);
  assert.equal(windowsPathRejection("C:\\repo\\~\\a.ts"), null);

  // ── 2. file-browser：端到端 ────────────────────────────────────────────────
  const { resolveTarget } = await import("../src/file-browser.js");
  const root = { path: repo, branch: "main", gitRepo: false, source: "repo" as const, repoPath: repo };

  assert.equal((await resolveTarget(root, "src/app.ts")).absPath, join(repo, "src", "app.ts"));
  await assert.rejects(
    () => resolveTarget(root, join(sibling, "secret.txt")),
    (error: Error) => status(error) === 400,
    "兄弟目录必须拒",
  );

  if (caseInsensitiveFs) {
    // 用户从别处粘一条大小写不同的绝对路径进来。Windows 上这是**同一个文件**，
    // 按字节比就成了「路径不在这个任务的工作目录里」——一句纯粹的假指控。
    // 这条是全场最吃 boundaryKey 的一个：越界判定发生在 realpath **之前**（拿的
    // 是 resolve() 的结果），没有任何东西会替它归一大小写。
    assert.equal(
      (await resolveTarget(root, lower(join(repo, "src", "app.ts")))).absPath,
      lower(join(repo, "src", "app.ts")),
      "只有大小写不同的绝对路径要按界内处理",
    );
    // 反向也要成立：根的大小写和盘上的不一样，界内文件照样能开。
    const lowerRoot = { ...root, path: lower(repo), repoPath: lower(repo) };
    assert.equal((await resolveTarget(lowerRoot, "src/app.ts")).directory, false);
  }

  // ── 3. local-open-routes：端到端 ───────────────────────────────────────────
  const { resolveAllowedLocalPath } = await import("../src/local-open-routes.js");
  assert.equal(
    await resolveAllowedLocalPath(join(repo, "src", "app.ts"), [repo]),
    join(repo, "src", "app.ts"),
  );
  assert.equal(
    await resolveAllowedLocalPath(join(sibling, "secret.txt"), [repo]),
    null,
    "前缀相同的兄弟目录不在白名单里",
  );
  if (caseInsensitiveFs) {
    // 这两条走的是 realpath 之后的比较。**realpath 自己就会把大小写归一**
    // （Windows 的 GetFinalPathNameByHandle、macOS 的 realpath(3) 都返回盘上的
    // 真实大小写），所以它们钉的是「不会因为大小写被误拒」这个结果，而不是
    // boundaryKey 那一步——真正非它不可的是上面 file-browser 那条（比较发生在
    // realpath 之前）。两条都留着：哪天有人把 realpath 挪走，这里得跟着红。
    const hit = await resolveAllowedLocalPath(lower(join(repo, "src", "app.ts")), [repo]);
    assert.equal(boundaryKey(hit ?? ""), boundaryKey(join(repo, "src", "app.ts")), "请求路径大小写不同不影响白名单命中");
    assert.ok(
      await resolveAllowedLocalPath(join(repo, "src", "app.ts"), [lower(repo)]),
      "白名单根的大小写不同也要命中",
    );
  }

  // ── 4. 界内的 8.3 短名照拒 ────────────────────────────────────────────────
  // 这一条是纯函数测不到的：路径**真的存在**、realpath 也真的展不开它（它本来
  // 就是全名），而且落在根目录里边。放行它等于承认「短名可以代表长名」，前缀
  // 比较就再也说不准了。
  await assert.rejects(
    () => resolveTarget(root, "PROGRA~1/note.txt"),
    (error: Error) => status(error) === 400,
    "界内的 8.3 短名也要拒",
  );
  assert.equal(await resolveAllowedLocalPath(join(shortName, "note.txt"), [repo]), null);
  // 不存在的路径带短名时同样要按越界拒（realpath 失败 → 拿原样路径查那条分支）
  await assert.rejects(
    () => resolveTarget(root, "PROGRA~1/gone.txt"),
    (error: Error) => status(error) === 400,
    "短名 + 文件不存在，仍然按越界报而不是 404",
  );

  // ── 5. 长路径提示（MAX_PATH）─────────────────────────────────────────────
  // 不是安全边界，是**同一个平台上的另一条路径长度约束**：git 只会回一句
  // "Filename too long"，不说该开哪两个开关，ash 得替它补上。这里钉的是
  // 「什么时候补、补的内容里有没有那两条命令」——开发机上永远走不到真分支。
  const shortPath = "C:\\code\\p\\.worktrees\\abc123";
  const deepPath = `C:\\Users\\someone\\Documents\\${"nested\\".repeat(30)}repo\\.worktrees\\abcdefgh`;
  assert.equal(windowsLongPathHint(shortPath, "fatal: 'x' already exists"), null, "短路径 + 无关报错不该乱给提示");
  const byError = windowsLongPathHint(shortPath, "error: unable to create file …: Filename too long");
  assert.ok(byError, "git 明说 too long 时,路径再短也要给提示");
  const byLength = windowsLongPathHint(deepPath, "fatal: 说不清的失败");
  assert.ok(byLength, "路径本身已经够深时,任何失败都值得提一句");
  assert.ok(byLength.includes(String(deepPath.length)), "要报出这条路径到底多长");
  for (const needle of ["LongPathsEnabled 1", "core.longpaths true", "260"]) {
    assert.ok(byError.includes(needle), `提示里必须有 ${needle}`);
  }

  console.log(
    `✅ 路径边界（大小写归一 / 兄弟目录 / UNC / 8.3 / 长路径提示）全部通过${caseInsensitiveFs ? "" : "（本机文件系统区分大小写，端到端的大小写用例已跳过）"}`,
  );
} finally {
  // 删舞台前先松开库文件,否则 Windows 上必然 EBUSY(理由见 tmp-db.ts 的 releaseTmpDb)。
  // 只能动态 import:tmp-db 静态引了 platform.js,而静态 import 会被提升到文件顶部的
  // 平台伪造**之前**执行,IS_WINDOWS 就成了开发机的真值,整条测试白跑。
  await (await import("./tmp-db.js")).releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
