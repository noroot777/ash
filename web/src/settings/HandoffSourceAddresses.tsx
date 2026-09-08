import { useCallback, useEffect, useRef, useState } from "react";
import type { HandoffTarget } from "@ash/shared";
import type { HandoffSourceAddress } from "@ash/shared/handoff";
import { SpinnerGap } from "@phosphor-icons/react";
import { Button, TextInput } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { HANDOFF_URL_RE, normalizeTargetUrl, shortOf } from "./handoffTargetUi.ts";

export function HandoffSourceAddresses({ onSaved }: { onSaved: (targets: HandoffTarget[]) => void }) {
  const card = useRef<HTMLDivElement>(null);
  const [sources, setSources] = useState<HandoffSourceAddress[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setLoading(true);
    setError("");
    api.handoffSourceAddresses().then(setSources)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "来源机器地址读取失败"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (window.location.hash === "#handoff-source-addresses") card.current?.scrollIntoView({ block: "start" });
  }, []);
  return (
    <div className="settings-card" id="handoff-source-addresses" ref={card}>
      <div className="settings-row">
        <div>
          <b>来源机器地址</b>
          <small>
            来源机的 IP 或端口变了，在这里填写它现在的 ash 完整地址。核对原有指纹后保存，再回到任务重新检查。
            <br />保存会同步更新接力目标机地址；多人模式下只对你生效。
          </small>
        </div>
      </div>
      {loading ? <p className="handoff-peer-empty">读取中…</p> : error ? (
        <div className="settings-row">
          <span role="alert">{error}</span><Button variant="ghost" onClick={load}>重新读取</Button>
        </div>
      ) : sources.length === 0 ? (
        <p className="handoff-peer-empty">还没有记录来源机器。收到接力任务或接力申请后会自动列在这里。</p>
      ) : sources.map((source) => (
        <SourceAddressRow key={source.fingerprint} source={source} onSaved={(url, targets) => {
          setSources((current) => current.map((item) => item.fingerprint === source.fingerprint ? { ...item, url } : item));
          onSaved(targets);
        }} />
      ))}
    </div>
  );
}

function SourceAddressRow({ source, onSaved }: {
  source: HandoffSourceAddress;
  onSaved: (url: string, targets: HandoffTarget[]) => void;
}) {
  const [draft, setDraft] = useState(source.url);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const url = normalizeTargetUrl(draft);
  const inputId = `handoff-source-${source.fingerprint}`;
  const save = async () => {
    if (busy || !HANDOFF_URL_RE.test(url)) return;
    setBusy(true);
    setMessage("");
    setFailed(false);
    try {
      const targets = await api.updateHandoffSourceAddress(source.fingerprint, url);
      setDraft(url);
      onSaved(url, targets);
      setMessage("地址已保存，来源机指纹一致。回到任务点击“重新检查”即可。");
    } catch (reason) {
      setFailed(true);
      setMessage(reason instanceof Error ? reason.message : "来源机器地址保存失败");
    } finally { setBusy(false); }
  };
  return (
    <form className="settings-row handoff-source-row" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="handoff-source-label">
        <label htmlFor={inputId}>{source.name}</label>
        <small>指纹 {shortOf(source.fingerprint)}</small>
      </div>
      <TextInput
        id={inputId}
        aria-label={`${source.name}的 ash 地址`}
        placeholder="http://192.168.1.50:4317"
        value={draft}
        disabled={busy}
        onChange={(event) => { setDraft(event.target.value); setMessage(""); }}
      />
      <Button type="submit" variant="ghost" disabled={busy || !HANDOFF_URL_RE.test(url)}>
        {busy && <SpinnerGap size={13} className="is-spinning" aria-hidden="true" />}
        {busy ? "正在核对…" : "核对并保存"}
      </Button>
      {message && <p className={`handoff-source-feedback${failed ? " is-error" : ""}`} role={failed ? "alert" : "status"}>{message}</p>}
    </form>
  );
}
