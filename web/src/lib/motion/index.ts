// 动效库（anime.js）只在这一处引入：组件拿到的是这几个钩子和组件，不直接碰库
// （docs/ui-ux-audit 08「点睛」：重排、依次展开、数字）。每一段不超过 400ms，不循环，
// 只动 transform 和 opacity；减少动效时一律直接到终态。
export { useLayoutMotion } from "./useLayoutMotion.ts";
export { useStagger } from "./useStagger.ts";
export { RollingNumber } from "./RollingNumber.tsx";
export { DrawnCheck } from "./DrawnCheck.tsx";
