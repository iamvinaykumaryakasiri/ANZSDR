import type {
  CallDetail,
  CallLogEntry,
  ConsoleSnapshot,
  JarvisAnswer,
  KillSwitchView,
  MeetingDecision,
  MeetingRequestView,
  TraceEntry
} from '../contract';

const TOKEN_KEY = 'anzsdr.console.token';
const BASE = '/api/console';

let memoryToken: string | null = null;

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return memoryToken;
  }
}

export function setToken(token: string): void {
  memoryToken = token;
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* sessionStorage can be unavailable (private windows, blocked storage); the token then lives in memory only */
  }
}

export function clearToken(): void {
  memoryToken = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to clear */
  }
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type UnauthorisedHandler = () => void;
let onUnauthorised: UnauthorisedHandler | null = null;
export function setUnauthorisedHandler(handler: UnauthorisedHandler | null): void {
  onUnauthorised = handler;
}
export function reportUnauthorised(): void {
  onUnauthorised?.();
}

export function authHeaders(token = getToken()): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, token?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...authHeaders(token),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Accept: 'application/json'
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server.');
  }
  if (response.status === 401) {
    if (token === undefined) reportUnauthorised();
    throw new ApiError(401, 'The token was not accepted.');
  }
  if (!response.ok) {
    let detail = '';
    try {
      const parsed = (await response.json()) as { error?: unknown; message?: unknown };
      detail = typeof parsed.error === 'string' ? parsed.error : typeof parsed.message === 'string' ? parsed.message : '';
    } catch {
      /* a non-JSON error body adds nothing */
    }
    throw new ApiError(response.status, detail || `The server answered ${response.status}.`);
  }
  return (await response.json()) as T;
}

export const api = {
  /** `token` is passed only by the gate screen, to test a token before it is stored. */
  snapshot: (token?: string) => request<ConsoleSnapshot>('GET', '/snapshot', undefined, token),
  kill: (engage: boolean, reason?: string) => request<KillSwitchView>('POST', '/kill', { engage, ...(reason ? { reason } : {}) }),
  decide: (ref: string, decision: MeetingDecision) =>
    request<MeetingRequestView>('POST', `/meetings/${encodeURIComponent(ref)}`, { decision }),
  calls: () => request<CallLogEntry[]>('GET', '/calls'),
  call: (id: string) => request<CallDetail>('GET', `/calls/${encodeURIComponent(id)}`),
  trace: () => request<TraceEntry[]>('GET', '/trace'),
  jarvis: (query: string) => request<JarvisAnswer>('POST', '/jarvis', { query }),
  jarvisConfirm: (actionId: string) => request<JarvisAnswer>('POST', '/jarvis/confirm', { actionId })
};

/**
 * An <audio> element cannot send an Authorization header, so a recording behind
 * the token is fetched with it and played from an object URL. A URL that is
 * not on this origin's /api is handed back untouched.
 */
export async function loadRecording(url: string): Promise<string> {
  if (!url.startsWith('/api/')) return url;
  const response = await fetch(url, { headers: authHeaders() });
  if (response.status === 401) {
    reportUnauthorised();
    throw new ApiError(401, 'The token was not accepted.');
  }
  if (!response.ok) throw new ApiError(response.status, 'The recording could not be loaded.');
  return URL.createObjectURL(await response.blob());
}
