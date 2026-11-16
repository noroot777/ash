// 尾注上挂着动作的那几句，后面又落了几句别的话以后，动作还在不在（四种情形见 footnote-actions-cases）。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { footnoteActionCases } from "./footnote-actions-cases.ts";
import "../../src/styles/global.css";

const log = window as unknown as { __ran: string[] };
log.__ran = [];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ background: "var(--bg)", padding: 16 }}>
      {footnoteActionCases(log.__ran).map((entry) => (
        <section key={entry.id} className={`${entry.id}-fixture`} style={{ marginBottom: 24 }}>
          <ConversationFeed task={entry.task} items={entry.items} sessions={entry.sessions} questionHistory={[]} loading={false} error={null}
            reviews={entry.reviews} reviewRetry={entry.reviewRetry} turnRetry={entry.turnRetry} onOpenReviewPanel={() => {}} />
        </section>
      ))}
    </div>
  </StrictMode>,
);
