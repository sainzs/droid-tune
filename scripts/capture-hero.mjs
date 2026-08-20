#!/usr/bin/env node

// Render assets/hero.html with headless Chrome, then assemble the PNG frames
// into a looping GIF. It intentionally uses Chrome's CLI rather than adding a
// browser dependency to this zero-runtime-dependency project.

import { accessSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = join(ROOT, 'assets', 'hero.html');
const DEFAULT_OUT = join(ROOT, 'assets', 'hero.gif');
const WIDTH = 1000;
const HEIGHT = 640;
const FPS = 12;
const DURATION_MS = 13_200;

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROMIUM_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // Try the next known installation.
    }
  }
  throw new Error('Chrome not found; set CHROME_PATH to a headless-capable browser');
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: options.stdio ?? 'ignore' });
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited ${code}: ${stderr.slice(-600)}`));
    });
  });
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const out = resolve(arg('--out', DEFAULT_OUT));
  const fps = Number(arg('--fps', FPS));
  if (!Number.isInteger(fps) || fps < 1 || fps > 30) throw new Error('--fps must be an integer from 1 to 30');
  const frames = Math.ceil((DURATION_MS / 1000) * fps);

  const chrome = findChrome();
  const work = await mkdtemp(join(tmpdir(), 'droidtune-hero-'));
  const profile = join(work, 'chrome-profile');
  const framesDir = join(work, 'frames');
  await mkdir(framesDir);
  await mkdir(dirname(out), { recursive: true });

  try {
    process.stdout.write(`capturing ${frames} frames at ${WIDTH}x${HEIGHT} / ${fps}fps\n`);
    for (let frame = 0; frame < frames; frame += 1) {
      const filename = join(framesDir, `frame-${String(frame).padStart(4, '0')}.png`);
      const url = `${pathToFileURL(HTML).href}?frame=${frame}`;
      await run(chrome, [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--run-all-compositor-stages-before-draw',
        '--force-device-scale-factor=1',
        `--user-data-dir=${profile}`,
        `--window-size=${WIDTH},${HEIGHT}`,
        `--screenshot=${filename}`,
        '--virtual-time-budget=100',
        url
      ]);
      if ((frame + 1) % 24 === 0 || frame === frames - 1) {
        process.stdout.write(`  ${frame + 1}/${frames}\n`);
      }
    }

    const palette = join(work, 'palette.png');
    const input = join(framesDir, 'frame-%04d.png');
    await run('ffmpeg', [
      '-y', '-loglevel', 'error', '-framerate', String(fps), '-i', input,
      '-vf', 'palettegen=max_colors=128:stats_mode=diff', palette
    ]);
    await run('ffmpeg', [
      '-y', '-loglevel', 'error', '-framerate', String(fps), '-i', input,
      '-i', palette,
      '-lavfi', 'paletteuse=dither=bayer:bayer_scale=4',
      '-loop', '0', out
    ]);

    const bytes = (await stat(out)).size;
    process.stdout.write(`wrote ${out} (${(bytes / 1024).toFixed(0)}KB)\n`);
    if (bytes >= 3 * 1024 * 1024) {
      throw new Error('hero.gif is over the 3MB README asset budget');
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`capture-hero: ${error.message}`);
  process.exitCode = 1;
});
