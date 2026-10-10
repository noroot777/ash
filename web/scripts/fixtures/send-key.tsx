import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppSettings, ComposerSendKey } from "@ash/shared";
import { DEFAULT_APP_SETTINGS } from "@ash/shared";
import "../../src/styles/global.css";
import { ComposerObjective } from "../../src/composer/ComposerObjective.tsx";
import { ComposerSendKeyCard } from "../../src/settings/ComposerSendKeyCard.tsx";
import { api } from "../../src/lib/api.ts";
import { composerSendKey } from "../../src/lib/sendKey.ts";
import { useSendKeyLabels } from "../../src/lib/useComposerSendKey.ts";

// 「输入框按哪一下算发送」的台子。走的是真实那条链路：
//   GET/PATCH /api/settings → api.ts 的 adopt → sendKey.ts → 输入框与提示文案。
// 所以 fetch 是打桩的、组件是真的。
//
// 三个开关，各对应一类时序：
//   `?send-key=`  服务端那份的初值
//   `?hang=1`     GET 永不应答 —— 看「还没学到这一档」时按下的回车落在哪
//   `?hold=1`     第一条 GET 被扣住，放行时交回**它发出那一刻**的旧值 —— 看迟到的
//                 旧应答能不能覆盖掉刚保存的新值
//   `?fail=N`     接下来 N 条 GET 直接 503 —— 把开场那轮重试打光，逼出兜底
//
// `window.__probeSettings()` 再单独发一条**必定被扣住**的 GET：它在兜底之前发出、
// 放行后才回来，用来看那个兜底有没有把更早发出的真应答挤掉。

const params = new URLSearchParams(location.search);
const hang = params.get("hang") === "1";
const hold = params.get("hold") === "1";
let failsLeft = Number(params.get("fail") ?? 0);
const stored: AppSettings = {
  ...DEFAULT_APP_SETTINGS,
  composerSendKey: (params.get("send-key") as ComposerSendKey | null) ?? DEFAULT_APP_SETTINGS.composerSendKey,
};

const reply = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { "content-type": "application/json" },
});
let heldGate: (() => void) | null = null;
let heldUsed = false;
// 这一条是测试显式发的（__probeSettings），一律扣住 —— 跟 `?hold=1` 那条分开，
// 免得两边抢「第一条 GET」这个名额，顺序一变用例就飘。
let probing = false;
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(href, location.origin).pathname;
  if (path === "/api/settings") {
    if (init?.method === "PATCH") {
      Object.assign(stored, JSON.parse(String(init.body)) as Partial<AppSettings>);
      return reply(stored);
    }
    if (probing) {
      const snapshot = { ...stored };
      await new Promise<void>((resolve) => { heldGate = resolve; });
      return reply(snapshot);
    }
    if (hang) return await new Promise<Response>(() => { /* 故意不应答 */ });
    if (failsLeft > 0) { failsLeft -= 1; return new Response("boom", { status: 503 }); }
    if (hold && !heldUsed) {
      heldUsed = true;
      // 快照「发出那一刻」的值：之后的 PATCH 改了 stored 也不影响这一份。
      const snapshot = { ...stored };
      await new Promise<void>((resolve) => { heldGate = resolve; });
      return reply(snapshot);
    }
    return reply(stored);
  }
  if (path.startsWith("/api/")) return reply({});
  return realFetch(input, init);
};

// 测试侧的两个把手：放行被扣住的那条 GET、读「这一档学到了没有」。
Object.assign(window, {
  __releaseHeldSettings: () => { heldGate?.(); heldGate = null; },
  __sendKeyState: () => composerSendKey(),
  // fetch 打桩的入口是同步跑到第一个 await 的，所以这个标记在那一刻读得到。
  __probeSettings: () => {
    probing = true;
    const pending = api.settings().catch(() => undefined);
    probing = false;
    return pending.then(() => undefined);
  },
});

function Fixture() {
  const [value, setValue] = useState<ComposerSendKey>(stored.composerSendKey);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const labels = useSendKeyLabels();

  // 设置页就是这么读写的（DefaultsSettings.tsx）：GET 一份、PATCH 回一份。
  useEffect(() => {
    api.settings()
      .then((settings) => setValue(settings.composerSendKey))
      .catch(() => { /* hang 那一档永远停在这里 */ })
      .finally(() => setLoading(false));
  }, []);
  const change = useCallback(async (next: ComposerSendKey) => {
    setValue((await api.patchSettings({ composerSendKey: next })).composerSendKey);
  }, []);

  return <main className="settings-main" style={{ width: "min(100%, 960px)", margin: "auto", padding: 20 }}>
    <p data-testid="log">{log.join(",")}</p>
    <p data-testid="hint">{labels.send} 发送 · {labels.newline} 换行</p>
    {/* hold / hang 那两档下这条 GET 不会回来，别让「载入中」把下拉按死 */}
    <ComposerSendKeyCard value={value} loading={loading && !hang && !hold} onChange={change} />
    <div style={{ marginTop: 16 }}>
      <ComposerObjective
        body={body} mode="single" textareaRef={textareaRef}
        onChange={setBody} onPaste={() => {}}
        items={[]} selected={0} token={null}
        onSelect={() => {}} onPick={() => {}} onDismiss={() => {}}
        onSubmit={() => setLog((prev) => [...prev, `submit(${JSON.stringify(body)})`])}
      />
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
