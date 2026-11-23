import http from "http";
import zlib from "zlib";

/**
 * Maps register addresses to positions in the READ_TABLES response buffer.
 *
 * The unit returns all register ranges packed back to back. Range boundaries
 * and lengths are defined in the unit's web UI JavaScript (VlxDevConstants /
 * VlxReadConstants). A built-in model (firmware 2.0.x) is used by default;
 * if the response length does not match, the model is loaded from the unit.
 */

interface Range {
  name: string;
  start: number;
  end: number;
  offset: number;
}

export interface ModelConstants {
  dev: Record<string, number>; // RANGE_START_*/RANGE_END_*
  read: Record<string, number>; // CYC_NUM_OF_*
}

/** Range order used by the unit (matches vlxBufferSize in the web UI). */
const RANGE_ORDER: Array<[name: string, countKey: string, required: boolean]> = [
  ["g_cyclone_general_info", "CYC_NUM_OF_GENERAL_INFO", true],
  ["g_typhoon_general_info", "CYC_NUM_OF_GENERAL_TYP_INFO", true],
  ["g_cyclone_hw_state", "CYC_NUM_OF_HW_STATES", true],
  ["g_cyclone_sw_state", "CYC_NUM_OF_SW_STATES", true],
  ["g_cyclone_time", "CYC_NUM_OF_TIME_ELEMENTS", true],
  ["g_cyclone_output", "CYC_NUM_OF_OUTPUTS", true],
  ["g_cyclone_input", "CYC_NUM_OF_INPUTS", true],
  ["g_cyclone_config", "CYC_NUM_OF_CONFIGS", true],
  ["g_cyclone_settings", "CYC_NUM_OF_CYC_SETTINGS", true],
  ["g_typhoon_settings", "CYC_NUM_OF_TYP_SETTINGS", true],
  // firmware v2: self test, firmware v3+: constant flow (handled below)
  ["g_faults", "CYC_NUM_OF_FAULTS", true],
  ["g_cyclone_weekly_schedule", "CYC_NUM_OF_SCHEDULED_EVENTS", true],
  ["g_cyclone_extended", "CYC_NUM_OF_EXT_SETTINGS", false],
];

/** Built-in model, taken from MyVallox firmware 2.0.22. */
export const BUILTIN_MODEL: ModelConstants = {
  dev: {
    RANGE_START_g_cyclone_general_info: 0, RANGE_END_g_cyclone_general_info: 35,
    RANGE_START_g_typhoon_general_info: 256, RANGE_END_g_typhoon_general_info: 282,
    RANGE_START_g_cyclone_hw_state: 4352, RANGE_END_g_cyclone_hw_state: 4394,
    RANGE_START_g_cyclone_sw_state: 4608, RANGE_END_g_cyclone_sw_state: 4632,
    RANGE_START_g_cyclone_time: 4848, RANGE_END_g_cyclone_time: 4854,
    RANGE_START_g_cyclone_output: 4864, RANGE_END_g_cyclone_output: 4870,
    RANGE_START_g_cyclone_input: 5120, RANGE_END_g_cyclone_input: 5126,
    RANGE_START_g_cyclone_config: 8192, RANGE_END_g_cyclone_config: 8221,
    RANGE_START_g_cyclone_settings: 20480, RANGE_END_g_cyclone_settings: 20555,
    RANGE_START_g_typhoon_settings: 21760, RANGE_END_g_typhoon_settings: 21782,
    RANGE_START_g_self_test: 32768, RANGE_END_g_self_test: 32783,
    RANGE_START_g_faults: 36864, RANGE_END_g_faults: 37063,
    RANGE_START_g_cyclone_weekly_schedule: 40960, RANGE_END_g_cyclone_weekly_schedule: 41128,
    RANGE_START_g_cyclone_extended: 46000, RANGE_END_g_cyclone_extended: 46023,
  },
  read: {
    CYC_NUM_OF_GENERAL_INFO: 36,
    CYC_NUM_OF_GENERAL_TYP_INFO: 27,
    CYC_NUM_OF_HW_STATES: 43,
    CYC_NUM_OF_SW_STATES: 25,
    CYC_NUM_OF_TIME_ELEMENTS: 7,
    CYC_NUM_OF_OUTPUTS: 7,
    CYC_NUM_OF_INPUTS: 7,
    CYC_NUM_OF_CONFIGS: 30,
    CYC_NUM_OF_CYC_SETTINGS: 76,
    CYC_NUM_OF_TYP_SETTINGS: 23,
    CYC_NUM_OF_SELF_TESTS: 16,
    CYC_NUM_OF_FAULTS: 200,
    CYC_NUM_OF_SCHEDULED_EVENTS: 169,
    CYC_NUM_OF_EXT_SETTINGS: 24,
  },
};

export class DataModel {
  private ranges: Range[] = [];
  readonly totalSize: number;

  constructor(readonly constants: ModelConstants, readonly source: string) {
    const { dev, read } = constants;
    const isFwV2 = "RANGE_START_g_self_test" in dev;
    const order = [...RANGE_ORDER];
    order.splice(10, 0, isFwV2
      ? ["g_self_test", "CYC_NUM_OF_SELF_TESTS", true]
      : ["g_constant_flow", "CYC_NUM_OF_CF", true]);

    let pos = 0;
    for (const [name, countKey, required] of order) {
      const start = dev[`RANGE_START_${name}`];
      const end = dev[`RANGE_END_${name}`];
      const count = read[countKey];
      if (start === undefined || end === undefined || count === undefined) {
        if (required) throw new Error(`Data model: required range ${name} missing`);
        continue;
      }
      this.ranges.push({ name, start, end, offset: pos });
      pos += count;
    }
    this.totalSize = pos;
  }

  offsetOf(address: number): number | undefined {
    for (const r of this.ranges) {
      if (address >= r.start && address <= r.end) return r.offset + (address - r.start);
    }
    return undefined;
  }
}

/** Parse "VlxDevConstants.X = 123," style constants out of the unit's web UI JS. */
export function parseModelFromJs(js: string): ModelConstants {
  const re = /(Vlx\w+)\.(\w+)\s*=\s*([\w.]+)\s*[,;]/g;
  const consts: Record<string, Record<string, number>> = {};
  let m: RegExpExecArray | null;
  while ((m = re.exec(js)) !== null) {
    const [, parent, key, rawValue] = m;
    if (parent !== "VlxDevConstants" && parent !== "VlxReadConstants") continue;
    const bucket = (consts[parent] ??= {});
    if (key in bucket) continue;
    let value: number | undefined;
    if (/^\d/.test(rawValue)) {
      value = rawValue.startsWith("0x") ? parseInt(rawValue, 16) : Math.trunc(Number(rawValue));
    } else {
      const [p, k] = rawValue.split(".");
      value = consts[p]?.[k];
    }
    if (value !== undefined && !Number.isNaN(value)) bucket[key] = value;
  }
  return { dev: consts.VlxDevConstants ?? {}, read: consts.VlxReadConstants ?? {} };
}

function httpGet(url: string, timeoutMs: number, maxBytes = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy(new Error("Response too large"));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => {
        try {
          let body = Buffer.concat(chunks);
          // MyVallox serves bundle.js gzip-compressed (pre-compressed file), detect by magic bytes.
          if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) body = zlib.gunzipSync(body);
          resolve(body.toString("utf8"));
        } catch (e) {
          reject(e);
        }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`Timeout fetching ${url}`)));
    req.on("error", reject);
  });
}

/** Try to load the data model from the unit's web UI (js/bundle.js, js/vallox.js). */
export async function loadModelFromUnit(host: string, timeoutMs = 10000): Promise<DataModel> {
  let lastError: unknown;
  for (const path of ["js/bundle.js", "js/vallox.js"]) {
    try {
      const js = await httpGet(`http://${host}/${path}`, timeoutMs);
      return new DataModel(parseModelFromJs(js), `unit:${path}`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
