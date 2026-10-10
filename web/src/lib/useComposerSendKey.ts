// 「哪一下算发送」给 React 用的那一面:当前档位(提示文案跟着它重渲染)+ 整页一次的拉取。
//
// 判据本体在 `sendKey.ts`(它不认识 React,也不 import api);这里只做两件 React 的事。
import { useEffect, useState } from "react";
import type { ComposerSendKey } from "@ash/shared";
import { api } from "./api.ts";
import { composerSendKey, onComposerSendKeyChange, sendKeyLabels } from "./sendKey.ts";

// 这一档住在服务端,而读它的输入框散在全站。整页拉一次就够:`api.settings()` 的
// adopt 会把读到的档位交给 sendKey.ts,之后所有输入框从那里取。
//
// 失败了可以再试(网络抖一下就让这一档整场错着,代价是「随手一个回车把半句话发出去」),
// 但**得有上限**:挂着这个钩子的输入框有十来个,不封顶的话 `/settings` 一直不通时,
// 每打开一个输入框就多发一次请求。三次之后就认本地镜像/出厂默认。
const MAX_ATTEMPTS = 3;
let loaded: Promise<unknown> | null = null;
let attempts = 0;
function ensureLoaded(): void {
  if (loaded || attempts >= MAX_ATTEMPTS) return;
  attempts += 1;
  loaded = api.settings().catch(() => { loaded = null; });
}

/** 当前这一档,改了会重渲染。写提示文案的地方用 `useSendKeyLabels` 更直接。 */
export function useComposerSendKey(): ComposerSendKey {
  const [mode, setMode] = useState(composerSendKey);
  useEffect(() => {
    ensureLoaded();
    // 订阅之前这一档可能已经被别人学到了(adopt 发生在任何一次读设置时)。
    setMode(composerSendKey());
    return onComposerSendKeyChange(setMode);
  }, []);
  return mode;
}

/** 提示文案要的那两个键名。 */
export function useSendKeyLabels(): ReturnType<typeof sendKeyLabels> {
  return sendKeyLabels(useComposerSendKey());
}
