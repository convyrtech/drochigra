import Phaser from 'phaser';
import { COLORS, cssColor, FONT_FAMILY } from '../game/layout.js';
import type { FormArt, FormPage, FormText } from './formLayout.js';
import { artImage, artImageCentred } from './plate.js';

/**
 * Turns a `FormPage` from `src/ui/formLayout.ts` into Phaser objects.
 *
 * Everything about *where* things go was decided already, without a scene; this
 * file only draws. That is the whole point of the split — the positions are
 * measurable by a unit test, and there is one place, here, where a text object
 * is actually made.
 *
 * The one thing this file decides on its own is the last line of defence for
 * the promise the layout makes: after Phaser has measured a line with the real
 * font of the real device, a line that still overruns its box is shrunk until it
 * fits. `textMetrics.ts` bounds every font that could be measured, so this
 * should never fire — but «should never» is how the three lines that started
 * this got onto the paper in the first place.
 *
 * Every part is pinned with scrollFactor 0 and put on one depth, so the report
 * stays put while the shaft scrolls behind it.
 */

export type PagePart =
  | Phaser.GameObjects.Rectangle
  | Phaser.GameObjects.Text
  | Phaser.GameObjects.Image;

export interface DrawnPage {
  /** Everything drawn, in draw order. The caller pins, tweens and destroys these. */
  readonly parts: PagePart[];
  /** Everything except the full-screen scrim: what a screen animates. */
  readonly panelParts: PagePart[];
  readonly button: Phaser.GameObjects.Rectangle;
  /** Lines by their `FormText.id`, for the one figure a screen animates. */
  readonly text: (id: string) => Phaser.GameObjects.Text;
}

export function drawFormPage(
  scene: Phaser.Scene,
  page: FormPage,
  options: { readonly width: number; readonly height: number; readonly depth: number },
): DrawnPage {
  const { width, height, depth } = options;
  const parts: PagePart[] = [];
  const byId = new Map<string, Phaser.GameObjects.Text>();

  const shade = scene.add
    .rectangle(0, 0, width, height, COLORS.shaft, page.shadeAlpha)
    .setOrigin(0, 0);
  parts.push(shade);

  const panelStart = parts.length;
  const sheet = page.sheet ? drawArt(scene, page.sheet) : null;
  parts.push(
    sheet ??
      scene.add
        .rectangle(page.panel.x, page.panel.y, page.panel.width, page.panel.height, COLORS.panel)
        .setOrigin(0, 0)
        .setStrokeStyle(3, page.panelEdgeColor),
  );

  for (const rule of [...page.sheetRules, ...page.headerRules]) {
    parts.push(
      scene.add
        .rectangle(rule.x, rule.y, rule.width, rule.height, rule.color, rule.alpha ?? 1)
        .setOrigin(0, 0),
    );
  }
  for (const art of page.art) {
    const image = drawArt(scene, art);
    if (image) {
      parts.push(image);
    }
  }
  for (const rule of page.rules) {
    parts.push(
      scene.add
        .rectangle(rule.x, rule.y, rule.width, rule.height, rule.color, rule.alpha ?? 1)
        .setOrigin(0, 0),
    );
  }
  for (const line of page.texts) {
    const text = placeText(scene, line);
    byId.set(line.id, text);
    parts.push(text);
  }

  const button = scene.add
    .rectangle(page.button.x, page.button.y, page.button.width, page.button.height, COLORS.button)
    .setOrigin(0, 0)
    .setStrokeStyle(3, COLORS.buttonEdge);
  parts.push(button);
  const label = placeText(scene, page.button.label);
  byId.set(page.button.label.id, label);
  parts.push(label);

  for (const part of parts) {
    part.setScrollFactor(0).setDepth(depth);
  }

  return {
    parts,
    panelParts: parts.slice(panelStart),
    button,
    text(id: string): Phaser.GameObjects.Text {
      const found = byId.get(id);
      if (!found) {
        throw new Error(`the page has no line «${id}»`);
      }
      return found;
    },
  };
}

/**
 * One line of type, measured against its box with the font the device really
 * has and shrunk until it fits.
 *
 * The shrink is a floor, not a design: it walks down whole pixels so the result
 * is still a sane font size, and it stops at half the asked-for size — a line
 * that needs less than half has a layout problem no clamp can hide, and a
 * three-pixel word is not more readable than one that overhangs.
 */
export function placeText(
  scene: Phaser.Scene,
  line: FormText,
): Phaser.GameObjects.Text {
  const text = scene.add
    .text(line.x, line.y, line.text, {
      fontFamily: FONT_FAMILY,
      fontSize: line.fontSize,
      color: cssColor(line.color),
    })
    .setOrigin(line.originX, line.originY);
  if (line.stroke) {
    text.setStroke(cssColor(line.stroke.color), line.stroke.width);
  }
  fitInside(text, line.box[1] - line.box[0]);
  return text;
}

/** Shrinks a Phaser text until it is no wider than `maxWidth`. */
export function fitInside(text: Phaser.GameObjects.Text, maxWidth: number): void {
  if (maxWidth <= 0 || text.width <= maxWidth) {
    return;
  }
  const asked = Number.parseFloat(String(text.style.fontSize));
  if (!Number.isFinite(asked) || asked <= 0) {
    return;
  }
  const floor = Math.max(1, Math.floor(asked / 2));
  for (let size = Math.floor(asked) - 1; size >= floor; size -= 1) {
    text.setFontSize(size);
    if (text.width <= maxWidth) {
      return;
    }
  }
}

function drawArt(scene: Phaser.Scene, art: FormArt): Phaser.GameObjects.Image | null {
  const image = art.centred
    ? artImageCentred(scene, art.id, art.x, art.y, art.width, art.height)
    : artImage(scene, art.id, art.x, art.y, art.width, art.height);
  if (!image) {
    return null;
  }
  if (art.rotation !== undefined) {
    image.setRotation(art.rotation);
  }
  if (art.alpha !== undefined) {
    image.setAlpha(art.alpha);
  }
  return image;
}
