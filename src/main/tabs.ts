import { BrowserWindow, Menu, WebContentsView, clipboard, type Session, type WebContents } from 'electron';
import type { InternalPage, TabError, TabState, TabsSnapshot } from '../shared/types';
import { upgradedHosts } from './security';
import { addHistory, getSettings, updateHistoryTitle } from './store';

const INTERNAL_PAGES: InternalPage[] = ['newtab', 'settings', 'history', 'bookmarks', 'ai'];
const SEARCH_URLS = {
  duckduckgo: 'https://duckduckgo.com/?q=',
  brave: 'https://search.brave.com/search?q=',
  startpage: 'https://www.startpage.com/do/search?q=',
  google: 'https://www.google.com/search?q=',
  ecosia: 'https://www.ecosia.org/search?q=',
};
const PAGE_TITLES: Record<InternalPage, string> = {
  newtab: 'Neuer Tab',
  settings: 'Einstellungen',
  history: 'Verlauf',
  bookmarks: 'Lesezeichen',
  ai: 'AI Chat',
};

interface Tab extends TabState {
  view?: WebContentsView;
}

interface Rect { x: number; y: number; width: number; height: number }

/** Turns whatever the user typed into a URL: internal page, web address or search query. */
export function resolveInput(input: string): string {
  const text = input.trim();
  if (!text) return 'aether://newtab';
  if (/^aether:\/\//i.test(text)) return text.toLowerCase();
  if (/^(https?|about):/i.test(text)) return text;
  const looksLikeHost = /^(localhost|\[[0-9a-f:]+\]|(\d{1,3}\.){3}\d{1,3}|([\w-]+\.)+[a-z]{2,})(:\d+)?(\/.*)?$/i.test(text);
  if (looksLikeHost && !/\s/.test(text)) {
    const local = /^(localhost|127\.|\[::1\])/.test(text);
    return `${local ? 'http' : 'https'}://${text}`;
  }
  return SEARCH_URLS[getSettings().searchEngine] + encodeURIComponent(text);
}

const internalPageOf = (url: string): InternalPage | undefined => {
  const m = /^aether:\/\/([a-z]+)/.exec(url);
  return m && INTERNAL_PAGES.includes(m[1] as InternalPage) ? (m[1] as InternalPage) : undefined;
};

export class TabManager {
  private tabs = new Map<number, Tab>();
  private order: number[] = [];
  private nextId = 1;
  private viewport: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private overlay = false;
  private attached?: WebContentsView;
  activeId = -1;

  constructor(
    private win: BrowserWindow,
    private ses: Session,
    private send: (channel: string, payload: unknown) => void,
  ) {}

  // ---------- public API ----------

  snapshot(): TabsSnapshot {
    return {
      activeId: this.activeId,
      tabs: this.order.map((id) => {
        const { view: _view, ...state } = this.tabs.get(id)!;
        return state;
      }),
    };
  }

  create(input = 'aether://newtab', opts: { background?: boolean; afterId?: number } = {}): number {
    const id = this.nextId++;
    const tab: Tab = {
      id, kind: 'internal', url: '', title: '', loading: false, canGoBack: false,
      canGoForward: false, secure: false, blocked: 0, zoom: 1,
    };
    this.tabs.set(id, tab);
    const at = opts.afterId !== undefined ? this.order.indexOf(opts.afterId) + 1 : this.order.length;
    this.order.splice(at > 0 ? at : this.order.length, 0, id);
    this.navigate(id, input);
    if (!opts.background || this.activeId === -1) this.activate(id);
    else this.emit();
    return id;
  }

  close(id: number) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const idx = this.order.indexOf(id);
    this.order.splice(idx, 1);
    this.tabs.delete(id);
    this.destroyView(tab);
    if (this.order.length === 0) {
      this.create();
      return;
    }
    if (this.activeId === id) this.activate(this.order[Math.min(idx, this.order.length - 1)]);
    else this.emit();
  }

  activate(id: number) {
    if (!this.tabs.has(id)) return;
    this.activeId = id;
    this.layout();
    this.emit();
    this.tabs.get(id)!.view?.webContents.focus();
  }

  cycle(step: 1 | -1) {
    const idx = this.order.indexOf(this.activeId);
    this.activate(this.order[(idx + step + this.order.length) % this.order.length]);
  }

  move(id: number, toIndex: number) {
    const from = this.order.indexOf(id);
    if (from < 0) return;
    this.order.splice(from, 1);
    this.order.splice(Math.max(0, Math.min(toIndex, this.order.length)), 0, id);
    this.emit();
  }

  navigate(id: number, input: string) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const url = resolveInput(input);
    const page = internalPageOf(url);
    tab.error = undefined;
    if (page) {
      this.destroyView(tab);
      Object.assign(tab, {
        kind: 'internal', page, url: `aether://${page}`, title: PAGE_TITLES[page], favicon: undefined,
        loading: false, canGoBack: false, canGoForward: false, secure: true, blocked: 0,
      });
    } else {
      if (!tab.view) this.createView(tab);
      Object.assign(tab, { kind: 'web', page: undefined, url, title: url, loading: true, blocked: 0 });
      tab.view!.webContents.loadURL(url).catch(() => {/* reported via did-fail-load */});
    }
    if (id === this.activeId) this.layout();
    this.emit();
  }

  active(): Tab | undefined {
    return this.tabs.get(this.activeId);
  }

  get(id: number): Tab | undefined {
    return this.tabs.get(id);
  }

  webContentsOfActive(): WebContents | undefined {
    return this.active()?.view?.webContents;
  }

  back() { this.webContentsOfActive()?.navigationHistory.goBack(); }
  forward() { this.webContentsOfActive()?.navigationHistory.goForward(); }
  stop() { this.webContentsOfActive()?.stop(); }
  reload(hard = false) {
    const tab = this.active();
    if (!tab) return;
    if (tab.error) return this.navigate(tab.id, tab.error.url);
    const wc = tab.view?.webContents;
    if (hard) wc?.reloadIgnoringCache();
    else wc?.reload();
  }

  setZoom(delta: number | 'reset') {
    const tab = this.active();
    const wc = tab?.view?.webContents;
    if (!tab || !wc) return;
    const next = delta === 'reset' ? 1 : Math.min(3, Math.max(0.3, Math.round((tab.zoom + delta) * 10) / 10));
    tab.zoom = next;
    wc.setZoomFactor(next);
    this.emit();
  }

  find(text: string, forward = true, findNext = false) {
    const wc = this.webContentsOfActive();
    if (!wc) return;
    if (!text) wc.stopFindInPage('clearSelection');
    else wc.findInPage(text, { forward, findNext });
  }

  stopFind() {
    this.webContentsOfActive()?.stopFindInPage('clearSelection');
  }

  setViewport(rect: Rect) {
    this.viewport = {
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)),
    };
    this.layout();
  }

  /** While the UI shows a menu/dialog over the page, hide the native page view. */
  setOverlay(open: boolean) {
    this.overlay = open;
    this.layout();
  }

  tabIdForWebContents(wcId: number): number | undefined {
    for (const tab of this.tabs.values()) if (tab.view?.webContents.id === wcId) return tab.id;
    return undefined;
  }

  noteBlocked(wcId: number) {
    const id = this.tabIdForWebContents(wcId);
    if (id === undefined) return;
    this.tabs.get(id)!.blocked++;
    this.emitSoon();
  }

  async pageText(maxChars = 60_000): Promise<{ title: string; url: string; text: string } | undefined> {
    const tab = this.active();
    const wc = tab?.view?.webContents;
    if (!tab || !wc || tab.kind !== 'web') return undefined;
    // Runs in an isolated world so the page's own scripts can't tamper with the extraction.
    const text = (await wc.executeJavaScriptInIsolatedWorld(1001, [
      { code: '(document.body && document.body.innerText) || ""' },
    ])) as string;
    return { title: tab.title, url: tab.url, text: String(text).slice(0, maxChars) };
  }

  destroyAll() {
    for (const tab of this.tabs.values()) this.destroyView(tab);
  }

  // ---------- internals ----------

  private emitTimer?: NodeJS.Timeout;
  private emit() {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = undefined;
    this.send('tabs:update', this.snapshot());
  }
  /** Coalesce bursts of updates (e.g. blocked-request counters). */
  private emitSoon() {
    this.emitTimer ??= setTimeout(() => this.emit(), 120);
  }

  private layout() {
    const tab = this.active();
    const want = tab && tab.kind === 'web' && !tab.error && !this.overlay ? tab.view : undefined;
    if (this.attached && this.attached !== want) {
      this.win.contentView.removeChildView(this.attached);
      this.attached = undefined;
    }
    if (want) {
      if (this.attached !== want) {
        this.win.contentView.addChildView(want);
        this.attached = want;
      }
      want.setBounds(this.viewport);
    }
  }

  private destroyView(tab: Tab) {
    if (!tab.view) return;
    if (this.attached === tab.view) {
      this.win.contentView.removeChildView(tab.view);
      this.attached = undefined;
    }
    tab.view.webContents.close();
    tab.view = undefined;
  }

  private createView(tab: Tab) {
    const view = new WebContentsView({
      webPreferences: {
        session: this.ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
        safeDialogs: true,
        spellcheck: true,
        webviewTag: false,
      },
    });
    view.setBackgroundColor('#0b0d14');
    tab.view = view;
    const wc = view.webContents;
    const update = (patch: Partial<Tab>) => {
      Object.assign(tab, patch);
      this.emit();
    };
    const syncNav = () => ({
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    });

    wc.on('did-start-loading', () => update({ loading: true }));
    wc.on('did-stop-loading', () => update({ loading: false, ...syncNav() }));
    wc.on('page-title-updated', (_e, title) => {
      update({ title });
      if (getSettings().saveHistory) updateHistoryTitle(wc.getURL(), title);
    });
    wc.on('page-favicon-updated', (_e, icons) => update({ favicon: icons.find((i) => i.startsWith('https:')) ?? icons[0] }));
    wc.on('did-navigate', (_e, url) => {
      update({ url, error: undefined, secure: url.startsWith('https:'), zoom: wc.getZoomFactor(), ...syncNav() });
      if (getSettings().saveHistory && /^https?:/.test(url)) addHistory(url, wc.getTitle());
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) update({ url, ...syncNav() });
    });
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3 /* ABORTED */) return;
      let host = '';
      try { host = new URL(url).hostname; } catch { /* keep empty */ }
      const error: TabError = { code, description, url, httpsUpgrade: url.startsWith('https:') && upgradedHosts.has(host) };
      update({ error, loading: false, url, title: host || url });
      if (tab.id === this.activeId) this.layout();
    });
    wc.on('render-process-gone', (_e, details) => {
      update({ error: { code: 0, description: `Seite abgestürzt (${details.reason})`, url: tab.url, httpsUpgrade: false }, loading: false });
      if (tab.id === this.activeId) this.layout();
    });
    wc.on('found-in-page', (_e, result) => this.send('find:result', { active: result.activeMatchOrdinal, total: result.matches }));
    wc.on('zoom-changed', (_e, dir) => this.setZoom(dir === 'in' ? 0.1 : -0.1));

    // Only web schemes are allowed to load inside a tab.
    wc.on('will-navigate', (e, url) => {
      if (!/^(https?:|about:blank)/.test(url)) e.preventDefault();
    });
    wc.on('will-redirect', (e, url) => {
      if (!/^https?:/.test(url)) e.preventDefault();
    });
    // Never open native windows: links/popups become tabs (or get blocked).
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (!/^https?:/.test(url)) return { action: 'deny' };
      if (disposition === 'new-window' && getSettings().blockPopups) {
        this.send('toast', { text: 'Pop-up blockiert', url });
        return { action: 'deny' };
      }
      this.create(url, { background: disposition === 'background-tab', afterId: tab.id });
      return { action: 'deny' };
    });
    wc.on('context-menu', (_e, params) => this.showContextMenu(tab, params));
  }

  private showContextMenu(tab: Tab, p: Electron.ContextMenuParams) {
    const wc = tab.view!.webContents;
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (p.linkURL && /^https?:/.test(p.linkURL)) {
      items.push(
        { label: 'Link in neuem Tab öffnen', click: () => this.create(p.linkURL, { background: true, afterId: tab.id }) },
        { label: 'Linkadresse kopieren', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' },
      );
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push(
        { label: 'Bild in neuem Tab öffnen', click: () => this.create(p.srcURL, { background: true, afterId: tab.id }) },
        { label: 'Bild speichern unter …', click: () => wc.downloadURL(p.srcURL) },
        { label: 'Bildadresse kopieren', click: () => clipboard.writeText(p.srcURL) },
        { type: 'separator' },
      );
    }
    if (p.selectionText) {
      const sel = p.selectionText.trim();
      items.push(
        { label: 'Kopieren', role: 'copy' },
        { label: `Mit AI erklären: „${sel.slice(0, 24)}${sel.length > 24 ? '…' : ''}“`, click: () => this.send('ai:ask', { text: sel }) },
        { label: `Suchen nach „${sel.slice(0, 24)}${sel.length > 24 ? '…' : ''}“`, click: () => this.create(sel, { afterId: tab.id }) },
        { type: 'separator' },
      );
    }
    if (p.isEditable) {
      items.push(
        { label: 'Ausschneiden', role: 'cut' },
        { label: 'Kopieren', role: 'copy' },
        { label: 'Einfügen', role: 'paste' },
        { label: 'Alles auswählen', role: 'selectAll' },
        { type: 'separator' },
      );
      if (p.misspelledWord && p.dictionarySuggestions.length) {
        items.unshift(
          ...p.dictionarySuggestions.slice(0, 4).map((s) => ({ label: s, click: () => wc.replaceMisspelling(s) })),
          { type: 'separator' as const },
        );
      }
    }
    items.push(
      { label: 'Zurück', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Vorwärts', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Neu laden', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Seite mit AI zusammenfassen', click: () => this.send('ai:summarize', {}) },
      { label: 'Element untersuchen', click: () => wc.inspectElement(p.x, p.y) },
    );
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }
}
