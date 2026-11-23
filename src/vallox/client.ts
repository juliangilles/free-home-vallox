import WebSocket from "ws";
import { buildReadTablesRequest, buildWriteRequest, parseReadTablesResponse, WriteItem } from "./protocol";
import { BUILTIN_MODEL, DataModel, loadModelFromUnit } from "./dataModel";
import { ALARM_TEXTS, cKToCelsius, FAULT_ACTIVITY_ACTIVE, FAULT_ENTRY_SIZE, Reg } from "./registers";

export type Profile = "home" | "away" | "boost" | "fireplace" | "extra" | "off" | "unknown";

export interface ValloxFault {
  code: number;
  text: string;
  severe: boolean;
}

export interface ValloxState {
  fanSpeed?: number; // %
  extractFanRpm?: number;
  supplyFanRpm?: number;
  tempExtract?: number; // Abluft °C
  tempExhaust?: number; // Fortluft °C
  tempOutdoor?: number; // Außenluft °C
  tempSupply?: number; // Zuluft °C
  humidity?: number; // %RH, undefined = no sensor
  co2?: number; // ppm, undefined = no sensor
  away: boolean;
  unitOff: boolean;
  boostTimer: number; // remaining minutes (65535 = endless)
  fireplaceTimer: number;
  extraTimer: number;
  homeSpeedSetting?: number; // % configured per profile
  awaySpeedSetting?: number;
  boostSpeedSetting?: number;
  boostDefaultMinutes?: number;
  fireplaceDefaultMinutes?: number;
  filterDays?: number;
  limpMode: boolean;
  activeFaults: ValloxFault[];
  fault: boolean; // limpMode || active faults
  profile: Profile;
  machineModel?: number;
}

export interface ValloxClientOptions {
  host: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

const RETRY_DELAYS_MS = [200, 500, 1000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Client for the MyVallox local websocket API.
 *
 * Like the Python reference implementation, it opens a short-lived websocket
 * per request. This makes "reconnect" implicit: a broken connection only
 * affects one request, the next one simply connects again. Requests are
 * serialized so the unit never sees more than one connection from us.
 */
export class ValloxClient {
  private model: DataModel = new DataModel(BUILTIN_MODEL, "builtin");
  private modelChecked = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly timeoutMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: ValloxClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.log = opts.log ?? (() => undefined);
  }

  get host(): string {
    return this.opts.host;
  }

  get modelSource(): string {
    return this.model.source;
  }

  /** Read all registers and return them as raw words (index = buffer offset). */
  async readRaw(): Promise<Uint16Array> {
    const resp = await this.request(buildReadTablesRequest());
    const words = parseReadTablesResponse(resp);
    if (!this.modelChecked) {
      this.modelChecked = true;
      if (words.length < this.model.totalSize) {
        this.log(`Response has ${words.length} words, built-in model expects ${this.model.totalSize}; loading model from unit`);
        try {
          this.model = await loadModelFromUnit(this.opts.host);
          this.log(`Loaded data model from ${this.model.source} (${this.model.totalSize} words)`);
        } catch (e) {
          this.log(`Could not load data model from unit (${(e as Error).message}); using built-in model`);
        }
      }
    }
    return words;
  }

  /** Read a single register value from a raw table, undefined if not available. */
  value(words: Uint16Array, address: number): number | undefined {
    const off = this.model.offsetOf(address);
    if (off === undefined || off >= words.length) return undefined;
    return words[off];
  }

  async fetchState(): Promise<ValloxState> {
    const words = await this.readRaw();
    return this.decodeState(words);
  }

  decodeState(words: Uint16Array): ValloxState {
    const v = (a: number) => this.value(words, a);
    const opt = (a: number) => {
      const x = v(a);
      return x === undefined || x === 0xffff ? undefined : x;
    };

    const boostTimer = v(Reg.BOOST_TIMER) ?? 0;
    const fireplaceTimer = v(Reg.FIREPLACE_TIMER) ?? 0;
    const extraTimer = v(Reg.EXTRA_TIMER) ?? 0;
    const away = v(Reg.STATE) === 1;
    const unitOff = v(Reg.MODE) === 5;
    const limpMode = v(Reg.LIMP_MODE) === 1;
    const rh = v(Reg.RH_VALUE);
    const co2 = v(Reg.CO2_VALUE);

    const activeFaults: ValloxFault[] = [];
    const total = opt(Reg.TOTAL_FAULT_COUNT);
    if (total !== undefined) {
      for (let i = 0; i < Math.min(total, 33); i++) {
        const base = Reg.FAULT_TABLE_START + i * FAULT_ENTRY_SIZE;
        const code = v(base);
        const activity = v(base + 5);
        if (!code || activity !== FAULT_ACTIVITY_ACTIVE) continue;
        activeFaults.push({
          code,
          text: ALARM_TEXTS[code] ?? `Fehlercode ${code}`,
          severe: v(base + 1) === 1,
        });
      }
    }

    let profile: Profile = "unknown";
    if (unitOff) profile = "off";
    else if (boostTimer > 0) profile = "boost";
    else if (fireplaceTimer > 0) profile = "fireplace";
    else if (extraTimer > 0) profile = "extra";
    else if (v(Reg.STATE) === 0) profile = "home";
    else if (away) profile = "away";

    return {
      fanSpeed: v(Reg.FAN_SPEED),
      extractFanRpm: v(Reg.EXTR_FAN_SPEED),
      supplyFanRpm: v(Reg.SUPP_FAN_SPEED),
      tempExtract: cKToCelsius(v(Reg.TEMP_EXTRACT_AIR)),
      tempExhaust: cKToCelsius(v(Reg.TEMP_EXHAUST_AIR)),
      tempOutdoor: cKToCelsius(v(Reg.TEMP_OUTDOOR_AIR)),
      tempSupply: cKToCelsius(v(Reg.TEMP_SUPPLY_AIR)),
      humidity: rh ? rh : undefined,
      co2: co2 ? co2 : undefined,
      away,
      unitOff,
      boostTimer,
      fireplaceTimer,
      extraTimer,
      homeSpeedSetting: opt(Reg.HOME_SPEED_SETTING),
      awaySpeedSetting: opt(Reg.AWAY_SPEED_SETTING),
      boostSpeedSetting: opt(Reg.BOOST_SPEED_SETTING),
      boostDefaultMinutes: opt(Reg.BOOST_TIME),
      fireplaceDefaultMinutes: opt(Reg.FIREPLACE_TIME),
      filterDays: opt(Reg.REMAINING_TIME_FOR_FILTER),
      limpMode,
      activeFaults,
      fault: limpMode || activeFaults.length > 0,
      profile,
      machineModel: v(Reg.MACHINE_MODEL),
    };
  }

  async writeValues(items: WriteItem[]): Promise<void> {
    this.log(`Write ${items.map((i) => `${i.address}=${i.value}`).join(", ")}`);
    await this.request(buildWriteRequest(items));
  }

  // ---- high level commands ------------------------------------------------

  setAway(away: boolean): Promise<void> {
    return this.writeValues([{ address: Reg.STATE, value: away ? 1 : 0 }]);
  }

  /** Start boost; minutes = 0 uses the unit's configured default, 65535 = endless. */
  startBoost(minutes: number): Promise<void> {
    return this.startTimed(Reg.BOOST_TIMER, minutes, Reg.BOOST_TIME);
  }

  startFireplace(minutes: number): Promise<void> {
    return this.startTimed(Reg.FIREPLACE_TIMER, minutes, Reg.FIREPLACE_TIME);
  }

  /**
   * Activate the Home profile: basic state Home, all timed modes (Boost, Fireplace,
   * programmable) off and, if fanSpeed > 0, the Home fan speed setting.
   */
  activateHome(fanSpeed: number): Promise<void> {
    const items: WriteItem[] = [
      { address: Reg.STATE, value: 0 },
      { address: Reg.BOOST_TIMER, value: 0 },
      { address: Reg.FIREPLACE_TIMER, value: 0 },
      { address: Reg.EXTRA_TIMER, value: 0 },
    ];
    const speed = Math.round(fanSpeed);
    if (speed > 0) items.push({ address: Reg.HOME_SPEED_SETTING, value: Math.min(100, speed) });
    return this.writeValues(items);
  }

  /**
   * Set the fan speed setting (%) of a profile. Vallox has no free speed value:
   * each of Home, Away and Boost has its own configured speed.
   */
  setProfileFanSpeed(profile: "home" | "away" | "boost", percent: number): Promise<void> {
    const reg = {
      home: Reg.HOME_SPEED_SETTING,
      away: Reg.AWAY_SPEED_SETTING,
      boost: Reg.BOOST_SPEED_SETTING,
    }[profile];
    const value = Math.min(100, Math.max(0, Math.round(percent)));
    return this.writeValues([{ address: reg, value }]);
  }

  stopBoost(): Promise<void> {
    return this.writeValues([{ address: Reg.BOOST_TIMER, value: 0 }]);
  }

  stopFireplace(): Promise<void> {
    return this.writeValues([{ address: Reg.FIREPLACE_TIMER, value: 0 }]);
  }

  private async startTimed(timerReg: number, minutes: number, defaultReg: number): Promise<void> {
    let dur = Math.round(minutes);
    if (!(dur > 0)) {
      const words = await this.readRaw();
      dur = this.value(words, defaultReg) ?? 30;
    }
    dur = Math.min(Math.max(dur, 1), 65535);
    // Timed modes are exclusive (same as the Vallox web UI / HA integration).
    const timers = [Reg.BOOST_TIMER, Reg.FIREPLACE_TIMER, Reg.EXTRA_TIMER];
    await this.writeValues(timers.map((t) => ({ address: t, value: t === timerReg ? dur : 0 })));
  }

  // ---- transport ----------------------------------------------------------

  private request(payload: Buffer): Promise<Buffer> {
    const run = () => this.requestWithRetry(payload);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async requestWithRetry(payload: Buffer): Promise<Buffer> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await this.requestOnce(payload);
      } catch (e) {
        lastError = e as Error;
        if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
    throw lastError ?? new Error("Vallox request failed");
  }

  private requestOnce(payload: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${this.opts.host}/`, {
        handshakeTimeout: this.timeoutMs,
        perMessageDeflate: false,
      });
      let done = false;
      const finish = (err?: Error, data?: Buffer) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ws.removeAllListeners();
        ws.on("error", () => undefined); // swallow errors during close
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        if (err) reject(err);
        else resolve(data!);
      };
      const timer = setTimeout(() => finish(new Error(`Vallox ${this.opts.host}: timeout`)), this.timeoutMs * 2);
      ws.on("open", () => ws.send(payload));
      ws.on("message", (data: WebSocket.RawData) => {
        const buf = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer);
        finish(undefined, buf);
      });
      ws.on("error", (e) => finish(new Error(`Vallox ${this.opts.host}: ${e.message}`)));
      ws.on("close", () => finish(new Error(`Vallox ${this.opts.host}: connection closed`)));
    });
  }
}
