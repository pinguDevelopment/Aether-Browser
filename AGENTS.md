# AGENTS.md – Aether Browser

Arbeitsnotizen für alle, die (Mensch oder KI) an diesem Repo weiterarbeiten. Bitte bei jeder größeren Änderung aktualisieren.

## Ziel

Vollständiger Desktop-Browser für macOS, Windows und Linux. Futuristisches, modernes Design, eingebauter AI-Chat-Tab, performant und mit starken Sicherheitseinstellungen. Aktuell: **Prototyp**.

## Entscheidungen

- **Electron + TypeScript**, Build mit **esbuild** (`scripts/build.mjs`), Packaging mit **electron-builder**.
- **Kein UI-Framework**: Die Oberfläche ist schlankes TypeScript mit eigenem `h()`-Helper (`src/renderer/dom.ts`) und eigenem CSS. Das hält Start und Speicherverbrauch klein.
- **Tabs = `WebContentsView`s** (kein `<webview>`), die der Hauptprozess über der UI positioniert. Die UI meldet die Fläche (`#stage`) per `ui:viewport`. Alles, was über einer Webseite liegen müsste, muss daher in Titel- oder Toolbar-Bereich oder in eine Leiste darüber (siehe Toasts, Berechtigungs- und Suchleiste). Alternativ `ui:overlay` nutzen, das die Seite ausblendet.
- **Interne Seiten** (`aether://newtab|settings|history|bookmarks|ai`) werden von der UI gerendert, nicht als echte URLs geladen.
- **AI-Anbieter**: Anthropic über das offizielle SDK `@anthropic-ai/sdk` (Standardmodell `claude-opus-5-5`, Streaming, Server-Fallback bei Ablehnung für unterstützte Modelle). Alle anderen (OpenAI, Gemini, Ollama, LM Studio, eigener Endpunkt) über die OpenAI-kompatible `/chat/completions`-Schnittstelle.
- **API-Keys** nur im Hauptprozess, verschlüsselt mit `safeStorage`. Die UI sieht nur, *ob* ein Key existiert.
- **Tracker-Blocker**: `@ghostery/adblocker` `FiltersEngine` wird direkt in einem eigenen `onBeforeRequest` aufgerufen (nicht `enableBlockingInSession`), weil Electron pro Session nur einen Listener je webRequest-Event erlaubt und wir dort auch HTTPS-Upgrade und Cookie-Filter brauchen. Engine-Cache: `<userData>/adblock-engine.bin`.
- Name: **Aether Browser** (Repo `pinguDevelopment/AetherBrowser`, vorher `WebBrowser`). Installer heißen `Aether-Browser-<version>-<os>-<arch>.<ext>`.
- **Releases**: Tag `v*` pushen → Workflow baut alle Systeme und erstellt ein GitHub-Release mit allen Installern (Job `release`).
- Sprache der Oberfläche: **Deutsch**.
- **Paketgröße**: Alle Laufzeit-Pakete stehen in `devDependencies`, weil esbuild sie in `dist/` bündelt; so landet kein `node_modules` im Installer (app.asar < 1 MB). Nur Locales `de` und `en-US`, Kompression `maximum`, DMG als `ULFO`. Der Rest (~90 MB pro Installer) ist Chromium selbst.
- **Dark Mode erzwingen** (`src/main/darkmode.ts`, Einstellung `forceDarkMode`): Zuerst wird Seiten per DevTools-Protokoll `prefers-color-scheme: dark` gemeldet (nativeTheme allein erreicht Seiteninhalte nicht auf jedem System), damit Seiten mit eigenem Dark Theme dieses nutzen. Ist der Seitenhintergrund danach noch hell, wird per `insertCSS` invertiert; Bilder/Videos werden zurück-invertiert. Hinweis: `insertCSS` mit `cssOrigin: 'user'` lässt sich nicht wieder entfernen, daher Author-Origin.
- **macOS-Signatur**: ad-hoc (`identity: "-"`), da noch kein Apple-Zertifikat. Ohne Signatur meldet Apple Silicon „beschädigt“. CI prüft die Signatur mit `codesign --verify`.

## Stand (v0.1.0)

Erledigt:
- Fenster mit eigener Titelleiste (macOS Ampel, Windows/Linux Overlay-Buttons)
- Tabs (neu, schließen, wechseln, verschieben, Mittelklick), Adressleiste mit Suche und Inline-Autovervollständigung
- Startseite, Verlauf, Lesezeichen, Suchen auf Seite, Zoom, Kontextmenü, Downloads mit Hinweis
- Sicherheit: Sandbox überall, IPC-Absenderprüfung, Nur-HTTPS mit Warnseite, Tracker-/Werbeblocker, Drittanbieter-Cookies blockiert, DNT/GPC, Berechtigungsabfragen mit Merken, Pop-up-Blocker, Daten beim Beenden löschen, Electron-Fuses
- AI-Chat in Seitenleiste und als Tab, Anbieterwahl Cloud/lokal, Modellliste laden, Seitenkontext, „Mit AI erklären“, „Seite zusammenfassen“
- Einstellungsseite für alles oben
- Dark Mode für alle Webseiten erzwingen (Einstellungen → Allgemein), sofort umschaltbar
- Linux-Build (AppImage, .deb) lokal gebaut und gestartet; CI-Workflow für alle drei Systeme

Getestet (Linux, Xvfb, Playwright): Startseite, Navigation, Tracker-Zähler, Berechtigungsleiste, Link in neuem Tab, HTTPS-Fehlerseite, Einstellungen, AI-Chat mit einem lokalen Mock-Server (OpenAI-kompatibel). Der Anthropic-Pfad ist typgeprüft, aber nicht gegen die echte API getestet (kein Key in der Testumgebung).

## Offene Punkte / Ideen

- Code-Signing und Notarisierung (macOS, Windows), Auto-Update
- Kosmetisches Filtern (Elemente ausblenden) für den Werbeblocker
- Sitzung wiederherstellen (Tabs beim Neustart), geschlossene Tabs wieder öffnen
- Privates Fenster, Profile
- Download-Manager-Seite
- Chatverläufe speichern
- Vorschläge-Dropdown in der Adressleiste
- Tests automatisieren (Playwright-Skript ins Repo übernehmen)

## Befehle

```bash
npm install
npm start            # build + start
npm run typecheck
npm run dist:linux   # bzw. dist:win / dist:mac
```

In Containern als root: `npx electron --no-sandbox .` (die App respektiert `--no-sandbox` nur, wenn es explizit übergeben wird).
