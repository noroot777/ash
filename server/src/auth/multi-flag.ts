// 「现在是不是多人模式」的**同步**镜像。
//
// 独立成一个零依赖模块,是因为读它的地方(executors/spawn.ts)在同步路径上,而权威值
// 在 app_settings 表里、只能异步读。auth/mode.ts 每次解析实例配置时把这一位刷新,
// server 启动时也会主动预热一次(index.ts)。
//
// 判据只在**降级方向**上被使用:值为 false 时行为与本功能上线前完全一致。所以哪怕
// 极端情况下这一位落后一拍,后果也只是「某一次 spawn 少清了一遍出站凭证」,而不是
// 「把多人模式的隔离弄反」。真正的鉴权闸走的是异步权威值,不看这里。
let multiUser = false;

export const setMultiUserFlag = (value: boolean): void => {
  multiUser = value;
};

export const isMultiUserSync = (): boolean => multiUser;
