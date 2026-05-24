import path from 'path';
import { fileURLToPath } from 'url';
import fse from 'fs-extra';
import mime from 'mime-types';
import pLimit from 'p-limit';
import { fetchBuffer, resolveUrl } from './http.js';

const ASSET_CONCURRENCY = 6;

function urlToLocalPath(assetUrl, baseDir) {
  try {
    const u = new URL(assetUrl);
    let filePath = u.pathname;
    if (!filePath || filePath === '/') filePath = '/index.html';
    // strip leading slash and collapse path traversal
    const clean = filePath.replace(/^\//, '').replace(/\.\./g, '_');
    const localPath = path.join(baseDir, 'assets', clean);
    return localPath;
  } catch {
    return null;
  }
}

function ensureExtension(localPath, contentType) {
  if (path.extname(localPath)) return localPath;
  const ext = mime.extension(contentType.split(';')[0].trim());
  return ext ? `${localPath}.${ext}` : localPath;
}

export async function downloadAssets(assetUrls, baseDir, spinner) {
  const limit = pLimit(ASSET_CONCURRENCY);
  const urlToLocal = new Map();
  const seen = new Set();

  const tasks = assetUrls
    .filter((u) => u && !seen.has(u) && (() => { seen.add(u); return true; })())
    .map((assetUrl) =>
      limit(async () => {
        let localPath = urlToLocalPath(assetUrl, baseDir);
        if (!localPath) return;
        try {
          const { buffer, contentType } = await fetchBuffer(assetUrl);
          localPath = ensureExtension(localPath, contentType);
          await fse.ensureDir(path.dirname(localPath));
          await fse.writeFile(localPath, buffer);
          urlToLocal.set(assetUrl, localPath);
          if (spinner) spinner.text = `Downloaded ${path.basename(localPath)}`;
        } catch {
          // non-fatal: some assets may be protected or unavailable
        }
      })
    );

  await Promise.all(tasks);
  return urlToLocal;
}

export function relativeAssetPath(assetLocalPath, fromFile, baseDir) {
  const rel = path.relative(path.dirname(fromFile), assetLocalPath);
  return rel.startsWith('.') ? rel : `./${rel}`;
}
