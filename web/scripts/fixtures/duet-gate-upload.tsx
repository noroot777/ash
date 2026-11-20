import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { GateAction } from "@navi/shared";
import { DuetGateControls } from "../../src/duet/DuetControls.tsx";
import "../../src/styles/global.css";

function Navi() {
  const [gated, setGated] = useState<string[]>([]);
  return (
    <div style={{ padding: 16 }}>
      <DuetGateControls
        task={{ archived: false }}
        gate={{ gate: "G1", open: true, consensus: true, consensusBy: "both" }}
        round={2}
        maxRounds={4}
        busy={false}
        linkedTasks={[]}
        onGate={async (action: GateAction) => { setGated((current) => [...current, action.kind]); }}
        onOpenHandoff={() => {}}
        onOpenTask={() => {}}
      />
      <ul data-testid="gated">{gated.map((kind, index) => <li key={index}>{`门禁：${kind}`}</li>)}</ul>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Navi />
  </StrictMode>,
);
