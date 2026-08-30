#!/usr/bin/env node
/**
 * Sprite generator for ВОСТОК-9.
 *
 * Reads scripts/art/manifest.json, asks PixelLab for every asset that is not on
 * disk yet, and writes the PNGs into content/art/ — which is Vite's publicDir,
 * so a generated file is served as ./art/<id>.png and lands in dist/ untouched.
 *
 * Three rules the whole design hangs on:
 *
 *   1. Generations cost money and the trial key has forty of them. A run never
 *      pays twice for the same asset: anything already in content/art/ is
 *      skipped, and the manifest is walked in priority order so the cells — 70%
 *      of the screen — are bought before the icons.
 *   2. The style has to be one style. Every request sends the same
 *      outline/shading/detail/view and a forced palette (`color_image`) built
 *      from GDD_VOSTOK9.md §16, encoded here as a PNG strip so the script needs
 *      no image library at all.
 *   3. Running out of credits is a normal outcome, not a crash. The run stops
 *      with a plain message and everything already written stays where it is.
 *   4. A stand-in is never mistaken for art. `scripts/art/placeholders.mjs`
 *      stamps every blob it paints with a `tEXt` chunk (`vostok9-placeholder`),
 *      and this script asks the **file**, not the index — so a deleted or
 *      hand-written content/art/index.json cannot turn fourteen blobs into
 *      fourteen sprites nobody paid for.
 *
 * Every answer is appended to scripts/art/ledger.json — usage, seed, prompt,
 * time — so the same set can be rebuilt on a fresh key.
 *
 * Usage:
 *   node scripts/art/generate.mjs                 all missing assets
 *   node scripts/art/generate.mjs --dry-run       show the plan, spend nothing
 *   node scripts/art/generate.mjs --only rock-l1  just these ids (comma separated)
 *   node scripts/art/generate.mjs --force rock-l1 regenerate this id even if it exists
 *   node scripts/art/generate.mjs --limit 3       stop after three generations
 *   node scripts/art/generate.mjs --index         only rewrite content/art/index.json
 *
 * The key lives in .env.local as PIXELLAB_API_KEY. It has no VITE_ prefix, so
 * Vite never hands it to the client: the game only ever loads finished PNGs.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const MANIFEST_PATH = join(HERE, 'manifest.json');
const LEDGER_PATH = join(HERE, 'ledger.json');
const ART_DIR = join(ROOT, 'content', 'art');
const INDEX_PATH = join(ART_DIR, 'index.json');

/**
 * PixelLab, or a stand-in. The override exists so the whole run — balance,
 * request, PNG on disk, ledger entry, index — can be exercised against a local
 * stub without spending a generation; nothing but a test ever sets it.
 */
const API = process.env.PIXELLAB_API_URL ?? 'https://api.pixellab.ai/v2';
/** Width and height of one palette swatch in the forced-palette strip. */
const SWATCH = 16;

// ---------------------------------------------------------------------------
// PNG encoder: eight bit truecolour, one IDAT, no filtering. Forty lines
// instead of a dependency — the only image this script has to make is a strip
// of flat colour swatches.
// ---------------------------------------------------------------------------

/** One PNG chunk: length, type, data, CRC over type+data. */
export function pngChunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

/**
 * A `tEXt` chunk: keyword, a zero byte, text. Latin-1 only, which every keyword
 * and value here is. Ancillary and private, so browsers, Phaser and every image
 * tool skip it — but it travels inside the file, which is the whole point.
 */
export function textChunk(keyword, text) {
  return pngChunk(
    'tEXt',
    Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]),
  );
}

/**
 * Pixels to a PNG file. `channels` is 3 for RGB and 4 for RGBA; the buffer is
 * width*height*channels bytes, row major, no padding. `extra` chunks are placed
 * after IHDR, where every ancillary chunk is allowed to sit.
 */
export function encodePng(width, height, pixels, channels = 3, extra = []) {
  const stride = width * channels;
  // Every scanline is prefixed with its filter type; 0 means «stored as is».
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // colour type: truecolour, with alpha or not
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...extra,
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// «This is not art»: the mark, and how it is read back
// ---------------------------------------------------------------------------

/**
 * The keyword `scripts/art/placeholders.mjs` stamps into every stand-in it
 * paints, and the only thing that tells a stand-in from real art.
 *
 * It lives **in the PNG**, not in `content/art/index.json`, because the index is
 * a derived file: delete it, run `--index`, and an index-only mark is gone —
 * fourteen crude blobs silently become «art», `--clean` deletes nothing, the
 * generator reports «Генерировать нечего» and a fresh key buys not one sprite.
 * A property of the file survives being deleted, copied, committed and rebuilt.
 */
export const PLACEHOLDER_KEYWORD = 'vostok9-placeholder';
export const PLACEHOLDER_TEXT =
  'Stand-in painted by scripts/art/placeholders.mjs. NOT the art: crude palette shapes at manifest sizes. Delete with `node scripts/art/placeholders.mjs --clean`.';

/** The chunk that mark is carried in. */
export function placeholderChunk() {
  return textChunk(PLACEHOLDER_KEYWORD, PLACEHOLDER_TEXT);
}

/**
 * Does this PNG carry the stand-in mark? Walks the chunk list rather than
 * searching the bytes: a compressed IDAT can spell anything by accident, a
 * chunk header cannot.
 */
export function isPlaceholderPng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
    return false;
  }
  let at = 8;
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('ascii', at + 4, at + 8);
    const start = at + 8;
    const end = start + length;
    if (end + 4 > buffer.length) {
      return false;
    }
    if (type === 'tEXt') {
      const zero = buffer.indexOf(0, start);
      if (zero > start && zero < end && buffer.toString('latin1', start, zero) === PLACEHOLDER_KEYWORD) {
        return true;
      }
    }
    if (type === 'IEND') {
      return false;
    }
    at = end + 4;
  }
  return false;
}

/** The same question about a file that may not be there at all. */
export function isPlaceholderFile(path) {
  try {
    return isPlaceholderPng(readFileSync(path));
  } catch {
    return false;
  }
}

export function parseHex(hex) {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

/**
 * The forced palette as PixelLab wants it: an image whose colours are the only
 * ones the generator may use. A horizontal strip of flat swatches is the
 * simplest thing that says exactly that.
 */
function paletteStripBase64(colors) {
  const width = colors.length * SWATCH;
  const height = SWATCH;
  const rgb = Buffer.alloc(width * height * 3);
  for (let x = 0; x < width; x += 1) {
    const [r, g, b] = parseHex(colors[Math.floor(x / SWATCH)]);
    for (let y = 0; y < height; y += 1) {
      const at = (y * width + x) * 3;
      rgb[at] = r;
      rgb[at + 1] = g;
      rgb[at + 2] = b;
    }
  }
  return encodePng(width, height, rgb).toString('base64');
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { dryRun: false, indexOnly: false, only: null, force: new Set(), limit: Infinity };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--index') {
      options.indexOnly = true;
    } else if (arg === '--only') {
      options.only = new Set((argv[++i] ?? '').split(',').filter(Boolean));
    } else if (arg === '--force') {
      for (const id of (argv[++i] ?? '').split(',').filter(Boolean)) {
        options.force.add(id);
      }
    } else if (arg === '--limit') {
      options.limit = Number(argv[++i]);
    } else {
      throw new Error(`неизвестный аргумент: ${arg}`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// The index the game reads
// ---------------------------------------------------------------------------

/**
 * Rewrites content/art/index.json from what is actually on disk.
 *
 * The game must never ask for a PNG that is not there: a 404 is a console error
 * in the browser and the e2e smoke test counts those. So the list of what
 * exists travels with the art instead of being guessed at runtime, and an asset
 * that was never generated simply stays a rectangle.
 */
export function writeIndex(manifest) {
  mkdirSync(ART_DIR, { recursive: true });
  const known = new Set(manifest.assets.map((asset) => asset.id));
  const present = readdirSync(ART_DIR)
    .filter((name) => name.endsWith('.png'))
    .map((name) => name.slice(0, -4))
    .filter((id) => known.has(id))
    .sort();
  // Read off the files themselves, never carried over from the old index: the
  // index is written from what is on disk, so it can never disagree with it.
  const stillPlaceholders = present.filter((id) => isPlaceholderFile(join(ART_DIR, `${id}.png`)));
  writeFileSync(
    INDEX_PATH,
    `${JSON.stringify(
      {
        _comment:
          'Written by scripts/art/generate.mjs (and scripts/art/placeholders.mjs) from what is on disk. Lists the sprites that exist, so the game never asks for a file that is not there — a 404 is a console error and the e2e smoke test counts those. `placeholders` is read back out of the PNGs themselves (a tEXt chunk named vostok9-placeholder), not remembered here: those files are stand-ins, not art, and generate.mjs overwrites them without being asked.',
        assets: present,
        placeholders: stillPlaceholders,
      },
      null,
      2,
    )}\n`,
  );
  return { present, placeholders: stillPlaceholders };
}

/** Ids of the stand-ins currently on disk, asked of the PNGs and nothing else. */
export function placeholdersOnDisk() {
  if (!existsSync(ART_DIR)) {
    return [];
  }
  return readdirSync(ART_DIR)
    .filter((name) => name.endsWith('.png'))
    .filter((name) => isPlaceholderFile(join(ART_DIR, name)))
    .map((name) => name.slice(0, -4))
    .sort();
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

function readLedger() {
  if (!existsSync(LEDGER_PATH)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function appendLedger(entry) {
  const ledger = readLedger();
  ledger.push(entry);
  writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function loadKey() {
  if (!process.env.PIXELLAB_API_KEY) {
    try {
      process.loadEnvFile(join(ROOT, '.env.local'));
    } catch {
      // No .env.local: the key may still come from the environment.
    }
  }
  const key = process.env.PIXELLAB_API_KEY;
  if (!key) {
    throw new Error('нет PIXELLAB_API_KEY — положи ключ в .env.local или в окружение');
  }
  return key;
}

async function getBalance(key) {
  const response = await fetch(`${API}/balance`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(`GET /balance: HTTP ${response.status} ${await response.text()}`);
  }
  return response.json();
}

/**
 * Generations left on the key, or null when the answer does not say.
 *
 * Measured against the API, not guessed: on the trial key of this project
 * `/balance` answers `subscription: {generations: 0, total: 40}` and every
 * generation request comes back `402 Insufficient generations and credits.
 * Generations: 40.0/40.0`. So `generations` is what is **left** and `total` is
 * what the plan held — 40 of 40 already spent. Read it the other way round and
 * the script cheerfully reports «40 осталось» over a dead key.
 */
function generationsLeft(balance) {
  const subscription = balance?.subscription;
  if (!subscription || typeof subscription.generations !== 'number') {
    return null;
  }
  return subscription.generations;
}

function describeBalance(balance) {
  const left = generationsLeft(balance);
  const usd = balance?.credits?.usd;
  const parts = [];
  if (left !== null) {
    parts.push(`генераций осталось: ${left} (план: ${balance.subscription.total ?? '?'})`);
  }
  if (typeof usd === 'number') {
    parts.push(`кредитов: $${usd.toFixed(2)}`);
  }
  return parts.join(', ') || JSON.stringify(balance);
}

/** Nothing left to spend: neither a generation nor a cent to buy one with. */
function isKeyEmpty(balance) {
  const left = generationsLeft(balance);
  const usd = balance?.credits?.usd;
  return left === 0 && (typeof usd !== 'number' || usd <= 0);
}

/** HTTP answers that mean «the key has nothing left», not «the request is bad». */
function isOutOfCredits(status, text) {
  if (status === 402) {
    return true;
  }
  return /credit|balance|quota|insufficient|generations/i.test(text) && status >= 400;
}

class OutOfCredits extends Error {}

async function createImage(key, request) {
  const response = await fetch(`${API}/create-image-pixflux`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const text = await response.text();
    if (isOutOfCredits(response.status, text)) {
      throw new OutOfCredits(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    throw new Error(`POST /create-image-pixflux: HTTP ${response.status} ${text.slice(0, 500)}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

  if (options.indexOnly) {
    const { present, placeholders } = writeIndex(manifest);
    console.log(`content/art/index.json: ${present.length} спрайтов — ${present.join(', ') || 'пусто'}`);
    if (placeholders.length > 0) {
      console.log(`из них заглушек: ${placeholders.join(', ')}`);
    }
    return;
  }

  const key = loadKey();
  const before = await getBalance(key);
  console.log(`Баланс PixelLab: ${describeBalance(before)}`);

  mkdirSync(ART_DIR, { recursive: true });

  const planned = [];
  for (const asset of manifest.assets) {
    if (options.only && !options.only.has(asset.id)) {
      continue;
    }
    const file = join(ART_DIR, `${asset.id}.png`);
    // A stand-in from placeholders.mjs is not art and must never stand between
    // the owner and a real generation, so it counts as «not there yet». The
    // answer is read out of the file, so a lost or hand-edited index.json
    // cannot turn fourteen blobs into fourteen paid-for sprites.
    const real = existsSync(file) && !isPlaceholderFile(file);
    if (real && !options.force.has(asset.id)) {
      console.log(`· ${asset.id}: уже есть, пропускаю`);
      continue;
    }
    planned.push(asset);
  }

  if (planned.length === 0) {
    console.log('Генерировать нечего.');
    writeIndex(manifest);
    return;
  }

  const budget = Math.min(planned.length, options.limit);
  console.log(`К генерации: ${planned.map((asset) => asset.id).join(', ')} (возьму ${budget})`);
  if (options.dryRun) {
    console.log('--dry-run: ничего не потрачено.');
    return;
  }

  // Asking for a picture on an empty key just burns a round trip and answers
  // 402. Say it once, plainly, and leave content/art/ exactly as it is.
  if (isKeyEmpty(before)) {
    console.log(
      '\nНа ключе не осталось ни генераций, ни кредитов — генерировать нечем.\n' +
        'Заведи новый ключ PixelLab, положи его в .env.local как PIXELLAB_API_KEY\n' +
        'и запусти этот же скрипт снова: он пойдёт по манифесту сверху вниз и\n' +
        'докупит недостающее. Уже сгенерированное не трогается.',
    );
    return;
  }

  let spent = 0;
  let stoppedAt = null;
  for (const asset of planned) {
    if (spent >= options.limit) {
      stoppedAt = asset.id;
      console.log(`Достигнут --limit ${options.limit}, останавливаюсь перед ${asset.id}.`);
      break;
    }

    const colors = manifest.palettes[asset.palette];
    if (!Array.isArray(colors)) {
      throw new Error(`${asset.id}: нет палитры «${asset.palette}» в манифесте`);
    }

    const request = {
      description: asset.prompt,
      image_size: asset.size,
      text_guidance_scale: manifest.style.text_guidance_scale,
      outline: manifest.style.outline,
      shading: manifest.style.shading,
      detail: manifest.style.detail,
      view: asset.view ?? manifest.style.view,
      no_background: asset.no_background === true,
      color_image: { type: 'base64', base64: paletteStripBase64(colors), format: 'png' },
      seed: asset.seed,
    };

    const startedAt = Date.now();
    process.stdout.write(`→ ${asset.id} (${asset.size.width}×${asset.size.height}, палитра ${asset.palette})… `);
    let answer;
    try {
      answer = await createImage(key, request);
    } catch (error) {
      if (error instanceof OutOfCredits) {
        console.log('нет');
        stoppedAt = asset.id;
        console.log(`\nКончились генерации на ключе. Остановился на «${asset.id}».`);
        console.log(`Сделанное уже лежит в content/art/, повторный запуск его не тронет.`);
        console.log(`Причина: ${error.message}`);
        break;
      }
      console.log('ошибка');
      throw error;
    }

    const image = answer?.image;
    if (!image?.base64) {
      throw new Error(`${asset.id}: ответ без картинки — ${JSON.stringify(answer).slice(0, 300)}`);
    }
    writeFileSync(join(ART_DIR, `${asset.id}.png`), Buffer.from(image.base64, 'base64'));
    spent += 1;
    console.log(`ок за ${((Date.now() - startedAt) / 1000).toFixed(1)} с`);

    appendLedger({
      id: asset.id,
      at: new Date(startedAt).toISOString(),
      seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      seed: asset.seed,
      size: asset.size,
      palette: asset.palette,
      colors,
      style: {
        outline: request.outline,
        shading: request.shading,
        detail: request.detail,
        view: request.view,
        text_guidance_scale: request.text_guidance_scale,
        no_background: request.no_background,
      },
      prompt: asset.prompt,
      usage: answer.usage ?? null,
    });
  }

  // Anything just generated is real art now: the PNG that arrived carries no
  // mark, so the index writer stops calling it a stand-in on its own.
  const { present, placeholders: stillPlaceholders } = writeIndex(manifest);
  console.log(`\nСгенерировано за запуск: ${spent}.`);
  console.log(`В content/art/ лежит ${present.length}: ${present.join(', ')}`);
  if (stillPlaceholders.length > 0) {
    console.log(`Ещё заглушки, не арт: ${stillPlaceholders.join(', ')}`);
  }
  if (stoppedAt) {
    console.log(`Остановился на «${stoppedAt}».`);
  }

  const after = await getBalance(key);
  console.log(`Баланс PixelLab: ${describeBalance(after)}`);
}

// Importable: placeholders.mjs borrows the PNG encoder and the index writer, so
// there is one copy of each. Only a direct run generates anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
