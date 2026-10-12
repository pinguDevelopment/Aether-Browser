# Aether Browser

Ein schneller, sicherheitsbewusster Desktop-Browser für **macOS, Windows und Linux** mit futuristischem Design und eingebautem **AI-Chat**. Gebaut mit Electron (Chromium) und TypeScript.

> Status: **Prototyp (v0.2.3)**

## Funktionen

- **Tabs** mit Drag & Drop, Mittelklick zum Schließen, Favicons und Ladeanzeige
- **Adressleiste** mit Suche, Inline-Autovervollständigung aus Verlauf und Lesezeichen, Schloss-Symbol und Zähler für blockierte Tracker
- **Startseite** mit Uhr, Suche und Lesezeichen-Kacheln
- **Lesezeichen**, **Verlauf**, **Suchen auf Seite** (Strg+F), **Zoom**, Downloads, Kontextmenü
- **AI-Chat** als Seitenleiste (Strg+Umschalt+A) und als eigener Tab
  - Cloud: Anthropic Claude, OpenAI, Google Gemini, eigener OpenAI-kompatibler Endpunkt
  - Lokal: Ollama, LM Studio
  - „Seite einbeziehen“: Der Text der aktuellen Seite wird als Kontext mitgeschickt
  - **Agent-Modus** (Kästchen im Chat, standardmäßig aus): Die AI darf Tabs lesen, öffnen, wechseln und schließen, navigieren, klicken, tippen und scrollen. Jeder Schritt wird im Chat angezeigt; Einstellungen und API-Keys sind für den Agenten gesperrt.
  - Rechtsklick auf markierten Text: „Mit AI erklären“, Rechtsklick auf die Seite: „Seite mit AI zusammenfassen“
- **Dark Mode für alle Webseiten** (abschaltbar): nutzt das eigene dunkle Design einer Seite, sonst wird sie lesbar umgefärbt, Bilder behalten ihre Farben
- **Updates**: *Einstellungen → Über Aether Browser → Nach Updates suchen*, oder die Update-Pille in der Toolbar. Windows und Linux installieren neue Versionen selbst und starten neu. Auf macOS wird die neue `.dmg` geladen und geöffnet (automatisches Ersetzen braucht ein Apple-Entwicklerzertifikat).
- **Einstellungen**: Suchmaschine, Akzentfarbe, Datenschutz, Website-Berechtigungen, AI-Anbieter und API-Keys

## Sicherheit

| Bereich | Umsetzung |
| --- | --- |
| Prozess-Isolation | Jede Website läuft in einem eigenen, sandboxed Renderer (`sandbox`, `contextIsolation`, kein Node.js). Die Oberfläche ist ebenfalls sandboxed. |
| IPC | Die Oberfläche spricht nur über eine schmale Preload-Brücke; der Hauptprozess akzeptiert IPC ausschließlich von der eigenen UI und prüft alle Eingaben. |
| Nur HTTPS | HTTP wird automatisch auf HTTPS umgestellt. Klappt das nicht, gibt es eine Warnseite mit bewusstem „Trotzdem unverschlüsselt laden“. |
| Tracker & Werbung | Netzwerkfilter mit den Ghostery-Listen (EasyList, EasyPrivacy u. a.), eingebaute Notfall-Liste falls offline. |
| Cookies | Drittanbieter-Cookies werden blockiert. |
| Signale | „Do Not Track“ und Global Privacy Control. |
| Berechtigungen | Kamera, Mikrofon, Standort usw. nur nach Nachfrage, Entscheidungen pro Website änderbar. USB/HID/Serial/Bluetooth gesperrt. |
| Pop-ups & Fenster | Seiten können keine nativen Fenster öffnen; Pop-ups werden blockiert, Links öffnen als Tab. |
| API-Keys | Mit dem Schlüsselbund des Betriebssystems verschlüsselt (`safeStorage`), sie verlassen nie den Hauptprozess. Ohne Schlüsselbund werden Keys nur im Arbeitsspeicher gehalten. |
| AI & Seiteninhalt | Seiteninhalte werden in einer isolierten Welt ausgelesen und dem Modell als „Daten, keine Anweisungen“ übergeben. |
| Gepackte App | Electron-Fuses: kein `RunAsNode`, keine `NODE_OPTIONS`, ASAR-Integritätsprüfung, Cookie-Verschlüsselung. |
| Daten | Optional: alle Browserdaten beim Beenden löschen. |

## Entwickeln

Voraussetzung: Node.js 22+

```bash
npm install
npm start          # baut und startet die App
npm run typecheck  # TypeScript-Prüfung
```

## Installer bauen

```bash
npm run dist:linux   # AppImage + .deb
npm run dist:win     # NSIS-Installer (.exe), auf Windows ausführen
npm run dist:mac     # .dmg + .zip, auf macOS ausführen
```

Die Ergebnisse landen in `release/`.

**Release veröffentlichen:** Version in `package.json` anpassen, dann entweder einen Tag pushen (`git tag v0.3.0 && git push origin v0.3.0`) oder auf GitHub unter *Actions → Build → Run workflow* „release“ anhaken. GitHub Actions baut alle Installer und erstellt daraus automatisch ein Release.

Der GitHub-Actions-Workflow `.github/workflows/build.yml` baut bei jedem Push auf `main` automatisch für alle drei Systeme und stellt die Installer als Artefakte bereit. Die Builds sind noch **nicht signiert**; macOS und Windows zeigen beim ersten Start daher eine Warnung.

## Tastenkürzel

| Aktion | Kürzel |
| --- | --- |
| Neuer Tab / Tab schließen | Strg/Cmd+T / Strg/Cmd+W |
| Adressleiste | Strg/Cmd+L |
| Nächster / vorheriger Tab | Strg+Tab / Strg+Umschalt+Tab |
| Neu laden | Strg/Cmd+R, F5 |
| Suchen auf Seite | Strg/Cmd+F |
| Lesezeichen setzen | Strg/Cmd+D |
| Verlauf | Strg/Cmd+Y |
| AI-Seitenleiste | Strg/Cmd+Umschalt+A |
| Einstellungen | Strg/Cmd+, |
| Zoom | Strg/Cmd + / − / 0 |
| Entwicklertools der Seite | F12 |

## Projektstruktur

```
src/
  main/       Hauptprozess: Fenster, Tabs, Sicherheit, AI-Anbieter, Speicher
  preload/    Schmale, typisierte Brücke zwischen UI und Hauptprozess
  renderer/   Oberfläche (TypeScript ohne Framework, eigenes CSS)
  shared/     Gemeinsame Typen
scripts/      esbuild-Build
build/        App-Icon
```
