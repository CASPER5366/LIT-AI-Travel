import axios from 'axios';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

export async function fetchText(url, extraHeaders = {}) {
  const res = await axios.get(url, {
    headers: { ...BROWSER_HEADERS, ...extraHeaders },
    timeout: 20000,
    maxRedirects: 5,
    decompress: true,
    validateStatus: (s) => s < 400,
  });
  return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
}

export async function fetchBuffer(url) {
  const res = await axios.get(url, {
    headers: BROWSER_HEADERS,
    responseType: 'arraybuffer',
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: (s) => s < 400,
  });
  return { buffer: Buffer.from(res.data), contentType: res.headers['content-type'] || '' };
}

export function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch {
    return null;
  }
}

export function isSameOrigin(base, url) {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

export function hostnameSlug(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}
