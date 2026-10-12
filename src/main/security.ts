import { app, type Session, type WebContents } from 'electron';
import { FiltersEngine, Request } from '@ghostery/adblocker';
import { getDomain } from 'tldts';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSettings, getSitePermissions, setSitePermission } from './store';

/** Permissions that are harmless enough to grant without asking. */
const ALWAYS_ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);

/** Small built-in list used until (or if) the full filter lists are available. */
const FALLBACK_TRACKERS = [
  'doubleclick.net', 'googlesyndication.com', 'google-analytics.com', 'googletagmanager.com',
  'googleadservices.com', 'adservice.google.com', 'facebook.net', 'connect.facebook.net',
  'scorecardresearch.com', 'hotjar.com', 'taboola.com', 'outbrain.com', 'criteo.com',
  'adnxs.com', 'amazon-adsystem.com', 'quantserve.com', 'mixpanel.com', 'segment.io',
  'bat.bing.com', 'ads.linkedin.com', 'analytics.tiktok.com', 'adsrvr.org', 'rubiconproject.com',
  'pubmatic.com', 'openx.net', 'moatads.com', 'chartbeat.com', 'newrelic.com', 'clarity.ms',
];

let engine: FiltersEngine | undefined;

async function loadFilterEngine(ses: Session) {
  const cachePath = join(app.getPath('userData'), 'adblock-engine.bin');
  try {
    engine = await FiltersEngine.fromPrebuiltAdsAndTracking(
      // Fetch through the web session; the UI session only allows local files.
      (url: string) => ses.fetch(url),
      {
        path: cachePath,
        read: async (p: string) => new Uint8Array(await readFile(p)),
        write: (p: string, buf: Uint8Array) => writeFile(p, buf),
      },
    );
  } catch (err) {
    console.warn('[security] Filterlisten konnten nicht geladen werden, nutze eingebaute Liste:', err);
  }
}

const isLocalHost = (host: string) =>
  host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' ||
  /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith('.local');

function isThirdParty(requestUrl: string, topUrl: string | undefined): boolean {
  if (!topUrl || !/^https?:/.test(topUrl)) return false;
  const a = getDomain(requestUrl);
  const b = getDomain(topUrl);
  return !!a && !!b && a !== b;
}

function topLevelUrl(wc: WebContents | undefined | null): string | undefined {
  try {
    return wc && !wc.isDestroyed() ? wc.getURL() : undefined;
  } catch {
    return undefined;
  }
}

export interface SecurityHooks {
  onBlocked(webContentsId: number): void;
  askPermission(wc: WebContents, origin: string, permission: string): Promise<{ allow: boolean; remember: boolean }>;
}

/** Hosts the user explicitly allowed to load over plain HTTP during this session. */
export const httpExceptions = new Set<string>();
/** Hosts whose page load was upgraded from HTTP to HTTPS (used to offer an HTTP fallback on failure). */
export const upgradedHosts = new Set<string>();

export function hardenWebSession(ses: Session, hooks: SecurityHooks) {
  void loadFilterEngine(ses);

  // Present a regular Chrome user agent; "Electron" in the UA breaks many sites and aids fingerprinting.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|aether-browser|Aether)\/\S+/gi, ''));

  ses.webRequest.onBeforeRequest((details, callback) => {
    const s = getSettings();
    let url: URL;
    try {
      url = new URL(details.url);
    } catch {
      return callback({});
    }

    if (s.httpsOnly && url.protocol === 'http:' && !isLocalHost(url.hostname) && !httpExceptions.has(url.hostname)) {
      if (details.resourceType === 'mainFrame') upgradedHosts.add(url.hostname);
      url.protocol = 'https:';
      return callback({ redirectURL: url.toString() });
    }

    if (s.blockTrackers && details.resourceType !== 'mainFrame' && /^https?:$/.test(url.protocol)) {
      const source = details.frame?.url || topLevelUrl(details.webContents) || details.referrer;
      let blocked = false;
      if (engine) {
        const { match, redirect } = engine.match(
          Request.fromRawDetails({ url: details.url, sourceUrl: source, type: details.resourceType as never, requestId: String(details.id) }),
        );
        if (redirect) {
          // Replaced with a harmless stub (e.g. analytics shims) so the page keeps working.
          if (details.webContentsId !== undefined) hooks.onBlocked(details.webContentsId);
          return callback({ redirectURL: redirect.dataUrl });
        }
        blocked = match;
      } else {
        const domain = getDomain(details.url) ?? '';
        blocked = FALLBACK_TRACKERS.some((t) => url.hostname === t || url.hostname.endsWith(`.${t}`) || domain === t);
      }
      if (blocked) {
        if (details.webContentsId !== undefined) hooks.onBlocked(details.webContentsId);
        return callback({ cancel: true });
      }
    }
    callback({});
  });

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const s = getSettings();
    const headers = details.requestHeaders;
    if (s.sendDoNotTrack) {
      headers['DNT'] = '1';
      headers['Sec-GPC'] = '1';
    }
    if (s.blockThirdPartyCookies && details.resourceType !== 'mainFrame' && isThirdParty(details.url, topLevelUrl(details.webContents))) {
      delete headers['Cookie'];
    }
    callback({ requestHeaders: headers });
  });

  ses.webRequest.onHeadersReceived((details, callback) => {
    const s = getSettings();
    const headers = details.responseHeaders;
    if (headers && s.blockThirdPartyCookies && details.resourceType !== 'mainFrame' && isThirdParty(details.url, topLevelUrl(details.webContents))) {
      for (const key of Object.keys(headers)) if (key.toLowerCase() === 'set-cookie') delete headers[key];
    }
    callback({ responseHeaders: headers });
  });

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (ALWAYS_ALLOWED.has(permission)) return callback(true);
    let origin: string;
    try {
      origin = new URL(details.requestingUrl || wc.getURL()).origin;
    } catch {
      return callback(false);
    }
    const stored = getSitePermissions()[origin]?.[permission];
    if (stored) return callback(stored === 'allow');
    if (getSettings().permissionDefault === 'deny') return callback(false);
    hooks.askPermission(wc, origin, permission).then(({ allow, remember }) => {
      if (remember) setSitePermission(origin, permission, allow ? 'allow' : 'deny');
      callback(allow);
    }, () => callback(false));
  });

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (ALWAYS_ALLOWED.has(permission)) return true;
    return getSitePermissions()[requestingOrigin]?.[permission] === 'allow';
  });

  // No WebUSB / WebHID / WebSerial / Bluetooth access for websites in the prototype.
  ses.setDevicePermissionHandler(() => false);
}

/** The UI session only ever loads our own bundled files. */
export function hardenUiSession(ses: Session) {
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, cb) => {
    // Favicons are the only remote content the UI shows.
    const ok = details.url.startsWith('file://') || details.url.startsWith('devtools://') || details.url.startsWith('data:') ||
      (details.resourceType === 'image' && details.url.startsWith('https://'));
    cb({ cancel: !ok });
  });
}

export async function clearBrowsingData(ses: Session) {
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.clearAuthCache();
}
