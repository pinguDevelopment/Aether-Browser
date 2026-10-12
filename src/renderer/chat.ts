import type { ChatEvent, ChatMessage, Settings } from '../shared/types';
import { PROVIDERS } from '../shared/types';
import { api, h, hostOf } from './dom';
import { icon } from './icons';
import { renderMarkdown } from './markdown';

const panels = new Set<ChatPanel>();

api.on('ai:event', (payload) => {
  const e = payload as ChatEvent;
  for (const p of panels) p.handle(e);
});

export class ChatPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private providerLabel: HTMLElement;
  private pageToggle: HTMLInputElement;
  private messages: ChatMessage[] = [];
  private requestId?: string;
  private streamingEl?: HTMLElement;
  private streamingText = '';

  constructor(private mode: 'sidebar' | 'page', private getSettings: () => Settings, openSettings: () => void) {
    panels.add(this);
    this.providerLabel = h('button', { class: 'chip provider', title: 'Anbieter in den Einstellungen ändern', onclick: openSettings });
    this.pageToggle = h('input', { attrs: { type: 'checkbox', checked: mode === 'sidebar' } });
    this.list = h('div', { class: 'chat-list' });
    this.input = h('textarea', {
      attrs: { rows: '1', placeholder: mode === 'sidebar' ? 'Frag etwas zu dieser Seite …' : 'Nachricht an Aether AI …' },
      oninput: () => this.autosize(),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.submit();
        }
      },
    });
    this.sendBtn = h('button', { class: 'send', title: 'Senden', onclick: () => (this.requestId ? this.cancel() : this.submit()) }, icon('send'));

    this.el = h('div', { class: `chat chat-${mode}` },
      h('div', { class: 'chat-head' },
        h('div', { class: 'chat-title' }, icon('spark', 'glow'), h('span', { text: 'Aether AI' })),
        this.providerLabel,
        h('button', { class: 'icon-btn', title: 'Neuer Chat', onclick: () => this.reset() }, icon('newchat')),
      ),
      this.list,
      h('div', { class: 'composer' },
        h('label', { class: 'page-toggle', title: 'Text der aktuellen Seite als Kontext mitsenden' }, this.pageToggle, icon('page'), h('span', { text: 'Seite einbeziehen' })),
        h('div', { class: 'composer-row' }, this.input, this.sendBtn),
      ),
    );
    this.refreshProvider();
    this.renderEmpty();
  }

  refreshProvider() {
    const s = this.getSettings();
    const info = PROVIDERS.find((p) => p.id === s.aiProvider)!;
    this.providerLabel.replaceChildren(icon(info.kind === 'local' ? 'chip' : 'cloud'), h('span', { text: `${info.label.replace(/ \(.*\)/, '')} · ${s.aiModels[s.aiProvider] || '–'}` }));
    this.pageToggle.parentElement!.style.display = s.aiAllowPageContext ? '' : 'none';
  }

  focus() {
    this.input.focus();
  }

  ask(text: string, includePage: boolean) {
    this.pageToggle.checked = includePage;
    this.input.value = text;
    this.submit();
  }

  private autosize() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 180)}px`;
  }

  private renderEmpty() {
    if (this.messages.length) return;
    const suggestions = this.mode === 'sidebar'
      ? ['Fasse diese Seite zusammen', 'Was sind die wichtigsten Punkte?', 'Erkläre das einfacher']
      : ['Plane mir einen Wochenendtrip', 'Erkläre Quantencomputer in 3 Sätzen', 'Schreibe eine höfliche E-Mail'];
    this.list.replaceChildren(
      h('div', { class: 'chat-empty' },
        h('div', { class: 'orb' }),
        h('p', { text: this.mode === 'sidebar' ? 'Ich kann die aktuelle Seite lesen und Fragen dazu beantworten.' : 'Womit kann ich helfen?' }),
        h('div', { class: 'suggestions' },
          ...suggestions.map((s) => h('button', { class: 'chip', text: s, onclick: () => this.ask(s, this.mode === 'sidebar') })),
        ),
      ),
    );
  }

  private reset() {
    if (this.requestId) this.cancel();
    this.messages = [];
    this.renderEmpty();
  }

  private bubble(role: 'user' | 'assistant', text: string, note?: string) {
    const body = h('div', { class: 'bubble-body' });
    if (role === 'user') body.textContent = text;
    else body.innerHTML = renderMarkdown(text);
    const el = h('div', { class: `bubble ${role}` }, note ? h('div', { class: 'bubble-note' }, icon('page'), h('span', { text: note })) : null, body);
    el.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a[data-external]') as HTMLAnchorElement | null;
      if (a) {
        e.preventDefault();
        void api.tabs.create(a.getAttribute('href'));
      }
    });
    this.list.append(el);
    this.list.scrollTop = this.list.scrollHeight;
    return body;
  }

  private async submit() {
    const text = this.input.value.trim();
    if (!text || this.requestId) return;
    if (!this.messages.length) this.list.replaceChildren();
    this.input.value = '';
    this.autosize();
    this.messages.push({ role: 'user', content: text });
    const includePage = this.pageToggle.checked && this.getSettings().aiAllowPageContext;
    const page = includePage ? ((await api.ai.activePage()) as { title: string; url: string } | undefined) : undefined;
    this.bubble('user', text, page ? `${page.title || hostOf(page.url)}` : undefined);

    this.requestId = crypto.randomUUID();
    this.streamingText = '';
    this.streamingEl = this.bubble('assistant', '');
    this.streamingEl.parentElement!.classList.add('streaming');
    this.sendBtn.replaceChildren(icon('stop'));
    this.sendBtn.title = 'Stoppen';
    await api.ai.chat({ requestId: this.requestId, messages: this.messages, includePage: !!page });
  }

  private cancel() {
    if (this.requestId) void api.ai.cancel(this.requestId);
  }

  handle(e: ChatEvent) {
    if (e.requestId !== this.requestId || !this.streamingEl) return;
    if (e.type === 'delta') {
      this.streamingText += e.text;
      this.streamingEl.innerHTML = renderMarkdown(this.streamingText);
      const nearBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 120;
      if (nearBottom) this.list.scrollTop = this.list.scrollHeight;
      return;
    }
    const bubble = this.streamingEl.parentElement!;
    bubble.classList.remove('streaming');
    if (e.type === 'error') {
      bubble.classList.add('error');
      this.streamingEl.textContent = e.message;
      this.messages.pop(); // drop the unanswered user turn so the next try starts clean
    } else if (this.streamingText) {
      this.messages.push({ role: 'assistant', content: this.streamingText });
    } else {
      bubble.remove();
      this.messages.pop();
    }
    this.requestId = undefined;
    this.streamingEl = undefined;
    this.sendBtn.replaceChildren(icon('send'));
    this.sendBtn.title = 'Senden';
  }
}
