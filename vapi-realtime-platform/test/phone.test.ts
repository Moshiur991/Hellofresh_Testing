import { describe, expect, it } from 'vitest';
import { normalizePhone, isValidE164 } from '../src/utils/phone.js';

describe('normalizePhone', () => {
  it('normalizes a 10-digit NANP number', () => {
    expect(normalizePhone('416 555 0100')).toBe('+14165550100');
  });
  it('passes through a valid E.164 number', () => {
    expect(normalizePhone('+14165550100')).toBe('+14165550100');
  });
  it('returns null for garbage input', () => {
    expect(normalizePhone('call me maybe')).toBeNull();
  });
});

describe('isValidE164', () => {
  it('accepts a well-formed number', () => {
    expect(isValidE164('+14165550100')).toBe(true);
  });
  it('rejects a malformed number', () => {
    expect(isValidE164('4165550100')).toBe(false);
  });
});
