import { basename } from "node:path";
import { powerShell } from "../platform.js";
import type { AppOpener, OpenerProbe } from "./types.js";

// Windows 没有 LaunchServices，也没有 .desktop 那种「应用自报能开什么」的清单 ——
// 「谁能打开 .md」这件事只写在注册表里，而且分散在四处：
//
//   HKCR\.md\OpenWithProgids                     应用安装时登记的 ProgID（值名就是 ID）
//   HKCU\…\FileExts\.md\OpenWithProgids          用户用「打开方式」点开过的
//   HKCR\.md\OpenWithList                        子键名是 exe 文件名 → Applications\<exe>
//   HKCU\…\FileExts\.md\OpenWithList             值数据是 exe 文件名（外加一个 MRUList）
//
// 默认应用同样有两层：用户钉死的 `FileExts\.md\UserChoice\ProgId` 优先，没有才看
// `HKCR\.md` 的默认值。拿到 ProgID 之后再到 `HKCR\<ProgID>\shell\open\command` 取真正
// 的启动命令行 —— 那串东西带着 `%1` 这类占位符，得自己替换（见 buildCommand）。
//
// 读注册表走 PowerShell 而不是 `reg.exe`：reg 的输出按控制台 OEM 代码页编码，中文
// 应用名到了 Node 这边就是乱码；PowerShell 可以把输出编码钉成 UTF-8。

/** 一个 ProgID 对应的启动方式。`command` 是注册表里的原始模板，含占位符。 */
interface Entry {
  id: string;
  name: string;
  command: string;
}

export interface Scan {
  entries: Entry[];
  defaultId: string | null;
}

// 装/卸应用会改注册表，但没有便宜的「变了没有」判据（不像 macOS 能看目录 mtime）。
// 所以按扩展名缓存一小段时间，界面上的重扫按钮走 force 直接作废。
const TTL_MS = 5 * 60_000;
const memo = new Map<string, { at: number; scan: Scan }>();

// 扩展名会被拼进 PowerShell 脚本里的注册表路径，所以先卡形状：文件名是用户可控的，
// `a.md\..\..\x` 这种东西不能有机会变成另一个键。真实扩展名都在这个字符集里。
const SAFE_EXT = /^[a-z0-9_+.-]{1,20}$/;

/**
 * 生成查注册表的 PowerShell。导出是为了让回归测试能检查转义 —— 这段字符串要穿过
 * JS 模板字面量和 PowerShell 两层引号规则，`\` 少一个就是查了个不存在的键，
 * 表现是「Windows 上一个应用都探不到」而不是报错。
 *
 * 输出走 `[Console]::Out.WriteLine` 而不是直接把字符串丢进管道：PowerShell 5.1 的
 * 格式化器会按控制台宽度硬折行，而注册表里的命令行模板轻松超过 120 字符。
 */
export function registryScript(ext: string): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ext = '.${ext}'
$hkcr = 'Registry::HKEY_CLASSES_ROOT\\'
$fileExts = 'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\'
$ids = New-Object System.Collections.Generic.List[string]

# 键不存在时 Get-Item 给 $null,再 .GetValue() 就是「不能在 null 上调方法」——
# SilentlyContinue 压得住,但一路裸调下去很难看清哪句真出了事,统一从这里取值。
function RegValue($path, $name) {
  $k = Get-Item -LiteralPath $path
  if (-not $k) { return '' }
  return [string]$k.GetValue($name)
}
# OpenWithProgids:ProgID 藏在**值名**里(值数据是空的 REG_NONE)
function AddValueNames($path) {
  $k = Get-Item -LiteralPath $path
  if ($k) { foreach ($n in $k.GetValueNames()) { if ($n -and $n -ne 'MRUList') { $ids.Add($n) } } }
}
# HKCU 的 OpenWithList:值数据是 exe 文件名,应用本体登记在 HKCR\\Applications 下
function AddValueData($path) {
  $k = Get-Item -LiteralPath $path
  if (-not $k) { return }
  foreach ($n in $k.GetValueNames()) {
    if ($n -eq 'MRUList') { continue }
    $v = [string]$k.GetValue($n)
    if ($v) { $ids.Add('Applications\\' + $v) }
  }
}
# HKCR 的 OpenWithList:同样的信息记成**子键名**
function AddSubKeyNames($path) {
  $k = Get-Item -LiteralPath $path
  if ($k) { foreach ($n in $k.GetSubKeyNames()) { if ($n) { $ids.Add('Applications\\' + $n) } } }
}

AddValueNames ($hkcr + $ext + '\\OpenWithProgids')
AddValueNames ($fileExts + $ext + '\\OpenWithProgids')
AddSubKeyNames ($hkcr + $ext + '\\OpenWithList')
AddValueData ($fileExts + $ext + '\\OpenWithList')

$assoc = RegValue ($hkcr + $ext) ''
if ($assoc) { $ids.Add($assoc) }
$default = [string](Get-ItemProperty -LiteralPath ($fileExts + $ext + '\\UserChoice')).ProgId
if (-not $default) { $default = $assoc }
[Console]::Out.WriteLine("D\`t$default")

$seen = @{}
foreach ($id in $ids) {
  if (-not $id) { continue }
  $key = $id.ToLowerInvariant()
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = $true
  $cmd = RegValue ($hkcr + $id + '\\shell\\open\\command') ''
  if (-not $cmd) { continue }
  # 显示名三档:应用自己登记的 → exe 的版本信息 → exe 文件名。前两档都可能是
  # '@C:\\path\\x.dll,-101' 这种间接字符串(要 SHLoadIndirectString 才展得开),遇到就跳过。
  $name = RegValue ($hkcr + $id + '\\Application') 'ApplicationName'
  if (-not $name) { $name = RegValue ($hkcr + $id) 'FriendlyAppName' }
  if ($name -and $name.StartsWith('@')) { $name = '' }
  if (-not $name) {
    if ($cmd.StartsWith('"')) { $exe = $cmd.Substring(1).Split('"')[0] } else { $exe = $cmd.Split(' ')[0] }
    $item = Get-Item -LiteralPath $exe
    if ($item -and $item.VersionInfo -and $item.VersionInfo.FileDescription) { $name = [string]$item.VersionInfo.FileDescription }
    if (-not $name) { $name = [IO.Path]::GetFileNameWithoutExtension($exe) }
  }
  $cmd = $cmd -replace '[\\r\\n\\t]', ' '
  $name = ([string]$name) -replace '[\\r\\n\\t]', ' '
  [Console]::Out.WriteLine("A\`t$id\`t$name\`t$cmd")
}
`;
}

/** 解析上面那段脚本的输出。导出给回归测试用 —— 开发机上没有注册表可查。 */
export function parseRegistryScan(text: string): Scan {
  const entries: Entry[] = [];
  let defaultId: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts[0] === "D") {
      defaultId = parts[1]?.trim() || null;
      continue;
    }
    if (parts[0] !== "A" || parts.length < 4) continue;
    const id = parts[1]!.trim();
    const command = parts.slice(3).join("\t").trim();
    if (!id || !command) continue;
    entries.push({ id, name: parts[2]!.trim() || basename(id), command });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  return { entries, defaultId };
}

async function scan(ext: string, force: boolean): Promise<Scan> {
  if (!SAFE_EXT.test(ext)) return { entries: [], defaultId: null };
  const hit = memo.get(ext);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.scan;
  const result = parseRegistryScan(await powerShell(registryScript(ext)));
  memo.set(ext, { at: Date.now(), scan: result });
  return result;
}

/** 把注册表扫描结果映射成界面要的形状。跟取数分开，是为了能不上 Windows 也测得到。 */
export function toWindowsProbe(ext: string, found: Scan): OpenerProbe {
  const base = { platform: "win32", canReveal: true } as const;
  if (!ext) {
    return { ...base, apps: [], note: "这个文件没有扩展名 —— Windows 就是靠扩展名决定用什么程序打开的" };
  }
  if (!SAFE_EXT.test(ext)) {
    return { ...base, apps: [], note: `扩展名 .${ext} 形状不对，没去查注册表` };
  }
  const wanted = found.defaultId?.toLowerCase() ?? null;
  const apps: AppOpener[] = found.entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    detail: entry.id,
    // 四个来源都是**这个扩展名下**的注册表键，不存在 macOS 那种「什么都收」的应用。
    match: "extension",
    isDefault: entry.id.toLowerCase() === wanted,
  }));
  apps.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name, "zh-Hans-CN"));
  return { ...base, apps, note: apps.length ? null : `注册表里没有登记能打开 .${ext} 的程序` };
}

// 注意签名跟 macOS/Linux 那两个不一样：那边要看文件本身(UTI、MIME 嗅探)，Windows 的
// 关联**只由扩展名决定**，路径在这一步没有任何用处。
export async function probeWindowsOpeners(ext: string, force: boolean): Promise<OpenerProbe> {
  if (!ext || !SAFE_EXT.test(ext)) return toWindowsProbe(ext, { entries: [], defaultId: null });
  return toWindowsProbe(ext, await scan(ext, force));
}

/** 按 cmd 的规矩切词：只有引号有意义，反斜杠不是转义符（Windows 路径全是它）。 */
function tokenize(template: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let started = false;
  for (const ch of template) {
    if (ch === "\"") {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (started || cur) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started || cur) out.push(cur);
  return out;
}

// 注册表里的模板长这样:`"C:\Program Files\…\Code.exe" "%1"`。占位符有好几种写法
// (%1 一个参数、%L 长路径、%* 全部参数),都换成这个文件的路径;一个都没有的老条目
// (DDE 时代的遗留)就把路径接在最后。
// 两个常量是同一条规则的两副面孔:带 /g 的那个有 lastIndex 状态,拿它做 .test() 判断
// 会隔次返回 false —— 判断用无状态的,替换用带 /g 的。
const PLACEHOLDER = /%(?:1|l|d|v|\*)/i;
const PLACEHOLDER_ALL = /%(?:1|l|d|v|\*)/gi;

// 注册表里的命令行**是给 shell 读的**,`%SystemRoot%\system32\NOTEPAD.EXE` 这种写法
// 到处都是;而我们走的是 execFile(不过 shell),它不会展开这些变量,结果是「找不到程序」
// 然后静默退回系统默认 —— 界面上看起来接受了你选的应用,打开的却是另一个。
// 所以在这里自己展开。
//
// 只认 `%名字%` 这一种形状,而且名字必须以字母/下划线开头:占位符 `%1` `%L` `%*` 长得
// 不一样,不会被误伤。展开在替换占位符**之前**做 —— 反过来的话,文件名里真有 `%X%`
// 的文档会被当成变量展开掉。
const ENV_VAR = /%([A-Za-z_][A-Za-z0-9_().#$-]*)%/g;

/** Windows 的环境变量名不区分大小写,而 `process.env` 在别的平台上区分,自己兜一层。 */
function envValue(name: string): string | undefined {
  const direct = process.env[name];
  if (direct !== undefined) return direct;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

/** 认不出来的变量原样留着,跟 cmd 一个脾气:宁可让它跑不起来退回默认,也不要拼出一条错路径。 */
function expandEnv(token: string): string {
  return token.replace(ENV_VAR, (whole, name: string) => envValue(name) ?? whole);
}

export function buildWindowsCommand(template: string, absPath: string) {
  const tokens = tokenize(template).map(expandEnv);
  // 模板是空的就别拼了:接下去 `applied` 会只剩文件路径,变成「把这个文档本身当程序执行」。
  if (!tokens.length) return null;
  let replaced = false;
  const applied = tokens.map((token) => {
    if (!PLACEHOLDER.test(token)) return token;
    replaced = true;
    return token.replace(PLACEHOLDER_ALL, absPath);
  });
  if (!replaced) applied.push(absPath);
  const [file, ...args] = applied;
  return file ? { file, args } : null;
}

/**
 * 用指定程序打开;`appId`(ProgID)为空走系统默认。
 *
 * 调用方(openers/index.ts)已经确认过 appId 出现在这个文件的探测结果里,所以这里
 * 直接查刚才那次扫描的缓存 —— 查不到就退回系统默认,不是错误。
 */
export async function windowsOpenCommand(absPath: string, ext: string, appId: string | null) {
  const fallback = { file: "cmd", args: ["/c", "start", "", absPath] };
  if (!appId) return { ...fallback, fallback: null };
  const { entries } = await scan(ext, false);
  const entry = entries.find((item) => item.id.toLowerCase() === appId.toLowerCase());
  const command = entry ? buildWindowsCommand(entry.command, absPath) : null;
  // 注册表里的命令行跑不起来(应用被卸了、路径带的 flag 变了)时还有系统默认兜着。
  return command ? { ...command, fallback } : { ...fallback, fallback: null };
}
