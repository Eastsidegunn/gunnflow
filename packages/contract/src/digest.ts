/** Digest rule: sha256 hex of the exact UTF-8 bytes (no BOM, no newline conversion). */
export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Digest of a body as the contract defines it for `Intent.edit.body`. */
export function digestOfBody(body: string): Promise<string> {
  return sha256Hex(utf8Bytes(body));
}
