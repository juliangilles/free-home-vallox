import { AddOn, FreeAtHome } from "@busch-jaeger/free-at-home";
import { ValloxBridge } from "./bridge";
import { parseConfig } from "./config";

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

async function main() {
  const metaData = AddOn.readMetaData();
  const freeAtHome = new FreeAtHome();
  freeAtHome.activateSignalHandling();

  const addOn = new AddOn.AddOn(metaData.id);
  let bridge: ValloxBridge | undefined;
  let pendingConfig: Record<string, any> | undefined;
  let everConnected = false;

  addOn.on("configurationChanged", (configuration: Record<string, any>) => {
    const cfg = parseConfig(configuration);
    log(`Configuration received (host=${cfg.host || "-"}, poll=${cfg.pollIntervalSec}s, boost=${cfg.boostMinutes}min, fireplace=${cfg.fireplaceMinutes}min)`);
    if (bridge) bridge.applyConfig(cfg);
    else pendingConfig = configuration;
  });
  addOn.connectToConfiguration();

  freeAtHome.on("open", () => {
    if (everConnected) void bridge?.onSysApReconnected();
    everConnected = true;
  });
  freeAtHome.on("close", (reason) => log(`SysAP connection closed: ${reason}`));

  // Device creation needs the SysAP; retry until it is reachable.
  for (let attempt = 1; ; attempt++) {
    try {
      const b = new ValloxBridge(freeAtHome, parseConfig(pendingConfig), log);
      await b.start();
      bridge = b;
      if (pendingConfig) b.applyConfig(parseConfig(pendingConfig));
      break;
    } catch (e) {
      const delay = Math.min(5000 * attempt, 60000);
      log(`Creating devices failed (${(e as Error).message}); retrying in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const shutdown = async () => {
    log("Shutting down");
    await bridge?.stop().catch(() => undefined);
    addOn.dispose();
  };
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
