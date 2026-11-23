import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { ValloxBridge } from "../src/bridge";
import { DEFAULT_CONFIG } from "../src/config";
import type { ValloxState } from "../src/vallox/client";

/** Minimal stand-in for a free@home channel: records datapoint writes. */
class FakeChannel extends EventEmitter {
  writes: string[] = [];
  constructor(readonly id: string) {
    super();
  }
  private rec(what: string) {
    this.writes.push(what);
    return Promise.resolve();
  }
  setTemperature(v: string) { return this.rec(`temp=${v}`); }
  setHumidity(v: string) { return this.rec(`rh=${v}`); }
  setOn(v: boolean) { void this.rec(`on=${v}`); }
  setOnOff(v: boolean) { void this.rec(`onoff=${v}`); }
  setAbsoluteFanSpeed(v: string) { void this.rec(`speed=${v}`); }
  setDeviceName(v: string) { return this.rec(`name=${v}`); }
  triggerKeepAlive() { return Promise.resolve(); }
  setUnresponsive() { return Promise.resolve(); }
}

function fakeFreeAtHome(humidityCreation: Promise<void>) {
  const channels = new Map<string, FakeChannel>();
  const make = async (id: string) => {
    const ch = new FakeChannel(id);
    channels.set(id, ch);
    return ch;
  };
  const fah = {
    createAirQualityTemperatureDevice: make,
    createSwitchingActuatorDevice: make,
    createCeilingFan: make,
    createBinarySensor: make,
    createAirQualityHumidityDevice: async (id: string) => {
      await humidityCreation; // slow device creation on the SysAP
      return make(id);
    },
    postNotification: async () => ({}),
  };
  return { fah, channels };
}

const state: ValloxState = {
  fanSpeed: 52, tempSupply: 20, tempExtract: 21.7, tempOutdoor: 7.5, tempExhaust: 13.2, humidity: 38,
  away: false, unitOff: false, boostTimer: 0, fireplaceTimer: 0, extraTimer: 0,
  filterDays: 39, limpMode: false, activeFaults: [], fault: false, profile: "home",
};

test("publishing while the humidity device is still being created does not spin", async () => {
  let release!: () => void;
  const creation = new Promise<void>((r) => (release = r));
  const { fah, channels } = fakeFreeAtHome(creation);
  const bridge = new ValloxBridge(fah as any, { ...DEFAULT_CONFIG, host: "" }, () => undefined);
  await bridge.start();

  // Two polls arrive while the humidity device is pending (the case that used to hang).
  (bridge as any).lastState = state;
  (bridge as any).publishState(state);
  (bridge as any).publishState({ ...state, tempSupply: 19.7 });

  // If publishState recursed via the microtask queue, this timer would never fire.
  const timerFired = await Promise.race([
    new Promise<boolean>((r) => setTimeout(() => r(true), 50)),
    new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
  ]);
  assert.equal(timerFired, true);

  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(channels.get("vallox-humidity")?.writes, ["rh=38"]);
  assert.deepEqual(channels.get("vallox-temp-supply")?.writes, ["temp=20.0", "temp=19.7"]);
  await bridge.stop();
});

test("fan speed command writes the speed setting of the active profile", async () => {
  const { fah, channels } = fakeFreeAtHome(Promise.resolve());
  const bridge = new ValloxBridge(fah as any, { ...DEFAULT_CONFIG, host: "" }, () => undefined);
  await bridge.start();
  const calls: string[] = [];
  (bridge as any).client = {
    setProfileFanSpeed: async (p: string, v: number) => void calls.push(`${p}=${v}`),
  };
  (bridge as any).schedulePoll = () => undefined;
  const fan = channels.get("vallox-fan")!;

  (bridge as any).lastState = state; // profile home, measured 52 %
  (bridge as any).publishState(state);
  await (bridge as any).setFanSpeed(65);
  assert.deepEqual(calls, ["home=65"]);
  assert.equal(fan.writes.at(-1), "speed=65");

  // measured speed still 52 a moment later: keep showing the requested 65
  (bridge as any).publishState(state);
  assert.equal(fan.writes.at(-1), "speed=65");
  // fans caught up
  (bridge as any).publishState({ ...state, fanSpeed: 65 });
  assert.equal((bridge as any).fanSpeedHold, undefined);

  (bridge as any).lastState = { ...state, profile: "away" };
  await (bridge as any).setFanSpeed(150);
  assert.deepEqual(calls, ["home=65", "away=100"]);

  // fireplace: not settable, display falls back to the measured value
  (bridge as any).lastState = { ...state, profile: "fireplace", fireplaceTimer: 10 };
  await (bridge as any).setFanSpeed(30);
  assert.deepEqual(calls, ["home=65", "away=100"]);
  assert.equal(fan.writes.at(-1), "speed=52");
  await bridge.stop();
});

test("Zuhause actuator activates Home with the configured fan speed; off only re-asserts", async () => {
  const { fah, channels } = fakeFreeAtHome(Promise.resolve());
  const bridge = new ValloxBridge(fah as any, { ...DEFAULT_CONFIG, host: "", homeFanSpeed: 52 }, () => undefined);
  await bridge.start();
  const calls: string[] = [];
  (bridge as any).client = { activateHome: async (v: number) => void calls.push(`home=${v}`) };
  (bridge as any).schedulePoll = () => undefined;
  const home = channels.get("vallox-home")!;

  const boosting = { ...state, profile: "boost" as const, boostTimer: 20 };
  (bridge as any).lastState = boosting;
  (bridge as any).publishState(boosting);
  assert.equal(home.writes.at(-1), "on=false");

  home.emit("isOnChanged", true);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ["home=52"]);
  assert.equal(home.writes.at(-1), "on=true");

  home.emit("isOnChanged", false); // no own action, real state (home) shown again
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ["home=52"]);
  await bridge.stop();
});
