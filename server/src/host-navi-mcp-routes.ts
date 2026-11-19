// 「替这台机器上的 CLI 接好 navi MCP」—— 独立 app 首次连上自己的服务时打一下(见
// desktop/macos/Sources/HostMcpSetup.swift),之后用户也能从菜单里再查一次。逻辑在
// mcp-registry/host-setup.ts,这里只管谁能打。
import type { Context, Hono } from "hono";
import { LEGACY_HOST_MCP_SETUP_PATH } from "@navi/shared/legacy-names";
import { isLocalDirect } from "./auth/remote-access.js";
import { setUpHostNaviMcp } from "./mcp-registry/host-setup.js";

/** 当前路径。旧路径（mac 应用现在打的那条）同一个处理照接，见 legacy-names.ts。 */
export const HOST_MCP_SETUP_PATH = "/navi-mcp/host-setup";

export function mountHostNaviMcpRoutes(api: Hono): void {
  for (const path of [HOST_MCP_SETUP_PATH, LEGACY_HOST_MCP_SETUP_PATH]) api.post(path, hostSetup);
}

async function hostSetup(c: Context): Promise<Response> {
  // 写的是本机用户自己的 CLI 配置,所以只认坐在这台机器前的人;多人模式下每人一份个人目录,
  // 由注册执行器那一下各补各的,没有「本机 CLI」这一说。
  if (!isLocalDirect(c)) return c.json({ error: "只接受本机直连：这一下会写这台机器上各家 CLI 的配置" }, 403);
  const { instanceConfig } = await import("./auth/mode.js");
  if ((await instanceConfig()).mode === "multi") {
    return c.json({ error: "多人模式下各人的 CLI 配置在各自的个人目录里，注册执行器时各自补接" }, 403);
  }
  return c.json({ hosts: await setUpHostNaviMcp() });
}
