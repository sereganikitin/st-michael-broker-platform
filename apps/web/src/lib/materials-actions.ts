/** Structural subset shared by the public and authenticated document APIs. */
export interface MaterialActionDocument {
  name?: string | null;
  fileUrl?: string | null;
  type?: string | null;
  description?: string | null;
  category?: string | null;
  isPublic?: boolean | null;
  sortOrder?: number | null;
  updatedAt?: string | null;
}

export interface SafeMaterialUrl {
  href: string;
  isLocal: boolean;
}

export interface MaterialDownloadAttributes {
  href: string;
  download?: string;
  target?: '_blank';
  rel?: 'noopener noreferrer';
  label: 'Скачать' | 'Открыть оригинал';
}

const PARSE_ORIGIN = 'https://material-url.invalid';
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SCHEME = /^[a-z][a-z\d+.-]*:/i;

/** Decode only for validation, never rewrite the underlying resource's path. */
function decodedPath(path: string): string | null {
  let value = path;
  for (let pass = 0; pass < 4; pass += 1) {
    if (!/%[a-f\d]{2}/i.test(value)) {
      // A literal percent is valid after decoding (e.g. "100%25.jpg").
      return pass === 0 && /%(?![a-f\d]{2})/i.test(value) ? null : value;
    }
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  // Do not accept unusually deep escaping that could hide traversal downstream.
  return /%[a-f\d]{2}/i.test(value) ? null : value;
}

function trustedOrigin(value?: string): string | null {
  if (!value || CONTROL_CHARACTERS.test(value) || value.includes('\\')) return null;
  try {
    const origin = new URL(value);
    return /^https?:$/.test(origin.protocol) && !origin.username && !origin.password
      && origin.pathname === '/' && !origin.search && !origin.hash ? origin.origin : null;
  } catch {
    return null;
  }
}

/**
 * Root-relative and plain relative file paths are local in SSR. Absolute HTTP(S)
 * URLs are local only when the caller supplies the exact browser origin. Never
 * compare host substrings or assume the production host while rendering SSR.
 */
export function safeMaterialUrl(raw: unknown, browserOrigin?: string): SafeMaterialUrl | null {
  if (typeof raw !== 'string' || CONTROL_CHARACTERS.test(raw) || raw.includes('\\')) return null;
  const value = raw.trim().replace(/^\.\//, '');
  if (!value || value.startsWith('//') || value.startsWith('?') || value.startsWith('#')) return null;
  const absolute = SCHEME.test(value);
  if (absolute && !/^https?:\/\//i.test(value)) return null;
  const rawPath = absolute ? value.replace(/^https?:\/\/[^/?#]*/i, '').split(/[?#]/, 1)[0] : value.split(/[?#]/, 1)[0];
  const path = decodedPath(rawPath);
  if (path === null || CONTROL_CHARACTERS.test(path) || path.includes('\\') || path.startsWith('//')) return null;
  const parts = path.split('/');
  if (parts.some(part => part === '..' || part === '.') || (!absolute && parts[0].includes(':'))) return null;
  try {
    // Plain relative API paths must not depend on the currently open folder URL.
    const relative = value.startsWith('/') ? value : '/' + value;
    const parsed = new URL(absolute ? value : relative, PARSE_ORIGIN);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) return null;
    return {
      href: absolute ? parsed.href : parsed.pathname + parsed.search + parsed.hash,
      isLocal: !absolute || parsed.origin === trustedOrigin(browserOrigin),
    };
  } catch {
    return null;
  }
}

function downloadFilename(doc: MaterialActionDocument, href: string): string {
  const pathname = new URL(href, PARSE_ORIGIN).pathname;
  const lastPart = pathname.split('/').at(-1) || '';
  // A single decode restores Unicode names but does not turn literal "%20" into a space.
  let resourceName = lastPart;
  try { resourceName = decodeURIComponent(lastPart); } catch { /* Validated URL: retain escaped filename. */ }
  const clean = (name: string) => name.replace(/[\/\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_').trim();
  const title = clean(typeof doc.name === 'string' ? doc.name : '');
  const fallback = clean(resourceName);
  const extension = /\.[a-z\d]{1,10}$/i.exec(fallback)?.[0] || '';
  const name = title && title !== '.' && title !== '..'
    ? title + (extension && !/\.[a-z\d]{1,10}$/i.test(title) ? extension : '')
    : fallback && fallback !== '.' && fallback !== '..' ? fallback : 'material';
  // Cover markers belong to the actual file name; do not remove '*', '**', '***'.
  return name;
}

/** Native anchors stream large files; no blob fetch, public proxy, or auth bypass. */
export function materialDownloadAttributes(doc: MaterialActionDocument, browserOrigin?: string): MaterialDownloadAttributes | null {
  const url = safeMaterialUrl(doc.fileUrl, browserOrigin);
  if (!url) return null;
  return url.isLocal
    ? { href: url.href, download: downloadFilename(doc, url.href), label: 'Скачать' }
    : { href: url.href, target: '_blank', rel: 'noopener noreferrer', label: 'Открыть оригинал' };
}

/** Find the actual current calculator document, not a stale hardcoded URL. */
export function findInstallmentCalculator(docs: readonly MaterialActionDocument[] | null | undefined): string | null {
  if (!Array.isArray(docs)) return null;
  const candidates = docs.flatMap((doc, index) => {
    if (!doc || doc.isPublic === false) return [];
    const url = safeMaterialUrl(doc.fileUrl);
    if (!url) return [];
    const pathname = new URL(url.href, PARSE_ORIGIN).pathname;
    const name = typeof doc.name === 'string' ? doc.name : '';
    const type = typeof doc.type === 'string' ? doc.type.trim() : '';
    // A clearly different resource extension wins over an accidentally stale
    // CMS type/title. Dynamic or extensionless HTML endpoints remain possible.
    if (/\.(pdf|xlsx?|docx?|pptx?|zip|rar|jpe?g|png|webp|mp4|mov)$/i.test(pathname)) return [];
    const html = /^html?$/i.test(type) || /^text\/html(?:\s*;|$)/i.test(type)
      || /^application\/xhtml\+xml(?:\s*;|$)/i.test(type) || /\.html?$/i.test(pathname) || /\.html?$/i.test(name);
    if (!html) return [];
    const description = typeof doc.description === 'string' ? doc.description : '';
    const combined = `${name} ${description} ${decodedPath(pathname) || pathname}`;
    const calculator = /калькулятор|calculator|kalkul/i;
    const installment = /рассроч|rassroch|install?ments?/i;
    if (!calculator.test(combined) || !installment.test(combined)) return [];
    const priority = calculator.test(name) && installment.test(name) ? 2 : 1;
    const date = typeof doc.updatedAt === 'string' ? Date.parse(doc.updatedAt) : NaN;
    const updated = Number.isFinite(date) ? date : 0;
    const order = typeof doc.sortOrder === 'number' && Number.isFinite(doc.sortOrder) ? doc.sortOrder : 0;
    return [{ href: url.href, priority, updated, order, index }];
  });
  candidates.sort((a, b) => b.priority - a.priority || b.updated - a.updated || a.order - b.order || a.index - b.index);
  return candidates[0]?.href || null;
}
