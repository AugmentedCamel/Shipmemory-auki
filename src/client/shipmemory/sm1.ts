import pako from 'pako';

const SM1_PREFIX = 'SM1:';
const BASE45_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function base45Decode(input: string): Uint8Array {
  const output: number[] = [];
  for (let i = 0; i < input.length; i += 3) {
    const remaining = input.length - i;
    if (remaining >= 3) {
      const a = BASE45_CHARSET.indexOf(input[i]);
      const b = BASE45_CHARSET.indexOf(input[i + 1]);
      const c = BASE45_CHARSET.indexOf(input[i + 2]);
      if (a < 0 || b < 0 || c < 0) throw new Error(`Invalid Base45 char at ${i}`);
      const n = a + b * 45 + c * 45 * 45;
      output.push((n >> 8) & 0xff, n & 0xff);
    } else {
      // Final 2-char group → 1 byte
      const a = BASE45_CHARSET.indexOf(input[i]);
      const b = BASE45_CHARSET.indexOf(input[i + 1]);
      if (a < 0 || b < 0) throw new Error(`Invalid Base45 char at ${i}`);
      output.push(a + b * 45);
    }
  }
  return new Uint8Array(output);
}

/**
 * Decode an SM1-encoded string: strip prefix → Base45 decode → zlib inflate.
 * If the input doesn't start with "SM1:", returns it as-is (plain text QR).
 */
export function decodeSM1(raw: string): string {
  if (!raw.startsWith(SM1_PREFIX)) return raw;
  const base45Payload = raw.slice(SM1_PREFIX.length);
  const compressed = base45Decode(base45Payload);
  const inflated = pako.inflate(compressed);
  return new TextDecoder().decode(inflated);
}
