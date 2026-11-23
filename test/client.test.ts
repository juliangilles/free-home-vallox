import { test } from "node:test";
import assert from "node:assert/strict";
import { ValloxClient } from "../src/vallox/client";

test("activateHome writes state, clears timers and sets home speed in one request", async () => {
  const c = new ValloxClient({ host: "127.0.0.1" });
  const written: Array<Array<{ address: number; value: number }>> = [];
  (c as any).writeValues = async (items: any) => void written.push(items);
  await c.activateHome(52);
  await c.activateHome(0);
  assert.deepEqual(written[0].map((i) => `${i.address}=${i.value}`), ["4609=0", "4612=0", "4613=0", "4614=0", "20507=52"]);
  assert.deepEqual(written[1].map((i) => `${i.address}=${i.value}`), ["4609=0", "4612=0", "4613=0", "4614=0"]);
});
