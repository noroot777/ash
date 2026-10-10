import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppSettings, ComposerSendKey } from "@ash/shared";
import { DEFAULT_APP_SETTINGS } from "@ash/shared";
import "../../src/styles/global.css";
import { ComposerObjective } from "../../src/composer/ComposerObjective.tsx";
import { ComposerSendKeyCard } from "../../src/settings/ComposerSendKeyCard.tsx";
import { api } from "../../src/lib/api.ts";
import { useSendKeyLabels } from "../../src/lib/useComposerSendKey.ts";

// 「输入框按哪一下算发送」的台子。走的是真实那条链路：
//   GET/PATCH /api/settings → api.ts 的 adopt → sendKey.ts → 输入框与提示文案。
// 所以 fetch 是打桩的、组件是真的。
//
// `?send-key=` 指定服务端那份的初值；`?hang=1` 让 GET 永不应答，用来看「设置还没到货时
// 按下的第一个回车」落在哪一档上（本地镜像那条保险）。

const params = new URLSearchParams(location.search);
const hang = params.get("hang") === "1";
const stored: AppSettings = {
  ...DEFAULT_APP_SETTINGS,
  composerSendKey: (params.get("send-key") as ComposerSendKey | null) ?? DEFAULT_APP_SETTINGS.composerSendKey,
};

const reply = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { "content-type": "application/json" },
});
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(href, location.origin).pathname;
  if (path === "/api/settings") {
    if (init?.method === "PATCH") {
      Object.assign(stored, JSON.parse(String(init.body)) as Partial<AppSettings>);
      return reply(stored);
    }
    if (hang) return await new Promise<Response>(() => { /* 故意不应答 */ });
    return reply(stored);
  }
  if (path.startsWith("/api/")) return reply({});
  return realFetch(input, init);
};

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
    <ComposerSendKeyCard value={value} loading={loading && !hang} onChange={change} />
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
