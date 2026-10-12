import { app, session, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { createWriteStream, readFileSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UpdateStatus } from '../shared/types';

// Updates come from the GitHub releases of this repository.
// Windows (NSIS) and Linux (AppImage/.deb) install in place via electron-updater, which verifies the
// SHA-512 hash from latest*.yml. macOS in-place updates require an Apple Developer signature, so on
// macOS the new .dmg is downloaded and opened for the user to drag into Applications.
const REPO = 'pinguDevelopment/Aether-Browser';

let send: (s: UpdateStatus) => void = () => {};
let status: UpdateStatus = { state: 'idle', current: app.getVersion() };
// Own session: the UI session blocks all network access, the web session carries browsing data.
const updateFetch = (url: string, init?: RequestInit) => session.fromPartition('aether-updater').fetch(url, init);

let macAsset: { urls: string[]; name: string; size: number } | undefined;
let releasePage = `https://github.com/${REPO}/releases/latest`;

function set(next: Partial<UpdateStatus>) {
  status = { ...status, retry: false, ...next, current: app.getVersion() };
  send(status);
}

const supportsInPlace = () =>
  app.isPackaged && (process.platform === 'win32' || (process.platform === 'linux' && (!!process.env.APPIMAGE || isDeb())));

function isDeb() {
  try {
    // electron-builder writes the package type next to the app resources.
    return readFileSync(join(process.resourcesPath, 'package-type'), 'utf8').trim() === 'deb';
  } catch {
    return false;
  }
}

export function initUpdater(emit: (s: UpdateStatus) => void) {
  send = emit;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => set({ state: 'checking', message: undefined }));
  autoUpdater.on('update-not-available', () => set({ state: 'none' }));
  autoUpdater.on('update-available', (info) => set({ state: 'available', version: info.version }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', () => {
    set({ state: 'installing' });
    // Silent install, then relaunch the new version.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  });
  autoUpdater.on('error', (err) => set({ state: 'error', message: err?.message ?? String(err), retry: status.state === 'downloading' }));
}

export function getUpdateStatus(): UpdateStatus {
  return status;
}

const newer = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

export async function checkForUpdates() {
  if (!app.isPackaged) return set({ state: 'error', message: 'Updates gibt es nur in der installierten Version.' });
  if (supportsInPlace()) {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      set({ state: 'error', message: (err as Error).message });
    }
    return;
  }
  // macOS (and other installs without in-place support): look at the latest release ourselves.
  set({ state: 'checking', message: undefined });
  try {
    const res = await updateFetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub antwortet mit ${res.status}`);
    const rel = (await res.json()) as { tag_name: string; html_url: string; assets: { name: string; size: number; url: string; browser_download_url: string }[] };
    if (rel.html_url) releasePage = rel.html_url;
    const version = rel.tag_name.replace(/^v/, '');
    if (!newer(version, app.getVersion())) return set({ state: 'none' });
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const asset = rel.assets.find((a) => a.name.endsWith(`-mac-${arch}.dmg`));
    if (!asset) throw new Error('Kein passender Installer im Release gefunden.');
    // Two routes to the same file: the public download link and the API asset endpoint (separate redirect path).
    macAsset = { urls: [asset.browser_download_url, asset.url], name: asset.name, size: asset.size };
    set({ state: 'available', version });
  } catch (err) {
    set({ state: 'error', message: (err as Error).message });
  }
}

export async function installUpdate() {
  if (status.state !== 'available' && !(status.state === 'error' && status.retry)) return;
  if (supportsInPlace()) {
    set({ state: 'downloading', percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      set({ state: 'error', message: (err as Error).message, retry: true });
    }
    return;
  }
  if (!macAsset) return;
  const asset = macAsset;
  const target = join(app.getPath('downloads'), asset.name);
  const part = `${target}.download`;
  set({ state: 'downloading', percent: 0, message: undefined });
  let lastError = '';
  // GitHub's download CDN occasionally answers 502/503/504: retry with backoff, then try the other route.
  for (const url of asset.urls) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
      try {
        await download(url, part, asset.size);
        await rename(part, target);
        set({ state: 'manual', message: 'Das Installationsfenster ist geöffnet: Aether Browser in „Programme“ ziehen, ersetzen und neu starten.' });
        await shell.openPath(target);
        return;
      } catch (err) {
        lastError = (err as Error).message;
        await rm(part, { force: true }).catch(() => {});
        if (/\(4\d\d\)/.test(lastError) && !/\(429\)/.test(lastError)) break; // client errors won't fix themselves
      }
    }
  }
  set({ state: 'error', message: `${lastError}. Du kannst das Update auch direkt von der Release-Seite laden.`, retry: true });
}

async function download(url: string, file: string, expectedSize: number) {
  const headers: Record<string, string> = url.startsWith('https://api.github.com/') ? { Accept: 'application/octet-stream' } : {};
  const res = await updateFetch(url, { headers, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (${res.status})`);
  const total = Number(res.headers.get('content-length')) || expectedSize;
  let done = 0;
  let shown = -1;
  const body = Readable.fromWeb(res.body as never);
  body.on('data', (chunk: Buffer) => {
    done += chunk.length;
    const percent = total ? Math.min(100, Math.floor((done / total) * 100)) : 0;
    // One update per percent, not per network chunk.
    if (percent !== shown) set({ state: 'downloading', percent: (shown = percent) });
  });
  await pipeline(body, createWriteStream(file));
  if (expectedSize && done !== expectedSize) throw new Error('Download unvollständig');
}

export function openReleasePage() {
  void shell.openExternal(releasePage);
}
