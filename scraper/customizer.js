import path from 'path';
import fse from 'fs-extra';
import ora from 'ora';
import chalk from 'chalk';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-6';
const OUTPUT_ROOT = path.resolve(process.cwd(), '../output');

// Max chars to send per file to stay within context limits
const CSS_CHAR_LIMIT = 40000;
const JS_CHAR_LIMIT = 20000;
const HTML_CHAR_LIMIT = 60000;

function truncate(text, limit) {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '\n\n[... truncated for context ...]';
}

async function readScrapedSite(siteDir) {
  const manifestPath = path.join(siteDir, 'manifest.json');
  if (!(await fse.pathExists(manifestPath))) {
    throw new Error(`No manifest.json found in ${siteDir}. Run scrape first.`);
  }
  const manifest = await fse.readJSON(manifestPath);

  const html = await fse.readFile(path.join(siteDir, 'index.html'), 'utf8');

  const cssFiles = [];
  for (const cssPath of manifest.files.css) {
    try {
      const text = await fse.readFile(path.join(siteDir, cssPath), 'utf8');
      cssFiles.push({ path: cssPath, text });
    } catch { /* skip */ }
  }

  const jsFiles = [];
  for (const jsPath of manifest.files.js) {
    try {
      const text = await fse.readFile(path.join(siteDir, jsPath), 'utf8');
      jsFiles.push({ path: jsPath, text });
    } catch { /* skip */ }
  }

  return { manifest, html, cssFiles, jsFiles };
}

function buildSystemPrompt() {
  return `You are an expert web developer and designer. You have been given the scraped source code of a real website. Your job is to customize and transform it into a new website based on the user's instructions.

Guidelines:
- Preserve ALL functionality unless the user asks to change or remove something
- When rewriting HTML, output the complete new HTML document
- When rewriting CSS, output the complete new CSS content
- When rewriting JS, output the complete new JS content
- Use modern, clean, and accessible HTML5/CSS3
- Keep the same overall layout and navigation structure unless told otherwise
- Replace placeholder/sample content with the user's requested content
- Output ONLY the file content (no markdown fences, no explanations in the file content)

When the user asks for changes, respond with:
1. A brief explanation of what you changed
2. The modified files in clearly labeled sections using this format:
   === FILE: <filename> ===
   <complete file content>
   === END FILE ===`;
}

function buildInitialContext(manifest, html, cssFiles, jsFiles) {
  let context = `SCRAPED WEBSITE CONTEXT
========================
Source URL: ${manifest.url}
Title: ${manifest.title}
Description: ${manifest.description}
Scraped at: ${manifest.scrapedAt}

Navigation items: ${manifest.navigation.map((n) => n.text).join(', ')}
Main headings: ${manifest.headings.join(', ')}

Page content sample:
${manifest.bodyTextSample}

========================
SOURCE FILES
========================

--- index.html ---
${truncate(html, HTML_CHAR_LIMIT)}

${cssFiles.map((f) => `--- ${f.path} ---\n${truncate(f.text, CSS_CHAR_LIMIT)}`).join('\n\n')}

${jsFiles.map((f) => `--- ${f.path} ---\n${truncate(f.text, JS_CHAR_LIMIT)}`).join('\n\n')}`;

  return context;
}

function parseFileBlocks(response) {
  const files = {};
  const regex = /=== FILE: (.+?) ===\n([\s\S]*?)=== END FILE ===/g;
  let match;
  while ((match = regex.exec(response)) !== null) {
    files[match[1].trim()] = match[2];
  }
  return files;
}

async function applyChanges(files, outputDir, sourceDir) {
  // First copy all source files to output
  await fse.copy(sourceDir, outputDir, { overwrite: true });

  // Then overwrite with AI-modified files
  for (const [filename, content] of Object.entries(files)) {
    const dest = path.join(outputDir, filename);
    await fse.ensureDir(path.dirname(dest));
    await fse.writeFile(dest, content);
  }
}

export async function customizeSite(siteDir, instructions, options = {}) {
  const { interactive = false, outputDir: customOutputDir } = options;

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable is not set. ' +
      'Set it with: export ANTHROPIC_API_KEY=your-key',
    );
  }

  const spinner = ora({ text: 'Reading scraped site...', color: 'cyan' }).start();

  const { manifest, html, cssFiles, jsFiles } = await readScrapedSite(siteDir);
  const slug = path.basename(siteDir);
  const outputDir = customOutputDir || path.join(OUTPUT_ROOT, `${slug}-custom`);
  await fse.ensureDir(outputDir);

  spinner.text = 'Sending to Claude for customization...';

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const context = buildInitialContext(manifest, html, cssFiles, jsFiles);

  const messages = [
    {
      role: 'user',
      content: `${context}\n\n========================\nUSER INSTRUCTIONS\n========================\n${instructions}`,
    },
  ];

  let response;
  try {
    const result = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: buildSystemPrompt(),
      messages,
    });
    response = result.content[0].text;
  } catch (err) {
    spinner.fail('Claude API error: ' + err.message);
    throw err;
  }

  spinner.text = 'Applying changes...';

  const modifiedFiles = parseFileBlocks(response);
  const fileCount = Object.keys(modifiedFiles).length;

  if (fileCount === 0) {
    spinner.warn('Claude response did not contain any FILE blocks. Saving response as changes.md');
    await fse.copy(siteDir, outputDir, { overwrite: true });
    await fse.writeFile(path.join(outputDir, 'changes.md'), response);
  } else {
    await applyChanges(modifiedFiles, outputDir, siteDir);
  }

  // Save the full conversation log
  const log = {
    sourceUrl: manifest.url,
    instructions,
    modifiedFiles: Object.keys(modifiedFiles),
    claudeResponse: response,
    timestamp: new Date().toISOString(),
  };
  await fse.writeJSON(path.join(outputDir, 'customization-log.json'), log, { spaces: 2 });

  spinner.succeed(
    chalk.green(`Customized site saved`) +
      chalk.gray(` → ${outputDir} (${fileCount} file(s) modified)`),
  );

  console.log(chalk.cyan('\nClaude\'s changes:'));
  // Print summary (lines before first FILE block)
  const summaryEnd = response.indexOf('=== FILE:');
  const summary = summaryEnd > 0 ? response.slice(0, summaryEnd).trim() : response.trim();
  console.log(chalk.white(summary.slice(0, 1000)));

  if (fileCount > 0) {
    console.log(chalk.cyan('\nModified files:'));
    Object.keys(modifiedFiles).forEach((f) => console.log(chalk.yellow(`  • ${f}`)));
  }

  return { outputDir, modifiedFiles, response };
}

export async function interactiveCustomize(siteDir, options = {}) {
  const { outputDir: customOutputDir } = options;

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set.');
  }

  const spinner = ora({ text: 'Reading scraped site...', color: 'cyan' }).start();
  const { manifest, html, cssFiles, jsFiles } = await readScrapedSite(siteDir);
  spinner.succeed('Site loaded.');

  const slug = path.basename(siteDir);
  const outputDir = customOutputDir || path.join(OUTPUT_ROOT, `${slug}-custom`);
  await fse.ensureDir(outputDir);
  await fse.copy(siteDir, outputDir, { overwrite: true });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const context = buildInitialContext(manifest, html, cssFiles, jsFiles);

  const conversationHistory = [];
  // Add site context as the first user message
  conversationHistory.push({
    role: 'user',
    content: `${context}\n\nI'd like to customize this website. I'll give you instructions shortly.`,
  });
  conversationHistory.push({
    role: 'assistant',
    content: `I've analyzed the website "${manifest.title}" scraped from ${manifest.url}. I can see it has ${cssFiles.length} CSS file(s), ${jsFiles.length} JS file(s), and ${manifest.assetCount} assets.\n\nWhat changes would you like to make?`,
  });

  console.log(chalk.cyan('\n=== Interactive Customization Mode ==='));
  console.log(chalk.gray(`Site: ${manifest.title} (${manifest.url})`));
  console.log(chalk.gray(`Output: ${outputDir}`));
  console.log(chalk.yellow('\nType your customization instructions. Type "done" to exit.\n'));

  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (q) => new Promise((res) => rl.question(q, res));

  let round = 0;
  while (true) {
    const instruction = await ask(chalk.green('You: '));
    if (instruction.trim().toLowerCase() === 'done') break;
    if (!instruction.trim()) continue;

    round++;
    conversationHistory.push({ role: 'user', content: instruction });

    const thinkSpinner = ora('Claude is thinking...').start();
    let response;
    try {
      const result = await client.messages.create({
        model: MODEL,
        max_tokens: 8192,
        system: buildSystemPrompt(),
        messages: conversationHistory,
      });
      response = result.content[0].text;
    } catch (err) {
      thinkSpinner.fail('API error: ' + err.message);
      continue;
    }

    conversationHistory.push({ role: 'assistant', content: response });

    const modifiedFiles = parseFileBlocks(response);
    if (Object.keys(modifiedFiles).length > 0) {
      for (const [filename, content] of Object.entries(modifiedFiles)) {
        const dest = path.join(outputDir, filename);
        await fse.ensureDir(path.dirname(dest));
        await fse.writeFile(dest, content);
      }
      thinkSpinner.succeed(
        `Applied changes to: ${Object.keys(modifiedFiles).join(', ')}`,
      );
    } else {
      thinkSpinner.succeed('Claude responded (no file changes).');
    }

    // Print Claude's explanation
    const summaryEnd = response.indexOf('=== FILE:');
    const summary = summaryEnd > 0 ? response.slice(0, summaryEnd).trim() : response.trim();
    console.log(chalk.cyan('\nClaude: ') + chalk.white(summary.slice(0, 800)));
    console.log();
  }

  // Save conversation log
  await fse.writeJSON(
    path.join(outputDir, 'customization-log.json'),
    { sourceUrl: manifest.url, conversation: conversationHistory, timestamp: new Date().toISOString() },
    { spaces: 2 },
  );

  rl.close();
  console.log(chalk.green(`\nDone! Customized site saved to: ${outputDir}`));
  return { outputDir };
}
