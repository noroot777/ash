import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const web = await startWebServer();

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage();
  await page.goto(`${web.origin}/scripts/fixtures/inspector-attachments.html`);

  const originalLink = page.getByRole("link", { name: "image.png" });
  const followUpLink = page.getByRole("link", { name: "follow-up.jpg" });
  const fileLink = page.getByRole("link", { name: "spec.pdf" });
  await originalLink.waitFor();
  assert.match(await originalLink.getAttribute("href"), /\/api\/uploads\/KxOxbl42hcRf-image\.png$/);
  assert.match(await followUpLink.getAttribute("href"), /\/api\/uploads\/R4nd0mAbC123-follow-up\.jpg$/);
  assert.match(await fileLink.getAttribute("href"), /\/api\/uploads\/D0cumentAb12-spec\.pdf$/);
  assert.equal(await fileLink.getAttribute("target"), "_blank");
  assert.equal(await page.locator(".task-message-attachments").count(), 0, "inspector attachments should not render cards");
  assert.equal(await page.getByText("[用户附带的文件，请用 Read 工具查看以下本地文件]").count(), 0);
  assert.equal(await page.getByText("检查原始需求里的图片链接。").count(), 1);
  assert.equal(await page.getByText("检查追问里的图片链接。").count(), 1);

  await originalLink.click();
  const dialog = page.getByRole("dialog", { name: /图片预览/ });
  await dialog.waitFor();
  assert.equal(await page.getByText("1 / 2", { exact: true }).count(), 1);
  assert.match(await dialog.locator("img").getAttribute("src"), /KxOxbl42hcRf-image\.png$/);
  assert.equal(await page.getByRole("button", { name: "上一张图片" }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "下一张图片" }).count(), 1);

  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByText("2 / 2", { exact: true }).count(), 1);
  assert.match(await dialog.locator("img").getAttribute("src"), /R4nd0mAbC123-follow-up\.jpg$/);

  await page.keyboard.press("ArrowLeft");
  assert.equal(await page.getByText("1 / 2", { exact: true }).count(), 1);
  assert.match(await dialog.locator("img").getAttribute("src"), /KxOxbl42hcRf-image\.png$/);

  console.log("inspector attachment preview links test passed");
} finally {
  await browser?.close();
  await web.close();
}
