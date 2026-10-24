import * as pty from "node-pty";

let terminal: pty.IPty | undefined;
const send = (message: object, callback?: () => void) => {
  if (process.connected) process.send?.(message, () => callback?.());
  else callback?.();
};

process.on("message", (message: {
  type: string;
  file: string;
  args: string[];
  options: pty.IPtyForkOptions;
  data: string;
  cols: number;
  rows: number;
}) => {
  try {
    if (message.type === "start" && !terminal) {
      terminal = pty.spawn(message.file, message.args, message.options);
      terminal.onData((data) => send({ type: "data", data }));
      terminal.onExit(({ exitCode, signal }) => send({ type: "exit", exitCode, signal }, () => process.exit(0)));
      send({ type: "ready", pid: terminal.pid });
    } else if (message.type === "write") terminal?.write(message.data);
    else if (message.type === "resize") terminal?.resize(message.cols, message.rows);
    else if (message.type === "kill") terminal?.kill();
  } catch (error) {
    send({ type: "error", error: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
  }
});

process.once("disconnect", () => {
  terminal?.kill();
  process.exit(0);
});
