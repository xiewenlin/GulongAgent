/** Share-link secrets must not enter ordinary page-view analytics. */
export function isPrivateLetterPath(value) {
  try {
    const pathname = decodeURIComponent(new URL(String(value), "https://gulong.invalid").pathname).replace(/\/+/g, "/");
    return /^\/love-letter(?:\/|$)/i.test(pathname);
  } catch { return /^\/*love-letter(?:\/|[?#]|$)/i.test(String(value)); }
}
