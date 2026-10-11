// 「哪一下算发送」给 React 用的那一面:当前档位(提示文案跟着它重渲染)+ 整页一次的拉取。
//
// 判据本体在 `sendKey.ts`(它不认识 React,也不 import api);这里只做两件 React 的事。
import { useEffect, useState } from "react";
import type { ComposerSendKey } from "@ash/shared";
import { api } from "./api.ts";
import {
  composerSendKey,
  displaySendKey,
  onComposerSendKeyChange,
  sendKeyLabels,
} from "./sendKey.ts";

// 这一档住在服务端,而读它的输入框散在全站。整页拉一次就够:`api.settings()` 读到的
// 那一份会经 settingsSync 交给 sendKey.ts,之后所有输入框从那里取。
//
// 读不到怎么办:**什么都不假设**。在学到之前裸回车一律当换行(见 sendKey.ts),发送
// 按钮和 ⌘/Ctrl+回车照常可用,所以「一直学不到」不会把谁挡死 —— 比起猜一个没人选过
// 的档位去真的发消息,这一侧安全得多(第 2 轮审查问题 2)。
//
// 重试分两层,都不靠挂载计数:
//  · 一轮里退避重试几次,盖住一次网络抖动;
//  · 这一轮全败就放开闸门,**下一个挂载的输入框会再起一轮** —— 用户切页面、开新框
//    的时候自然重试,既能自愈,也不会在没人看的页面上无限轮询。
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;
let loading = false;
function ensureLoaded(): void {
  if (loading || composerSendKey() !== null) return;
  loading = true;
  void (async () => {
    try {
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
    } finally {
      loading = false;
    }
  })();
}

/**
 * 当前这一档,改了会重渲染。未知时给的是**此刻真正在生效**的那一档(见
 * `displaySendKey`),不是出厂默认。写提示文案用 `useSendKeyLabels`。
 */
export function useComposerSendKey(): ComposerSendKey {
  const [mode, setMode] = useState(displaySendKey);
  useEffect(() => {
    ensureLoaded();
    // 订阅之前这一档可能已经被别人学到了(任何一次读设置都会推一份过来)。
    setMode(displaySendKey());
    return onComposerSendKeyChange(() => setMode(displaySendKey()));
  }, []);
  return mode;
}

/** 提示文案要的那两个键名。 */
export function useSendKeyLabels(): ReturnType<typeof sendKeyLabels> {
  return sendKeyLabels(useComposerSendKey());
}
