const METADATA_FIELDS = new Set([
  "type", "kind", "role", "t", "at", "agent", "timestamp", "created_at", "updated_at",
  "id", "uuid", "session_id", "tool_use_id", "parent_tool_use_id", "turn_id", "call_id",
]);
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
type Frame = { object: boolean; key: string; expectKey: boolean; visible: boolean };

export class SearchLogText {
  private mode: "start" | "json" | "plain" | "skip" = "start";
  private stack: Frame[] = [];
  private quoted = false;
  private asKey = false;
  private capture = false;
  private key = "";
  private escaped = false;
  private unicode: string | null = null;
  private record = false;

  constructor(private readonly emit: (text: string) => void, private readonly format: "jsonl" | "transcript" = "jsonl") {}

  private reset(): void {
    this.mode = "start";
    this.stack = [];
    this.quoted = false;
    this.escaped = false;
    this.unicode = null;
    this.record = false;
  }

  append(chunk: string): void {
    const output: string[] = [];
    const accept = (text: string) => {
      if (this.asKey) this.key = (this.key + text).slice(0, 64);
      else if (this.capture) output.push(text);
    };
    let index = 0;
    while (index < chunk.length) {
      const character = chunk[index]!;
      if (this.mode === "start") {
        if (character === "\x1e") { this.record = true; index += 1; continue; }
        if (this.format === "transcript" && !this.record) this.mode = "plain";
        else {
          if (/\s/.test(character)) { index += 1; continue; }
          this.mode = character === "{" || character === "[" ? "json" : "plain";
        }
      }
      if (this.mode === "plain" || this.mode === "skip") {
        const newline = chunk.indexOf("\n", index);
        const sentinel = this.format === "transcript" ? chunk.indexOf("\x1e", index) : -1;
        const end = Math.min(newline < 0 ? chunk.length : newline, sentinel < 0 ? chunk.length : sentinel);
        const next = end < chunk.length && end === newline ? end + 1 : end;
        if (this.mode === "plain") output.push(chunk.slice(index, next));
        index = next;
        if (end < chunk.length) this.reset();
        continue;
      }
      if (this.quoted) {
        if (character === "\n") { this.reset(); output.push("\n"); }
        else if (this.unicode !== null) {
          this.unicode += character;
          if (this.unicode.length === 4) {
            if (/^[\da-f]{4}$/i.test(this.unicode)) accept(String.fromCharCode(parseInt(this.unicode, 16)));
            this.unicode = null;
          }
        } else if (this.escaped) {
          this.escaped = false;
          if (character === "u") this.unicode = "";
          else accept(ESCAPES[character] ?? character);
        } else if (character === "\\") this.escaped = true;
        else if (character === '"') {
          this.quoted = false;
          if (this.asKey) this.stack.at(-1)!.key = this.key;
          else if (this.capture) output.push("\n");
        } else {
          const special = /["\\\n]/g;
          special.lastIndex = index;
          const end = special.exec(chunk)?.index ?? chunk.length;
          accept(chunk.slice(index, end));
          index = end;
          continue;
        }
        index += 1;
        continue;
      }
      const frame = this.stack.at(-1);
      if (character === '"') {
        this.quoted = true;
        this.asKey = !!frame?.object && frame.expectKey;
        this.capture = !this.asKey && !!frame && (this.record
          ? this.stack.length === 1 && frame.key === "text"
          : frame.visible && (!frame.object || !METADATA_FIELDS.has(frame.key)));
        this.key = "";
        if (this.capture) output.push("\n");
      } else if (character === "{" || character === "[") {
        if (this.stack.length >= 64) { this.stack = []; this.mode = "skip"; }
        else this.stack.push({ object: character === "{", key: "", expectKey: true, visible: !frame || frame.visible && (!frame.object || !METADATA_FIELDS.has(frame.key)) });
      } else if (character === "}" || character === "]") this.stack.pop();
      else if (character === ":" && frame) frame.expectKey = false;
      else if (character === "," && frame) { frame.expectKey = true; frame.key = ""; }
      else if (character === "\n") { this.reset(); output.push("\n"); }
      index += 1;
    }
    if (output.length) this.emit(output.join(""));
  }
}
