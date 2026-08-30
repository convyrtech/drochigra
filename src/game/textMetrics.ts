/**
 * How wide a line of text will be, without a browser to ask.
 *
 * The layout of the report, the closed plan, the hangar and the base is decided
 * by numbers in `layout.ts` — a margin here, a badge width there — and every one
 * of those numbers is a promise that the line written at that place still ends
 * before the panel does. Nothing checked that promise: the game measures text in
 * a canvas, the tests run in node, and the two never met. Three lines had walked
 * off their panels by the time anyone looked.
 *
 * So the widths are measured once, here, and both halves can use them:
 * `tests/textFit.test.ts` holds every line of those screens against the box it
 * is written in, and `fitInside` in `src/ui/formPage.ts` uses the real canvas at run time as the
 * last resort for the line nobody thought of.
 *
 * ## Where the numbers come from
 *
 * Chromium was asked for `measureText` on every character the game writes, at
 * `26px`, in eight sans-serif families — DejaVu Sans, Liberation Sans, Noto
 * Sans, Ubuntu Sans, Ubuntu, Arimo, FreeSans and whatever `sans-serif` resolves
 * to — and each character here keeps the **widest** of the eight. Three facts
 * make that a bound and not an estimate:
 *
 *  1. **Advances add up.** For every family and every string of this game, the
 *     sum of the per-character advances came out equal to or larger than the
 *     measured width of the whole string (the difference is kerning, and kerning
 *     only ever pulls letters together). So a sum is never short.
 *  2. **Size scales exactly.** The same strings at `58px` measured exactly
 *     58/26 of their width at `26px`, in every family. So one table serves every
 *     font size.
 *  3. **The widest of eight covers the target.** `FONT_FAMILY` is
 *     `system-ui, sans-serif`, which is Roboto on Android, San Francisco on iOS,
 *     Segoe UI on Windows and one of these on Linux. DejaVu Sans — the widest of
 *     the eight and the one this table mostly is — is wider than Roboto and San
 *     Francisco on Cyrillic capitals by around a tenth, so a line that fits here
 *     fits on the phones the game is for.
 *
 * The honest limit: this is a bound over the fonts that could be measured, not
 * over every font on earth. A device with something wider still would break it,
 * which is exactly why `fitInside` exists as well.
 */

/**
 * Advance width of one character, in ems — multiply by the font size in pixels.
 * The widest of the eight families measured, per character.
 */
const EM: Readonly<Record<string, number>> = {
  ' ': 0.3179, '!': 0.4009, '"': 0.46, '%': 0.9502, '(': 0.3901, ')': 0.3901,
  '+': 0.8379, ',': 0.3179, '-': 0.3608, '.': 0.3179, '/': 0.372, '0': 0.6362,
  '1': 0.6362, '2': 0.6362, '3': 0.6362, '4': 0.6362, '5': 0.6362, '6': 0.6362,
  '7': 0.6362, '8': 0.6362, '9': 0.6362, ':': 0.3369, 'A': 0.6841, 'B': 0.686,
  'C': 0.7222, 'D': 0.77, 'E': 0.667, 'F': 0.6108, 'G': 0.7778, 'H': 0.752,
  'I': 0.339, 'J': 0.528, 'K': 0.674, 'L': 0.563, 'M': 0.907, 'N': 0.76,
  'O': 0.7871, 'P': 0.667, 'Q': 0.7871, 'R': 0.7222, 'S': 0.667, 'T': 0.632,
  'U': 0.7319, 'V': 0.6841, 'W': 0.9888, 'X': 0.6851, 'Y': 0.678, 'Z': 0.6851,
  'a': 0.6128, 'b': 0.6348, 'c': 0.5498, 'd': 0.6348, 'e': 0.6152, 'f': 0.381,
  'g': 0.6348, 'h': 0.6338, 'i': 0.2778, 'j': 0.2778, 'k': 0.5791, 'l': 0.2778,
  'm': 0.9741, 'n': 0.6338, 'o': 0.6118, 'p': 0.6348, 'q': 0.6348, 'r': 0.413,
  's': 0.521, 't': 0.393, 'u': 0.6338, 'v': 0.5918, 'w': 0.8179, 'x': 0.5918,
  'y': 0.5918, 'z': 0.5249, '«': 0.6118, '·': 0.333, '»': 0.6118, '×': 0.8379,
  'Ё': 0.6675, 'А': 0.6841, 'Б': 0.686, 'В': 0.686, 'Г': 0.6099, 'Д': 0.812,
  'Е': 0.667, 'Ж': 1.0771, 'З': 0.653, 'И': 0.768, 'Й': 0.768, 'К': 0.71,
  'Л': 0.752, 'М': 0.907, 'Н': 0.752, 'О': 0.7871, 'П': 0.752, 'Р': 0.667,
  'С': 0.7222, 'Т': 0.632, 'У': 0.6353, 'Ф': 0.861, 'Х': 0.6851, 'Ц': 0.7764,
  'Ч': 0.698, 'Ш': 1.0693, 'Щ': 1.0938, 'Ъ': 0.845, 'Ы': 0.8853, 'Ь': 0.686,
  'Э': 0.7188, 'Ю': 1.0796, 'Я': 0.7222, 'а': 0.6128, 'б': 0.6167, 'в': 0.5894,
  'г': 0.5254, 'д': 0.6914, 'е': 0.6152, 'ж': 0.9009, 'з': 0.5317, 'и': 0.6499,
  'й': 0.6499, 'к': 0.604, 'л': 0.6392, 'м': 0.7544, 'н': 0.6538, 'о': 0.6118,
  'п': 0.6538, 'р': 0.6348, 'с': 0.5498, 'т': 0.5825, 'у': 0.5918, 'ф': 0.855,
  'х': 0.5918, 'ц': 0.6807, 'ч': 0.613, 'ш': 0.915, 'щ': 0.9419, 'ъ': 0.7065,
  'ы': 0.7896, 'ь': 0.594, 'э': 0.5488, 'ю': 0.8418, 'я': 0.6016, 'ё': 0.6152,
  '–': 0.5562, '—': 1.0, '№': 1.1,
};

/**
 * What an unknown character costs: the widest entry in the table, which is `№`.
 * A character nobody measured is charged as the widest one that was, so an
 * unknown glyph can only ever make the estimate too big, never too small.
 */
const UNKNOWN_EM = 1.1;

/**
 * The width of a line, in design pixels, at or above what a canvas would give.
 *
 * `fontSize` is the CSS string the layout writes — `'26px'` — because that is
 * what `VIEW.font` holds and what Phaser is handed; anything else would be a
 * second place to keep the same number.
 */
export function textWidth(text: string, fontSize: string): number {
  const px = fontPx(fontSize);
  let ems = 0;
  for (const character of text) {
    ems += EM[character] ?? UNKNOWN_EM;
  }
  return ems * px;
}

/**
 * How tall the ink of one line is, in design pixels — the same upper bound, for
 * the other axis.
 *
 * It is the **ink**, not the line box: `actualBoundingBoxAscent + Descent` over
 * the same eight families, measured on `ЁДКЩgjy0` — a capital Ё for the highest
 * mark Russian has and three descenders under it — came to at most 1.19 of the
 * font size, and this rounds that up. The line box is taller (up to 1.39) but
 * mostly air: two lines whose boxes touch still have clear white between their
 * letters, and a check built on boxes would have failed the report's own
 * headline, which is set exactly like that on purpose.
 */
export function lineHeight(fontSize: string): number {
  return fontPx(fontSize) * 1.25;
}

/** `'26px'` to `26`. Throws on anything else: a silent 0 would pass every test. */
export function fontPx(fontSize: string): number {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(fontSize);
  if (!match) {
    throw new Error(`font size must be written as «NNpx», got «${fontSize}»`);
  }
  return Number(match[1]);
}
