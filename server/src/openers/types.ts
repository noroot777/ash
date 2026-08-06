/** 一个「能打开这个文件」的本机应用。`id` 是打开时回传给服务端的标识。 */
export interface AppOpener {
  id: string;
  name: string;
  /** 次要信息：macOS 给 bundle id，Linux 给 .desktop 文件名。 */
  detail: string;
  /** 凭什么算它能开：扩展名 > 文件类型 > 它什么都收。 */
  match: "extension" | "type" | "generic";
  isDefault: boolean;
}

export interface OpenerProbe {
  platform: NodeJS.Platform;
  /** 这台机器上「在文件夹中显示」能不能做到。 */
  canReveal: boolean;
  apps: AppOpener[];
  /** 探测不出东西时给用户的一句人话，没有就是 null。 */
  note: string | null;
}
