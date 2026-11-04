# RemoteDesk

Eigene Fernsteuerung im Stil von Chrome Remote Desktop – mit **festem Code + PIN**.

**Webseite zum Verbinden:** https://laudisa01.github.io/remote-desk/

## So funktioniert es

1. **Auf dem Computer, den du steuern willst:** RemoteDesk herunterladen und installieren
   - [Windows](https://github.com/Laudisa01/remote-desk/releases/latest/download/RemoteDesk-Setup.exe)
   - [Mac – Apple Silicon (M1/M2/M3/M4)](https://github.com/Laudisa01/remote-desk/releases/latest/download/RemoteDesk-arm64.dmg)
   - [Mac – Intel](https://github.com/Laudisa01/remote-desk/releases/latest/download/RemoteDesk-x64.dmg)
2. Beim ersten Start eine **PIN** (6–12 Ziffern) festlegen. Die App zeigt den **Computer-Code** (9 Ziffern) – der bleibt **immer gleich**.
3. **Auf einem beliebigen anderen Computer:** https://laudisa01.github.io/remote-desk/ öffnen, Code + PIN eingeben → du siehst und steuerst den Computer. Mit **⛶ Vollbild** wie am eigenen PC.

Die App läuft im Hintergrund weiter (Symbol in Menüleiste/Taskleiste), wenn du das Fenster schließt. Mit „Beim Anmelden automatisch starten“ ist der Computer nach jedem Neustart erreichbar.

## Erster Start

**Windows:** „Der Computer wurde durch Windows geschützt“ → *Weitere Informationen → Trotzdem ausführen* (die App ist nicht signiert).

**Mac:** Rechtsklick auf RemoteDesk → *Öffnen*. Danach in der App auf **Bildschirmaufnahme** und **Bedienungshilfen** klicken und RemoteDesk in den Systemeinstellungen erlauben. Anschließend RemoteDesk über das Menüleisten-Symbol beenden und neu öffnen.

## Bedienung im Browser

- **▾** oben in der Mitte: Vollbild, Qualität, Text in die Zwischenablage senden, Tastenkombinationen, Trennen.
- Im Vollbild (Chrome/Edge) gehen auch Esc, Alt+Tab und die Windows-Taste an den anderen Computer. Vollbild verlassen: **Esc lange gedrückt halten**.
- Gemerkte Computer erscheinen oben in der Liste (nur Code + Name, nie die PIN).

## Sicherheit

- Zugriff nur mit Code **und** PIN. Die PIN wird nur als Hash (scrypt) gespeichert.
- Nach 5 falschen PINs ist der Zugang 15 Minuten gesperrt.
- Optional: „Jeden Zugriff hier zusätzlich bestätigen“.
- Während einer Sitzung zeigt die App deutlich „Dieser Computer wird ferngesteuert“ mit Trennen-Knopf (auch im Tray-Menü).
- Bild und Steuerung laufen per WebRTC Ende-zu-Ende verschlüsselt zwischen den Computern. Für den Verbindungsaufbau wird der kostenlose öffentliche [PeerJS](https://peerjs.com)-Vermittlungsdienst genutzt (sieht nur die Verbindungsdaten, nicht Bild oder Eingaben).

## Aufbau

| Ordner | Inhalt |
|---|---|
| `docs/` | Viewer-Webseite (GitHub Pages) |
| `host/` | Electron-App für den gesteuerten Computer (Bildschirmaufnahme, Maus/Tastatur über nut-js) |

## Selbst bauen

[Node.js 20+](https://nodejs.org) installieren, dann:

```bash
cd host
npm install
npm start          # App testen
npx electron-builder --mac dmg --arm64 --x64 --win nsis --x64   # Installer bauen → host/dist/
```

Scrollgeschwindigkeit: `scrollPixelsPerStep` in der Konfigurationsdatei der App (`~/Library/Application Support/RemoteDesk/config.json` bzw. `%APPDATA%\RemoteDesk\config.json`), kleiner = schneller.
