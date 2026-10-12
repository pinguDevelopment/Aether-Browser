import type { AetherApi } from '../preload/index';

declare global {
  interface Window { aether: AetherApi }
}

export const api = window.aether;

type Child = Node | string | number | null | undefined | false;
type Props = {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string | boolean | undefined>;
  dataset?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
} & { [K in `on${string}`]?: (e: never) => void };

/** Tiny hyperscript helper. Text is always set via textContent, never parsed as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key === 'class') el.className = value as string;
    else if (key === 'text') el.textContent = value as string;
    else if (key === 'title') el.title = value as string;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') Object.assign(el.style, value);
    else if (key === 'attrs') {
      for (const [a, v] of Object.entries(value as Record<string, string | boolean | undefined>)) {
        if (v === false || v === undefined) continue;
        el.setAttribute(a, v === true ? '' : v);
      }
    } else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function faviconEl(url?: string, fallbackLetter = '•') {
  if (url && url.startsWith('https:')) {
    const img = h('img', { class: 'favicon', attrs: { src: url, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' } });
    img.onerror = () => img.replaceWith(h('span', { class: 'favicon letter', text: fallbackLetter }));
    return img;
  }
  return h('span', { class: 'favicon letter', text: fallbackLetter });
}

let toastHost: HTMLElement | undefined;
export function toast(text: string) {
  toastHost ??= $('#toasts');
  const el = h('div', { class: 'toast', text });
  toastHost.replaceChildren(el);
  setTimeout(() => el.classList.add('out'), 2800);
  setTimeout(() => el.remove(), 3300);
}
