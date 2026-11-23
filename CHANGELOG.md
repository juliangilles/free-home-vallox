# Changelog

## 0.1.3

- Neuer Aktor **„Vallox Zuhause“**: aktiviert das Profil Zuhause, beendet Boost/Kamin/programmierbares Profil und setzt die Lüfterleistung „Zuhause“ auf einen konfigurierbaren Wert (Standard 52 %).
- Neue Einstellung „Lüfterleistung für Aktor ‚Zuhause‘“.

## 0.1.2

- Herausgeber auf „J. Gilles“ gesetzt.

## 0.1.1

- Lüfterleistung ist über das Lüfter-Gerät einstellbar; geschrieben wird der Sollwert des aktiven Profils (Zuhause, Abwesend, Boost).

## 0.1.0

- Erste Version: Temperaturen, Luftfeuchte, Lüfterleistung, Profile Abwesend/Boost/Kamin, Störungs- und Filterstatus, Benachrichtigungen, Konfiguration im SysAP.
- Behoben: 100 % CPU und blockiertes Add-on, wenn das Feuchte-Gerät beim ersten Start noch angelegt wurde.
- Behoben: Datenmodell aus der Anlage nachladen funktionierte nicht, weil `bundle.js` gzip-komprimiert ausgeliefert wird.
