import { app, safeStorage } from 'electron';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Bookmark, HistoryEntry, ProviderId, SecretsStatus, Settings } from '../shared/types';
import { PROVIDERS } from '../shared/types';

const dir = () => app.getPath('userData');

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(dir(), name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write: write to a temp file, then rename over the target. */
function writeJson(name: string, data: unknown) {
  mkdirSync(dir(), { recursive: true });
  const target = join(dir(), name);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, target);
}

/** Debounced writer so frequent updates (history, titles) don't hit the disk on every change. */
function debouncedWriter(name: string, get: () => unknown, delay = 800) {
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    writeJson(name, get());
  };
  return {
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, delay);
    },
    flush,
  };
}

const record = <T>(fn: (id: ProviderId) => T) =>
  Object.fromEntries(PROVIDERS.map((p) => [p.id, fn(p.id)])) as Record<ProviderId, T>;

export const DEFAULT_SETTINGS: Settings = {
  searchEngine: 'duckduckgo',
  homeShowsBookmarks: true,
  accent: 'cyan',
  forceDarkMode: false,
  httpsOnly: true,
  blockTrackers: true,
  blockThirdPartyCookies: true,
  sendDoNotTrack: true,
  saveHistory: true,
  clearOnExit: false,
  permissionDefault: 'ask',
  blockPopups: true,
  aiProvider: 'anthropic',
  aiModels: record((id) => PROVIDERS.find((p) => p.id === id)!.defaultModel),
  aiBaseUrls: record((id) => PROVIDERS.find((p) => p.id === id)!.defaultBaseUrl),
  aiSystemPrompt:
    'Du bist Aether, ein hilfreicher Assistent, der in einen Webbrowser eingebaut ist. Antworte präzise und in der Sprache des Nutzers.',
  aiAllowPageContext: true,
};

// ---------- Settings ----------

let settings: Settings;
const settingsWriter = debouncedWriter('settings.json', () => settings, 200);

export function getSettings(): Settings {
  if (!settings) {
    const saved = readJson<Partial<Settings>>('settings.json', {});
    settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      aiModels: { ...DEFAULT_SETTINGS.aiModels, ...saved.aiModels },
      aiBaseUrls: { ...DEFAULT_SETTINGS.aiBaseUrls, ...saved.aiBaseUrls },
    };
  }
  return settings;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const current = getSettings();
  // Only accept keys we know about, so the UI can't inject arbitrary data.
  const clean: Partial<Settings> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (key in patch && typeof patch[key] === typeof DEFAULT_SETTINGS[key]) {
      (clean as Record<string, unknown>)[key] = patch[key];
    }
  }
  settings = { ...current, ...clean };
  settingsWriter.schedule();
  return settings;
}

// ---------- Secrets (API keys) ----------
// Keys are encrypted with the OS keychain via safeStorage and never leave the main process.

const memoryOnly = new Map<ProviderId, string>();

export function encryptionLevel(): SecretsStatus['encryption'] {
  if (!safeStorage.isEncryptionAvailable()) return 'unavailable';
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return 'weak';
  return 'os';
}

function readSecrets(): Record<string, string> {
  return readJson<Record<string, string>>('secrets.json', {});
}

export function setApiKey(provider: ProviderId, key: string) {
  const secrets = readSecrets();
  const trimmed = key.trim();
  if (!trimmed) {
    delete secrets[provider];
    memoryOnly.delete(provider);
  } else if (encryptionLevel() === 'os') {
    secrets[provider] = safeStorage.encryptString(trimmed).toString('base64');
  } else {
    // Without a real keychain we refuse to persist the key and keep it for this session only.
    memoryOnly.set(provider, trimmed);
  }
  writeJson('secrets.json', secrets);
}

export function getApiKey(provider: ProviderId): string | undefined {
  if (memoryOnly.has(provider)) return memoryOnly.get(provider);
  const enc = readSecrets()[provider];
  if (!enc) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return undefined;
  }
}

export function secretsStatus(): SecretsStatus {
  const stored = Object.keys(readSecrets()) as ProviderId[];
  const configured = Array.from(new Set([...stored, ...memoryOnly.keys()]));
  return { configured, encryption: encryptionLevel() };
}

// ---------- History ----------

const HISTORY_LIMIT = 5000;
let history: HistoryEntry[] | undefined;
const historyWriter = debouncedWriter('history.json', () => history ?? []);

export function getHistory(): HistoryEntry[] {
  history ??= readJson<HistoryEntry[]>('history.json', []);
  return history;
}

export function addHistory(url: string, title: string) {
  const list = getHistory();
  if (list[0]?.url === url) {
    list[0].title = title || list[0].title;
    list[0].visitedAt = Date.now();
  } else {
    list.unshift({ url, title, visitedAt: Date.now() });
    if (list.length > HISTORY_LIMIT) list.length = HISTORY_LIMIT;
  }
  historyWriter.schedule();
}

export function updateHistoryTitle(url: string, title: string) {
  const entry = getHistory().find((e) => e.url === url);
  if (entry && title) {
    entry.title = title;
    historyWriter.schedule();
  }
}

export function clearHistory() {
  history = [];
  historyWriter.flush();
}

// ---------- Bookmarks ----------

let bookmarks: Bookmark[] | undefined;
const bookmarksWriter = debouncedWriter('bookmarks.json', () => bookmarks ?? [], 100);

export function getBookmarks(): Bookmark[] {
  bookmarks ??= readJson<Bookmark[]>('bookmarks.json', []);
  return bookmarks;
}

export function toggleBookmark(url: string, title: string, favicon?: string): boolean {
  const list = getBookmarks();
  const idx = list.findIndex((b) => b.url === url);
  if (idx >= 0) {
    list.splice(idx, 1);
    bookmarksWriter.schedule();
    return false;
  }
  list.push({ id: crypto.randomUUID(), url, title: title || url, favicon, createdAt: Date.now() });
  bookmarksWriter.schedule();
  return true;
}

export function removeBookmark(id: string) {
  bookmarks = getBookmarks().filter((b) => b.id !== id);
  bookmarksWriter.schedule();
}

// ---------- Site permissions ----------

type SitePerms = Record<string, Record<string, 'allow' | 'deny'>>;
let sitePerms: SitePerms | undefined;
const permsWriter = debouncedWriter('permissions.json', () => sitePerms ?? {}, 100);

export function getSitePermissions(): SitePerms {
  sitePerms ??= readJson<SitePerms>('permissions.json', {});
  return sitePerms;
}

export function setSitePermission(origin: string, permission: string, value: 'allow' | 'deny' | null) {
  const all = getSitePermissions();
  const site = (all[origin] ??= {});
  if (value === null) delete site[permission];
  else site[permission] = value;
  if (Object.keys(site).length === 0) delete all[origin];
  permsWriter.schedule();
}

export function flushAll() {
  settingsWriter.flush();
  if (history) historyWriter.flush();
  if (bookmarks) bookmarksWriter.flush();
  if (sitePerms) permsWriter.flush();
}
