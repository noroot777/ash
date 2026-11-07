const TEXT_FIELDS = new Set([
  "text", "content", "message", "output", "aggregated_output", "stdout", "stderr",
  "error", "thinking", "reasoning", "delta", "prompt", "description", "command",
]);
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
type Frame = { object: boolean; key: string; expectKey: boolean; text: boolean };

export class SearchLogText {
  private mode: "start" | "json" | "plain" | "skip" = "start";
  private stack: Frame[] = [];
  private quoted = false;
  private asKey = false;
  private capture = false;
  private key = "";
  private escaped = false;
  private unicode: string | null = null;

  constructor(private readonly emit: (text: string) => void) {}

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
        if (/\s/.test(character)) { index += 1; continue; }
        this.mode = character === "{" || character === "[" ? "json" : "plain";
      }
      if (this.mode === "plain" || this.mode === "skip") {
        const end = chunk.indexOf("\n", index);
        const next = end < 0 ? chunk.length : end + 1;
        if (this.mode === "plain") output.push(chunk.slice(index, next));
        index = next;
        if (end >= 0) this.mode = "start";
        continue;
      }
      if (this.quoted) {
        if (this.unicode !== null) {
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
          const special = /["\\]/g;
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
        this.capture = !this.asKey && !!frame && (frame.object ? TEXT_FIELDS.has(frame.key) : frame.text);
        this.key = "";
        if (this.capture) output.push("\n");
      } else if (character === "{" || character === "[") {
        if (this.stack.length >= 64) { this.stack = []; this.mode = "skip"; }
        else this.stack.push({ object: character === "{", key: "", expectKey: true, text: !!frame && (frame.object ? TEXT_FIELDS.has(frame.key) : frame.text) });
      } else if (character === "}" || character === "]") this.stack.pop();
      else if (character === ":" && frame) frame.expectKey = false;
      else if (character === "," && frame) { frame.expectKey = true; frame.key = ""; }
      else if (character === "\n") { this.stack = []; this.mode = "start"; }
      index += 1;
    }
    if (output.length) this.emit(output.join(""));
  }
}
