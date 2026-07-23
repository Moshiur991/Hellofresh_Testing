/** Loosely normalizes a spoken/typed phone number to E.164-ish digits. Never throws — voice
 * transcripts are messy ("four one six, five five five..."); callers decide what to do with `null`. */
export function normalizePhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return null;
  const withoutPlus = digits.replace(/^\+/, '');
  if (withoutPlus.length === 10) return `+1${withoutPlus}`; // assume NANP if no country code given
  if (withoutPlus.length === 11 && withoutPlus.startsWith('1')) return `+${withoutPlus}`;
  if (digits.startsWith('+') && withoutPlus.length >= 8) return `+${withoutPlus}`;
  return null;
}

export function isValidE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}
