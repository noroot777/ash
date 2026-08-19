// 系统文件选择窗口(dir-picker.ts)的纯逻辑部分。
//
// 真正弹窗那步是模态的、要人手点,机器上跑不了;而三个平台里只有一个能在开发机上验证
// (这台是 macOS,Windows 那条路径没有真机)。所以把「不弹窗也能判对错」的那几块——放行
// 谁、脚本长什么样、输出怎么解析、起始目录怎么退——全钉在这里,尤其是 Windows:它唯一
// 的护栏就是这条测试。
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  directoryPickerSupport,
  isLoopbackAddress,
  macScript,
  normalizePickedPath,
  parseMarker,
  readPickRequest,
  startDirectory,
  windowsPickerScript,
} from "../src/dir-picker.js";
import { encodePowerShellCommand } from "../src/platform.js";

// ── 放行谁 ───────────────────────────────────────────────────────────────────
// 这是「窗口会不会弹到别人机器上」的唯一判据,写宽一格就等于把某台机器的桌面交给远程。
for (const ok of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "localhost", " 127.0.0.1 "]) {
  assert.equal(isLoopbackAddress(ok), true, `${ok} 是本机`);
}
for (const no of [undefined, "", "192.168.1.7", "100.64.0.3", "::ffff:10.0.0.1", "10.0.0.1", "127.0.0.1.evil.com", "fe80::1"]) {
  assert.equal(isLoopbackAddress(no), false, `${String(no)} 不是本机`);
}

// 远程调用方一律不可用,而且必须给出人话理由(前端拿它决定连按钮都不渲染)。
const remote = directoryPickerSupport("192.168.1.7");
assert.equal(remote.available, false, "远程浏览器不该能弹窗");
assert.ok(remote.reason && remote.reason.length > 0, "不可用时必须给理由");
const local = directoryPickerSupport("127.0.0.1");
if (process.platform === "darwin" || process.platform === "win32") {
  assert.equal(local.available, true, "本机 + 有图形界面的平台应当可用");
  assert.equal(local.reason, null, "可用时不该再给理由");
} else {
  assert.equal(typeof local.available, "boolean");
  if (!local.available) assert.ok(local.reason, "不可用时必须给理由");
}

// ── 输出解析 ─────────────────────────────────────────────────────────────────
// 认不出来必须回 null,而不是把半截 stderr 当路径填进用户的输入框。
assert.deepEqual(parseMarker("OK/Users/fjh/code/harness\n"), { path: "/Users/fjh/code/harness", cancelled: false });
assert.deepEqual(parseMarker("OKC:\\Users\\fjh\\代码\r\n"), { path: "C:\\Users\\fjh\\代码", cancelled: false });
assert.deepEqual(parseMarker("CANCEL\r\n"), { path: null, cancelled: true });
// PowerShell 的告警/进度会先落在前面,标记在最后一行,所以从后往前扫。
assert.deepEqual(parseMarker("WARNING: something\nOK/tmp/x"), { path: "/tmp/x", cancelled: false });
for (const junk of ["", "\n\n", "not a marker", "OK"]) {
  assert.equal(parseMarker(junk), null, `「${junk}」不该被当成结果`);
}

// AppleScript 的 `POSIX path of` 给文件夹一律带尾斜杠(2026-08-18 真机实测:选中 server/src
// 回来的是 `/Users/fjh/code/harness/server/src/`)。不削掉的话同一个目录会在库里存出两种写法。
assert.deepEqual(parseMarker("OK/Users/fjh/code/harness/server/src/"), {
  path: "/Users/fjh/code/harness/server/src",
  cancelled: false,
});
assert.equal(normalizePickedPath("/tmp/x/"), "/tmp/x");
assert.equal(normalizePickedPath("C:\\Users\\fjh\\code\\"), "C:\\Users\\fjh\\code");
// 根目录本身就是一个分隔符,削光就不是路径了。
assert.equal(normalizePickedPath("/"), "/");
assert.equal(normalizePickedPath("C:\\"), "C:\\");

// ── macOS 脚本 ───────────────────────────────────────────────────────────────
// 起始目录必须走 argv:拼进脚本文本的话,带引号/反斜杠的路径就是一条现成的注入面。
for (const useSystemEvents of [true, false]) {
  const lines = macScript(useSystemEvents);
  const text = lines.join("\n");
  assert.equal(lines[0], "on run argv", "必须用 argv 收参数");
  assert.equal(lines[lines.length - 1], "end run");
  assert.ok(text.includes("set startPath to item 1 of argv"), "起始目录只能从 argv 拿");
  assert.ok(text.includes("choose folder"), "选目录用 choose folder");
  assert.ok(text.includes("on error number -128"), "用户取消(-128)必须被吃掉,不能当报错");
  assert.ok(text.includes('return "CANCEL"'), "取消要回 CANCEL 标记");
  assert.ok(text.includes('return "OK"'), "选中要回 OK 标记");
  assert.equal(
    text.includes('tell application "System Events"'),
    useSystemEvents,
    "System Events 变体由参数决定,退路那份必须是裸写法",
  );
  if (useSystemEvents) {
    // 只 tell 不 activate,窗口照样会藏在别的窗口后面 —— 用户看到的就是「按了没反应」。
    assert.ok(text.includes("activate"), "System Events 变体必须 activate,否则窗口不在最前");
    assert.ok(text.trimEnd().includes("end tell"), "tell 块要闭合");
  }
}

// ── Windows 脚本 ─────────────────────────────────────────────────────────────
// 这台机器不是 Windows,这段脚本永远跑不到;下面每一条都对应一个已知会让它默默失效的坑。
const win = windowsPickerScript();
assert.ok(win.includes("Add-Type -AssemblyName System.Windows.Forms"), "得先加载 WinForms");
assert.ok(win.includes("FolderBrowserDialog"), "选目录用 FolderBrowserDialog");
assert.ok(
  win.includes("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"),
  "不钉 UTF-8 的话中文目录名会被 OEM 代码页变成乱码",
);
assert.ok(win.includes("$env:HARNESS_DIR_PICKER_START"), "起始目录经环境变量传入,绕开 PowerShell 引号规则");
assert.ok(win.includes("$dialog.ShowDialog($owner)"), "必须带 owner 窗口调用,否则会被前台窗口规则挡在后面");
assert.ok(win.includes("$owner.TopMost = $true"), "owner 要置顶");
assert.ok(win.includes("$owner.Show()") && win.includes("$owner.Activate()"), "owner 得先显示并激活才算前台");
assert.ok(win.includes("$owner.Dispose()"), "owner 用完要释放");
assert.ok(win.includes("[Console]::Out.WriteLine('OK' + $dialog.SelectedPath)"), "选中要回 OK 标记");
assert.ok(win.includes("[Console]::Out.WriteLine('CANCEL')"), "取消要回 CANCEL 标记");
assert.ok(!/\$start\s*=\s*'/.test(win), "脚本本身必须是常量,不许把路径拼进去");

// -EncodedCommand 吃的是 UTF-16LE 的 base64。编错了 PowerShell 会拿到一段乱码脚本然后
// 报一个跟本功能毫无关系的语法错。
const encoded = encodePowerShellCommand(win);
assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), win, "编码必须能原样还原");
assert.ok(/^[A-Za-z0-9+/]+=*$/.test(encoded), "编出来得是合法 base64");

// 解析器认得出自己那段脚本会打印的东西(两边约定不能各改各的)。
assert.deepEqual(parseMarker("OKC:\\Users\\fjh\\code"), { path: "C:\\Users\\fjh\\code", cancelled: false });

// ── 起始目录 ─────────────────────────────────────────────────────────────────
const dir = await mkdtemp(join(tmpdir(), "harness-dir-picker-"));
const file = join(dir, "readme.md");
await writeFile(file, "x");
assert.equal(await startDirectory(dir), resolve(dir), "给的就是目录:原样停在那儿");
assert.equal(await startDirectory(file), resolve(dir), "给的是文件:退到它所在的目录");
assert.equal(await startDirectory(join(dir, "no-such", "deeper")), homedir(), "两级都不存在:退到家目录");
assert.equal(await startDirectory(""), homedir(), "空值退到家目录");
assert.equal(await startDirectory(undefined), homedir(), "没给也退到家目录");
assert.equal(await startDirectory("~"), homedir(), "~ 要展开");

// ── 请求体闸 ─────────────────────────────────────────────────────────────────
// 这道闸的分量跟上面那条 loopback 判据一样:过了它就会在服务端桌面上弹出一个模态窗口,
// 并占住单飞闸直到有人去点。所以「解析不了就当 {} 继续」是不行的——放宽一格,任何一个
// 本机浏览器页面都能靠一次简单 POST 在用户桌面上弹窗。
const jsonHeaders = { contentType: "application/json" };

assert.deepEqual(readPickRequest(jsonHeaders, '{"startIn":"/tmp/x"}'), { ok: true, startIn: "/tmp/x" });
assert.deepEqual(readPickRequest(jsonHeaders, "{}"), { ok: true, startIn: undefined });
// 前端带的是 `application/json; charset=utf-8` 这类写法,参数部分不能影响判断。
assert.deepEqual(readPickRequest({ contentType: "application/json; charset=utf-8" }, "{}"), {
  ok: true,
  startIn: undefined,
});
assert.deepEqual(readPickRequest({ contentType: "application/json", secFetchSite: "same-origin" }, "{}"), {
  ok: true,
  startIn: undefined,
});

// 解析失败必须当场回 400,不许落到 pickDirectory。
for (const bad of ["{bad json", "", "not json", "[1,2]", '"just a string"', "null"]) {
  const result = readPickRequest(jsonHeaders, bad);
  assert.equal(result.ok, false, `「${bad}」不该被放进 picker`);
  if (!result.ok) assert.equal(result.status, 400, `「${bad}」应当回 400`);
}
// startIn 类型不对也一样:拿默认值把窗口弹出去是最坏的处理方式。
for (const bad of ['{"startIn":123}', '{"startIn":null}', '{"startIn":["/tmp"]}']) {
  const result = readPickRequest(jsonHeaders, bad);
  assert.equal(result.ok, false, `${bad} 的 startIn 类型不对`);
  if (!result.ok) assert.equal(result.status, 400);
}

// 简单请求(no-cors fetch / 表单提交)只能带这三种 Content-Type,换成 JSON 就得先过预检。
// 挡住它们,跨站页面就没法拿这个端点在用户桌面上弹窗——响应读不到,副作用照样会发生。
for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", undefined, ""]) {
  const result = readPickRequest({ contentType: type }, '{"startIn":"/tmp/x"}');
  assert.equal(result.ok, false, `Content-Type「${String(type)}」不该被放行`);
  if (!result.ok) assert.equal(result.status, 415, `Content-Type「${String(type)}」应当回 415`);
}

// Sec-Fetch-Site 是浏览器盖的章,页面伪造不了。缺头(curl / 手机端 / 测试)照常放行。
for (const site of ["cross-site", "same-site"]) {
  const result = readPickRequest({ ...jsonHeaders, secFetchSite: site }, "{}");
  assert.equal(result.ok, false, `Sec-Fetch-Site: ${site} 不该被放行`);
  if (!result.ok) assert.equal(result.status, 403);
}
for (const site of ["none", "same-origin", "SAME-ORIGIN", undefined, null]) {
  assert.equal(readPickRequest({ ...jsonHeaders, secFetchSite: site }, "{}").ok, true, `Sec-Fetch-Site: ${String(site)} 应当放行`);
}

console.log("dir-picker 测试通过");