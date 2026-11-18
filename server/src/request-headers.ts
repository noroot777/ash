// 收请求头的单点：我方的头一律按各代名字读（`x-navi-…`，退到旧名 `x-ash-…`），见 shared/src/http-headers.ts。
import type { Context } from "hono";
import { readHeader, type NaviHeaderName } from "@ash/shared/http-headers";

export { NAVI_HEADERS } from "@ash/shared/http-headers";

export const requestHeader = (c: Context, name: NaviHeaderName): string | undefined =>
  readHeader((key) => c.req.header(key), name);
