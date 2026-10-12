import { app, BrowserWindow, ipcMain, Menu, session, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { join } from 'node:path';
import type { ChatRequest, PermissionPrompt, ProviderId, Settings } from '../shared/types';
import { PROVIDERS } from '../shared/types';
import { cancelChat, listModels, streamChat } from './ai';
import { clearBrowsingData, hardenUiSession, hardenWebSession, httpExceptions } from './security';
import * as store from './store';
import { TabManager } from './tabs';

// Sandbox every renderer process, including our own UI (unless explicitly started with --no-sandbox, e.g. in CI containers).
if (!app.commandLine.hasSwitch('no-sandbox')) app.enableSandbox();
app.setName('Aether');

const WEB_PARTITION = 'persist:aether-web';
let win: BrowserWindow | undefined;
let tabs: TabManager | undefined;

const send = (channel: string, payload: unknown) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

// ---------- permission prompts ----------

let nextPromptId = 1;
const pendingPrompts = new Map<number, (r: { allow: boolean; remember: boolean }) => void>();

function askPermission(wc: WebContents, origin: string, permission: string) {
  return new Promise<{ allow: boolean; remember: boolean }>((resolve) => {
    const tabId = tabs?.tabIdForWebContents(wc.id);
    if (tabId === undefined) return resolve({ allow: false, remember: false });
    const id = nextPromptId++;
    const timeout = setTimeout(() => finish({ allow: false, remember: false }), 60_000);
    const finish = (r: { allow: boolean; remember: boolean }) => {
      clearTimeout(timeout);
      pendingPrompts.delete(id);
      send('perm:close', { id });
      resolve(r);
    };
    pendingPrompts.set(id, finish);
    send('perm:prompt', { id, tabId, origin, permission } satisfies PermissionPrompt);
  });
}

// ---------- window ----------

function createWindow() {
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#07080d',
    title: 'Aether',
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { color: '#0a0c14', symbolColor: '#b9c4ff', height: 40 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);

  // The UI may never navigate away from the bundled page or open windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const webSession = session.fromPartition(WEB_PARTITION);
  tabs = new TabManager(win, webSession, send);

  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    tabs?.destroyAll();
    tabs = undefined;
    win = undefined;
  });

  win.loadFile(join(__dirname, '../renderer/index.html'));
  win.webContents.once('did-finish-load', () => {
    const startUrl = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => /^https?:\/\//.test(a));
    tabs?.create(startUrl ?? 'aether://newtab');
  });
}

// ---------- application menu (keyboard shortcuts work even while a page has focus) ----------

function buildMenu() {
  const cmd = (name: string) => () => send('cmd', name);
  const t = () => tabs;
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'Datei',
      submenu: [
        { label: 'Neuer Tab', accelerator: 'CmdOrCtrl+T', click: () => t()?.create() },
        { label: 'Tab schließen', accelerator: 'CmdOrCtrl+W', click: () => t() && t()!.close(t()!.activeId) },
        { label: 'Adresse eingeben', accelerator: 'CmdOrCtrl+L', click: cmd('focus-address') },
        { label: 'Einstellungen', accelerator: 'CmdOrCtrl+,', click: () => t()?.create('aether://settings') },
        { type: 'separator' },
        { role: 'quit', label: 'Beenden' },
      ],
    },
    { role: 'editMenu', label: 'Bearbeiten' },
    {
      label: 'Ansicht',
      submenu: [
        { label: 'Neu laden', accelerator: 'CmdOrCtrl+R', click: () => t()?.reload() },
        { label: 'Neu laden', accelerator: 'F5', visible: false, click: () => t()?.reload() },
        { label: 'Neu laden ohne Cache', accelerator: 'CmdOrCtrl+Shift+R', click: () => t()?.reload(true) },
        { label: 'Suchen …', accelerator: 'CmdOrCtrl+F', click: cmd('find') },
        { type: 'separator' },
        { label: 'Vergrößern', accelerator: 'CmdOrCtrl+Plus', click: () => t()?.setZoom(0.1) },
        { label: 'Vergrößern', accelerator: 'CmdOrCtrl+=', visible: false, click: () => t()?.setZoom(0.1) },
        { label: 'Verkleinern', accelerator: 'CmdOrCtrl+-', click: () => t()?.setZoom(-0.1) },
        { label: 'Originalgröße', accelerator: 'CmdOrCtrl+0', click: () => t()?.setZoom('reset') },
        { type: 'separator' },
        { label: 'AI-Seitenleiste', accelerator: 'CmdOrCtrl+Shift+A', click: cmd('toggle-ai') },
        { label: 'Vollbild', role: 'togglefullscreen' },
        { label: 'Entwicklertools (Seite)', accelerator: 'F12', click: () => t()?.webContentsOfActive()?.toggleDevTools() },
        ...(!app.isPackaged ? [{ label: 'Entwicklertools (Oberfläche)', accelerator: 'CmdOrCtrl+Shift+F12', click: () => win?.webContents.toggleDevTools() }] : []),
      ],
    },
    {
      label: 'Verlauf',
      submenu: [
        { label: 'Zurück', accelerator: process.platform === 'darwin' ? 'Cmd+[' : 'Alt+Left', click: () => t()?.back() },
        { label: 'Vorwärts', accelerator: process.platform === 'darwin' ? 'Cmd+]' : 'Alt+Right', click: () => t()?.forward() },
        { label: 'Verlauf anzeigen', accelerator: 'CmdOrCtrl+Y', click: () => t()?.create('aether://history') },
        { label: 'Lesezeichen setzen', accelerator: 'CmdOrCtrl+D', click: cmd('bookmark') },
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Nächster Tab', accelerator: 'Ctrl+Tab', click: () => t()?.cycle(1) },
        { label: 'Vorheriger Tab', accelerator: 'Ctrl+Shift+Tab', click: () => t()?.cycle(-1) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC ----------

/** Only accept IPC from our own UI page, never from websites. */
function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R) {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!win || event.sender !== win.webContents || !event.senderFrame?.url.startsWith('file://')) {
      throw new Error('Blocked IPC from untrusted sender');
    }
    return fn(...(args as A));
  });
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : -1);
const str = (v: unknown, max = 8192) => (typeof v === 'string' ? v.slice(0, max) : '');
const isProvider = (v: unknown): v is ProviderId => PROVIDERS.some((p) => p.id === v);

function registerIpc() {
  handle('tabs:get', () => tabs?.snapshot());
  handle('tabs:create', (input?: unknown, background?: unknown) => tabs?.create(str(input) || undefined, { background: background === true }));
  handle('tabs:close', (id: unknown) => tabs?.close(num(id)));
  handle('tabs:activate', (id: unknown) => tabs?.activate(num(id)));
  handle('tabs:navigate', (id: unknown, input: unknown) => tabs?.navigate(num(id), str(input)));
  handle('tabs:move', (id: unknown, index: unknown) => tabs?.move(num(id), num(index)));
  handle('nav:back', () => tabs?.back());
  handle('nav:forward', () => tabs?.forward());
  handle('nav:reload', () => tabs?.reload());
  handle('nav:stop', () => tabs?.stop());
  handle('nav:zoom', (d: unknown) => tabs?.setZoom(d === 'reset' ? 'reset' : num(d)));
  handle('nav:allowHttp', (id: unknown) => {
    const tab = tabs?.get(num(id));
    if (!tab?.error) return;
    const url = new URL(tab.error.url);
    httpExceptions.add(url.hostname);
    url.protocol = 'http:';
    tabs?.navigate(tab.id, url.toString());
  });
  handle('find:start', (text: unknown, forward: unknown, next: unknown) => tabs?.find(str(text, 500), forward !== false, next === true));
  handle('find:stop', () => tabs?.stopFind());

  handle('ui:viewport', (r: unknown) => {
    const rect = r as { x: number; y: number; width: number; height: number };
    if (rect && [rect.x, rect.y, rect.width, rect.height].every((n) => typeof n === 'number')) tabs?.setViewport(rect);
  });
  handle('ui:overlay', (open: unknown) => tabs?.setOverlay(open === true));
  handle('ui:openExternal', (url: unknown) => {
    const u = str(url);
    if (/^https:\/\//.test(u)) void shell.openExternal(u);
  });

  handle('settings:get', () => store.getSettings());
  handle('settings:set', (patch: unknown) => store.updateSettings((patch ?? {}) as Partial<Settings>));
  handle('secrets:status', () => store.secretsStatus());
  handle('secrets:set', (provider: unknown, key: unknown) => {
    if (!isProvider(provider)) return store.secretsStatus();
    store.setApiKey(provider, str(key, 512));
    return store.secretsStatus();
  });

  handle('history:get', (query: unknown) => {
    const q = str(query, 200).toLowerCase();
    const list = store.getHistory();
    return (q ? list.filter((e) => e.url.toLowerCase().includes(q) || e.title.toLowerCase().includes(q)) : list).slice(0, 500);
  });
  handle('history:clear', () => store.clearHistory());
  handle('bookmarks:get', () => store.getBookmarks());
  handle('bookmarks:toggle', () => {
    const tab = tabs?.active();
    if (!tab || tab.kind !== 'web') return false;
    return store.toggleBookmark(tab.url, tab.title, tab.favicon);
  });
  handle('bookmarks:remove', (id: unknown) => store.removeBookmark(str(id)));

  handle('perms:list', () => store.getSitePermissions());
  handle('perms:set', (origin: unknown, perm: unknown, value: unknown) =>
    store.setSitePermission(str(origin), str(perm), value === 'allow' || value === 'deny' ? value : null));
  handle('perm:answer', (id: unknown, allow: unknown, remember: unknown) =>
    pendingPrompts.get(num(id))?.({ allow: allow === true, remember: remember === true }));

  handle('data:clear', async () => {
    await clearBrowsingData(session.fromPartition(WEB_PARTITION));
    store.clearHistory();
  });

  handle('ai:chat', async (req: unknown) => {
    const r = req as ChatRequest;
    const requestId = str(r?.requestId, 64);
    const messages = (Array.isArray(r?.messages) ? r.messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: str(m.content, 200_000) }));
    let page;
    if (r?.includePage && store.getSettings().aiAllowPageContext) page = await tabs?.pageText().catch(() => undefined);
    void streamChat(requestId, messages, page, (e) => send('ai:event', e));
    return { pageTitle: page?.title };
  });
  handle('ai:cancel', (id: unknown) => cancelChat(str(id, 64)));
  handle('ai:models', async (provider: unknown) => (isProvider(provider) ? listModels(provider).catch(() => []) : []));
  handle('ai:activePage', () => {
    const tab = tabs?.active();
    return tab?.kind === 'web' ? { title: tab.title, url: tab.url } : undefined;
  });
}

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => /^https?:\/\//.test(a));
    if (url) tabs?.create(url);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // Defense in depth: no <webview> tags and no unexpected windows from any renderer.
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (e) => e.preventDefault());
  });

  app.whenReady().then(() => {
    hardenUiSession(session.defaultSession);
    const webSession = session.fromPartition(WEB_PARTITION);
    hardenWebSession(webSession, {
      onBlocked: (wcId) => tabs?.noteBlocked(wcId),
      askPermission,
    });
    webSession.on('will-download', (_e, item) => {
      send('toast', { text: `Download gestartet: ${item.getFilename()}` });
      item.once('done', (_ev, state) => {
        send('toast', { text: state === 'completed' ? `Download fertig: ${item.getFilename()}` : `Download abgebrochen: ${item.getFilename()}` });
      });
    });
    registerIpc();
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (!win) createWindow();
    });
  });

  let cleared = false;
  app.on('before-quit', (e) => {
    store.flushAll();
    if (store.getSettings().clearOnExit && !cleared) {
      e.preventDefault();
      cleared = true;
      store.clearHistory();
      clearBrowsingData(session.fromPartition(WEB_PARTITION)).finally(() => app.quit());
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
