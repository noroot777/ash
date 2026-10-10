// 「哪一下算发送」给 React 用的那一面:当前档位(提示文案跟着它重渲染)+ 整页一次的拉取。
//
// 判据本体在 `sendKey.ts`(它不认识 React,也不 import api);这里只做两件 React 的事。
import { useEffect, useState } from "react";
import type { ComposerSendKey } from "@ash/shared";
import { api } from "./api.ts";
import {
  displaySendKey,
  onComposerSendKeyChange,
  sendKeyLabels,
  settleComposerSendKeyDefault,
} from "./sendKey.ts";

// 这一档住在服务端,而读它的输入框散在全站。整页拉一次就够:`api.settings()` 的
// adopt 会把读到的档位交给 sendKey.ts,之后所有输入框从那里取。
//
// 读不到就隔一会儿再试,**但有上限,而且按时间计不按挂载计**:在学到之前裸回车一律当
// 换行(见 sendKey.ts),所以「一直学不到」必须有个了断 —— 试满就认出厂默认,否则服务端
// 不应答时「回车发不出去」会被当成又一处坏掉的地方。按挂载计数不行:只挂载过一两个
// 输入框的页面永远到不了上限,会无限期停在未知态。
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;
let started = false;
function ensureLoaded(): void {
  if (started) return;
  started = true;
  void (async () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await api.settings();
        return;
      } catch {
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }
    settleComposerSendKeyDefault();
  })();
}

/** 当前这一档(未知时按出厂默认念),改了会重渲染。写提示文案用 `useSendKeyLabels`。 */
export function useComposerSendKey(): ComposerSendKey {
  const [mode, setMode] = useState(displaySendKey);
  useEffect(() => {
    ensureLoaded();
    // 订阅之前这一档可能已经被别人学到了(adopt 发生在任何一次读设置时)。
    setMode(displaySendKey());
    return onComposerSendKeyChange(() => setMode(displaySendKey()));
  }, []);
  return mode;
}

/** 提示文案要的那两个键名。 */
export function useSendKeyLabels(): ReturnType<typeof sendKeyLabels> {
  return sendKeyLabels(useComposerSendKey());
}
