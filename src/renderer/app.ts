import type { Bookmark, HistoryEntry, PermissionPrompt, Settings, TabState, TabsSnapshot } from '../shared/types';
import { ChatPanel } from './chat';
import { $, api, faviconEl, h, hostOf, toast } from './dom';
import { icon } from './icons';
import { bookmarksPage, historyPage, newTabPage, permissionName, settingsPage, type PageCtx } from './pages';

let settings: Settings;
let snap: TabsSnapshot = { tabs: [], activeId: -1 };
let bookmarkedUrls = new Set<string>();
const prompts: PermissionPrompt[] = [];

const els = {
  tabstrip: $('#tabstrip'),
  address: $<HTMLInputElement>('#address'),
  siteIcon: $('#site-icon'),
  shield: $('#shield-badge'),
  zoom: $('#zoom-badge'),
  star: $<HTMLButtonElement>('#star-btn'),
  back: $<HTMLButtonElement>('#back-btn'),
  forward: $<HTMLButtonElement>('#forward-btn'),
  reload: $<HTMLButtonElement>('#reload-btn'),
  loadBar: $('#load-bar'),
  stage: $('#stage'),
  viewport: $('#viewport'),
  internal: $('#internal'),
  error: $('#errorpage'),
  sidebar: $('#sidebar'),
  permbar: $('#permbar'),
  findbar: $('#findbar'),
};

const activeTab = (): TabState | undefined => snap.tabs.find((t) => t.id === snap.activeId);

// ---------- settings ----------

async function saveSettings(patch: Partial<Settings>) {
  settings = (await api.settings.set(patch)) as Settings;
  applyTheme();
  sidebarChat?.refreshProvider();
  pageChat?.refreshProvider();
}

function applyTheme() {
  document.documentElement.dataset.accent = settings.accent;
}

const ctx: PageCtx = {
  settings: () => settings,
  saveSettings,
  navigate: (input) => api.tabs.navigate(snap.activeId, input),
  openTab: (input) => api.tabs.create(input),
};

// ---------- viewport sync: tell the main process where the web page should be drawn ----------

let lastRect = '';
function syncViewport() {
  const r = els.stage.getBoundingClientRect();
  const rect = { x: r.left, y: r.top, width: r.width, height: r.height };
  const key = JSON.stringify(rect);
  if (key === lastRect) return;
  lastRect = key;
  void api.ui.viewport(rect);
}
new ResizeObserver(syncViewport).observe(els.stage);
window.addEventListener('resize', syncViewport);

// ---------- tab strip ----------

let dragId: number | undefined;

function renderTabs() {
  const items = snap.tabs.map((t, index) => {
    const fav = t.loading
      ? h('span', { class: 'spinner' })
      : t.kind === 'internal'
        ? icon(t.page === 'ai' ? 'spark' : t.page === 'settings' ? 'settings' : t.page === 'history' ? 'history' : t.page === 'bookmarks' ? 'bookmarks' : 'plus', 'tab-icon')
        : faviconEl(t.favicon, hostOf(t.url)[0]?.toUpperCase());
    const el = h('div', {
      class: `tab ${t.id === snap.activeId ? 'active' : ''}`,
      title: t.title,
      attrs: { draggable: 'true', role: 'tab' },
      onmousedown: (e: MouseEvent) => {
        if (e.button === 0) void api.tabs.activate(t.id);
      },
      onauxclick: (e: MouseEvent) => {
        if (e.button === 1) void api.tabs.close(t.id);
      },
      ondragstart: () => (dragId = t.id),
      ondragover: (e: DragEvent) => e.preventDefault(),
      ondrop: () => {
        if (dragId !== undefined && dragId !== t.id) void api.tabs.move(dragId, index);
        dragId = undefined;
      },
    },
    fav,
    h('span', { class: 'tab-title', text: t.title || hostOf(t.url) || 'Neuer Tab' }),
    h('button', { class: 'tab-close', title: 'Tab schließen', onmousedown: (e: MouseEvent) => e.stopPropagation(), onclick: () => api.tabs.close(t.id) }, icon('close')),
    );
    return el;
  });
  els.tabstrip.replaceChildren(...items);
  els.tabstrip.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---------- toolbar ----------

function displayUrl(t: TabState) {
  if (t.kind === 'internal') return t.page === 'newtab' ? '' : t.url;
  return t.error?.url ?? t.url;
}

function renderToolbar() {
  const t = activeTab();
  if (!t) return;
  if (document.activeElement !== els.address) els.address.value = displayUrl(t);
  els.back.disabled = !t.canGoBack;
  els.forward.disabled = !t.canGoForward;
  els.reload.replaceChildren(icon(t.loading ? 'stop' : 'reload'));
  els.reload.title = t.loading ? 'Laden stoppen' : 'Neu laden';
  els.loadBar.classList.toggle('active', t.loading);

  const insecure = t.kind === 'web' && !t.secure && !/^https?:\/\/(localhost|127\.)/.test(t.url);
  els.siteIcon.replaceChildren(icon(t.kind === 'internal' ? 'spark' : t.secure ? 'lock' : 'unlock'));
  els.siteIcon.className = insecure ? 'insecure' : t.secure ? 'secure' : '';
  els.siteIcon.title = t.kind === 'internal' ? 'Aether-Seite' : t.secure ? 'Verbindung ist verschlüsselt' : 'Verbindung ist NICHT verschlüsselt';

  els.shield.hidden = t.kind !== 'web';
  els.shield.replaceChildren(icon('shield'), h('span', { text: String(t.blocked) }));
  els.shield.classList.toggle('active', t.blocked > 0);

  els.zoom.hidden = t.zoom === 1;
  els.zoom.textContent = `${Math.round(t.zoom * 100)} %`;

  els.star.hidden = t.kind !== 'web';
  els.star.classList.toggle('on', bookmarkedUrls.has(t.url));
}

async function refreshBookmarks() {
  bookmarkedUrls = new Set(((await api.bookmarks.get()) as Bookmark[]).map((b) => b.url));
  renderToolbar();
}

// Inline autocomplete from history and bookmarks.
let suggestPool: string[] = [];
els.address.addEventListener('focus', async () => {
  els.address.select();
  const hist = (await api.history.get('')) as HistoryEntry[];
  const books = (await api.bookmarks.get()) as Bookmark[];
  suggestPool = Array.from(new Set([...books.map((b) => b.url), ...hist.map((e) => e.url)]));
});
els.address.addEventListener('input', (e) => {
  if ((e as InputEvent).inputType?.startsWith('delete')) return;
  const typed = els.address.value;
  if (typed.length < 2 || /\s/.test(typed)) return;
  const lower = typed.toLowerCase();
  for (const url of suggestPool) {
    const bare = url.replace(/^https?:\/\/(www\.)?/, '');
    if (bare.toLowerCase().startsWith(lower)) {
      const host = bare.split('/')[0];
      const completion = host.length >= typed.length && host.toLowerCase().startsWith(lower) ? host : bare;
      els.address.value = typed + completion.slice(typed.length);
      els.address.setSelectionRange(typed.length, els.address.value.length);
      return;
    }
  }
});
els.address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const value = els.address.value.trim();
    if (!value) return;
    void api.tabs.navigate(snap.activeId, value);
    els.address.blur();
  } else if (e.key === 'Escape') {
    const t = activeTab();
    if (t) els.address.value = displayUrl(t);
    els.address.blur();
  }
});

$('#newtab-btn').append(icon('plus'));
$('#newtab-btn').onclick = () => api.tabs.create();
els.back.append(icon('back'));
els.back.onclick = () => api.nav.back();
els.forward.append(icon('forward'));
els.forward.onclick = () => api.nav.forward();
els.reload.onclick = () => (activeTab()?.loading ? api.nav.stop() : api.nav.reload());
els.star.append(icon('star'));
els.star.onclick = toggleBookmark;
els.zoom.onclick = () => api.nav.zoom('reset');
$('#bookmarks-btn').append(icon('bookmarks'));
$('#bookmarks-btn').onclick = () => openInternal('bookmarks');
$('#history-btn').append(icon('history'));
$('#history-btn').onclick = () => openInternal('history');
$('#ai-btn').append(icon('spark'));
$('#ai-btn').onclick = () => toggleSidebar();
$('#settings-btn').append(icon('settings'));
$('#settings-btn').onclick = () => openInternal('settings');

/** Reuse an existing tab of that internal page, otherwise open a new one. */
function openInternal(page: string) {
  const existing = snap.tabs.find((t) => t.kind === 'internal' && t.page === page);
  if (existing) void api.tabs.activate(existing.id);
  else void api.tabs.create(`aether://${page}`);
}

async function toggleBookmark() {
  const added = (await api.bookmarks.toggle()) as boolean;
  toast(added ? 'Lesezeichen hinzugefügt' : 'Lesezeichen entfernt');
  await refreshBookmarks();
}

// ---------- stage: internal pages & error page ----------

let renderedKey = '';
let pageChat: ChatPanel | undefined;

async function renderStage() {
  const t = activeTab();
  if (!t) return;
  els.viewport.hidden = t.kind !== 'web' || !!t.error;
  els.internal.hidden = t.kind !== 'internal';
  els.error.hidden = !t.error;

  if (t.error) {
    const err = t.error;
    els.error.replaceChildren(
      h('div', { class: 'error-card' },
        icon('warn', 'glow big'),
        h('h1', { text: err.httpsUpgrade ? 'Keine sichere Verbindung möglich' : 'Seite nicht erreichbar' }),
        h('p', { class: 'muted', text: `${hostOf(err.url)} · ${err.description} (${err.code})` }),
        err.httpsUpgrade
          ? h('p', { text: 'Der Modus „Nur HTTPS“ ist aktiv. Diese Seite unterstützt möglicherweise keine verschlüsselte Verbindung. Daten, die du dort eingibst, könnten von Dritten mitgelesen werden.' })
          : null,
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', onclick: () => api.nav.reload(), text: 'Erneut versuchen' }),
          err.httpsUpgrade ? h('button', { class: 'btn danger', onclick: () => api.nav.allowHttp(t.id), text: 'Trotzdem unverschlüsselt laden' }) : null,
        ),
      ),
    );
  }

  const key = t.kind === 'internal' ? `${t.id}:${t.page}` : '';
  if (key === renderedKey) return;
  renderedKey = key;
  if (t.kind !== 'internal') {
    els.internal.replaceChildren();
    return;
  }
  let page: HTMLElement;
  switch (t.page) {
    case 'settings': page = await settingsPage(ctx); break;
    case 'history': page = await historyPage(ctx); break;
    case 'bookmarks': page = await bookmarksPage(ctx); break;
    case 'ai':
      pageChat ??= new ChatPanel('page', () => settings, () => openInternal('settings'));
      page = h('div', { class: 'page ai-page' }, pageChat.el);
      requestAnimationFrame(() => pageChat?.focus());
      break;
    default: page = await newTabPage(ctx);
  }
  // A newer render may have happened while we awaited.
  if (renderedKey === key) els.internal.replaceChildren(page);
}

// ---------- AI sidebar ----------

let sidebarChat: ChatPanel | undefined;

function toggleSidebar(force?: boolean) {
  const open = force ?? els.sidebar.hidden === true;
  if (open && !sidebarChat) {
    sidebarChat = new ChatPanel('sidebar', () => settings, () => openInternal('settings'));
    els.sidebar.append(
      h('div', { class: 'sidebar-actions' },
        h('button', { class: 'icon-btn small', title: 'Als Tab öffnen', onclick: () => openInternal('ai') }, icon('sidebar')),
        h('button', { class: 'icon-btn small', title: 'Schließen', onclick: () => toggleSidebar(false) }, icon('close')),
      ),
      sidebarChat.el,
    );
  }
  els.sidebar.hidden = !open;
  $('#ai-btn').classList.toggle('on', open);
  if (open) sidebarChat?.focus();
  syncViewport();
}

api.on('ai:summarize', () => {
  toggleSidebar(true);
  sidebarChat!.ask('Fasse diese Seite in wenigen Stichpunkten zusammen.', true);
});
api.on('ai:ask', (p) => {
  toggleSidebar(true);
  sidebarChat!.ask(`Erkläre mir Folgendes im Kontext dieser Seite:\n\n„${(p as { text: string }).text.slice(0, 4000)}“`, true);
});

// ---------- find in page ----------

const findInput = h('input', { attrs: { placeholder: 'Auf Seite suchen', spellcheck: 'false' } });
const findCount = h('span', { class: 'muted find-count' });
els.findbar.append(
  icon('search'), findInput, findCount,
  h('button', { class: 'icon-btn small', title: 'Vorheriger Treffer', onclick: () => api.find.start(findInput.value, false, true) }, icon('up')),
  h('button', { class: 'icon-btn small', title: 'Nächster Treffer', onclick: () => api.find.start(findInput.value, true, true) }, icon('down')),
  h('button', { class: 'icon-btn small', title: 'Schließen', onclick: () => closeFind() }, icon('close')),
);
findInput.addEventListener('input', () => api.find.start(findInput.value, true, false));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void api.find.start(findInput.value, !e.shiftKey, true);
  if (e.key === 'Escape') closeFind();
});
api.on('find:result', (p) => {
  const r = p as { active: number; total: number };
  findCount.textContent = findInput.value ? `${r.active}/${r.total}` : '';
});
function openFind() {
  if (activeTab()?.kind !== 'web') return;
  els.findbar.hidden = false;
  findInput.focus();
  findInput.select();
  syncViewport();
}
function closeFind() {
  els.findbar.hidden = true;
  findCount.textContent = '';
  void api.find.stop();
  syncViewport();
}

// ---------- permission prompts ----------

function renderPermbar() {
  const p = prompts.find((x) => x.tabId === snap.activeId);
  els.permbar.hidden = !p;
  if (p) {
    const remember = h('input', { attrs: { type: 'checkbox', checked: true } });
    const answer = (allow: boolean) => api.perms.answer(p.id, allow, remember.checked);
    els.permbar.replaceChildren(
      icon('shield', 'glow'),
      h('span', {}, h('strong', { text: hostOf(p.origin) }), ` möchte Zugriff auf: ${permissionName(p.permission)}`),
      h('label', { class: 'remember' }, remember, h('span', { text: 'Entscheidung merken' })),
      h('button', { class: 'btn', onclick: () => answer(false), text: 'Blockieren' }),
      h('button', { class: 'btn primary', onclick: () => answer(true), text: 'Erlauben' }),
    );
  }
  syncViewport();
}
api.on('perm:prompt', (p) => {
  prompts.push(p as PermissionPrompt);
  renderPermbar();
});
api.on('perm:close', (p) => {
  const idx = prompts.findIndex((x) => x.id === (p as { id: number }).id);
  if (idx >= 0) prompts.splice(idx, 1);
  renderPermbar();
});

// ---------- events from main ----------

api.on('tabs:update', (p) => {
  const prevActive = snap.activeId;
  snap = p as TabsSnapshot;
  if (prevActive !== snap.activeId && !els.findbar.hidden) closeFind();
  renderTabs();
  renderToolbar();
  void renderStage();
  renderPermbar();
});
api.on('toast', (p) => toast((p as { text: string }).text));
api.on('cmd', (name) => {
  switch (name) {
    case 'focus-address': els.address.focus(); els.address.select(); break;
    case 'find': openFind(); break;
    case 'toggle-ai': toggleSidebar(); break;
    case 'bookmark': void toggleBookmark(); break;
  }
});

// ---------- boot ----------

document.body.dataset.platform = api.platform;
(async () => {
  settings = (await api.settings.get()) as Settings;
  applyTheme();
  syncViewport();
  await refreshBookmarks();
  const initial = (await api.tabs.get()) as TabsSnapshot | undefined;
  if (initial?.tabs.length) {
    snap = initial;
    renderTabs();
    renderToolbar();
    void renderStage();
  }
})();
