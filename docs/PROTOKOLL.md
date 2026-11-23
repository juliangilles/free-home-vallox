# Vallox-Websocket-Protokoll

MyVallox-Anlagen bieten unter `ws://<ip>/` die Schnittstelle an, die auch ihre eigene Weboberfläche nutzt. Sie ist nicht offiziell dokumentiert; diese Beschreibung folgt der Python-Bibliothek [`vallox_websocket_api`](https://pypi.org/project/vallox-websocket-api/) (Version 6.1.0) und wurde an einer ValloPlus 350 MV geprüft.

## Nachrichten

Anfragen bestehen aus 16-Bit-Wörtern in **Little Endian**:

```
[Länge] [Befehl] [Nutzdaten …] [Prüfsumme]
```

- Prüfsumme = Summe aller vorherigen Wörter, modulo 65536
- Pro Anfrage öffnet der Client eine neue Verbindung, sendet eine Nachricht und wartet auf genau eine Antwort.

| Befehl | Wert | Anfrage | Antwort |
|---|---|---|---|
| `READ_TABLES` | 246 | `[3, 246, 0, 249]` | alle Register am Stück, Wörter in **Big Endian** |
| `WRITE_DATA` | 249 | `[n·2+2, 249, adr₁, wert₁, …, adrₙ, wertₙ, Prüfsumme]` | Bestätigung (wird nicht ausgewertet) |

Beim Schreiben werden die Paare nach Adresse sortiert. Werte sind vorzeichenlose 16-Bit-Zahlen; die Anlage lehnt Werte außerhalb des zulässigen Bereichs ab.

## Datenmodell

Die `READ_TABLES`-Antwort enthält mehrere Registerbereiche lückenlos hintereinander. Position eines Registers = Startposition seines Bereichs + (Adresse − Bereichsanfang).

| Bereich | Adressen | Länge |
|---|---|---|
| general_info | 0–35 | 36 |
| typhoon_general_info | 256–282 | 27 |
| hw_state | 4352–4394 | 43 |
| sw_state | 4608–4632 | 25 |
| time | 4848–4854 | 7 |
| output | 4864–4870 | 7 |
| input | 5120–5126 | 7 |
| config | 8192–8221 | 30 |
| settings | 20480–20555 | 76 |
| typhoon_settings | 21760–21782 | 23 |
| self_test (FW v2) **oder** constant_flow (FW v3) | 32768–32783 | 16 |
| faults | 36864–37063 | 200 |
| weekly_schedule | 40960–41128 | 169 |
| extended | 46000–… | 24 (FW 2.0.22) / 39 (FW v3) |

Eingebaut ist das Modell der Firmware 2.0.22 (690 Wörter). Firmware v3 liefert 705 Wörter; alle vom Add-on genutzten Register liegen dort an derselben Position. Ist die Antwort **kürzer** als erwartet, lädt der Client das Modell aus der Weboberfläche der Anlage (`js/bundle.js`, gzip-komprimiert ausgeliefert) und liest daraus die Konstanten `VlxDevConstants.RANGE_START_*` / `RANGE_END_*` und `VlxReadConstants.CYC_NUM_OF_*`.

## Verwendete Register

Adressen wie in der Vallox-Modbus-Dokumentation (D5269).

| Adresse | Name | Zugriff | Verwendung |
|---|---|---|---|
| 4353 | FAN_SPEED | lesen | aktuelle Lüfterleistung % |
| 4354 | TEMP_EXTRACT_AIR | lesen | Abluft |
| 4355 | TEMP_EXHAUST_AIR | lesen | Fortluft |
| 4356 | TEMP_OUTDOOR_AIR | lesen | Außenluft |
| 4358 | TEMP_SUPPLY_AIR | lesen | Zuluft |
| 4361 / 4362 | EXTR/SUPP_FAN_SPEED | lesen | Drehzahl rpm (nur Probe-Tool) |
| 4363 | RH_VALUE | lesen | Luftfeuchte %, 0 = kein Sensor |
| 4364 | CO2_VALUE | lesen | CO₂ ppm (nur Probe-Tool) |
| 4609 | STATE | lesen/schreiben | 0 = Zuhause, 1 = Abwesend |
| 4610 | MODE | lesen | 5 = Anlage aus |
| 4612 | BOOST_TIMER | lesen/schreiben | Restminuten Boost, 65535 = unbegrenzt |
| 4613 | FIREPLACE_TIMER | lesen/schreiben | Restminuten Kamin |
| 4614 | EXTRA_TIMER | lesen/schreiben | programmierbares Profil (wird nur beendet) |
| 4620 | REMAINING_TIME_FOR_FILTER | lesen | Tage bis Filterwechsel |
| 4621 | LIMP_MODE | lesen | 1 = Störung/Notbetrieb |
| 20501 | AWAY_SPEED_SETTING | lesen/schreiben | Lüfterleistung Abwesend % |
| 20507 | HOME_SPEED_SETTING | lesen/schreiben | Lüfterleistung Zuhause % |
| 20513 | BOOST_SPEED_SETTING | lesen/schreiben | Lüfterleistung Boost % |
| 20544 / 20545 | BOOST_TIME / FIREPLACE_TIME | lesen | Standarddauer, wenn im Add-on 0 eingestellt ist |
| 36865 | TOTAL_FAULT_COUNT | lesen | Anzahl Fehlereinträge |
| 36866 ff. | Fehlertabelle | lesen | je 6 Wörter: Code, Schwere, erstes/letztes Datum, Anzahl, Aktivität (1 = aktiv) |

Temperaturen sind in Hundertstel Kelvin angegeben: °C = (Wert − 27315) / 100. Der Wert 0 bedeutet „kein Messwert“.

## Befehle des Add-ons

| Aktion | geschriebene Register |
|---|---|
| Zuhause aktivieren | 4609 = 0, 4612 = 0, 4613 = 0, 4614 = 0, 20507 = Leistung (falls > 0) |
| Abwesend an/aus | 4609 = 1 / 0 |
| Boost starten | 4612 = Dauer, 4613 = 0, 4614 = 0 |
| Kamin starten | 4613 = Dauer, 4612 = 0, 4614 = 0 |
| Boost/Kamin beenden | 4612 = 0 bzw. 4613 = 0 |
| Lüfterleistung setzen | 20507, 20501 oder 20513 je nach aktivem Profil |
