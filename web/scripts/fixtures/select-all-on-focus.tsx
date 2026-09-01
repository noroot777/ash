import { useState } from "react";
import { createRoot } from "react-dom/client";
import { selectAllOnFocus } from "../../src/lib/selectAllOnFocus.ts";

// 两个用了「聚焦即全选」的框：一个数字框（派审的复审轮数、接力载荷上限那一类），
// 一个文本框（用来验证已经聚焦之后鼠标行为要放行）。
function Field({ id, type, initial }: { id: string; type: string; initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <input
      data-testid={id}
      type={type}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      {...selectAllOnFocus}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <main style={{ display: "flex", flexDirection: "column", gap: 16, width: 320, margin: "80px auto" }}>
    <Field id="number" type="number" initial="12" />
    <Field id="text" type="text" initial="abcdefgh" />
    <button type="button" data-testid="elsewhere">别处</button>
  </main>,
);
