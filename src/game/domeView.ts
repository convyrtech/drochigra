import Phaser from 'phaser';
import { isDomeWarning, turretTarget, type Enemy } from '../sim/defense.js';
import type { ShiftState } from '../sim/shift.js';
import { COLORS, ENEMY_STYLE, ENEMY_STYLE_FALLBACK, VIEW } from './layout.js';

/**
 * The dome and the fight in front of it: the shell with the turret on top, the
 * enemies walking in from both edges, the beam the turret holds on its target
 * and the alarm frame around the screen when the dome is low.
 *
 * Reads the shift state and paints it — nothing here decides anything. The
 * simulation keeps one number per enemy (progress, 0 at the edge and 1 at the
 * dome); turning that into a place on screen is this file's whole job.
 */
export interface DomeView {
  readonly update: (state: ShiftState) => void;
  /**
   * Enemy under a tap, or null when the tap hit empty sky. Screen coordinates:
   * everything here is pinned with scrollFactor 0.
   */
  readonly pickEnemy: (x: number, y: number) => number | null;
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

  const shell = scene.add.graphics().setScrollFactor(0).setDepth(depth);
  drawShell(shell, centerX);

  const fight = scene.add.graphics().setScrollFactor(0).setDepth(depth);
  const frame = scene.add.graphics().setScrollFactor(0).setDepth(frameDepth);

  /** Where each enemy was drawn last frame: taps are matched against this. */
  let spots: Spot[] = [];

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

  return {
    update(state: ShiftState): void {
      const defense = state.defense;
      fight.clear();
      spots = defense.enemies.map(enemySpot);

      const target = turretTarget(defense);
      for (let i = 0; i < defense.enemies.length; i += 1) {
        const enemy = defense.enemies[i];
        const spot = spots[i];
        if (!enemy || !spot) {
          continue;
        }
        drawEnemy(fight, enemy, spot);
        if (enemy.id === defense.focusId) {
          fight.lineStyle(3, COLORS.target, 1);
          fight.strokeCircle(spot.x, spot.y, dome.targetRingRadius);
        }
        if (target && enemy.id === target.id) {
          fight.lineStyle(dome.beamWidth, COLORS.progress, 0.85);
          fight.lineBetween(centerX, dome.apexY, spot.x, spot.y);
        }
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
  };
}

/** The shell is a shallow arc: it never moves, so it is drawn once. */
function drawShell(shell: Phaser.GameObjects.Graphics, centerX: number): void {
  const dome = VIEW.dome;
  const points: Phaser.Math.Vector2[] = [];
  for (let i = 0; i <= dome.arcSteps; i += 1) {
    const share = i / dome.arcSteps;
    const x = centerX - dome.halfWidth + 2 * dome.halfWidth * share;
    const fromCenter = (x - centerX) / dome.halfWidth;
    points.push(new Phaser.Math.Vector2(x, dome.apexY + (dome.baseY - dome.apexY) * fromCenter ** 2));
  }

  shell.fillStyle(COLORS.domeEdge, 0.16);
  shell.fillPoints(points, true, true);
  shell.lineStyle(3, COLORS.domeEdge, 1);
  shell.strokePoints(points, false, false);

  shell.fillStyle(COLORS.drill, 1);
  shell.fillRect(
    centerX - dome.turretWidth / 2,
    dome.apexY - dome.turretHeight,
    dome.turretWidth,
    dome.turretHeight,
  );
}

function drawEnemy(fight: Phaser.GameObjects.Graphics, enemy: Enemy, spot: Spot): void {
  const dome = VIEW.dome;
  const style = ENEMY_STYLE[enemy.type] ?? ENEMY_STYLE_FALLBACK;
  const { x, y } = spot;

  fight.fillStyle(style.color, 1);
  switch (style.shape) {
    case 'circle':
      fight.fillCircle(x, y, style.size);
      break;
    case 'square':
      fight.fillRect(x - style.size, y - style.size, style.size * 2, style.size * 2);
      break;
    case 'triangle':
      fight.fillTriangle(x, y - style.size, x + style.size, y + style.size, x - style.size, y + style.size);
      break;
  }

  const share = enemy.maxHp > 0 ? Math.min(1, Math.max(0, enemy.hp / enemy.maxHp)) : 0;
  const barX = x - dome.enemyBarWidth / 2;
  const barY = y + dome.enemyBarOffset;
  fight.fillStyle(COLORS.shaft, 0.9);
  fight.fillRect(barX, barY, dome.enemyBarWidth, dome.enemyBarHeight);
  fight.fillStyle(share > 0.5 ? COLORS.progress : COLORS.warning, 1);
  fight.fillRect(barX, barY, dome.enemyBarWidth * share, dome.enemyBarHeight);
}
