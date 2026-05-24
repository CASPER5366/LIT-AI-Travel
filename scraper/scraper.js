import path from 'path';
import fse from 'fs-extra';
import ora from 'ora';
import chalk from 'chalk';
import { fetchText, fetchBuffer, resolveUrl, hostnameSlug } from './utils/http.js';
import { parseHtml, extractInlineCssUrls, rewriteHtmlPaths, buildSiteSummary } from './utils/parser.js';
import { downloadAssets } from './utils/assets.js';

const OUTPUT_ROOT = path.resolve(process.cwd(), '../scraped');

export async function scrapeWebsite(url, options = {}) {
  const { outputDir: customOutputDir, verbose = false } = options;
  const slug = hostnameSlug(url);
  const outputDir = customOutputDir || path.join(OUTPUT_ROOT, slug);

  await fse.ensureDir(outputDir);
  await fse.ensureDir(path.join(outputDir, 'assets'));
  await fse.ensureDir(path.join(outputDir, 'css'));
  await fse.ensureDir(path.join(outputDir, 'js'));

  const spinner = ora({ text: `Fetching ${url}`, color: 'cyan' }).start();

  let html;
  try {
    html = await fetchText(url);
  } catch (err) {
    spinner.fail(`Failed to fetch ${url}: ${err.message}`);
    throw err;
  }

  spinner.text = 'Parsing HTML...';
  const { $, cssUrls, jsUrls, assetUrls } = parseHtml(html, url);

  // --- Download CSS ---
  spinner.text = `Downloading ${cssUrls.length} CSS file(s)...`;
  const cssContents = [];
  const cssUrlToLocal = new Map();
  let inlineCssAssets = [];

  for (const cssUrl of cssUrls) {
    try {
      const cssText = await fetchText(cssUrl);
      const filename = path.basename(new URL(cssUrl).pathname) || 'style.css';
      const localPath = `css/${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const fullPath = path.join(outputDir, localPath);
      await fse.writeFile(fullPath, cssText);
      cssContents.push({ url: cssUrl, localPath, text: cssText });
      cssUrlToLocal.set(cssUrl, localPath);
      // collect asset URLs referenced inside CSS
      inlineCssAssets.push(...extractInlineCssUrls(cssText, cssUrl));
    } catch {
      // skip unreachable CSS
    }
  }

  // --- Download JS ---
  spinner.text = `Downloading ${jsUrls.length} JS file(s)...`;
  const jsContents = [];
  const jsUrlToLocal = new Map();

  for (const jsUrl of jsUrls) {
    try {
      const jsText = await fetchText(jsUrl);
      const filename = path.basename(new URL(jsUrl).pathname) || 'script.js';
      const localPath = `js/${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const fullPath = path.join(outputDir, localPath);
      await fse.writeFile(fullPath, jsText);
      jsContents.push({ url: jsUrl, localPath, text: jsText });
      jsUrlToLocal.set(jsUrl, localPath);
    } catch {
      // skip unreachable JS
    }
  }

  // --- Download image/media assets ---
  const allAssetUrls = [...new Set([...assetUrls, ...inlineCssAssets])];
  spinner.text = `Downloading ${allAssetUrls.length} asset(s)...`;
  const urlToLocal = await downloadAssets(allAssetUrls, outputDir, spinner);

  // Build relative-path maps for HTML rewriting
  const cssRelMap = new Map();
  for (const [k, v] of cssUrlToLocal) cssRelMap.set(k, v);
  const jsRelMap = new Map();
  for (const [k, v] of jsUrlToLocal) jsRelMap.set(k, v);
  const assetRelMap = new Map();
  for (const [k, v] of urlToLocal) {
    assetRelMap.set(k, path.relative(outputDir, v).replace(/\\/g, '/'));
  }

  // --- Rewrite HTML paths ---
  spinner.text = 'Rewriting asset paths in HTML...';
  const rewrittenHtml = rewriteHtmlPaths($, assetRelMap, outputDir, cssRelMap, jsRelMap);
  await fse.writeFile(path.join(outputDir, 'index.html'), rewrittenHtml);

  // --- Save raw original HTML for reference ---
  await fse.writeFile(path.join(outputDir, 'original.html'), html);

  // --- Build manifest ---
  const summary = buildSiteSummary(
    url,
    $,
    cssContents.map((c) => c.localPath),
    jsContents.map((c) => c.localPath),
    allAssetUrls,
  );

  const manifest = {
    ...summary,
    files: {
      html: 'index.html',
      css: cssContents.map((c) => c.localPath),
      js: jsContents.map((c) => c.localPath),
      assets: [...urlToLocal.values()].map((p) =>
        path.relative(outputDir, p).replace(/\\/g, '/'),
      ),
    },
  };
  await fse.writeJSON(path.join(outputDir, 'manifest.json'), manifest, { spaces: 2 });

  spinner.succeed(
    chalk.green(`Scraped ${url}`) +
      chalk.gray(
        ` → ${outputDir} (${cssContents.length} CSS, ${jsContents.length} JS, ${urlToLocal.size} assets)`,
      ),
  );

  return { outputDir, manifest };
}
