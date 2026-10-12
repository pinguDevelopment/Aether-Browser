// Types shared between the main process, the preload bridge and the UI.

export type InternalPage = 'newtab' | 'settings' | 'history' | 'bookmarks' | 'ai';

export interface TabError {
  code: number;
  description: string;
  url: string;
  /** True when the failure came from the HTTPS-only upgrade. */
  httpsUpgrade: boolean;
}

export interface TabState {
  id: number;
  kind: 'web' | 'internal';
  page?: InternalPage;
  url: string;
  title: string;
  favicon?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  secure: boolean;
  blocked: number;
  zoom: number;
  error?: TabError;
}

export interface TabsSnapshot {
  tabs: TabState[];
  activeId: number;
}

export type SearchEngine = 'duckduckgo' | 'brave' | 'startpage' | 'google' | 'ecosia';

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'lmstudio' | 'custom';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  kind: 'cloud' | 'local';
  needsKey: boolean;
  defaultBaseUrl: string;
  defaultModel: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic', label: 'Anthropic Claude', kind: 'cloud', needsKey: true, defaultBaseUrl: 'https://api.anthropic.com', defaultModel: 'claude-opus-5-5' },
  { id: 'openai', label: 'OpenAI', kind: 'cloud', needsKey: true, defaultBaseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5' },
  { id: 'gemini', label: 'Google Gemini', kind: 'cloud', needsKey: true, defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.5-flash' },
  { id: 'ollama', label: 'Ollama (lokal)', kind: 'local', needsKey: false, defaultBaseUrl: 'http://localhost:11434/v1', defaultModel: 'llama3.2' },
  { id: 'lmstudio', label: 'LM Studio (lokal)', kind: 'local', needsKey: false, defaultBaseUrl: 'http://localhost:1234/v1', defaultModel: 'local-model' },
  { id: 'custom', label: 'Eigener Endpunkt (OpenAI-kompatibel)', kind: 'cloud', needsKey: false, defaultBaseUrl: 'https://', defaultModel: '' },
];

export type Accent = 'cyan' | 'violet' | 'lime' | 'magenta';

export interface Settings {
  searchEngine: SearchEngine;
  homeShowsBookmarks: boolean;
  accent: Accent;
  // Privacy & security
  httpsOnly: boolean;
  blockTrackers: boolean;
  blockThirdPartyCookies: boolean;
  sendDoNotTrack: boolean;
  saveHistory: boolean;
  clearOnExit: boolean;
  permissionDefault: 'ask' | 'deny';
  blockPopups: boolean;
  // AI
  aiProvider: ProviderId;
  aiModels: Record<ProviderId, string>;
  aiBaseUrls: Record<ProviderId, string>;
  aiSystemPrompt: string;
  aiAllowPageContext: boolean;
}

export interface SecretsStatus {
  /** Providers that currently have an API key stored. */
  configured: ProviderId[];
  /** Whether keys are protected by the OS keychain. */
  encryption: 'os' | 'weak' | 'unavailable';
}

export interface HistoryEntry {
  url: string;
  title: string;
  visitedAt: number;
}

export interface Bookmark {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  createdAt: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  requestId: string;
  messages: ChatMessage[];
  /** Attach text of the active page as context. */
  includePage: boolean;
}

export type ChatEvent =
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'done' }
  | { requestId: string; type: 'error'; message: string };

export interface PermissionPrompt {
  id: number;
  tabId: number;
  origin: string;
  permission: string;
}

export interface SiteInfo {
  origin: string;
  permissions: Record<string, 'allow' | 'deny'>;
}
