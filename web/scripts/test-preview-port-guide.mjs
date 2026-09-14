// 打开预览的现场，$PORT 到底教没教会。
// 跑：npm -w web run test:preview-port-guide
//
// 这条钉的是**新用户不读文档能不能写对第一条预览命令**。改动之前这一屏关于端口只有一句
// 「端口使用 ash 提供的 PORT 环境变量」——它读起来像「ash 会替你处理」，可它的意思是
// 「你得把它写进命令」；完整说明在设置页的「配置说明与示例」对话框里，而打开预览的人
// 不路过那儿。
//
// 钉四条：
//   ① **判据在，而且两半都在。** 「只认参数的必须写」和「读 PORT 的不用写」缺一不可：
//      只留前半句，用户会给 Next / CRA 加一个它们不认的 --port（有的直接报错退出）。
//   ② **起手式点一下就进输入框。** 新用户最需要的不是读懂规则，是先拿到一条能跑的命令；
//      能选中复制不算数，这一屏的输入框就在旁边。
//   ③ **方言跟着服务端那台机器走。** Windows 上一个 `$PORT` 都不许出现 —— 它在 cmd 里是
//      字面量，端口静默失效，不报任何错（preview-shell.ts 顶上记的就是这次漏判）。
//   ④ **没写端口不报警。** 一半的运行时自己读 PORT 环境变量，对它们报警等于教一条错规则。
//      唯一会弹出来的是方言写反了，那条零误报。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "./chrome-path.mjs";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");

  browser = await chromium.launch(await chromeLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/preview-port-guide.html`);

  const box = page.getByLabel("本次预览命令");
  const guide = page.locator(".preview-port-guide");
  await guide.waitFor({ timeout: 5000 });

  // ① 判据两半都在，而且不用展开任何东西就看得见。
  const rule = await guide.innerText();
  assert.match(rule, /必须把 \$PORT 写进命令/, "「只认参数的必须写」这半句没了");
  assert.match(rule, /不用写，npm run dev 就行/, "「读 PORT 的不用写」这半句没了");
  assert.match(rule, /撞车/, "没说清不写的后果，用户没有理由照做");
  assert.equal(await page.locator(".preview-port-branches > div").count(), 2, "二选一没摆成两行——连续散文读不出这是个判断题");
  assert.equal(await guide.isVisible(), true, "判据被折叠起来了——要点开才看得到等于没说");

  // ② 起手式点一下就填进输入框。
  assert.equal(await box.inputValue(), "", "输入框一开始就该是空的");
  const samples = page.locator(".preview-port-samples button");
  assert.equal(await samples.count(), 3, "起手式的条数变了");
  await samples.first().click();
  assert.equal(await box.inputValue(), "npm run dev -- --port $PORT", "点起手式没有填进输入框");
  // 填进去就能直接开跑：启动按钮不该还锁着。
  assert.equal(await page.getByRole("button", { name: "启动自填命令" }).isEnabled(), true, "填好了却起不了");
  // ④ 这条命令写对了，不许弹告警。
  assert.equal(await page.locator(".preview-port-mismatch").count(), 0, "写对的命令被报了警");
  // 「读 PORT 那一半」的起手式照样不带端口，且同样不报警。
  await samples.nth(1).click();
  assert.equal(await box.inputValue(), "npm run dev", "第二条起手式不该带端口——那一半自己读 PORT");
  assert.equal(await page.locator(".preview-port-mismatch").count(), 0,
    "没写 $PORT 就报警：一半的运行时根本不用写，报了等于教用户一条错规则");

  // ③ 服务端是 Windows 时，整屏一个 $PORT 都不许有。
  await page.getByTestId("switch-dialect").click();
  await page.locator(".preview-port-samples button", { hasText: "%PORT%" }).first().waitFor({ timeout: 5000 });
  const winText = await page.locator(".preview-launcher").innerText();
  assert.match(winText, /%PORT%/, "Windows 上没给 cmd 的写法");
  assert(!winText.includes("$PORT"), "Windows 上出现了 $PORT —— 它在 cmd 里是字面量，端口会静默失效");
  const winPlaceholder = await box.getAttribute("placeholder");
  assert(!winPlaceholder.includes("$PORT"), "占位符里的示例还是 POSIX 方言");

  // ④ 唯一会弹的告警：方言写反了。输入框里留着上一步 POSIX 的命令，此刻服务端是 Windows。
  await box.fill("npm run dev -- --port $PORT");
  await page.locator(".preview-port-mismatch").waitFor({ timeout: 5000 });
  assert.match(await page.locator(".preview-port-mismatch").textContent(), /cmd/, "方言写反了却没说是 cmd 的事");

  // —— 起好之后：端口对不上那一条必须在**屏幕上**，不是只在日志里 ——
  // 这条跟上面那些不是一类东西：上面是说明（可以不读），这条是已经发生的事实。它零误报、
  // 不挑语言，代价是只能事后说 —— 但事后说反而更具体，话里两个端口号都是用户自己的。
  await page.getByTestId("switch-dialect").click(); // 切回 POSIX
  const drift = page.locator(".preview-port-drift");
  await drift.waitFor({ timeout: 5000 });
  const driftText = await drift.innerText();
  assert.match(driftText, /起在 5173/, "没说它实际起在哪儿");
  assert.match(driftText, /借给它的 45843/, "没说 ash 借的是哪个——只给一个数字，用户对不上");
  assert.match(driftText, /抢 5173/, "没说清后果，这条就只是个红字");
  // 端口写在命令里 → 改写是确定的（那个数字就是它实际绑上的端口），敢给整行让他抄走。
  assert.equal(await drift.locator("code").first().textContent(), "npm run dev -- --port $PORT",
    "没给出改好的整行命令");
  assert.equal(await drift.getByRole("button", { name: /复制改好的启动命令/ }).count(), 1, "改好的命令不能一键带走");

  // 端口写在 vite.config.ts 里 → ash 编不出改法，必须老实改口，不许编一条看着像对的命令。
  await page.getByTestId("services-config").click();
  const fromConfig = await drift.innerText();
  assert.match(fromConfig, /来自项目的配置文件/, "编不出改法时没改口");
  assert(!/npm run dev -- --port \$PORT/.test(fromConfig), "端口不在命令里，却凭空编了一条改好的命令");

  // 命令写对时**整块不渲染**。这一条是这套设计敢占版面的前提：常驻文案永远在那儿，久了
  // 就成了背景；这条只在真出事时出现，所以它才「明显」。
  await page.getByTestId("services-ok").click();
  assert.equal(await drift.count(), 0, "命令写对了还在报警——那它就成了新的背景噪音");

  console.log("preview port guide: rule both halves, one-click samples, host dialect, mismatch-only warning, and on-screen port drift (fixable / config-pinned / silent-when-correct) passed");
} finally {
  await browser?.close();
  await server.close();
}
