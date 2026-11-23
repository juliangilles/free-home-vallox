import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReadTablesRequest, buildWriteRequest, parseReadTablesResponse } from "../src/vallox/protocol";
import { BUILTIN_MODEL, DataModel, parseModelFromJs } from "../src/vallox/dataModel";
import { ValloxClient } from "../src/vallox/client";
import { Reg } from "../src/vallox/registers";

test("read tables request matches python construct output", () => {
  // length=3, cmd=246, items=0, checksum=249 (little-endian words)
  assert.deepEqual([...buildReadTablesRequest()], [3, 0, 246, 0, 0, 0, 249, 0]);
});

test("write request encodes sorted items and checksum", () => {
  const buf = buildWriteRequest([
    { address: 4613, value: 0 },
    { address: 4612, value: 30 },
  ]);
  const words = [];
  for (let i = 0; i < buf.length; i += 2) words.push(buf.readUInt16LE(i));
  const body = [6, 249, 4612, 30, 4613, 0];
  const sum = body.reduce((a, b) => (a + b) & 0xffff, 0);
  assert.deepEqual(words, [...body, sum]);
});

test("write request rejects out-of-range values", () => {
  assert.throws(() => buildWriteRequest([{ address: 4612, value: 70000 }]));
  assert.throws(() => buildWriteRequest([]));
});

test("built-in model maps known addresses to buffer offsets", () => {
  const m = new DataModel(BUILTIN_MODEL, "builtin");
  assert.equal(m.offsetOf(0), 0);
  assert.equal(m.offsetOf(256), 36);
  assert.equal(m.offsetOf(4353), 36 + 27 + 1); // FAN_SPEED
  assert.equal(m.offsetOf(4609), 36 + 27 + 43 + 1); // STATE
  assert.equal(m.offsetOf(36864), 297); // fault range start (fw v2, after self test)
  assert.equal(m.offsetOf(9999), undefined);
  assert.equal(m.totalSize, 690);
});

test("model parser resolves numbers, hex and references", () => {
  const js = `VlxReadConstants.CYC_NUM_OF_X=5,VlxDevConstants.RANGE_START_g_a = 0x10;VlxDevConstants.ALIAS = VlxReadConstants.CYC_NUM_OF_X,Foo.BAR=1;`;
  const m = parseModelFromJs(js);
  assert.equal(m.read.CYC_NUM_OF_X, 5);
  assert.equal(m.dev.RANGE_START_g_a, 16);
  assert.equal(m.dev.ALIAS, 5);
});

test("state decoding converts temperatures and profile", () => {
  const client = new ValloxClient({ host: "127.0.0.1" });
  const model = new DataModel(BUILTIN_MODEL, "builtin");
  const words = new Uint16Array(model.totalSize);
  const set = (a: number, v: number) => (words[model.offsetOf(a)!] = v);
  set(Reg.TEMP_SUPPLY_AIR, 27315 + 2050); // 20.5 °C
  set(Reg.TEMP_OUTDOOR_AIR, 27315 - 330); // -3.3 °C
  set(Reg.FAN_SPEED, 40);
  set(Reg.RH_VALUE, 45);
  set(Reg.STATE, 1);
  set(Reg.FIREPLACE_TIMER, 12);
  set(Reg.REMAINING_TIME_FOR_FILTER, 88);
  set(Reg.TOTAL_FAULT_COUNT, 2);
  set(Reg.FAULT_TABLE_START, 9); // code: filter
  set(Reg.FAULT_TABLE_START + 5, 1); // active
  set(Reg.FAULT_TABLE_START + 6, 3); // second: cell frozen
  set(Reg.FAULT_TABLE_START + 6 + 5, 2); // solved

  // round-trip through the wire format (big-endian)
  const buf = Buffer.alloc(words.length * 2);
  words.forEach((w, i) => buf.writeUInt16BE(w, i * 2));
  const s = client.decodeState(parseReadTablesResponse(buf));

  assert.equal(s.tempSupply, 20.5);
  assert.equal(s.tempOutdoor, -3.3);
  assert.equal(s.tempExtract, undefined); // 0 = not available
  assert.equal(s.fanSpeed, 40);
  assert.equal(s.humidity, 45);
  assert.equal(s.away, true);
  assert.equal(s.profile, "fireplace");
  assert.equal(s.filterDays, 88);
  assert.equal(s.fault, true);
  assert.deepEqual(s.activeFaults.map((f) => f.code), [9]);
});
