import type { WebContents } from 'electron';
import { getSettings } from './store';

// Forced dark mode for websites.
// 1. Pages that ship their own dark theme get it via `prefers-color-scheme: dark` (see nativeTheme in index.ts).
// 2. Pages that are still light after loading are inverted with a CSS filter. Images, videos and other media
//    are inverted back so photos keep their real colors and text stays high-contrast.

const INVERT_CSS = `
html {
  filter: invert(1) hue-rotate(180deg) !important;
  background-color: #fff !important;
}
img, picture, video, canvas, iframe, embed, object, svg image,
[style*="background-image"], [style*="background: url"], [style*="background:url"] {
  filter: invert(1) hue-rotate(180deg) !important;
}
/* Media nested inside already re-inverted media must not be flipped twice. */
picture img, [style*="background-image"] img, [style*="background-image"] [style*="background-image"] {
  filter: none !important;
}
`;

/** Runs in an isolated world: returns the relative luminance (0–1) of the page background. */
const LUMINANCE_PROBE = `(() => {
  const read = (el) => {
    if (!el) return null;
    const m = getComputedStyle(el).backgroundColor.match(/[\\d.]+/g);
    if (!m) return null;
    const alpha = m[3] === undefined ? 1 : Number(m[3]);
    if (alpha < 0.1) return null;
    return [Number(m[0]), Number(m[1]), Number(m[2])];
  };
  const rgb = read(document.body) || read(document.documentElement) || [255, 255, 255];
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
})()`;

const injected = new WeakMap<WebContents, string>();
const checking = new WeakSet<WebContents>();

/**
 * Tell the page that the user prefers a dark color scheme, so sites with their own dark theme use it.
 * nativeTheme alone does not reach page content on every platform, so this uses the DevTools protocol.
 */
export async function emulateDarkScheme(wc: WebContents, enabled: boolean) {
  if (wc.isDestroyed()) return;
  try {
    if (!wc.debugger.isAttached()) {
      if (!enabled) return;
      wc.debugger.attach('1.3');
    }
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: enabled ? [{ name: 'prefers-color-scheme', value: 'dark' }] : [],
    });
    if (!enabled) wc.debugger.detach();
  } catch {
    /* debugger busy or page gone: the CSS fallback below still applies */
  }
}

export async function applyDarkMode(wc: WebContents, enabled: boolean) {
  if (wc.isDestroyed()) return;
  const key = injected.get(wc);
  if (!enabled) {
    if (key) {
      injected.delete(wc);
      await wc.removeInsertedCSS(key).catch(() => {});
    }
    return;
  }
  if (key || checking.has(wc) || !/^https?:/.test(wc.getURL())) return;
  // dom-ready and did-finish-load both call this; only one check may run, or the CSS is inserted twice.
  checking.add(wc);
  try {
    const luminance = (await wc.executeJavaScriptInIsolatedWorld(1002, [{ code: LUMINANCE_PROBE }])) as number;
    // Already dark (native dark theme or a dark site): leave it alone.
    if (typeof luminance === 'number' && luminance < 0.45) return;
    const newKey = await wc.insertCSS(INVERT_CSS);
    // The setting may have been switched off while we were checking.
    if (wc.isDestroyed()) return;
    if (getSettings().forceDarkMode) injected.set(wc, newKey);
    else await wc.removeInsertedCSS(newKey);
  } catch {
    /* page navigated away or is not scriptable */
  } finally {
    checking.delete(wc);
  }
}

/** Inserted CSS belongs to the old document; forget it on navigation so the new page gets checked again. */
export function resetDarkMode(wc: WebContents) {
  injected.delete(wc);
}
