// AI 协助的两件硬事：**结论怎么抠出来**、**试跑怎么判定**。
//
// 这两处错了都不会报错，只会安静地走歪：解析错了就把一段散文当脚本真跑一遍（白烧一轮），
// 判定错了就把「其实没起来」填进用户的设置里——而这个功能的全部卖点正是「填进去的那条
// 是真起来过的」。所以两件都钉死。
//
// 试跑那几支是**真的 spawn 进程**（node / sh），但不碰任何 CLI 智能体，不烧额度。
//
// 跑法：npm -w server run test:preview-assist
import { parseAssistScript } from "@ash/shared/preview-assist";
import { PREVIEW_MODE, previewLaunchOf } from "@ash/shared/preview";
import { cancelPreviewAssist, previewAssistState, reservePreviewAssistJob } from "../src/preview-assist-jobs.js";
import { isPidAlive } from "../src/platform.js";
import { canConnect } from "../src/preview-probe.js";
import { trialPreviewScript } from "../src/preview-trial.js";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures += 1;
    console.error(`✗ ${name}\n    expected ${e}\n    actual   ${a}`);
  } else console.log(`✓ ${name}`);
}

// ── 结论解析 ────────────────────────────────────────────────────────────────
check(
  "认标记后面的围栏块",
  parseAssistScript("我看了一圈，这个项目是 vite。\n\n启动脚本：\n```sh\nnpm run dev -- --port $PORT\n```\n跑完记得停。"),
  "npm run dev -- --port $PORT",
);
check(
  "标记前面的围栏块是它举的例子，不能认",
  parseAssistScript("常见写法是\n```sh\nnpm start\n```\n但这个项目不是。\n启动脚本：\n```bash\ncd web && npm run dev -- --port $PORT\n```"),
  "cd web && npm run dev -- --port $PORT",
);
check("多行脚本整块拿走", parseAssistScript("启动脚本：\n```sh\ncd api\n( npm start & )\ncd ../web\nnpm run dev -- --port $PORT\n```"), "cd api\n( npm start & )\ncd ../web\nnpm run dev -- --port $PORT");
check("标记行允许 markdown 装饰", parseAssistScript("**启动脚本：**\n\n```sh\nnpm run dev -- --port $PORT\n```"), "npm run dev -- --port $PORT");
// 没有标记行就一律不认。这条退路（取最后一个围栏块）抓到过 package.json 全文——那份
// JSON 被当成脚本在用户的项目目录里真跑了一遍。
check(
  "没写标记就不认，哪怕只有一个围栏块",
  parseAssistScript("这个项目的 package.json 是这样的：\n```json\n{ \"scripts\": { \"dev\": \"echo 起不来\" } }\n```\n所以它起不来。"),
  null,
);
// 它在正文里**引用**这四个字（「不要写『启动脚本』那一段」）时，老实现把后面半句话当命令跑了。
check(
  "正文里引用这四个字不算结论",
  parseAssistScript("按你说的，**不要写「启动脚本」那一段**，本回复中也不会再出现围栏代码块。这个仓库当前起不来。"),
  null,
);
check("标记后面接的是一句话而不是命令", parseAssistScript("启动脚本：这个项目没有可用的启动方式，建议先补上 dev server。"), null);
check("命令写在标记同一行也认", parseAssistScript("启动脚本：npm run dev -- --port $PORT\n\n就这样。"), "npm run dev -- --port $PORT");
check("一句话也没给就返回 null", parseAssistScript("这个项目我没看明白，建议你自己看看 README。"), null);
check("空围栏不算结论", parseAssistScript("启动脚本：\n```sh\n\n```"), null);
// 2026-09-26 现场：dev 脚本必然退出的仓库，智能体判断「起不来」所以通篇没有结论块，
// 解析退回最后一个围栏块，把它自己试跑的终端回显整段当脚本跑了。
check(
  "它贴的终端回显不是脚本",
  parseAssistScript("我试了一下：\n```\n$ PORT=53177 npm run dev\n> dev\n> echo 起不来 && exit 1\n\nexit code = 1\n```\n这个项目的 dev 脚本根本不起服务。"),
  null,
);
check("标记后面贴回显同样不认", parseAssistScript("启动脚本：\n```sh\n$ npm run dev\n> dev\n起来了\n```"), null);
check("单行连提示符一起粘过来，剥掉提示符", parseAssistScript("启动脚本：\n```sh\n$ npm run dev -- --port $PORT\n```"), "npm run dev -- --port $PORT");
// 第 1 轮审查复现：模型超时被杀 / CLI 挂掉 / 撞上 200 KB 截断线的时候，输出就断在围栏里。
// 老实现读到文件末尾也照样交给 clean()，于是半截内容进了 trialPreviewScript()，在用户的
// 项目目录里真跑一遍 —— 而那半截里可能正好只剩某条命令的前半句。
check(
  "围栏没闭合 = 这段输出是半截的，不认",
  parseAssistScript("启动脚本：\n```sh\nnpm run dev -- --port $PORT\n这段回答还没说完"),
  null,
);
check("只有开头那道围栏也不认", parseAssistScript("启动脚本：\n```sh"), null);
check("闭合了才认（同一段话补上结束围栏）", parseAssistScript("启动脚本：\n```sh\nnpm run dev -- --port $PORT\n```\n这段回答说完了"), "npm run dev -- --port $PORT");

// ── 选的那一档启动范围要真的走到试跑里 ──────────────────────────────────────
// 第 3 轮审查复现：端点递给 previewLaunchOf 的是请求体里那个**字符串**，而它当时只认整份配置
// 对象，于是 command/full/test 三档静默变成 frontend —— 用户选了「前后端全启动」，验过的却是
// 只起前端那一档，保存完打开预览才发现不是一回事。两头都钉：读得对、注得对。
check("四档字符串都认", PREVIEW_MODE.map((mode) => previewLaunchOf(mode)), [...PREVIEW_MODE]);
check("整份配置对象照旧认", previewLaunchOf({ mode: "script", launch: "full" }), "full");
check("不认识的值才回落 frontend", [previewLaunchOf("nope"), previewLaunchOf(null), previewLaunchOf({})], ["frontend", "frontend", "frontend"]);
for (const mode of PREVIEW_MODE) {
  const seen = await trialPreviewScript({
    cwd: process.cwd(), script: "echo MODE=$ASH_PREVIEW_MODE; exit 9", mode, timeoutMs: 20_000,
  });
  check(`试跑里的 ASH_PREVIEW_MODE 是 ${mode}`, seen.log.includes(`MODE=${mode}\n`), true);
}

// ── 同一项目只占一格 ────────────────────────────────────────────────────────
// 第 1 轮审查复现：老实现在「查有没有在跑」和「写进索引」之间 await 挑执行器，两个页面同时
// 点就真起两个智能体，后写入的把前一个顶掉 —— 被顶掉的那份查不到也停不了，一直在用户的
// 项目目录里跑着。这里直接钉预占这一步（走 startPreviewAssist 会真起 CLI，烧额度）。
const first = reservePreviewAssistJob("p-assist-race", "claim-甲");
const second = reservePreviewAssistJob("p-assist-race", "claim-乙");
check("第二次点进来不另开一份", [second.fresh, second.job.state.jobId === first.job.state.jobId], [false, true]);
check("拿到的就是在跑的那一份", previewAssistState("p-assist-race")?.jobId, first.job.state.jobId);
// 第 5 轮审查复现：交回去的那份**必须还是原主的 claim**。盖成后来这一次的，点击方就会把
// 别人跑出来的脚本当成自己的结果填进输入框——用户已经保存的那条就这么被换掉了。
check("新开的那份认下点击自报的身份", first.job.state.claim, "claim-甲");
check("复用回去的那份不认后来者", second.job.state.claim, "claim-甲");
check("停掉之后这一格能再占", [cancelPreviewAssist("p-assist-race"), reservePreviewAssistJob("p-assist-race", "claim-丙").fresh], [true, true]);
check("再占的那份认新身份", previewAssistState("p-assist-race")?.claim, "claim-丙");

// ── 试跑判定 ────────────────────────────────────────────────────────────────
const listen = `node -e "require('http').createServer((q,s)=>{s.end('ok')}).listen(process.env.PORT)"`;

const ok = await trialPreviewScript({ cwd: process.cwd(), script: listen, mode: "command", timeoutMs: 30_000 });
check("听住借来的端口就算起来了", ok.ok, true);
check("——并且报出探到的地址", typeof ok.url === "string" && ok.url.includes(String(ok.port)), true);
// 杀不干净的话这台机器上会留一个谁也管不到的 dev server，界面上连痕迹都没有。
await new Promise((done) => setTimeout(done, 500));
check("试跑结束后进程被杀干净，端口空出来", await canConnect(ok.port ?? 0), false);

const gone = await trialPreviewScript({ cwd: process.cwd(), script: "echo 我不干了 >&2; exit 3", mode: "command", timeoutMs: 30_000 });
check("进程自己退了就是没起来", gone.ok, false);
check("——原因里说清是退出了", gone.reason?.includes("进程已退出") ?? false, true);
check("——日志原样留着给人看", gone.log.includes("我不干了"), true);

// 活着但什么都不听：正是「build 完就 serve 静态文件忘了起服务」那类错的形状。
const mute = await trialPreviewScript({ cwd: process.cwd(), script: `node -e "setTimeout(()=>{},60000)"`, mode: "command", timeoutMs: 4_000 });
check("活着但没人听端口 = 没起来", mute.ok, false);
check("——原因说的是等超时了", mute.reason?.includes("没有服务响应") ?? false, true);

const stopped = await trialPreviewScript({
  cwd: process.cwd(), script: listen, mode: "command", timeoutMs: 30_000,
  canceled: () => true,
});
check("点了取消就当场收摊", [stopped.ok, stopped.reason], [false, "已取消"]);

// 组长先退、后台后代赖着不走：`npm run dev &` 这种写法的形状，而忽略 SIGTERM 的脚本满地都是。
// 第 3 轮审查复现：收尾只问组长（那层 shell）还活着没有，组长一退就立刻得到「已经没了」，
// 补 SIGKILL 那一步根本不执行 —— 机器上于是留着一个谁也管不到的进程，占着端口吃着 CPU，
// 而界面上连它存在过的痕迹都没有（试跑不写预览记录）。
const orphan = await trialPreviewScript({
  cwd: process.cwd(), mode: "command", timeoutMs: 30_000,
  script: `node -e "process.on('SIGTERM',()=>{});setTimeout(()=>{},60000);console.log('KID='+process.pid)" & sleep 0.6; exit 7`,
});
const kid = Number(/KID=(\d+)/.exec(orphan.log)?.[1] ?? 0);
// 收摊是「发信号」，进程消失是内核那边的事（组长已经退了，这个后代要挂到 launchd 上才被回收），
// 所以给它一点时间再判 —— 但只给一点：修好之前它会一直活着，这几秒等不出结果。
const waitGone = async (pid: number, within: number) => {
  const until = Date.now() + within;
  while (Date.now() < until && isPidAlive(pid)) await new Promise((done) => setTimeout(done, 50));
  return !isPidAlive(pid);
};
check("后台后代的 pid 报出来了（这条测不成就是脚本自己的问题）", kid > 0, true);
check("组长先退、后代忽略 TERM，也得被收走", kid > 0 && await waitGone(kid, 3_000), true);
if (kid > 0 && isPidAlive(kid)) { try { process.kill(kid, "SIGKILL"); } catch { /* 已经没了 */ } }

console.log(failures ? `\n${failures} 处不符` : "\n全部通过");
process.exit(failures ? 1 : 0);
