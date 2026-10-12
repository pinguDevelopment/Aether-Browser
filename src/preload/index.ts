import { contextBridge, ipcRenderer } from 'electron';

// Only these channels may be listened to from the UI.
const EVENTS = new Set(['tabs:update', 'find:result', 'toast', 'ai:ask', 'ai:summarize', 'ai:event', 'perm:prompt', 'perm:close', 'cmd']);

const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const api = {
  platform: process.platform,
  tabs: {
    get: call('tabs:get'),
    create: call('tabs:create'),
    close: call('tabs:close'),
    activate: call('tabs:activate'),
    navigate: call('tabs:navigate'),
    move: call('tabs:move'),
  },
  nav: {
    back: call('nav:back'),
    forward: call('nav:forward'),
    reload: call('nav:reload'),
    stop: call('nav:stop'),
    zoom: call('nav:zoom'),
    allowHttp: call('nav:allowHttp'),
  },
  find: { start: call('find:start'), stop: call('find:stop') },
  ui: { viewport: call('ui:viewport'), overlay: call('ui:overlay'), openExternal: call('ui:openExternal') },
  settings: { get: call('settings:get'), set: call('settings:set') },
  secrets: { status: call('secrets:status'), set: call('secrets:set') },
  history: { get: call('history:get'), clear: call('history:clear') },
  bookmarks: { get: call('bookmarks:get'), toggle: call('bookmarks:toggle'), remove: call('bookmarks:remove') },
  perms: { list: call('perms:list'), set: call('perms:set'), answer: call('perm:answer') },
  data: { clear: call('data:clear') },
  ai: { chat: call('ai:chat'), cancel: call('ai:cancel'), models: call('ai:models'), activePage: call('ai:activePage') },
  on(channel: string, cb: (payload: unknown) => void) {
    if (!EVENTS.has(channel)) throw new Error(`Unknown channel ${channel}`);
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

export type AetherApi = typeof api;
contextBridge.exposeInMainWorld('aether', api);
