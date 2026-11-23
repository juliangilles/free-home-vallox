import {
  AirHumidityChannel,
  AirTemperatureChannel,
  BinarySensorChannel,
  Channel,
  FreeAtHome,
  FreeAtHomeOnOffChannel,
} from "@busch-jaeger/free-at-home";
import type { CeilingFanChannel } from "@busch-jaeger/free-at-home/lib/virtualChannels/ceilingFanChannel";
import { ValloxConfig } from "./config";
import { ValloxClient, ValloxState } from "./vallox/client";

const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000; // device TTL on the SysAP is 30 min
const UNRESPONSIVE_AFTER_MS = 3 * 60 * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const POST_WRITE_POLL_MS = 1500;
const FAN_SPEED_HOLD_MS = 60 * 1000;
/** nativeId / display name prefix; only changed for testing (separate device set). */
const ID_PREFIX = process.env.VALLOX_ID_PREFIX || "vallox";
const NAME_PREFIX = process.env.VALLOX_NAME_PREFIX || "Vallox";

type Log = (msg: string) => void;

interface Devices {
  tempSupply: AirTemperatureChannel;
  tempExtract: AirTemperatureChannel;
  tempOutdoor: AirTemperatureChannel;
  tempExhaust: AirTemperatureChannel;
  fan: CeilingFanChannel;
  away: FreeAtHomeOnOffChannel;
  boost: FreeAtHomeOnOffChannel;
  fireplace: FreeAtHomeOnOffChannel;
  home: FreeAtHomeOnOffChannel;
  fault: BinarySensorChannel;
  filter: BinarySensorChannel;
  humidity?: AirHumidityChannel;
}

/**
 * Maps the Vallox unit onto free@home virtual devices and keeps them in sync.
 */
export class ValloxBridge {
  private client?: ValloxClient;
  private devices?: Devices;
  private published = new Map<string, string>();
  private pollTimer?: NodeJS.Timeout;
  private polling = false;
  private failures = 0;
  private lastSuccess = 0;
  private lastKeepAlive = 0;
  private unresponsive = false;
  private lastState?: ValloxState;
  private stopped = false;
  private notified = { fault: false, filter: false };
  private creatingHumidity = false;
  private fanSpeedHold?: { value: number; until: number };

  constructor(
    private readonly fah: FreeAtHome,
    private config: ValloxConfig,
    private readonly log: Log,
  ) {}

  async start(): Promise<void> {
    this.devices = await this.createDevices();
    this.applyConfig(this.config, true);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    await this.forEachDevice((c) => c.setUnresponsive());
  }

  applyConfig(config: ValloxConfig, force = false): void {
    const hostChanged = config.host !== this.config.host;
    this.config = config;
    if (!config.host) {
      this.log("No Vallox IP address configured – waiting for configuration");
      this.client = undefined;
      return;
    }
    if (force || hostChanged || !this.client) {
      this.log(`Using Vallox unit at ${config.host}, polling every ${config.pollIntervalSec}s`);
      this.client = new ValloxClient({ host: config.host, log: (m) => this.log(`[vallox] ${m}`) });
      this.published.clear();
    }
    this.schedulePoll(0);
  }

  /** Called when the connection to the SysAP was re-established. */
  async onSysApReconnected(): Promise<void> {
    this.log("SysAP connection re-established – refreshing devices");
    this.published.clear();
    this.lastKeepAlive = 0;
    this.schedulePoll(0);
  }

  // ---- device setup -------------------------------------------------------

  private async createDevices(): Promise<Devices> {
    const fah = this.fah;
    const temp = (id: string, name: string) => fah.createAirQualityTemperatureDevice(`${ID_PREFIX}-${id}`, name);
    const sw = (id: string, name: string) => fah.createSwitchingActuatorDevice(`${ID_PREFIX}-${id}`, name);

    const d: Devices = {
      tempSupply: await temp("temp-supply", `${NAME_PREFIX} Zuluft`),
      tempExtract: await temp("temp-extract", `${NAME_PREFIX} Abluft`),
      tempOutdoor: await temp("temp-outdoor", `${NAME_PREFIX} Außenluft`),
      tempExhaust: await temp("temp-exhaust", `${NAME_PREFIX} Fortluft`),
      fan: await fah.createCeilingFan(`${ID_PREFIX}-fan`, `${NAME_PREFIX} Lüfter`),
      away: await sw("away", `${NAME_PREFIX} Abwesend`),
      boost: await sw("boost", `${NAME_PREFIX} Stoßlüftung`),
      fireplace: await sw("fireplace", `${NAME_PREFIX} Kaminmodus`),
      home: await sw("home", `${NAME_PREFIX} Zuhause`),
      fault: await fah.createBinarySensor(`${ID_PREFIX}-fault`, `${NAME_PREFIX} Störung`),
      filter: await fah.createBinarySensor(`${ID_PREFIX}-filter`, `${NAME_PREFIX} Filterwechsel`),
    };

    d.away.on("isOnChanged", (on) =>
      this.command("away", d.away, on, (c) => c.setAway(on)));
    d.boost.on("isOnChanged", (on) =>
      this.command("boost", d.boost, on, (c) => (on ? c.startBoost(this.config.boostMinutes) : c.stopBoost())));
    d.fireplace.on("isOnChanged", (on) =>
      this.command("fireplace", d.fireplace, on, (c) =>
        on ? c.startFireplace(this.config.fireplaceMinutes) : c.stopFireplace()));
    // "Zuhause" starts the Home program (state Home, timed modes off, configured fan speed).
    // Switching it off has no action of its own (use Abwesend/Boost/Kamin); the real state is re-asserted.
    d.home.on("isOnChanged", (on) => {
      if (on) void this.command("home", d.home, on, (c) => c.activateHome(this.config.homeFanSpeed));
      else this.republishSwitch("home");
    });

    // On/off of the fan channel is display only (switching the unit off is not offered):
    // re-assert the real state.
    const reassertFan = (v: unknown) => {
      if (process.env.VALLOX_DEBUG) this.log(`fan input event ${String(v)}`);
      this.published.delete("fan.on");
      this.published.delete("fan.speed");
      if (this.lastState) this.publishState(this.lastState);
    };
    d.fan.on("isOnChanged", reassertFan);
    d.fan.on("relativeFanSpeedChanged", reassertFan);
    // Absolute speed sets the speed setting of the active profile (Home/Away/Boost).
    d.fan.on("absoluteFanSpeedChanged", (v) => void this.setFanSpeed(v));

    this.log("Virtual devices created");
    return d;
  }

  /**
   * Creates the humidity device in the background (only once a sensor delivers values).
   * Must not call publishState(): while creation is pending this would recurse
   * endlessly through the microtask queue and block the event loop. If creation
   * fails, the next poll simply tries again.
   */
  private async ensureHumidityDevice(): Promise<void> {
    if (!this.devices || this.devices.humidity || this.creatingHumidity) return;
    this.creatingHumidity = true;
    try {
      const ch = await this.fah.createAirQualityHumidityDevice(`${ID_PREFIX}-humidity`, `${NAME_PREFIX} Luftfeuchte`);
      this.devices.humidity = ch;
      const h = this.lastState?.humidity;
      if (h !== undefined) this.set("humidity", String(h), () => ch.setHumidity(String(h)));
    } catch (e) {
      this.log(`Could not create humidity device: ${(e as Error).message}`);
    } finally {
      this.creatingHumidity = false;
    }
  }

  // ---- commands -------------------------------------------------------------

  private async command(
    name: string,
    channel: FreeAtHomeOnOffChannel,
    on: boolean,
    action: (c: ValloxClient) => Promise<void>,
  ): Promise<void> {
    const client = this.client;
    this.log(`Command ${name} -> ${on ? "on" : "off"}`);
    if (!client) {
      this.republishSwitch(name);
      return;
    }
    try {
      await action(client);
      this.set(`${name}.on`, on ? "1" : "0", () => channel.setOn(on)); // optimistic feedback
    } catch (e) {
      this.log(`Command ${name} failed: ${(e as Error).message}`);
      this.republishSwitch(name);
    }
    this.schedulePoll(POST_WRITE_POLL_MS);
  }

  private async setFanSpeed(raw: number): Promise<void> {
    const client = this.client;
    const profile = this.lastState?.profile;
    const percent = Math.min(100, Math.max(0, Math.round(Number(raw))));
    this.log(`Command fan speed -> ${percent}% (profile ${profile ?? "unknown"})`);
    if (!client || !Number.isFinite(percent) || (profile !== "home" && profile !== "away" && profile !== "boost")) {
      // Fireplace/extra mode have separate supply/extract settings; unit off or unknown: nothing to set.
      this.log(`Fan speed can only be set in Home, Away or Boost profile`);
      this.fanSpeedHold = undefined;
      this.published.delete("fan.speed");
      if (this.lastState) this.publishState(this.lastState);
      return;
    }
    try {
      await client.setProfileFanSpeed(profile, percent);
      // The measured speed follows with a delay; show the requested value meanwhile.
      this.fanSpeedHold = { value: percent, until: Date.now() + FAN_SPEED_HOLD_MS };
      this.set("fan.speed", String(percent), () => this.devices?.fan.setAbsoluteFanSpeed(String(percent)));
    } catch (e) {
      this.log(`Setting fan speed failed: ${(e as Error).message}`);
      this.published.delete("fan.speed");
      if (this.lastState) this.publishState(this.lastState);
    }
    this.schedulePoll(POST_WRITE_POLL_MS);
  }

  private republishSwitch(name: string): void {
    this.published.delete(`${name}.on`);
    if (this.lastState) this.publishState(this.lastState);
  }

  // ---- polling ----------------------------------------------------------------

  private schedulePoll(delayMs: number): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    if (this.polling) {
      this.schedulePoll(1000);
      return;
    }
    const client = this.client;
    if (!client) return;
    this.polling = true;
    let next = this.config.pollIntervalSec * 1000;
    try {
      const state = await client.fetchState();
      if (client !== this.client) return; // config changed meanwhile
      if (this.failures > 0) this.log(`Vallox reachable again after ${this.failures} failed polls`);
      this.failures = 0;
      this.lastSuccess = Date.now();
      this.lastState = state;
      await this.keepAlive();
      this.publishState(state);
      await this.handleNotifications(state);
    } catch (e) {
      this.failures++;
      const since = this.lastSuccess ? Date.now() - this.lastSuccess : Infinity;
      if (this.failures === 1 || this.failures % 10 === 0) {
        this.log(`Vallox poll failed (${this.failures}x): ${(e as Error).message}`);
      }
      if (!this.unresponsive && since > UNRESPONSIVE_AFTER_MS) {
        this.log("Marking devices as unresponsive");
        this.unresponsive = true;
        this.published.clear();
        await this.forEachDevice((c) => c.setUnresponsive());
      }
      next = Math.min(next * Math.pow(2, Math.min(this.failures - 1, 4)), MAX_BACKOFF_MS);
    } finally {
      this.polling = false;
      this.schedulePoll(next);
    }
  }

  private async keepAlive(): Promise<void> {
    const now = Date.now();
    if (!this.unresponsive && now - this.lastKeepAlive < KEEPALIVE_INTERVAL_MS) return;
    this.lastKeepAlive = now;
    if (this.unresponsive) this.log("Devices responsive again");
    this.unresponsive = false;
    await this.forEachDevice((c) => c.triggerKeepAlive());
  }

  private async forEachDevice(fn: (c: Channel) => Promise<void>): Promise<void> {
    if (!this.devices) return;
    await Promise.all(
      Object.values(this.devices)
        .filter((c): c is Channel => !!c)
        .map((c) => fn(c).catch((e) => this.log(`Device update failed: ${(e as Error).message}`))),
    );
  }

  // ---- publishing -------------------------------------------------------------

  /** Write a datapoint only when its value changed since the last publish. */
  private set(key: string, value: string, write: () => unknown): void {
    if (this.published.get(key) === value) return;
    if (process.env.VALLOX_DEBUG) this.log(`publish ${key}=${value}`);
    this.published.set(key, value);
    try {
      const r = write();
      if (r instanceof Promise) {
        r.catch((e) => {
          this.published.delete(key);
          this.log(`Publishing ${key} failed: ${(e as Error).message}`);
        });
      }
    } catch (e) {
      this.published.delete(key);
      this.log(`Publishing ${key} failed: ${(e as Error).message}`);
    }
  }

  private publishState(s: ValloxState): void {
    const d = this.devices;
    if (!d) return;
    const temp = (key: string, ch: AirTemperatureChannel, v?: number) => {
      if (v !== undefined) this.set(key, v.toFixed(1), () => ch.setTemperature(v.toFixed(1)));
    };
    temp("temp.supply", d.tempSupply, s.tempSupply);
    temp("temp.extract", d.tempExtract, s.tempExtract);
    temp("temp.outdoor", d.tempOutdoor, s.tempOutdoor);
    temp("temp.exhaust", d.tempExhaust, s.tempExhaust);

    if (s.humidity !== undefined) {
      if (!d.humidity) void this.ensureHumidityDevice();
      else this.set("humidity", String(s.humidity), () => d.humidity!.setHumidity(String(s.humidity)));
    }

    let speed = s.fanSpeed ?? 0;
    const hold = this.fanSpeedHold;
    if (hold) {
      if (speed === hold.value || Date.now() > hold.until) this.fanSpeedHold = undefined;
      else speed = hold.value;
    }
    const fanOn = !s.unitOff && speed > 0;
    this.set("fan.on", fanOn ? "1" : "0", () => d.fan.setOnOff(fanOn));
    this.set("fan.speed", String(speed), () => d.fan.setAbsoluteFanSpeed(String(speed)));

    const sw = (key: string, ch: FreeAtHomeOnOffChannel, on: boolean) =>
      this.set(key, on ? "1" : "0", () => ch.setOn(on));
    sw("away.on", d.away, s.away);
    sw("boost.on", d.boost, s.boostTimer > 0);
    sw("fireplace.on", d.fireplace, s.fireplaceTimer > 0);
    sw("home.on", d.home, s.profile === "home");

    this.set("fault", s.fault ? "1" : "0", () => d.fault.setOnOff(s.fault));

    const filterDue = s.filterDays !== undefined && s.filterDays <= this.config.filterWarnDays;
    this.set("filter", filterDue ? "1" : "0", () => d.filter.setOnOff(filterDue));
    if (this.config.filterDaysInName && s.filterDays !== undefined) {
      const name = `${NAME_PREFIX} Filter (${s.filterDays} Tage)`;
      this.set("filter.name", name, () => d.filter.setDeviceName(name));
    }
  }

  // ---- notifications ------------------------------------------------------------

  private async handleNotifications(s: ValloxState): Promise<void> {
    const filterDue = s.filterDays !== undefined && s.filterDays <= this.config.filterWarnDays;
    if (s.fault && !this.notified.fault) {
      const details = s.activeFaults.map((f) => f.text).join(", ") || "Gerät im Notbetrieb (Limp-Mode)";
      await this.notify("vallox-fault", "Vallox: Störung", details, "Vallox: fault", details, "styleAlert");
    }
    if (filterDue && !this.notified.filter) {
      const body = `Filterwechsel in ${s.filterDays} Tagen fällig.`;
      await this.notify("vallox-filter", "Vallox: Filterwechsel", body, "Vallox: filter change", `Filter change due in ${s.filterDays} days.`, "styleWarn");
    }
    this.notified = { fault: s.fault, filter: filterDue };
  }

  private async notify(topicId: string, titleDe: string, bodyDe: string, titleEn: string, bodyEn: string,
    style: "styleWarn" | "styleAlert"): Promise<void> {
    this.log(`${titleDe}: ${bodyDe}`);
    if (!this.config.notifications) return;
    try {
      await this.fah.postNotification({
        formatVersion: 1,
        topicId,
        timeoutMinutes: 24 * 60,
        retention: 24 * 60,
        displayHints: [style],
        terminals: ["ui", "push-notification"],
        content: { utf8: { de: { title: titleDe, body: bodyDe }, en: { title: titleEn, body: bodyEn } } },
      });
    } catch (e) {
      this.log(`Notification failed: ${(e as Error).message}`);
    }
  }
}
