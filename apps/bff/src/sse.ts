/**
 * SSE framing per the HTML standard: LF, CRLF or CR line ends; a blank line
 * ends an event; repeated `data:` lines join with LF; one optional space after
 * the colon is stripped; comment lines are ignored.
 */
export class SseDecoder {
  private buffer = '';
  private event = '';
  private data: string[] = [];

  push(chunk: string): Array<{ event: string; data: string }> {
    this.buffer += chunk;
    const out: Array<{ event: string; data: string }> = [];
    // A trailing CR may be the first half of CRLF; keep it for the next chunk.
    const holdCr = this.buffer.endsWith('\r');
    const text = holdCr ? this.buffer.slice(0, -1) : this.buffer;
    const lines = text.split(/\r\n|\r|\n/);
    this.buffer = (lines.pop() ?? '') + (holdCr ? '\r' : '');
    for (const line of lines) {
      if (line === '') {
        if (this.data.length > 0) out.push({ event: this.event || 'message', data: this.data.join('\n') });
        this.event = '';
        this.data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') this.event = value;
      else if (field === 'data') this.data.push(value);
    }
    return out;
  }
}
