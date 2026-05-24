#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import fse from 'fs-extra';
import { scrapeWebsite } from './scraper.js';
import { customizeSite, interactiveCustomize } from './customizer.js';

const program = new Command();

program
  .name('lit-scraper')
  .description(
    chalk.bold('LIT-AI-Travel Website Scraper & AI Customizer') +
      '\n  Scrape any website and customize it with Claude AI',
  )
  .version('1.0.0');

// ── scrape ────────────────────────────────────────────────────────────────────
program
  .command('scrape <url>')
  .description('Scrape a website and save all HTML, CSS, JS, and assets locally')
  .option('-o, --output <dir>', 'Custom output directory')
  .action(async (url, opts) => {
    try {
      if (!url.startsWith('http')) url = 'https://' + url;
      const { outputDir, manifest } = await scrapeWebsite(url, { outputDir: opts.output });
      console.log(chalk.cyan('\nSite summary:'));
      console.log(`  Title:       ${manifest.title}`);
      console.log(`  Description: ${manifest.description?.slice(0, 80) || '(none)'}`);
      console.log(`  CSS files:   ${manifest.cssCount}`);
      console.log(`  JS files:    ${manifest.jsCount}`);
      console.log(`  Assets:      ${manifest.assetCount}`);
      console.log(chalk.gray(`\nNext step: node cli.js customize "${outputDir}" "your instructions"`));
    } catch (err) {
      console.error(chalk.red('Scrape failed:'), err.message);
      process.exit(1);
    }
  });

// ── customize ─────────────────────────────────────────────────────────────────
program
  .command('customize <siteDir> [instructions]')
  .description(
    'Customize a scraped website using Claude AI\n' +
      '  Pass instructions as argument, or use --interactive for a chat session',
  )
  .option('-i, --interactive', 'Start an interactive customization chat session')
  .option('-o, --output <dir>', 'Custom output directory')
  .action(async (siteDir, instructions, opts) => {
    try {
      const absDir = path.resolve(siteDir);
      if (!(await fse.pathExists(absDir))) {
        throw new Error(`Directory not found: ${absDir}`);
      }
      if (opts.interactive) {
        await interactiveCustomize(absDir, { outputDir: opts.output });
      } else {
        if (!instructions) {
          console.error(chalk.red('Error: provide instructions or use --interactive'));
          process.exit(1);
        }
        await customizeSite(absDir, instructions, { outputDir: opts.output });
      }
    } catch (err) {
      console.error(chalk.red('Customize failed:'), err.message);
      process.exit(1);
    }
  });

// ── scrape-and-customize ──────────────────────────────────────────────────────
program
  .command('scrape-and-customize <url> <instructions>')
  .description('Scrape a website and immediately customize it with AI in one step')
  .option('-o, --output <dir>', 'Custom output directory for the customized site')
  .action(async (url, instructions, opts) => {
    try {
      if (!url.startsWith('http')) url = 'https://' + url;

      console.log(chalk.bold.cyan('\n[Step 1/2] Scraping website...\n'));
      const { outputDir: scrapedDir } = await scrapeWebsite(url);

      console.log(chalk.bold.cyan('\n[Step 2/2] Customizing with Claude AI...\n'));
      await customizeSite(scrapedDir, instructions, { outputDir: opts.output });
    } catch (err) {
      console.error(chalk.red('Failed:'), err.message);
      process.exit(1);
    }
  });

// ── list ──────────────────────────────────────────────────────────────────────
program
  .command('list')
  .description('List all scraped and customized sites')
  .action(async () => {
    const scrapedRoot = path.resolve(process.cwd(), '../scraped');
    const outputRoot = path.resolve(process.cwd(), '../output');

    console.log(chalk.bold.cyan('\nScraped sites:'));
    if (await fse.pathExists(scrapedRoot)) {
      const dirs = await fse.readdir(scrapedRoot);
      for (const d of dirs) {
        const manifestPath = path.join(scrapedRoot, d, 'manifest.json');
        if (await fse.pathExists(manifestPath)) {
          const m = await fse.readJSON(manifestPath);
          console.log(chalk.yellow(`  ${d}`) + chalk.gray(` — ${m.title || m.url}`));
        }
      }
    } else {
      console.log(chalk.gray('  (none yet)'));
    }

    console.log(chalk.bold.cyan('\nCustomized sites:'));
    if (await fse.pathExists(outputRoot)) {
      const dirs = await fse.readdir(outputRoot);
      for (const d of dirs) {
        const logPath = path.join(outputRoot, d, 'customization-log.json');
        if (await fse.pathExists(logPath)) {
          const log = await fse.readJSON(logPath);
          console.log(chalk.green(`  ${d}`) + chalk.gray(` — from ${log.sourceUrl}`));
        }
      }
    } else {
      console.log(chalk.gray('  (none yet)'));
    }
    console.log();
  });

program.parse(process.argv);
