/**
 * Build a safe RFC 5987 Content-Disposition header value for an attachment.
 *
 * Emits both:
 *   - `filename="<ascii-fallback>"` for legacy clients
 *   - `filename*=UTF-8''<percent-encoded>` for modern clients (per RFC 5987/6266)
 *
 * Handles non-ASCII characters (emoji, unicode team names) and strips control
 * characters / quotes / backslashes that would break the quoted-string form.
 */
export function buildContentDisposition(filename: string): string {
  const safeInput = (filename ?? '').toString();

  // ASCII fallback: replace any non-ASCII, CR/LF, quotes, and backslashes with
  // underscores so the quoted-string form is always well-formed.
  const asciiFallback =
    safeInput.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'download';

  // RFC 5987 percent-encoding: encodeURIComponent covers all reserved chars,
  // but we also escape a few that it leaves alone per RFC 3986 (!, ', (, ), *).
  const encoded = encodeURIComponent(safeInput).replace(
    /['()*!]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );

  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
