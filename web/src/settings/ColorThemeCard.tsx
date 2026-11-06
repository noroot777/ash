import { ColorThemeChoice } from "../components/ColorThemeChoice.tsx";

// 设置页里的「外观」一块。个人面(PERSONAL_SETTING_KEYS):同一台机器上两个人各看各的。
// 项目下拉里还有一颗同样的开关(ProjectSwitcher.tsx),两处是同一份偏好。
export function ColorThemeCard({ notify }: { notify: (message: string) => void }) {
  return (
    // data-settings-anchor：文案里的「设置 → 默认规则 → 外观」照着它落点（见 sections.ts）。
    <section className="settings-section" data-settings-anchor="appearance">
      <h2>外观</h2>
      <div className="settings-card">
        <div className="settings-row">
          <div>
            <b>深浅色</b>
            <small>跟随系统时，系统切换深浅色页面跟着切换。</small>
          </div>
          <ColorThemeChoice notify={notify} />
        </div>
      </div>
    </section>
  );
}
