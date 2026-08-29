import Phaser from 'phaser';
import { isDomeWarning, turretTarget, type Enemy } from '../sim/defense.js';
import type { ShiftState } from '../sim/shift.js';
import { ART, hasArt } from './artTextures.js';
import {
  COLORS,
  enemyBarOffset,
  ENEMY_STYLE,
  ENEMY_STYLE_FALLBACK,
  VIEW,
  type EnemyStyle,
} from './layout.js';

/**
 * The dome and the fight in front of it: the shell with the turret on top, the
 * enemies walking in from both edges, the beam the turret holds on its target
 * and the alarm frame around the screen when the dome is low.
 *
 * Reads the shift state and paints it — nothing here decides anything. The
 * simulation keeps one number per enemy (progress, 0 at the edge and 1 at the
 * dome); turning that into a place on screen is this file's whole job.
 *
 * Every drawn thing here has two forms and picks one **once**, at build time,
 * from whether its sprite was generated (`artTextures.ts`): the shell is either
 * a sprite or the arc it always was, the turret either a sprite or the yellow
 * block, each enemy either a sprite or its circle/square/triangle. They are
 * independent — a shell with no turret sprite, or two enemies out of three, is a
 * normal state and draws correctly.
 */
export interface DomeView {
  readonly update: (state: ShiftState) => void;
  /**
   * Enemy under a tap, or null when the tap hit empty sky. Screen coordinates:
   * everything here is pinned with scrollFactor 0.
   */
  readonly pickEnemy: (x: number, y: number) => number | null;
  /** Flash the whole shell — the dome just took a hit. */
  readonly flashDome: () => void;
}

export interface DomeViewOptions {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  /** The alarm frame goes over everything else in the zone. */
  readonly frameDepth: number;
}

interface Spot {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

export function createDomeView(scene: Phaser.Scene, options: DomeViewOptions): DomeView {
  const { width, height, depth, frameDepth } = options;
  const dome = VIEW.dome;
  const centerX = width / 2;

  // The shell: a sprite standing on the base line where the arc stood, or the
  // arc. The turret is asked separately, so one may exist without the other.
  const shellArt = hasArt(scene, ART.dome)
    ? scene.add
        .image(centerX, dome.baseY, ART.dome)
        .setOrigin(0.5, 1)
        .setDisplaySize(dome.halfWidth * 2, dome.artHeight)
        .setScrollFactor(0)
        .setDepth(depth)
    : null;
  const turretArt = hasArt(scene, ART.turret)
    ? scene.add
        .image(centerX, dome.turretArtY, ART.turret)
        .setDisplaySize(dome.turretArtSize, dome.turretArtSize)
        .setScrollFactor(0)
        .setDepth(depth)
    : null;
  /** Where a beam leaves the station: the sprite's muzzle, or the bare apex. */
  const muzzleY = turretArt ? dome.muzzleY : dome.apexY;

  const shell = scene.add.graphics().setScrollFactor(0).setDepth(depth);
  drawShell(shell, centerX, { arc: shellArt === null, turret: turretArt === null });

  const fight = scene.add.graphics().setScrollFactor(0).setDepth(depth);
  const frame = scene.add.graphics().setScrollFactor(0).setDepth(frameDepth);

  /** Where each enemy was drawn last frame: taps are matched against this. */
  let spots: Spot[] = [];

  /**
   * Enemy sprites in use, by enemy id, plus the ones set aside for the next
   * wave. A wave is a handful of creatures and they come and go every few
   * seconds, so the images are reused instead of created and destroyed.
   */
  const enemyArt = new Map<number, Phaser.GameObjects.Image>();
  const spareArt: Phaser.GameObjects.Image[] = [];

  /** Seconds of white flash left on an enemy that just took a hit. */
  const enemyFlash = new Map<number, number>();
  /** The previous frame's hp per enemy, to spot a hit between frames. */
  const lastHp = new Map<number, number>();
  /** Seconds of bright shell left after the dome took a hit. */
  let domeFlashSec = 0;
  const FLASH_SEC = 0.12;

  function enemySpot(enemy: Enemy): Spot {
    // Sides alternate slot by slot, so every other slot walks the same edge.
    const slotOnSide = Math.floor(enemy.slot / 2);
    const lane = slotOnSide % dome.lanes;
    const rank = Math.floor(slotOnSide / dome.lanes);
    // A wave comes out all at once; without this the whole row would be one dot.
    const progress = Math.min(1, Math.max(0, enemy.progress - rank * dome.rankShift));

    const fromX = enemy.side === 'left' ? dome.edgeMargin : width - dome.edgeMargin;
    const toX = enemy.side === 'left' ? centerX - dome.centerGap : centerX + dome.centerGap;
    const laneHeight = dome.corridorBottom - dome.corridorTop;
    return {
      id: enemy.id,
      x: fromX + (toX - fromX) * progress,
      y: dome.corridorTop + (laneHeight * (lane + 0.5)) / dome.lanes,
    };
  }

  /** The sprite of an enemy type, or null when that one was never generated. */
  function enemyArtKey(type: string): string | null {
    const key = ART.enemyByType[type];
    return key !== undefined && hasArt(scene, key) ? key : null;
  }

  /** The image an enemy is drawn with this frame, taken from the spare pile. */
  function takeEnemyArt(id: number, key: string): Phaser.GameObjects.Image {
    const existing = enemyArt.get(id);
    if (existing) {
      return existing;
    }
    const image =
      spareArt.pop() ?? scene.add.image(0, 0, key).setScrollFactor(0).setDepth(depth);
    enemyArt.set(id, image);
    return image;
  }

  return {
    update(state: ShiftState): void {
      const defense = state.defense;
      fight.clear();
      spots = defense.enemies.map(enemySpot);

      const dt = scene.game.loop.delta / 1000;
      for (const [id, sec] of [...enemyFlash]) {
        const next = sec - dt;
        if (next <= 0) {
          enemyFlash.delete(id);
        } else {
          enemyFlash.set(id, next);
        }
      }
      if (domeFlashSec > 0) {
        domeFlashSec = Math.max(0, domeFlashSec - dt);
      }

      const target = turretTarget(defense);
      const drawn = new Set<number>();
      for (let i = 0; i < defense.enemies.length; i += 1) {
        const enemy = defense.enemies[i];
        const spot = spots[i];
        if (!enemy || !spot) {
          continue;
        }
        const prevHp = lastHp.get(enemy.id);
        if (prevHp !== undefined && enemy.hp < prevHp - 0.001) {
          enemyFlash.set(enemy.id, FLASH_SEC);
        }
        lastHp.set(enemy.id, enemy.hp);

        const style = ENEMY_STYLE[enemy.type] ?? ENEMY_STYLE_FALLBACK;
        const hitFlash = enemyFlash.has(enemy.id);
        const artKey = enemyArtKey(enemy.type);
        if (artKey === null) {
          drawEnemy(fight, style, spot, hitFlash, domeFlashSec > 0);
        } else {
          const image = takeEnemyArt(enemy.id, artKey);
          image
            .setTexture(artKey)
            .setDisplaySize(style.spriteSize, style.spriteSize)
            .setPosition(spot.x, spot.y)
            // The sprites are drawn facing right; the right-hand side walks left.
            .setFlipX(enemy.side === 'right')
            .setVisible(true);
          // A hit bleaches the creature to a white silhouette, the way the flat
          // shape used to bleach to white.
          if (hitFlash) {
            image.setTintFill(0xffffff);
          } else {
            image.clearTint();
          }
          drawn.add(enemy.id);
        }

        drawEnemyBar(fight, enemy, spot, style, artKey !== null);

        if (enemy.id === defense.focusId) {
          fight.lineStyle(3, COLORS.target, 1);
          fight.strokeCircle(spot.x, spot.y, dome.targetRingRadius);
        }
        if (target && enemy.id === target.id) {
          fight.lineStyle(dome.beamWidth, COLORS.progress, 0.85);
          fight.lineBetween(centerX, muzzleY, spot.x, spot.y);
        }
      }
      // Enemies that left the screen must not keep stale hp to compare against,
      // and their sprites go back on the spare pile for the next wave.
      const liveIds = new Set(defense.enemies.map((enemy) => enemy.id));
      for (const id of [...lastHp.keys()]) {
        if (!liveIds.has(id)) {
          lastHp.delete(id);
          enemyFlash.delete(id);
        }
      }
      for (const [id, image] of [...enemyArt]) {
        if (!drawn.has(id)) {
          image.setVisible(false).clearTint();
          enemyArt.delete(id);
          spareArt.push(image);
        }
      }

      if (shellArt) {
        // The sprite reddens instead of being redrawn.
        if (domeFlashSec > 0) {
          shellArt.setTint(COLORS.warning);
        } else {
          shellArt.clearTint();
        }
      } else if (domeFlashSec > 0) {
        drawShell(shell, centerX, { arc: true, turret: turretArt === null }, true);
      }

      frame.clear();
      if (isDomeWarning(state.balance, defense)) {
        // Slow pulse, so it reads as an alarm and not as a broken screen.
        const phase = (scene.time.now / 1000 / dome.framePulseSec) * Math.PI * 2;
        const alpha = 0.35 + 0.4 * Math.abs(Math.sin(phase));
        frame.lineStyle(dome.frameWidth, COLORS.warning, alpha);
        frame.strokeRect(
          dome.frameWidth / 2,
          dome.frameWidth / 2,
          width - dome.frameWidth,
          height - dome.frameWidth,
        );
      }
    },

    pickEnemy(x: number, y: number): number | null {
      let bestId: number | null = null;
      let bestDistance: number = dome.pickRadius;
      for (const spot of spots) {
        const distance = Math.hypot(spot.x - x, spot.y - y);
        if (distance <= bestDistance) {
          bestDistance = distance;
          bestId = spot.id;
        }
      }
      return bestId;
    },

    flashDome(): void {
      domeFlashSec = FLASH_SEC;
    },
  };
}

/** Which halves of the drawn station are still the graphics ones. */
interface ShellParts {
  readonly arc: boolean;
  readonly turret: boolean;
}

/**
 * The shell as a shallow arc with the turret block on it: whatever has no sprite
 * of its own. It never moves, so it is drawn once — and again for one frame when
 * the dome is hit.
 */
function drawShell(
  shell: Phaser.GameObjects.Graphics,
  centerX: number,
  parts: ShellParts,
  highlight = false,
): void {
  const dome = VIEW.dome;
  shell.clear();

  if (parts.arc) {
    const points: Phaser.Math.Vector2[] = [];
    for (let i = 0; i <= dome.arcSteps; i += 1) {
      const share = i / dome.arcSteps;
      const x = centerX - dome.halfWidth + 2 * dome.halfWidth * share;
      const fromCenter = (x - centerX) / dome.halfWidth;
      points.push(
        new Phaser.Math.Vector2(x, dome.apexY + (dome.baseY - dome.apexY) * fromCenter ** 2),
      );
    }

    if (highlight) {
      shell.fillStyle(COLORS.warning, 0.5);
      shell.fillPoints(points, true, true);
      shell.lineStyle(4, COLORS.warning, 0.9);
      shell.strokePoints(points, false, false);
    } else {
      shell.fillStyle(COLORS.domeEdge, 0.16);
      shell.fillPoints(points, true, true);
      shell.lineStyle(3, COLORS.domeEdge, 1);
      shell.strokePoints(points, false, false);
    }
  }

  if (parts.turret) {
    shell.fillStyle(COLORS.drill, 1);
    shell.fillRect(
      centerX - dome.turretWidth / 2,
      dome.apexY - dome.turretHeight,
      dome.turretWidth,
      dome.turretHeight,
    );
  }
}

/** Lighten a colour towards a hit-flash tint, mixing `amount` in [0,1]. */
function flashColor(color: number, tint: number, amount: number): number {
  const cr = (color >> 16) & 0xff;
  const cg = (color >> 8) & 0xff;
  const cb = color & 0xff;
  const tr = (tint >> 16) & 0xff;
  const tg = (tint >> 8) & 0xff;
  const tb = tint & 0xff;
  const r = Math.round(cr + (tr - cr) * amount);
  const g = Math.round(cg + (tg - cg) * amount);
  const b = Math.round(cb + (tb - cb) * amount);
  return (r << 16) | (g << 8) | b;
}

/** An enemy with no sprite: the flat shape it has always been. */
function drawEnemy(
  fight: Phaser.GameObjects.Graphics,
  style: EnemyStyle,
  spot: Spot,
  hitFlash: boolean,
  domeFlash: boolean,
): void {
  const { x, y } = spot;
  // A hit bleaches the enemy to white; a dome hit bleaches every enemy a little.
  let color = style.color;
  if (hitFlash) {
    color = flashColor(color, 0xffffff, 0.85);
  } else if (domeFlash) {
    color = flashColor(color, 0xffffff, 0.35);
  }

  fight.fillStyle(color, 1);
  switch (style.shape) {
    case 'circle':
      fight.fillCircle(x, y, style.size);
      break;
    case 'square':
      fight.fillRect(x - style.size, y - style.size, style.size * 2, style.size * 2);
      break;
    case 'triangle':
      fight.fillTriangle(
        x,
        y - style.size,
        x + style.size,
        y + style.size,
        x - style.size,
        y + style.size,
      );
      break;
  }
}

/** The health strip under an enemy, sprite or shape alike. */
function drawEnemyBar(
  fight: Phaser.GameObjects.Graphics,
  enemy: Enemy,
  spot: Spot,
  style: EnemyStyle,
  hasSprite: boolean,
): void {
  const dome = VIEW.dome;
  const share = enemy.maxHp > 0 ? Math.min(1, Math.max(0, enemy.hp / enemy.maxHp)) : 0;
  const barX = spot.x - dome.enemyBarWidth / 2;
  const barY = spot.y + enemyBarOffset(style, hasSprite);
  fight.fillStyle(COLORS.shaft, 0.9);
  fight.fillRect(barX, barY, dome.enemyBarWidth, dome.enemyBarHeight);
  fight.fillStyle(share > 0.5 ? COLORS.progress : COLORS.warning, 1);
  fight.fillRect(barX, barY, dome.enemyBarWidth * share, dome.enemyBarHeight);
}
