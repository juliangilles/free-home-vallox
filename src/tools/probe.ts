/**
 * Connection test: reads the Vallox unit once (or repeatedly) and prints the values.
 *
 *   node build/tools/probe.js <vallox-ip> [--watch] [--raw]
 *   VALLOX_HOST=<vallox-ip> node build/tools/probe.js
 */
import { ValloxClient } from "../vallox/client";
import { Reg } from "../vallox/registers";

async function main() {
  const args = process.argv.slice(2);
  const host = args.find((a) => !a.startsWith("--")) ?? process.env.VALLOX_HOST;
  if (!host) {
    console.error("Usage: node build/tools/probe.js <vallox-ip> [--watch] [--raw]");
    process.exit(2);
  }
  const client = new ValloxClient({ host, log: (m) => console.log(`[vallox] ${m}`) });

  const once = async () => {
    const t0 = Date.now();
    const words = await client.readRaw();
    const s = client.decodeState(words);
    console.log(`\n${new Date().toISOString()}  ${words.length} words in ${Date.now() - t0} ms (model: ${client.modelSource})`);
    console.table({
      "Zuluft °C": s.tempSupply,
      "Abluft °C": s.tempExtract,
      "Außenluft °C": s.tempOutdoor,
      "Fortluft °C": s.tempExhaust,
      "Luftfeuchte %": s.humidity ?? "kein Sensor",
      "CO2 ppm": s.co2 ?? "kein Sensor",
      "Lüfter %": s.fanSpeed,
      "Lüfter Abluft/Zuluft rpm": `${s.extractFanRpm} / ${s.supplyFanRpm}`,
      Profil: s.profile,
      "Boost-Timer min": s.boostTimer,
      "Kamin-Timer min": s.fireplaceTimer,
      "Boost-Standarddauer min": s.boostDefaultMinutes,
      "Kamin-Standarddauer min": s.fireplaceDefaultMinutes,
      "Tage bis Filterwechsel": s.filterDays,
      "Störung (Limp-Mode)": s.limpMode,
      "Aktive Fehler": s.activeFaults.map((f) => `${f.code}: ${f.text}`).join("; ") || "-",
    });
    if (args.includes("--raw")) {
      const regs = Object.entries(Reg).map(([k, a]) => [k, a, client.value(words, a)]);
      console.table(regs);
    }
  };

  await once();
  if (args.includes("--watch")) setInterval(() => once().catch((e) => console.error(e.message)), 10000);
}

main().catch((e) => {
  console.error("Probe failed:", e.message);
  process.exit(1);
});
