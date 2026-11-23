/**
 * Binary frame format of the MyVallox local websocket API (ws://<ip>/),
 * ported from the Python library "vallox_websocket_api".
 *
 * Request frames are little-endian 16-bit words:
 *   [length][command][payload ...][checksum]
 * where length = number of words of command + payload (+1, see below) and
 * checksum = 16-bit sum of all preceding words.
 *
 * The READ_TABLES response is a flat array of big-endian 16-bit words that
 * holds all register ranges packed back to back (see dataModel.ts).
 */

export const WsCommand = {
  READ_DATA: 250,
  WRITE_DATA: 249,
  READ_TABLES: 246,
  LOG_RAW: 243,
} as const;

export function checksum16(words: number[]): number {
  let sum = 0;
  for (const w of words) sum = (sum + (w & 0xffff)) & 0xffff;
  return sum;
}

function encodeWordsLE(words: number[]): Buffer {
  const withChecksum = [...words, checksum16(words)];
  const buf = Buffer.alloc(withChecksum.length * 2);
  withChecksum.forEach((w, i) => buf.writeUInt16LE(w & 0xffff, i * 2));
  return buf;
}

/** Request for the full register table: [3, 246, 0, checksum]. */
export function buildReadTablesRequest(): Buffer {
  return encodeWordsLE([3, WsCommand.READ_TABLES, 0]);
}

export interface WriteItem {
  address: number;
  value: number;
}

/** Write request: [len, 249, addr1, val1, addr2, val2, ..., checksum]; len = items*2 + 2. */
export function buildWriteRequest(items: WriteItem[]): Buffer {
  if (items.length === 0) throw new Error("No items to write");
  const sorted = [...items].sort((a, b) => a.address - b.address);
  const words: number[] = [sorted.length * 2 + 2, WsCommand.WRITE_DATA];
  for (const { address, value } of sorted) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new Error(`Invalid value ${value} for register ${address}`);
    }
    words.push(address, value);
  }
  return encodeWordsLE(words);
}

/** Parse READ_TABLES response into an array of unsigned 16-bit words (big-endian). */
export function parseReadTablesResponse(data: Buffer): Uint16Array {
  const count = Math.floor(data.length / 2);
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) out[i] = data.readUInt16BE(i * 2);
  return out;
}
