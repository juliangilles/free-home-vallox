# Entwicklung

## Voraussetzungen

- Node.js ≥ 20 (für `--env-file`)
- Netzwerkzugriff auf die Vallox-Anlage und den SysAP
- Im SysAP aktivierte **lokale API** (*Mehr → Installationseinstellungen → Lokale API*)

## Projektaufbau

```
src/
  main.ts              Einstieg: Add-on-Konfiguration lesen, SysAP-Verbindung, Bridge starten
  bridge.ts            free@home-Seite: virtuelle Geräte anlegen, Polling, Befehle, Keep-Alive, Benachrichtigungen
  config.ts            Konfiguration aus dem SysAP lesen (mit Umgebungsvariablen als Override)
  vallox/
    protocol.ts        Binärformat der Websocket-Nachrichten (Anfrage bauen, Antwort parsen)
    dataModel.ts       Abbildung Registeradresse → Position in der Antwort; Modell aus der Anlage nachladen
    registers.ts       verwendete Registeradressen, Fehlertexte, Temperaturumrechnung
    client.ts          ValloxClient: Werte lesen/dekodieren, Befehle (Profile, Timer, Lüfterleistung)
  tools/
    probe.ts           Kommandozeilen-Test: Werte der Anlage ausgeben
test/                  Unit-Tests (node:test)
free-at-home-metadata.json   Add-on-Metadaten und Konfigurationsoberfläche
```

Datenfluss:

```
Vallox  ──ws (READ_TABLES)──▶  ValloxClient.fetchState()  ──▶  ValloxBridge.publishState()  ──▶  SysAP-Datenpunkte
Vallox  ◀─ws (WRITE_DATA)───  ValloxClient.*()            ◀──  isOnChanged / absoluteFanSpeedChanged  ◀──  free@home
```

## Lokal entwickeln

```bash
npm install
cp .env.example .env
```

`.env` (wird nicht eingecheckt):

| Variable | Bedeutung |
|---|---|
| `VALLOX_HOST` | IP der Vallox-Anlage |
| `FREEATHOME_BASE_URL` | z. B. `http://192.168.x.y` |
| `FREEATHOME_API_USERNAME` / `FREEATHOME_API_PASSWORD` | Benutzer der lokalen API |
| `VALLOX_POLL_INTERVAL`, `VALLOX_BOOST_MINUTES`, `VALLOX_FIREPLACE_MINUTES`, `VALLOX_HOME_FAN_SPEED` | optionale Overrides der Add-on-Konfiguration |
| `VALLOX_DEBUG=1` | jeden geschriebenen Datenpunkt und jedes Lüfter-Event protokollieren |
| `VALLOX_ID_PREFIX`, `VALLOX_NAME_PREFIX` | eigener Gerätesatz für Tests (z. B. `valloxtest` / `TEST Vallox`), damit die echten Geräte unberührt bleiben |

Befehle:

```bash
npm run probe -- 192.168.x.z --raw   # nur Vallox: Werte und Rohregister ausgeben
npm run dev                            # Add-on lokal gegen den SysAP
```

Lokal und installiert gleichzeitig laufen lassen vermeiden – beide würden dieselben Geräte beschreiben.

## Tests

```bash
npm test
```

Abgedeckt sind u. a. das Nachrichtenformat (Prüfsumme, Byte-Reihenfolge), die Offset-Berechnung des Datenmodells, das Dekodieren von Temperaturen/Profilen/Fehlern, die Befehle an die Anlage sowie in `test/bridge.test.ts` das Verhalten der virtuellen Geräte mit einem nachgebauten SysAP:

- kein Hängenbleiben, wenn das Feuchte-Gerät beim ersten Start noch angelegt wird (früherer Fehler: endlose Microtask-Schleife mit 100 % CPU),
- Lüfterleistung schreibt den Sollwert des aktiven Profils, im Kaminmodus nicht,
- Aktor „Zuhause“.

## Paketieren

```bash
npm run pack
```

Erzeugt `de.private.vallox-<version>.tar` mit `build/`, Metadaten und den Laufzeit-Abhängigkeiten. Vorher `version` in `free-at-home-metadata.json` **und** `package.json` erhöhen und einen Eintrag in `CHANGELOG.md` ergänzen. `npm run validate` prüft die Metadaten.

## Fehlersuche

- **Vallox nicht erreichbar:** `npm run probe -- <ip>`. Die Weboberfläche der Anlage muss unter `http://<ip>/` erreichbar sein.
- **Unplausible Werte:** `npm run probe -- <ip> --raw` zeigt die Rohregister. Passt das eingebaute Datenmodell nicht zur Firmware, lädt der Client es aus `http://<ip>/js/bundle.js` nach (siehe [PROTOKOLL.md](PROTOKOLL.md)).
- **Hohe CPU-Last:** mit `node --prof --logfile=v8.log build/main.js` laufen lassen und mit `node --prof-process v8.log` auswerten – damit wurde der Fehler aus Version 0.1.0 gefunden.
- **Geräte erscheinen nicht:** Beim ersten Anlegen wartet die Bibliothek, bis der SysAP das Gerät meldet; das kann pro Gerät bis zu einer Minute dauern.
