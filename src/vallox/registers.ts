/**
 * Vallox register addresses. These are identical to the Modbus holding register
 * addresses documented in Vallox "Configuration Modbus" (D5269) and are used
 * unchanged by the local websocket API.
 */
export const Reg = {
  // Device info (general info range)
  MACHINE_MODEL: 17,

  // HW state
  FAN_SPEED: 4353, // % current fan speed
  TEMP_EXTRACT_AIR: 4354, // Abluft (extract, cell input)       cK
  TEMP_EXHAUST_AIR: 4355, // Fortluft (extract, cell output)    cK
  TEMP_OUTDOOR_AIR: 4356, // Außenluft (supply, cell input)     cK
  TEMP_SUPPLY_CELL_AIR: 4357, // supply, cell output            cK
  TEMP_SUPPLY_AIR: 4358, // Zuluft (supply, heater output)      cK
  EXTR_FAN_SPEED: 4361, // rpm
  SUPP_FAN_SPEED: 4362, // rpm
  RH_VALUE: 4363, // %RH, highest measurement, 0 = no sensor
  CO2_VALUE: 4364, // ppm, 0 = no sensor

  // SW state
  STATE: 4609, // 0 = Home, 1 = Away
  MODE: 4610, // 0 = normal, 5 = off
  BOOST_TIMER: 4612, // minutes, 65535 = indefinitely
  FIREPLACE_TIMER: 4613,
  EXTRA_TIMER: 4614,
  CELL_STATE: 4616,
  REMAINING_TIME_FOR_FILTER: 4620, // days
  LIMP_MODE: 4621, // 1 = device fault active

  // Settings
  AWAY_SPEED_SETTING: 20501, // % fan speed in Away profile
  HOME_SPEED_SETTING: 20507, // % fan speed in Home profile
  BOOST_SPEED_SETTING: 20513, // % fan speed in Boost profile
  FILTER_CHANGE_INTERVAL: 20537,
  BOOST_TIME: 20544, // default boost duration (min)
  FIREPLACE_TIME: 20545, // default fireplace duration (min)

  // Fault table
  TOTAL_FAULT_COUNT: 36865,
  FAULT_TABLE_START: 36866, // CODE, SEVERITY, FIRST_DATE, LAST_DATE, COUNT, ACTIVITY (6 words each)
} as const;

export const FAULT_ENTRY_SIZE = 6;
export const FAULT_ACTIVITY_ACTIVE = 1;

/** Alarm texts indexed by fault code (from vallox_websocket_api). */
export const ALARM_TEXTS = [
  "Kein Fehler",
  "Abluftventilator",
  "Zuluftventilator",
  "Wärmetauscher eingefroren",
  "Temperatursensor 1",
  "Temperatursensor 2",
  "Temperatursensor 3",
  "Temperatursensor 4",
  "Temperatursensor 5",
  "Filter verschmutzt",
  "Externer Sensor",
  "Nachheizregister",
  "Frostgefahr Wasserheizregister",
  "Kanaltemperatursensor Modul 1",
  "STB 2 Modul 1",
  "Kanaltemperatursensor Modul 2",
  "STB 2 Modul 2",
  "STB 1 Modul 1",
  "STB 1 Modul 2",
  "Wassertemperatursensor Modul 1",
  "Wassertemperatursensor Modul 2",
  "Wassertemperatur Modul 1",
  "Wassertemperatur Modul 2",
  "Zulufttemperatur zu niedrig",
  "Kommunikationsfehler",
];

/** centiKelvin -> °C (one decimal). 0 means "no value". */
export function cKToCelsius(raw: number | undefined): number | undefined {
  if (raw === undefined || raw === 0 || raw === 0xffff) return undefined;
  return Math.round((raw - 27315) / 10) / 10;
}
