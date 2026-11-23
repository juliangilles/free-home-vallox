/** Add-on configuration (group "vallox" in free-at-home-metadata.json). */
export interface ValloxConfig {
  host: string;
  pollIntervalSec: number;
  boostMinutes: number; // 0 = unit default, 65535 = endless
  fireplaceMinutes: number;
  homeFanSpeed: number; // % set when the Zuhause actuator is switched on, 0 = keep
  filterWarnDays: number;
  notifications: boolean;
  filterDaysInName: boolean;
}

export const DEFAULT_CONFIG: ValloxConfig = {
  host: "",
  pollIntervalSec: 30,
  boostMinutes: 30,
  fireplaceMinutes: 15,
  homeFanSpeed: 52,
  filterWarnDays: 14,
  notifications: true,
  filterDaysInName: true,
};

function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function bool(v: unknown, def: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return def;
}

/** Build config from the SysAP add-on configuration object, with env overrides for local dev. */
export function parseConfig(raw: Record<string, any> | undefined): ValloxConfig {
  const items: Record<string, unknown> = raw?.vallox?.items ?? {};
  const env = process.env;
  return {
    host: String(env.VALLOX_HOST ?? items.host ?? DEFAULT_CONFIG.host).trim(),
    pollIntervalSec: num(env.VALLOX_POLL_INTERVAL ?? items.pollInterval, DEFAULT_CONFIG.pollIntervalSec, 10, 600),
    boostMinutes: num(env.VALLOX_BOOST_MINUTES ?? items.boostMinutes, DEFAULT_CONFIG.boostMinutes, 0, 65535),
    fireplaceMinutes: num(env.VALLOX_FIREPLACE_MINUTES ?? items.fireplaceMinutes, DEFAULT_CONFIG.fireplaceMinutes, 0, 65535),
    homeFanSpeed: num(env.VALLOX_HOME_FAN_SPEED ?? items.homeFanSpeed, DEFAULT_CONFIG.homeFanSpeed, 0, 100),
    filterWarnDays: num(items.filterWarnDays, DEFAULT_CONFIG.filterWarnDays, 0, 365),
    notifications: bool(items.notifications, DEFAULT_CONFIG.notifications),
    filterDaysInName: bool(items.filterDaysInName, DEFAULT_CONFIG.filterDaysInName),
  };
}
