// 「现在是不是多人模式」「宿主机 CLI 是不是被隔离」的**同步**镜像。
//
// 独立成一个零依赖模块,是因为读它的地方(executors/spawn.ts、skills.ts)在同步路径上,
// 而权威值在 app_settings 表里、只能异步读。auth/mode.ts 每次解析实例配置时把这两位
// 刷新,server 启动时也会主动预热一次(index.ts)。
//
// 判据只在**降级方向**上被使用:值为 false 时行为与本功能上线前完全一致。所以哪怕
// 极端情况下这两位落后一拍,后果也只是「某一次 spawn 少清了一遍出站凭证」,而不是
// 「把多人模式的隔离弄反」。真正的鉴权闸走的是异步权威值,不看这里。
let multiUser = false;
// 多人 **且** 没开「共用宿主机 CLI」。两位分开存而不是存一个 sharedHostCli:
// 读侧问的永远是「要不要隔离」,合成判据只写一次就不会有人在别处拼错。
let hostCliIsolated = false;

export const setMultiUserFlag = (value: boolean): void => {
  multiUser = value;
};

export const setHostCliIsolatedFlag = (value: boolean): void => {
  hostCliIsolated = value;
};

export const isMultiUserSync = (): boolean => multiUser;

/** 宿主机的 CLI 登录态对任务隐藏吗(= 每人一个配置目录、清出站凭证、派发闸生效)。 */
export const isHostCliIsolatedSync = (): boolean => hostCliIsolated;
