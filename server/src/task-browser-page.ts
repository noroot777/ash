import type { Page } from "playwright-core";
import type { BrowserTarget, BrowserUserAction } from "@ash/shared/task-runtime";

export async function inspectBrowserPage(page: Page, prefix: string): Promise<{ text: string; targets: BrowserTarget[] }> {
  return page.evaluate((stamp) => {
    const candidates = document.querySelectorAll<HTMLElement>("a[href],button,input,textarea,select,[role=button],[role=checkbox],[contenteditable=true],summary");
    const targets: BrowserTarget[] = [];
    for (const element of candidates) {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height || getComputedStyle(element).visibility === "hidden" || targets.length >= 200) continue;
      const ref = `${stamp}-${targets.length + 1}`;
      element.setAttribute("data-ash-browser-ref", ref);
      const control = element as HTMLInputElement;
      const labels = "labels" in control ? Array.from(control.labels ?? []).map((label) => label.textContent ?? "").join(" ") : "";
      const labelled = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      targets.push({ ref, role: element.getAttribute("role") || element.tagName.toLowerCase(),
        name: (element.getAttribute("aria-label") || labelled.trim() || labels || element.innerText || element.getAttribute("placeholder") || control.name || "").trim().slice(0, 180),
        ...(["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) && control.type !== "password" ? { value: control.value.slice(0, 180) } : {}),
      });
    }
    return { text: document.body.innerText.slice(0, 12_000), targets };
  }, prefix);
}

export function browserViewport(width: unknown, height: unknown) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || Number(width) < 320 || Number(width) > 2560 || Number(height) < 240 || Number(height) > 1800) {
    throw new Error("浏览器尺寸范围：宽 320–2560，高 240–1800");
  }
  return { width: Number(width), height: Number(height) };
}

export function browserPath(path: string, base: string): string {
  const target = new URL(path, base);
  if (target.origin !== new URL(base).origin || target.username || target.password) throw new Error("共享浏览器只能打开此任务托管服务的页面");
  return target.href;
}

export async function operateBrowserPage(page: Page, input: BrowserUserAction, base: string, prefix: string): Promise<void> {
  if (input.action === "navigate") await page.goto(browserPath(input.path, base), { waitUntil: "domcontentloaded" });
  else if (input.action === "reload") await page.reload({ waitUntil: "domcontentloaded" });
  else if (input.action === "back") await page.goBack({ waitUntil: "domcontentloaded" });
  else if (input.action === "forward") await page.goForward({ waitUntil: "domcontentloaded" });
  else if (input.action === "resize") await page.setViewportSize(browserViewport(input.width, input.height));
  else if (input.action === "scroll") await page.mouse.wheel(0, input.direction === "down" ? 560 : -560);
  else if (input.action === "press") await page.keyboard.press(input.key);
  else if (input.action === "type") await page.keyboard.insertText(input.text);
  else if (input.action === "pointer") {
    const size = page.viewportSize()!;
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.x > size.width || input.y < 0 || input.y > size.height) throw new Error("点击位置已失效，请刷新画面");
    await page.mouse.click(input.x, input.y);
  } else if (input.action === "click" || input.action === "fill" || input.action === "select") {
    if (!input.ref.startsWith(`${prefix}-`) || !/^[a-z0-9-]+$/.test(input.ref)) throw new Error("页面目标已过期，请重新 snapshot 后使用新的 ref");
    const target = page.locator(`[data-ash-browser-ref="${input.ref}"]`);
    if (input.action === "click") await target.click();
    else if (input.action === "fill") await target.fill(input.text);
    else await target.selectOption(input.value);
  }
}
