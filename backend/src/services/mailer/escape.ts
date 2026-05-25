/**
 * Escape user-controlled strings before interpolating into HTML email bodies.
 * Email clients sanitize many attack vectors, but anchor tags, styled markup,
 * and images still render — making unescaped fields a phishing primitive.
 */
export function escapeHtml(value: string | null | undefined): string {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
