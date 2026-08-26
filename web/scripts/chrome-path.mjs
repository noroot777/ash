// 找一个能跑 headless 的 Chromium 内核给这堆 DOM 回归测试用。
// 以前每个 test-*.mjs 各抄一份候选表，且只写了 macOS 的路径，Windows 上 `npm -w web run build`
// 必挂在「找不到可执行的 Chrome/Chromium」——候选表统一放这里，按平台给全。
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { chromium } from "playwright-core";

function systemCandidates() {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  if (process.platform === "win32") {
    // Windows 上 Chrome 可能装在三处（用户级 / 64 位 / 32 位），Edge 同为 Chromium 内核，兜底够用。
    const roots = [
      process.env.LOCALAPPDATA,
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
    ].filter(Boolean);
    return [
      ...roots.map((root) => `${root}\\Google\\Chrome\\Application\\chrome.exe`),
      ...roots.map((root) => `${root}\\Microsoft\\Edge\\Application\\msedge.exe`),
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
}

function bundledCandidate() {
  try {
    return chromium.executablePath();
  } catch {
    // playwright-core 没装浏览器时会抛，当作没有这个候选。
    return null;
  }
}

// 顺序：显式指定 > 本机装的 Chrome/Edge > playwright 自带的 chromium。
export async function chromeExecutablePath() {
  const candidates = [process.env.CHROME_BIN, ...systemCandidates(), bundledCandidate()].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next local Chrome/Chromium candidate.
    }
  }
  throw new Error(
    `找不到可执行的 Chrome/Chromium；可通过 CHROME_BIN 指定路径。已尝试：\n  ${candidates.join("\n  ")}`,
  );
}

export async function chromeLaunchOptions() {
  return {
    executablePath: await chromeExecutablePath(),
    headless: true,
    args: ["--no-proxy-server"],
  };
}
