import * as cheerio from 'cheerio';
import { resolveUrl, isSameOrigin, fetchText } from './http.js';

export function parseHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const assets = new Set();
  const cssUrls = new Set();
  const jsUrls = new Set();

  // Collect CSS links
  $('link[rel="stylesheet"], link[rel="preload"][as="style"]').each((_, el) => {
    const href = $(el).attr('href');
    const resolved = href ? resolveUrl(pageUrl, href) : null;
    if (resolved) cssUrls.add(resolved);
  });

  // Collect JS scripts
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src');
    const resolved = src ? resolveUrl(pageUrl, src) : null;
    if (resolved) jsUrls.add(resolved);
  });

  // Collect images
  $('img[src], img[data-src], source[srcset]').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src) {
      const resolved = resolveUrl(pageUrl, src);
      if (resolved) assets.add(resolved);
    }
    const srcset = $(el).attr('srcset');
    if (srcset) {
      srcset.split(',').forEach((part) => {
        const url = part.trim().split(/\s+/)[0];
        const resolved = resolveUrl(pageUrl, url);
        if (resolved) assets.add(resolved);
      });
    }
  });

  // Background images in inline styles
  $('[style]').each((_, el) => {
    const style = $(el).attr('style') || '';
    const matches = style.matchAll(/url\(['"]?([^'")\s]+)['"]?\)/g);
    for (const m of matches) {
      const resolved = resolveUrl(pageUrl, m[1]);
      if (resolved) assets.add(resolved);
    }
  });

  // Favicon / other link assets
  $('link[rel*="icon"], link[rel="apple-touch-icon"]').each((_, el) => {
    const href = $(el).attr('href');
    const resolved = href ? resolveUrl(pageUrl, href) : null;
    if (resolved) assets.add(resolved);
  });

  // OG / twitter images
  $('meta[property="og:image"], meta[name="twitter:image"]').each((_, el) => {
    const content = $(el).attr('content');
    const resolved = content ? resolveUrl(pageUrl, content) : null;
    if (resolved) assets.add(resolved);
  });

  return {
    $,
    cssUrls: [...cssUrls],
    jsUrls: [...jsUrls],
    assetUrls: [...assets],
  };
}

export function extractInlineCssUrls(cssText, cssUrl) {
  const urls = new Set();
  const matches = cssText.matchAll(/url\(['"]?([^'")\s]+)['"]?\)/g);
  for (const m of matches) {
    const resolved = resolveUrl(cssUrl, m[1]);
    if (resolved) urls.add(resolved);
  }
  return [...urls];
}

export function rewriteHtmlPaths($, urlToLocal, pageHtmlPath, cssUrlToLocal, jsUrlToLocal) {
  // Rewrite CSS links
  $('link[rel="stylesheet"], link[rel="preload"][as="style"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && cssUrlToLocal.has(href)) {
      const localPath = cssUrlToLocal.get(href);
      $(el).attr('href', localPath);
    }
  });

  // Rewrite script srcs
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src && jsUrlToLocal.has(src)) {
      const localPath = jsUrlToLocal.get(src);
      $(el).attr('src', localPath);
    }
  });

  // Rewrite images
  $('img[src], img[data-src]').each((_, el) => {
    const attr = $(el).attr('src') ? 'src' : 'data-src';
    const val = $(el).attr(attr);
    if (val && urlToLocal.has(val)) {
      $(el).attr(attr, urlToLocal.get(val));
    }
  });

  return $.html();
}

export function buildSiteSummary(url, $, cssFiles, jsFiles, assets) {
  const title = $('title').text().trim();
  const description = $('meta[name="description"]').attr('content') || '';
  const h1s = $('h1').map((_, el) => $(el).text().trim()).get();
  const navLinks = $('nav a, header a').map((_, el) => ({
    text: $(el).text().trim(),
    href: $(el).attr('href'),
  })).get().filter((l) => l.text);

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 2000);

  return {
    url,
    title,
    description,
    headings: h1s,
    navigation: navLinks,
    cssCount: cssFiles.length,
    jsCount: jsFiles.length,
    assetCount: assets.length,
    bodyTextSample: bodyText,
    scrapedAt: new Date().toISOString(),
  };
}
