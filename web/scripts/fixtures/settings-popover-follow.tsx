// 执行器表行尾的「更多」菜单和它打开的参数浮层：设置内容滚动、窗口缩放后要跟着按钮走。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ProfileRowMenu } from "../../src/settings/ProfileRowMenu.tsx";
import "../../src/styles/global.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div data-scroller style={{ height: 500, overflow: "auto", margin: 24, border: "1px solid #ccc" }}>
      <div style={{ height: 200 }} />
      <div style={{ display: "flex", justifyContent: "flex-end", width: 420 }}>
        <ProfileRowMenu profileName="codex" extraArgs={["--foo"]} isDefault={false} busy={false}
          onSaveArgs={async () => true} onMakeDefault={() => {}} onDelete={() => {}} />
      </div>
      <div style={{ height: 1500 }} />
    </div>
  </StrictMode>,
);
