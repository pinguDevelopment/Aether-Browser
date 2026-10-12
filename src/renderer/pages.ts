import type { Bookmark, HistoryEntry, ProviderId, SecretsStatus, Settings } from '../shared/types';
import { PROVIDERS } from '../shared/types';
import { api, faviconEl, h, hostOf, toast } from './dom';
import { icon } from './icons';

export interface PageCtx {
  settings: () => Settings;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  navigate: (input: string) => void;
  openTab: (input: string) => void;
}

// ---------- New tab ----------

export async function newTabPage(ctx: PageCtx): Promise<HTMLElement> {
  const clock = h('div', { class: 'clock' });
  const date = h('div', { class: 'date' });
  const tick = () => {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    date.textContent = now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
  };
  tick();
  const timer = setInterval(() => (clock.isConnected ? tick() : clearInterval(timer)), 10_000);

  const search = h('input', {
    class: 'hero-search-input',
    attrs: { placeholder: 'Suchen oder Adresse eingeben', spellcheck: 'false', autofocus: true },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' && search.value.trim()) ctx.navigate(search.value);
    },
  });

  const bookmarks = ctx.settings().homeShowsBookmarks ? ((await api.bookmarks.get()) as Bookmark[]).slice(0, 12) : [];
  const page = h('div', { class: 'newtab' },
    h('div', { class: 'grid-bg' }),
    h('div', { class: 'hero' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }), h('span', { text: 'AETHER' })),
      clock,
      date,
      h('div', { class: 'hero-search' }, icon('search'), search),
      bookmarks.length
        ? h('div', { class: 'tiles' },
            ...bookmarks.map((b) =>
              h('button', { class: 'tile', title: b.url, onclick: () => ctx.navigate(b.url) },
                faviconEl(b.favicon, hostOf(b.url)[0]?.toUpperCase()),
                h('span', { text: b.title }),
              )))
        : null,
      h('div', { class: 'hero-footer' },
        h('span', { class: 'pill' }, icon('shield'), h('span', { text: ctx.settings().blockTrackers ? 'Tracker-Schutz aktiv' : 'Tracker-Schutz aus' })),
        h('span', { class: 'pill' }, icon('lock'), h('span', { text: ctx.settings().httpsOnly ? 'Nur HTTPS' : 'HTTP erlaubt' })),
      ),
    ),
  );
  requestAnimationFrame(() => search.focus());
  return page;
}

// ---------- History ----------

export async function historyPage(ctx: PageCtx): Promise<HTMLElement> {
  const list = h('div', { class: 'list' });
  const render = async (q = '') => {
    const items = (await api.history.get(q)) as HistoryEntry[];
    if (!items.length) return list.replaceChildren(h('p', { class: 'muted', text: q ? 'Keine Treffer.' : 'Der Verlauf ist leer.' }));
    let lastDay = '';
    const rows: HTMLElement[] = [];
    for (const e of items) {
      const day = new Date(e.visitedAt).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
      if (day !== lastDay) rows.push(h('h3', { class: 'day', text: day }));
      lastDay = day;
      rows.push(
        h('button', { class: 'row', onclick: () => ctx.navigate(e.url) },
          h('span', { class: 'time', text: new Date(e.visitedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) }),
          faviconEl(undefined, hostOf(e.url)[0]?.toUpperCase()),
          h('span', { class: 'row-title', text: e.title || e.url }),
          h('span', { class: 'row-sub', text: hostOf(e.url) }),
        ),
      );
    }
    list.replaceChildren(...rows);
  };
  const search = h('input', { class: 'field', attrs: { placeholder: 'Verlauf durchsuchen', type: 'search' }, oninput: () => render(search.value) });
  await render();
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', {}, icon('history', 'glow'), h('span', { text: 'Verlauf' })),
      search,
      h('button', {
        class: 'btn danger', onclick: async () => {
          if (!confirm('Gesamten Verlauf löschen?')) return;
          await api.history.clear();
          await render();
        },
      }, icon('trash'), h('span', { text: 'Löschen' })),
    ),
    list,
  );
}

// ---------- Bookmarks ----------

export async function bookmarksPage(ctx: PageCtx): Promise<HTMLElement> {
  const list = h('div', { class: 'list' });
  const render = async () => {
    const items = (await api.bookmarks.get()) as Bookmark[];
    if (!items.length) return list.replaceChildren(h('p', { class: 'muted', text: 'Noch keine Lesezeichen. Klicke auf den Stern in der Adressleiste.' }));
    list.replaceChildren(...items.map((b) =>
      h('div', { class: 'row' },
        faviconEl(b.favicon, hostOf(b.url)[0]?.toUpperCase()),
        h('button', { class: 'row-title link', text: b.title, onclick: () => ctx.navigate(b.url) }),
        h('span', { class: 'row-sub', text: hostOf(b.url) }),
        h('button', { class: 'icon-btn', title: 'Entfernen', onclick: async () => { await api.bookmarks.remove(b.id); await render(); } }, icon('trash')),
      )));
  };
  await render();
  return h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('h1', {}, icon('bookmarks', 'glow'), h('span', { text: 'Lesezeichen' }))), list);
}

// ---------- Settings ----------

function toggle(label: string, desc: string, value: boolean, onChange: (v: boolean) => void) {
  const input = h('input', { attrs: { type: 'checkbox', checked: value }, onchange: () => onChange(input.checked) });
  return h('label', { class: 'setting' },
    h('div', { class: 'setting-text' }, h('div', { class: 'setting-label', text: label }), h('div', { class: 'setting-desc', text: desc })),
    h('span', { class: 'switch' }, input, h('span', { class: 'knob' })),
  );
}

function select<T extends string>(label: string, desc: string, value: T, options: [T, string][], onChange: (v: T) => void) {
  const sel = h('select', { class: 'field', onchange: () => onChange(sel.value as T) },
    ...options.map(([v, l]) => h('option', { text: l, attrs: { value: v, selected: v === value } })));
  return h('div', { class: 'setting' },
    h('div', { class: 'setting-text' }, h('div', { class: 'setting-label', text: label }), h('div', { class: 'setting-desc', text: desc })),
    sel,
  );
}

const PERMISSION_NAMES: Record<string, string> = {
  media: 'Kamera/Mikrofon', geolocation: 'Standort', notifications: 'Benachrichtigungen', midi: 'MIDI',
  'clipboard-read': 'Zwischenablage lesen', 'display-capture': 'Bildschirmaufnahme', 'idle-detection': 'Aktivitätserkennung',
  'storage-access': 'Speicherzugriff', 'window-management': 'Fensterverwaltung', openExternal: 'Externe Apps öffnen',
};
export const permissionName = (p: string) => PERMISSION_NAMES[p] ?? p;

export async function settingsPage(ctx: PageCtx, section = 'general'): Promise<HTMLElement> {
  const s = ctx.settings();
  const set = (patch: Partial<Settings>) => ctx.saveSettings(patch);
  const nav = h('nav', { class: 'settings-nav' });
  const body = h('div', { class: 'settings-body' });

  const sections: [string, string, string, () => Promise<HTMLElement>][] = [
    ['general', 'Allgemein', 'settings', async () => h('div', {},
      select('Suchmaschine', 'Wird für Eingaben in der Adressleiste genutzt.', s.searchEngine, [
        ['duckduckgo', 'DuckDuckGo'], ['brave', 'Brave Search'], ['startpage', 'Startpage'], ['ecosia', 'Ecosia'], ['google', 'Google'],
      ], (v) => set({ searchEngine: v })),
      select('Akzentfarbe', 'Farbe für Leuchteffekte und Hervorhebungen.', s.accent, [
        ['cyan', 'Cyan'], ['violet', 'Violett'], ['lime', 'Neon-Grün'], ['magenta', 'Magenta'],
      ], (v) => set({ accent: v })),
      toggle('Lesezeichen auf der Startseite', 'Zeigt deine Lesezeichen als Kacheln im neuen Tab.', s.homeShowsBookmarks, (v) => set({ homeShowsBookmarks: v })),
    )],
    ['privacy', 'Datenschutz & Sicherheit', 'shield', async () => h('div', {},
      toggle('Nur HTTPS', 'Verbindungen werden automatisch auf HTTPS umgestellt. Unsichere Seiten nur nach Bestätigung.', s.httpsOnly, (v) => set({ httpsOnly: v })),
      toggle('Tracker & Werbung blockieren', 'Blockiert bekannte Tracker und Werbenetzwerke (EasyList/EasyPrivacy).', s.blockTrackers, (v) => set({ blockTrackers: v })),
      toggle('Drittanbieter-Cookies blockieren', 'Verhindert seitenübergreifendes Tracking über Cookies.', s.blockThirdPartyCookies, (v) => set({ blockThirdPartyCookies: v })),
      toggle('„Do Not Track“ & Global Privacy Control senden', 'Signalisiert Websites, dass du nicht verfolgt werden möchtest.', s.sendDoNotTrack, (v) => set({ sendDoNotTrack: v })),
      toggle('Pop-ups blockieren', 'Verhindert, dass Seiten ungefragt neue Fenster öffnen.', s.blockPopups, (v) => set({ blockPopups: v })),
      select('Berechtigungen (Kamera, Standort, …)', 'Was passiert, wenn eine Seite eine Berechtigung anfragt.', s.permissionDefault, [
        ['ask', 'Jedes Mal fragen'], ['deny', 'Immer ablehnen'],
      ], (v) => set({ permissionDefault: v })),
      toggle('Verlauf speichern', 'Besuchte Seiten werden lokal gespeichert.', s.saveHistory, (v) => set({ saveHistory: v })),
      toggle('Daten beim Beenden löschen', 'Cookies, Cache, Website-Daten und Verlauf werden beim Schließen gelöscht.', s.clearOnExit, (v) => set({ clearOnExit: v })),
      h('div', { class: 'setting' },
        h('div', { class: 'setting-text' }, h('div', { class: 'setting-label', text: 'Browserdaten jetzt löschen' }), h('div', { class: 'setting-desc', text: 'Löscht Cookies, Cache, Website-Speicher und Verlauf.' })),
        h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm('Alle Browserdaten löschen? Du wirst überall abgemeldet.')) return;
          await api.data.clear();
          toast('Browserdaten gelöscht');
        } }, icon('trash'), h('span', { text: 'Löschen' })),
      ),
    )],
    ['permissions', 'Website-Berechtigungen', 'lock', async () => {
      const wrap = h('div', {});
      const render = async () => {
        const perms = (await api.perms.list()) as Record<string, Record<string, 'allow' | 'deny'>>;
        const origins = Object.keys(perms);
        if (!origins.length) return wrap.replaceChildren(h('p', { class: 'muted', text: 'Keine gespeicherten Berechtigungen.' }));
        wrap.replaceChildren(...origins.map((o) => h('div', { class: 'perm-site' },
          h('div', { class: 'setting-label', text: o }),
          ...Object.entries(perms[o]).map(([p, v]) => h('div', { class: 'perm-row' },
            h('span', { text: permissionName(p) }),
            h('span', { class: `badge ${v}`, text: v === 'allow' ? 'Erlaubt' : 'Blockiert' }),
            h('button', { class: 'icon-btn', title: 'Zurücksetzen', onclick: async () => { await api.perms.set(o, p, null); await render(); } }, icon('trash')),
          )),
        )));
      };
      await render();
      return wrap;
    }],
    ['ai', 'AI-Assistent', 'spark', () => aiSettings(ctx)],
    ['about', 'Über Aether', 'chip', async () => h('div', { class: 'about' },
      h('div', { class: 'brand big' }, h('span', { class: 'brand-mark' }), h('span', { text: 'AETHER' })),
      h('p', { text: 'Version 0.1.0 · Prototyp' }),
      h('p', { class: 'muted', text: 'Jede Website läuft in einem eigenen, abgeschotteten Prozess (Chromium-Sandbox, Context Isolation, kein Node.js-Zugriff). API-Keys werden mit dem Schlüsselbund deines Betriebssystems verschlüsselt und verlassen nie den Hauptprozess.' }),
    )],
  ];

  const show = async (id: string) => {
    for (const b of nav.children) b.classList.toggle('active', (b as HTMLElement).dataset.id === id);
    const def = sections.find((x) => x[0] === id) ?? sections[0];
    body.replaceChildren(h('h2', { text: def[1] }), await def[3]());
  };
  for (const [id, label, ic] of sections) {
    nav.append(h('button', { dataset: { id }, onclick: () => show(id) }, icon(ic), h('span', { text: label })));
  }
  await show(section);
  return h('div', { class: 'page settings' }, h('div', { class: 'page-head' }, h('h1', {}, icon('settings', 'glow'), h('span', { text: 'Einstellungen' }))), h('div', { class: 'settings-grid' }, nav, body));
}

async function aiSettings(ctx: PageCtx): Promise<HTMLElement> {
  const wrap = h('div', {});
  let status = (await api.secrets.status()) as SecretsStatus;

  const render = () => {
    const s = ctx.settings();
    const active = PROVIDERS.find((p) => p.id === s.aiProvider)!;

    const cards = h('div', { class: 'provider-grid' }, ...PROVIDERS.map((p) =>
      h('button', {
        class: `provider-card ${p.id === s.aiProvider ? 'active' : ''}`,
        onclick: async () => { await ctx.saveSettings({ aiProvider: p.id }); render(); },
      },
      icon(p.kind === 'local' ? 'chip' : 'cloud'),
      h('div', { class: 'provider-name', text: p.label }),
      h('div', { class: 'provider-kind', text: p.kind === 'local' ? 'Lokal · keine Daten verlassen den Rechner' : 'Cloud' }),
      p.needsKey ? h('span', { class: `badge ${status.configured.includes(p.id) ? 'allow' : ''}`, text: status.configured.includes(p.id) ? 'Key gespeichert' : 'Key fehlt' }) : null,
      )));

    // Model picker with suggestions fetched from the provider.
    const datalist = h('datalist', { attrs: { id: 'model-options' } });
    const model = h('input', {
      class: 'field', attrs: { value: s.aiModels[active.id], list: 'model-options', placeholder: active.defaultModel || 'Modellname', spellcheck: 'false' },
      onchange: () => ctx.saveSettings({ aiModels: { ...ctx.settings().aiModels, [active.id]: model.value.trim() } }),
    });
    const loadModels = async () => {
      const ids = (await api.ai.models(active.id)) as string[];
      datalist.replaceChildren(...ids.map((id) => h('option', { attrs: { value: id } })));
      if (ids.length) toast(`${ids.length} Modelle gefunden`);
      else toast('Keine Modelle gefunden. Ist der Dienst erreichbar und der Key gesetzt?');
    };

    const baseUrl = h('input', {
      class: 'field', attrs: { value: s.aiBaseUrls[active.id], spellcheck: 'false' },
      onchange: () => ctx.saveSettings({ aiBaseUrls: { ...ctx.settings().aiBaseUrls, [active.id]: baseUrl.value.trim() } }),
    });

    const keyInput = h('input', { class: 'field', attrs: { type: 'password', placeholder: status.configured.includes(active.id) ? '•••••••• (gespeichert)' : 'API-Key einfügen', autocomplete: 'off', spellcheck: 'false' } });
    const saveKey = async (value: string) => {
      status = (await api.secrets.set(active.id, value)) as SecretsStatus;
      toast(value ? 'API-Key gespeichert' : 'API-Key entfernt');
      render();
    };

    const encryptionNote = {
      os: 'Keys werden mit dem Schlüsselbund deines Systems verschlüsselt gespeichert.',
      weak: 'Kein System-Schlüsselbund gefunden: Keys werden nur bis zum Beenden im Arbeitsspeicher gehalten.',
      unavailable: 'Verschlüsselung nicht verfügbar: Keys werden nur bis zum Beenden im Arbeitsspeicher gehalten.',
    }[status.encryption];

    const prompt = h('textarea', { class: 'field', attrs: { rows: '3' }, onchange: () => ctx.saveSettings({ aiSystemPrompt: prompt.value }) });
    prompt.value = s.aiSystemPrompt;

    wrap.replaceChildren(
      h('p', { class: 'muted', text: 'Wähle, ob der Chat über einen Cloud-Anbieter oder ein lokales Modell (z. B. Ollama, LM Studio) läuft.' }),
      cards,
      h('h3', { text: active.label }),
      field('Modell', h('div', { class: 'inline' }, model, datalist, h('button', { class: 'btn', onclick: loadModels, text: 'Modelle laden' }))),
      field('Endpunkt (Base URL)', baseUrl),
      active.needsKey || active.id === 'custom'
        ? field('API-Key', h('div', { class: 'inline' }, keyInput,
            h('button', { class: 'btn primary', onclick: () => keyInput.value.trim() && saveKey(keyInput.value) }, icon('key'), h('span', { text: 'Speichern' })),
            status.configured.includes(active.id) ? h('button', { class: 'btn danger', onclick: () => saveKey(''), text: 'Entfernen' }) : null,
          ), encryptionNote)
        : h('p', { class: 'muted', text: `Kein API-Key nötig. Stelle sicher, dass ${active.label.replace(/ \(.*\)/, '')} unter ${s.aiBaseUrls[active.id]} läuft.` }),
      h('h3', { text: 'Verhalten' }),
      field('System-Prompt', prompt),
      toggle('Seiteninhalt teilen erlauben', 'Erlaubt dem Chat, den Text der aktuellen Seite mitzusenden, wenn du „Seite einbeziehen“ aktivierst.', s.aiAllowPageContext, (v) => ctx.saveSettings({ aiAllowPageContext: v })),
    );
  };
  render();
  return wrap;
}

function field(label: string, control: HTMLElement, hint?: string) {
  return h('div', { class: 'field-wrap' }, h('div', { class: 'setting-label', text: label }), control, hint ? h('div', { class: 'setting-desc', text: hint }) : null);
}

export type { ProviderId };
