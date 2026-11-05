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

**Mac:** RemoteDesk aus dem DMG in *Programme* ziehen und öffnen. Da die App nicht bei Apple notarisiert ist, kommt beim ersten Öffnen „Apple konnte nicht überprüfen …“ → *Fertig* klicken, dann *Systemeinstellungen → Datenschutz & Sicherheit* → ganz unten bei RemoteDesk **Dennoch öffnen** (ältere macOS-Versionen: Rechtsklick auf die App → *Öffnen*). Das ist nur einmal nötig. Danach in der App auf **Bildschirmaufnahme** und **Bedienungshilfen** klicken und RemoteDesk in den Systemeinstellungen erlauben. Anschließend RemoteDesk über das Menüleisten-Symbol beenden und neu öffnen.

## Bedienung im Browser

- **▾** oben in der Mitte öffnet die Leiste: Bildschirm wählen (einzeln oder **alle Bildschirme**), Qualität, Ton an/aus, Chat, Dateien senden/holen, Lupe, Aufnahme, Tastenkombinationen, Vollbild, Trennen.
- **Ton:** Der Ton des anderen Computers ist im Browser zu hören (abschaltbar in der App unter „Ton übertragen“).
- **Dateien:** Datei einfach ins Browserfenster ziehen – sie landet im Ordner „Downloads“ des anderen Computers. Mit „Datei holen“ öffnet sich dort ein Auswahlfenster; die gewählte Datei wird im Browser heruntergeladen.
- **Zwischenablage:** Kopierter Text wird automatisch in beide Richtungen abgeglichen (bis 15 000 Zeichen; der Browser fragt einmal nach der Erlaubnis).
- **Chat:** Nachrichten zwischen Browser und App.
- **Lupe:** 1,5× / 2× / 3× – das Bild folgt der Maus. Auf dem Handy mit zwei Fingern zoomen.
- **Aufnahme:** speichert die Sitzung als Video im Download-Ordner. Der andere Computer sieht dabei einen Hinweis.
- **Handy & Tablet:** Ein Finger bewegt die Maus wie ein Trackpad, Tippen klickt, lange drücken und ziehen = Ziehen, zwei Finger tippen = Rechtsklick, zwei Finger schieben = scrollen. Das Tastatur-Symbol öffnet die Bildschirmtastatur.
- **Mehrere Personen:** Wer sich zuerst verbindet, steuert. Bis zu 3 weitere können gleichzeitig zusehen. Trennt die steuernde Person, übernimmt der nächste.
- Im Vollbild (Chrome/Edge) gehen auch Esc, Alt+Tab und die Windows-Taste an den anderen Computer. Vollbild verlassen: **Esc lange gedrückt halten**.
- Gemerkte Computer erscheinen oben in der Liste (nur Code + Name, nie die PIN).

## In der App

- **Hilfe-Zugang:** „Einmal-PIN“ erzeugt eine 6-stellige PIN, die 10 Minuten und nur für eine Verbindung gilt. Der Zugriff muss am Computer bestätigt werden – so kann dir jemand helfen, ohne deine feste PIN zu kennen.
- **Bildschirm hier schwarz schalten** (während einer Sitzung): Die Monitore am Computer werden schwarz, die Übertragung zeigt weiter alles.
- **Nach dem Trennen Computer sperren**, **Mitteilung bei neuem Zugriff**, **Weitere Zuschauer erlauben**, **Ton übertragen**.
- **Verlauf:** wann sich wer (Browser + Gerät) verbunden hat, wie lange, und fehlgeschlagene Versuche.
- **Updates:** Die App prüft selbst auf neue Versionen und installiert sie per Knopfdruck (ab Version 1.1.0). Auf dem Mac musst du danach eventuell die Freigaben „Bildschirmaufnahme“ und „Bedienungshilfen“ neu erteilen, weil die App nicht bei Apple signiert ist.

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
