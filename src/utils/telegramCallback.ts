import { randomBytes } from 'node:crypto';

type CallbackAction = 'alert' | 'chart';

export interface CallbackPayload {
  query: string;
  price: number;
  title?: string;
}

const CALLBACK_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CALLBACKS = 10_000;
const payloads = new Map<string, CallbackPayload & { action: CallbackAction; expiresAt: number }>();

export function makeCallbackData(
  action: CallbackAction,
  query: string,
  price: number,
  title?: string
): string {
  if (payloads.size >= MAX_CALLBACKS) {
    const oldestKey = payloads.keys().next().value;
    if (oldestKey !== undefined) payloads.delete(oldestKey);
  }

  const token = randomBytes(8).toString('hex');
  payloads.set(token, {
    action,
    query: query.trim(),
    price: Math.max(0, Math.trunc(price)),
    title,
    expiresAt: Date.now() + CALLBACK_TTL_MS,
  });
  return `${action}:${token}`;
}

export function resolveCallbackData(
  action: CallbackAction,
  callbackData: string,
  now = Date.now()
): CallbackPayload | null {
  const tokenMatch = callbackData.match(new RegExp(`^${action}:([a-f0-9]{16})$`));
  if (tokenMatch) {
    const stored = payloads.get(tokenMatch[1]);
    if (!stored || stored.action !== action || stored.expiresAt <= now) {
      if (stored) payloads.delete(tokenMatch[1]);
      return null;
    }
    return { query: stored.query, price: stored.price, title: stored.title };
  }

  // Backward compatibility for buttons created by older releases.
  const legacyMatch = callbackData.match(new RegExp(`^${action}:(.+):(\\d+)$`));
  if (!legacyMatch) return null;
  return { query: legacyMatch[1], price: Number.parseInt(legacyMatch[2], 10) };
}
