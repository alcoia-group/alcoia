import { describe, it, expect } from 'vitest';
import { maskToken, relativeTime, escapeHtml } from '../alcoia/src/popup/diagnostics-format.js';

describe('maskToken', () => {
  it('shows only the last few characters of a real token', () => {
    expect(maskToken('abcdefghijklmnopqrstuvwxyz0987654321')).toBe('••••••••••••4321');
  });

  it('never contains more than the trailing 4 characters of the original token', () => {
    const token = 'super-secret-install-token-value';
    const masked = maskToken(token);
    expect(masked.endsWith(token.slice(-4))).toBe(true);
    expect(masked).not.toContain(token.slice(0, -4));
  });

  it('handles a short token without throwing or leaking it', () => {
    expect(maskToken('ab')).toBe('••••');
  });

  it('renders an em dash for no token', () => {
    expect(maskToken(null)).toBe('—');
    expect(maskToken(undefined)).toBe('—');
    expect(maskToken('')).toBe('—');
  });

  it('ignores a non-string value rather than throwing', () => {
    expect(maskToken(12345)).toBe('—');
  });
});

describe('relativeTime', () => {
  const now = 1_000_000_000;
  it('says "just now" for anything under 5s', () => {
    expect(relativeTime(now - 2000, now)).toBe('just now');
  });
  it('reports seconds under a minute', () => {
    expect(relativeTime(now - 30_000, now)).toBe('30s ago');
  });
  it('reports minutes under an hour', () => {
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
  });
  it('reports hours under a day', () => {
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
  });
  it('reports days beyond that', () => {
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
});

describe('escapeHtml', () => {
  it('escapes the characters that would break out of an attribute or tag', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('is safe to use on an error-log message before it reaches innerHTML', () => {
    expect(escapeHtml("<script>alert('x')</script>")).not.toContain('<script>');
  });
});
