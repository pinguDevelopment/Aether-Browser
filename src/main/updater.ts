import { app, session, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { createWriteStream, readFileSync } from 'node:fs';
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

let macAsset: { url: string; name: string } | undefined;

function set(next: Partial<UpdateStatus>) {
  status = { ...status, ...next, current: app.getVersion() };
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
  autoUpdater.on('error', (err) => set({ state: 'error', message: err?.message ?? String(err) }));
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
    const rel = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
    const version = rel.tag_name.replace(/^v/, '');
    if (!newer(version, app.getVersion())) return set({ state: 'none' });
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const asset = rel.assets.find((a) => a.name.endsWith(`-mac-${arch}.dmg`));
    if (!asset) throw new Error('Kein passender Installer im Release gefunden.');
    macAsset = { url: asset.browser_download_url, name: asset.name };
    set({ state: 'available', version });
  } catch (err) {
    set({ state: 'error', message: (err as Error).message });
  }
}

export async function installUpdate() {
  if (status.state !== 'available') return;
  if (supportsInPlace()) {
    set({ state: 'downloading', percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      set({ state: 'error', message: (err as Error).message });
    }
    return;
  }
  if (!macAsset) return;
  try {
    set({ state: 'downloading', percent: 0 });
    const res = await updateFetch(macAsset.url);
    if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    let done = 0;
    const target = join(app.getPath('downloads'), macAsset.name);
    const body = Readable.fromWeb(res.body as never);
    body.on('data', (chunk: Buffer) => {
      done += chunk.length;
      if (total) set({ state: 'downloading', percent: Math.round((done / total) * 100) });
    });
    await pipeline(body, createWriteStream(target));
    set({ state: 'manual', message: 'Das Installationsfenster ist geöffnet: Aether Browser in „Programme“ ziehen, ersetzen und neu starten.' });
    await shell.openPath(target);
  } catch (err) {
    set({ state: 'error', message: (err as Error).message });
  }
}
