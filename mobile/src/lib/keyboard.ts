// 键盘相关的两件事：KeyboardAvoidingView 该给多大偏移，和「键盘现在开着吗」。
import { useContext, useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";
import { HeaderHeightContext } from "@react-navigation/elements";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * KeyboardAvoidingView 的 keyboardVerticalOffset —— 要的是**窗口顶到 KAV 顶**的距离。
 *
 * RN 的 KAV 用 `frame.y + frame.height - (keyboardScreenY - offset)` 算该补多少
 * padding：`frame` 是 onLayout 量出来的、**相对父容器**的矩形（native-stack 把屏幕
 * 内容摆在 header 下面，所以 frame.y≈0），而 `keyboardScreenY` 是**屏幕坐标**。两个
 * 坐标系差的那一段正好是「状态栏 + 导航头」，offset 就得补这一段。
 *
 * 之前这里写死 88（默许状态栏 44 + 导航头 44），只有一类机型对得上：
 *   · iPhone 14/15/16 Pro 状态栏 59 → 少补 15pt，输入框底下被键盘啃掉一截；
 *   · iPhone SE 状态栏 20 → 多补 24pt，输入框和键盘之间凭空浮起一条空带。
 * native-stack 把算好的真值放在 HeaderHeightContext 里（已含状态栏），读它即可。
 */
export function useKeyboardOffset(): number {
  // useHeaderHeight() 在没有 header 的地方直接 throw；这里读 context 自己兜底 ——
  // Expo web 导出走的 NativeStackView 不铺这个 Provider，桌面预览不该白屏。
  const headerHeight = useContext(HeaderHeightContext);
  const insets = useSafeAreaInsets();
  if (Platform.OS !== "ios") return 0;
  return headerHeight ?? insets.top + 44;
}

/**
 * 键盘是否正展开。用来收掉输入条的手势条留白 —— 键盘顶上去之后 insets.bottom 那
 * 34pt 已经被键盘盖住，再留着就是输入框和键盘之间一条谁也用不上的空隙。
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    // iOS 的 will* 与动画同步（跟着键盘一起动，不会先跳一下）；Android 只有 did*。
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const shown = Keyboard.addListener(showEvent, () => setVisible(true));
    const hidden = Keyboard.addListener(hideEvent, () => setVisible(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return visible;
}
