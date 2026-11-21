export function* terminalInputChunks(data: string): Generator<string> {
  let offset = 0;
  while (offset < data.length) {
    let end = Math.min(offset + 16_384, data.length);
    const code = data.charCodeAt(end - 1);
    if (end < data.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
    yield data.slice(offset, end);
    offset = end;
  }
}
