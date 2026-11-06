import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { launchChrome } from "./dom-stage.mjs";
import { fetchesSettled, trackFetches, waitUntil } from "./wait-until.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = join(repo, "server/scripts/fixtures/git-workbench-server.ts");

function startBackend() {
  const child = spawn(process.execPath, ["--import", "tsx", fixturePath], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  let stdout = "";
  let stderr = "";
  const ready = new Promise((resolve, reject) => {
    const fail = (message) => reject(new Error(`${message}\n${stderr}\n${stdout}`));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        try {
          const value = JSON.parse(line);
          if (value?.port && value?.projectId && value?.root) return resolve(value);
        } catch { /* wait for the readiness JSON */ }
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => fail(`Fixture exited before readiness (${code ?? signal})`));
    // 不是睡眠：就绪那一行一到就 resolve；15 秒只是夹具起不来时的报错上限。
    setTimeout(() => fail("Fixture did not become ready"), 15_000).unref();
  });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    if (child.connected) {
      child.send({ type: "close" }, (error) => {
        if (error && child.exitCode === null) child.kill("SIGTERM");
      });
    } else {
      child.kill("SIGTERM");
    }
    const didExit = await Promise.race([
      exited.then(() => true),
      // 收尾兜底：子进程按时退出就不等；超时只是改用 SIGKILL，没有断言依赖它。
      new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (!didExit && child.exitCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  };
  return { ready, close, diagnostics: () => ({ stdout, stderr }) };
}

const git = (root, ...args) =>
  execFileSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Workbench Review",
      "-c",
      "user.email=review@example.test",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

const gitRaw = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const write = (root, path, content) => writeFileSync(join(root, path), content);

function abortMerge(root) {
  spawnSync("git", ["-C", root, "merge", "--abort"], { stdio: "ignore" });
}

function createConflict(root, name, path, base, ours, theirs) {
  abortMerge(root);
  git(root, "checkout", "-q", "main");
  git(root, "reset", "--hard", "HEAD");
  git(root, "clean", "-fd");
  write(root, path, base);
  git(root, "add", "--", path);
  git(root, "commit", "-qm", `review base ${name}`);
  git(root, "checkout", "-qb", `review/${name}`);
  write(root, path, theirs);
  git(root, "add", "--", path);
  git(root, "commit", "-qm", `review theirs ${name}`);
  git(root, "checkout", "-q", "main");
  write(root, path, ours);
  git(root, "add", "--", path);
  git(root, "commit", "-qm", `review ours ${name}`);
  const merged = spawnSync(
    "git",
    ["-C", root, "merge", "--no-edit", `review/${name}`],
    { encoding: "utf8" },
  );
  assert.notEqual(merged.status, 0, `expected ${name} to produce a conflict`);
}

const backend = startBackend();
let vite;
let browser;
let page;
let backendDirectory;
let screenshotDirectory;
const actionPosts = [];

const refresh = async () => {
  const pending = page.waitForResponse((response) =>
    response.request().method() === "GET" &&
    /\/git\/workbench$/.test(new URL(response.url()).pathname),
  );
  void pending.catch(() => undefined);
  await page.getByLabel("工作台选项").click();
  await page.getByRole("menu", { name: "工作台选项" }).getByRole("menuitem", { name: "刷新 Git 工作台" }).click();
  const response = await pending;
  assert.equal(response.ok(), true, `refresh failed with HTTP ${response.status()}`);
  // 等到的那一份响应可能是点刷新之前就在飞的那趟轮询（满载时常见）：它带的是改仓库之前的
  // 快照，页面会按序号丢掉它，真正的刷新还在路上。再等页面上所有工作台读取都消费完——刷新
  // 那一发在点击时就已发出，必在其中。
  await fetchesSettled(page, 0, "刷新发出的工作台读取已被页面消费完");
  await page.getByLabel("选择工作树").waitFor({ state: "visible" });
};

const openConflict = async (path) => {
  await refresh();
  await page.getByRole("button", { name: new RegExp(path.replace(".", "\\.")) }).click();
  const box = page.getByRole("dialog", { name: new RegExp(`解决冲突 · ${path.replace(".", "\\.")}`) });
  await box.getByLabel("冲突解决结果").waitFor();
  return box;
};

const saveConflict = async (box, path, expected) => {
  const pending = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    /\/git\/workbench\/actions$/.test(new URL(response.url()).pathname),
  );
  void pending.catch(() => undefined);
  await box.getByRole("button", { name: "保存结果并暂存", exact: true }).click();
  const response = await pending;
  const body = await response.json().catch(() => null);
  assert.equal(response.ok(), true, `resolve failed: ${JSON.stringify(body)}`);
  await box.locator("strong", { hasText: "所有冲突文件已解决" }).waitFor();
  await box.getByRole("button", { name: "返回工作台", exact: true }).click();
  await box.waitFor({ state: "detached" });
  assert.equal(readFileSync(join((await backend.ready).root, path), "utf8"), expected);
  assert.equal(gitRaw((await backend.ready).root, "show", `:${path}`), expected);
};

const submitActionDialog = async (title) => {
  const box = page.getByRole("dialog", { name: title });
  const pending = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    /\/git\/workbench\/actions$/.test(new URL(response.url()).pathname),
  );
  void pending.catch(() => undefined);
  await box.getByRole("button", { name: title, exact: true }).click();
  const response = await pending;
  const body = await response.json().catch(() => null);
  assert.equal(response.ok(), true, `${title} failed: ${JSON.stringify(body)}`);
  await box.waitFor({ state: "detached" });
  return body;
};

try {
  const info = await backend.ready;
  backendDirectory = info.directory;
  git(info.root, "config", "core.autocrlf", "false");
  vite = await createServer({
    root: webRoot,
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      // 光写 watch: null 不够：加载了 web/vite.config.ts 时，vite 合并配置会跳过值为 null 的项，
      // watcher 照开。同一检出里任何文件一变它就推整页刷新，把测试做到一半的页面冲掉（实测：
      // 别的执行者改 web/scripts 里的文件时，review / refresh-paths 两条因此中途被刷新）。
      // 关掉 HMR 连接，刷新就推不到页面上。
      hmr: false,
      proxy: { "/api": { target: `http://127.0.0.1:${info.port}` } },
    },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  assert(address && typeof address === "object", "Vite did not expose a port");
  browser = await launchChrome();
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  // 页面上的工作台状态读取（refresh 要等「点刷新之后发出的那一发」真被页面消费完）。
  await trackFetches(page, "/git/workbench\\?");
  // 记下工作台发出、还没拿到响应的 /api 请求（mutateRepository 要等它们都结束）。
  const inFlight = new Set();
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) inFlight.add(request);
  });
  page.on("requestfinished", (request) => inFlight.delete(request));
  page.on("requestfailed", (request) => inFlight.delete(request));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/git\/workbench\/actions$/.test(new URL(request.url()).pathname)
    ) {
      actionPosts.push(request.postDataJSON()?.action?.kind || "unknown");
    }
  });
  const url = new URL(`http://127.0.0.1:${address.port}/scripts/fixtures/git-workbench.html`);
  url.searchParams.set("project", info.projectId);
  url.searchParams.set("view", "git");
  url.searchParams.set("gitView", "changes");
  url.searchParams.set("gitRoot", info.root);
  await page.goto(url.href);
  await page.getByRole("navigation", { name: "Git 工作台视图" }).waitFor();
  await page.getByLabel("选择工作树").waitFor();
  // 改仓库之前，工作台在服务端跑的 git 读（会短暂持有 index.lock）必须都已结束。从前是
  // 「离开页面 + 睡 300ms + 2 秒内等锁消失」：满载时一发离开前已发出的读可能 300ms 后才在服务端
  // 起 git，锁检查早就放行了。现在先在浏览器里把新的 /api 请求全挡掉（挡下的到不了服务端），
  // 再等此前已发出的每一发都**拿到了响应**（服务端回了 = 那次 git 已经跑完），之后才离开页面。
  const mutateRepository = async (mutation) => {
    const blocked = new Set();
    const block = (route) => { blocked.add(route.request()); return route.abort(); };
    await page.route("**/api/**", block);
    await waitUntil(() => {
      const left = [...inFlight].filter((request) => !blocked.has(request));
      if (left.length) throw new Error(`还在途：${left.map((request) => request.url()).join(", ")}`);
      return true;
    }, "工作台已发出的 /api 请求都拿到响应");
    await page.goto("about:blank");
    await page.unroute("**/api/**", block);
    await waitUntil(() => !existsSync(join(info.root, ".git/index.lock")), "workbench Git read did not release index.lock");
    mutation();
    await page.goto(url.href);
    await page.getByRole("navigation", { name: "Git 工作台视图" }).waitFor();
    await page.getByLabel("选择工作树").waitFor();
  };

  const tokens = "$$ | $& | $` | $' | $1 | $12";
  const cases = [
    {
      name: "dollar-ours",
      path: "dollar-ours.sh",
      oursLine: `ours ${tokens}\n`,
      theirsLine: "theirs plain\n",
      choice: "采用我方",
      expectedLine: `ours ${tokens}\n`,
    },
    {
      name: "dollar-theirs",
      path: "dollar-theirs.sh",
      oursLine: "ours plain\n",
      theirsLine: `theirs ${tokens}\n`,
      choice: "采用对方",
      expectedLine: `theirs ${tokens}\n`,
    },
    {
      name: "dollar-both",
      path: "dollar-both.sh",
      oursLine: `ours ${tokens}\n`,
      theirsLine: `theirs ${tokens}\n`,
      choice: "两者都要",
      expectedLine: `ours ${tokens}\ntheirs ${tokens}\n`,
    },
  ];

  for (const [index, scenario] of cases.entries()) {
    const base = "header\nbase\nfooter\n";
    const ours = `header\n${scenario.oursLine}footer\n`;
    const theirs = `header\n${scenario.theirsLine}footer\n`;
    const expected = `header\n${scenario.expectedLine}footer\n`;
    await mutateRepository(() => createConflict(info.root, scenario.name, scenario.path, base, ours, theirs));

    if (index === 0) {
      await refresh();
      const syncButtons = [
        page.getByRole("button", { name: "获取", exact: true }),
        page.getByRole("button", { name: "拉取", exact: true }),
        page.getByRole("button", { name: /^推送/ }),
      ];
      const before = actionPosts.length;
      for (const button of syncButtons) {
        await button.waitFor();
        assert.equal(await button.isDisabled(), true, `${await button.innerText()} should be disabled during conflict`);
        await button.evaluate((element) => element.click());
      }
      await page.getByLabel("工作台选项").evaluate((element) => element.click());
      const forcePush = page.getByRole("menu", { name: "工作台选项" }).getByRole("menuitem", { name: "保护强推…" });
      await forcePush.waitFor();
      assert.equal(await forcePush.isDisabled(), true, "force push should be disabled during conflict");
      await forcePush.evaluate((element) => element.click());
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      assert.equal(actionPosts.length, before, "disabled sync buttons must not POST actions");
      await page.keyboard.press("Escape");
    }

    const box = await openConflict(scenario.path);
    const block = box.locator(".gwb-conflict-block").first();
    await block.getByRole("button", { name: scenario.choice, exact: true }).click();
    assert.equal(await box.getByLabel("冲突解决结果").inputValue(), expected);
    await saveConflict(box, scenario.path, expected);
  }

  const separator = Array.from({ length: 20 }, (_, index) => `same ${index + 1}`).join("\n");
  const duplicateBase = `top\nbase\n${separator}\nbase\nbottom\n`;
  const duplicateOurs = `top\nours ${tokens}\n${separator}\nours ${tokens}\nbottom\n`;
  const duplicateTheirs = `top\ntheirs ${tokens}\n${separator}\ntheirs ${tokens}\nbottom\n`;
  await mutateRepository(() => createConflict(
    info.root,
    "duplicate-blocks",
    "duplicate.txt",
    duplicateBase,
    duplicateOurs,
    duplicateTheirs,
  ));
  const duplicateDialog = await openConflict("duplicate.txt");
  const editor = duplicateDialog.getByLabel("冲突解决结果");
  const initial = await editor.inputValue();
  const pattern = /^<<<<<<<[^\n]*\n([\s\S]*?)^=======[^\n]*\n([\s\S]*?)^>>>>>>>[^\n]*(?:\n|$)/gm;
  const matches = [...initial.matchAll(pattern)];
  assert.equal(matches.length, 2, "fixture should produce two conflict blocks");
  assert.equal(matches[0][0], matches[1][0], "fixture conflict blocks should be identical");
  const second = matches[1];
  const expectedSecondOnly =
    initial.slice(0, second.index) +
    second[1] +
    initial.slice(second.index + second[0].length);
  await duplicateDialog
    .locator(".gwb-conflict-block")
    .nth(1)
    .getByRole("button", { name: "采用我方", exact: true })
    .click();
  assert.equal(await editor.inputValue(), expectedSecondOnly);
  assert.equal((await editor.inputValue()).match(/^<<<<<<</gm)?.length, 1);

  await duplicateDialog
    .getByRole("button", { name: "关闭冲突解决器", exact: true })
    .click();
  await mutateRepository(() => {
    abortMerge(info.root);
    git(info.root, "checkout", "-q", "main");
    git(info.root, "reset", "--hard", "HEAD");
    git(info.root, "clean", "-fd");
  });

  const backupRef = "refs/ash-backup/browser-review";
  const backupSha = git(info.root, "rev-parse", "HEAD");
  git(info.root, "update-ref", backupRef, backupSha);
  const common = git(info.root, "rev-parse", "--git-common-dir");
  const helperDirectory = resolve(
    info.root,
    common,
    "ash-workbench",
    "rebase-11111111-1111-1111-1111-111111111111",
  );
  mkdirSync(helperDirectory, { recursive: true });
  writeFileSync(join(helperDirectory, "sequence.cjs"), "temporary helper\n");
  await refresh();
  await page
    .getByRole("navigation", { name: "Git 工作台视图" })
    .getByRole("button", { name: /^操作日志/ })
    .click();
  await page.getByText("历史备份与维护", { exact: true }).click();
  const backups = page.getByRole("region", { name: "历史备份" });
  const backupRow = backups.locator(".gwb-ref-row", { hasText: backupRef });
  await backupRow.waitFor();
  assert.match(await backups.getByRole("heading").innerText(), /历史备份 · 1/);

  screenshotDirectory = mkdtempSync(join(tmpdir(), "ash-git-workbench-review-"));
  await page.screenshot({ path: join(screenshotDirectory, "backups-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390);
  await page.screenshot({ path: join(screenshotDirectory, "backups-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });

  await backupRow.getByRole("button", { name: "恢复为新分支", exact: true }).click();
  const recoveryDialog = page.getByRole("dialog", { name: "从备份找回分支" });
  await recoveryDialog.getByRole("textbox").fill("recovery/browser-review");
  await submitActionDialog("从备份找回分支");
  assert.equal(git(info.root, "rev-parse", "refs/heads/recovery/browser-review"), backupSha);

  await backups.getByRole("button", { name: "清理变基辅助文件", exact: true }).click();
  await submitActionDialog("清理变基辅助文件");
  assert.equal(existsSync(helperDirectory), false, "rebase helper directory should be removed");

  await backupRow.getByRole("button", { name: "删除备份", exact: true }).click();
  const deleteDialog = page.getByRole("dialog", { name: "删除备份" });
  const deleteConfirm = deleteDialog.getByRole("button", { name: "删除备份", exact: true });
  assert.equal(await deleteConfirm.isDisabled(), true);
  await deleteDialog.getByLabel("输入目标以确认").fill("refs/ash-backup/wrong");
  assert.equal(await deleteConfirm.isDisabled(), true);
  await deleteDialog.getByLabel("输入目标以确认").fill(backupRef);
  assert.equal(await deleteConfirm.isEnabled(), true);
  await submitActionDialog("删除备份");
  assert.notEqual(
    spawnSync("git", ["-C", info.root, "rev-parse", "--verify", backupRef]).status,
    0,
    "backup ref should be deleted",
  );
  await backups.getByText("没有保留的历史备份").waitFor();
  assert.deepEqual(
    actionPosts.slice(-3),
    ["branch-create", "rebase-cleanup", "backup-delete"],
  );

  console.log("Git workbench review browser test passed");
} catch (error) {
  const diagnostics = backend.diagnostics();
  throw new Error(
    `${error instanceof Error ? error.stack || error.message : String(error)}\naction POSTs: ${JSON.stringify(actionPosts)}\nbackend stderr:\n${diagnostics.stderr}\nbackend stdout:\n${diagnostics.stdout}`,
  );
} finally {
  if (backendDirectory) abortMerge((await backend.ready).root);
  await browser?.close();
  await vite?.close();
  await backend.close();
  if (screenshotDirectory) rmSync(screenshotDirectory, { recursive: true, force: true });
  if (backendDirectory) {
    assert.equal(existsSync(backendDirectory), false, `fixture did not clean up ${backendDirectory}`);
  }
}
