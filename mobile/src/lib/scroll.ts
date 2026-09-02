// 会话流的「粘底」。轮询把新内容塞进来时自动跟到底，但正在往回翻历史的人不该被抢走
// 阅读位置。
//
// 原来只挂了 onScroll + onContentSizeChange，漏掉两件在手机上天天发生的事：
//
// 1. **容器高度变了，内容尺寸没变** —— 键盘弹出（KeyboardAvoidingView 顶起来）、待发
//    送托盘多一行、输入框敲成三行，可视区都会缩短。ScrollView 缩短时 contentOffset
//    原样不动，于是底部内容被推出视野：用户看到的是「刚发完消息，最后几条不见了」。
//    contentSize 没变，onContentSizeChange 一声不吭，只有 onLayout 知道。
// 2. **程序性滚动自己把粘底关掉** —— scrollToEnd 动画途中 onScroll 照常上报，起手那
//    几帧距底几百 px，阈值判断当场把 stick 置 false。此后再来新内容就不跟了，表现正
//    是「粘底时灵时不灵」。所以程序性滚动期间的滚动事件一律不参与判定。
import { useCallback, useRef, type RefObject } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollView, LayoutChangeEvent } from "react-native";

// 距底多近算「还粘着」。一行气泡的高度量级，手指轻轻带一下不会脱粘。
const STICK_THRESHOLD = 80;
// 程序性滚动的静默窗口，够 iOS 的滚动动画跑完。
const PROGRAMMATIC_MS = 400;

export type StickyBottom = ReturnType<typeof useStickyBottom>;

export function useStickyBottom(ref: RefObject<ScrollView | null>) {
  const stick = useRef(true);
  const viewport = useRef(0);
  const quietUntil = useRef(0);
  // 首屏那一次直接落底，别当着用户面把整段历史滚一遍。
  const settled = useRef(false);

  const scrollToEnd = useCallback((animated: boolean) => {
    quietUntil.current = Date.now() + PROGRAMMATIC_MS;
    ref.current?.scrollToEnd({ animated });
  }, [ref]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (Date.now() < quietUntil.current) return;
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - (layoutMeasurement.height + contentOffset.y);
    stick.current = distanceFromBottom < STICK_THRESHOLD;
  }, []);

  const onContentSizeChange = useCallback(() => {
    if (!stick.current) return;
    const animated = settled.current;
    settled.current = true;
    scrollToEnd(animated);
  }, [scrollToEnd]);

  // 可视区高度变化（键盘、输入区叠高、旋转）后重新贴底。等一帧再滚：这一帧原生刚量完
  // 自己的新尺寸，JS 侧的内容可能还在同一批更新里，晚一帧两边都是最终值。
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    if (height === viewport.current) return;
    const grew = height > viewport.current;
    viewport.current = height;
    if (!stick.current) return;
    // 变矮（键盘弹出）时不做动画：内容本来就在眼前，动一下反而像被抽走了。
    requestAnimationFrame(() => scrollToEnd(grew && settled.current));
  }, [scrollToEnd]);

  /** 「接下来这次内容更新我要看到」—— 发送、重跑之类由用户自己触发的动作前调一下。 */
  const stickNow = useCallback(() => {
    stick.current = true;
  }, []);

  /**
   * 把某一块拉进视野，按**底边**对齐 —— 需要露出来的东西（问题卡的输入框和发送键）都
   * 在自己那一块的下缘。滚过去就等于脱离底部，粘底跟着关掉，免得下一轮轮询把人拽走。
   */
  const revealRegion = useCallback((y: number, height: number) => {
    if (viewport.current <= 0) return;
    stick.current = false;
    quietUntil.current = Date.now() + PROGRAMMATIC_MS;
    const target = Math.max(0, y + height + 12 - viewport.current);
    // 块比可视区还高时按顶边对齐，否则会把开头（问题正文）滚出屏幕外。
    ref.current?.scrollTo({ y: height + 12 > viewport.current ? Math.max(0, y - 12) : target, animated: true });
  }, [ref]);

  return { onScroll, onContentSizeChange, onLayout, stickNow, scrollToEnd, revealRegion };
}
