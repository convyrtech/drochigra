import Phaser from 'phaser';
import { COLORS, cssColor, FONT_FAMILY, VIEW } from '../game/layout.js';
import {
  cargoCapacity,
  isCargoBlocked,
  type ShiftState,
} from '../sim/shift.js';

/**
 * Dome zone panel: shift timer, banked scrap, cargo, crystals, depth and the
 * "hand over" button. Fixed on screen while the shaft scrolls behind it.
 * All texts are Russian (AGENTS.md), all numbers come from the shift state.
 */
export interface Hud {
  readonly update: (state: ShiftState) => void;
}

export interface HudOptions {
  readonly width: number;
  readonly domeHeight: number;
  readonly depth: number;
  readonly onBank: () => void;
}

export function createHud(scene: Phaser.Scene, options: HudOptions): Hud {
  const { width, domeHeight, depth, onBank } = options;
  const { hud, font } = VIEW;

  const panel = scene.add.rectangle(0, 0, width, domeHeight, COLORS.dome).setOrigin(0, 0);
  const edge = scene.add.rectangle(0, domeHeight - 2, width, 2, COLORS.domeEdge).setOrigin(0, 0);

  const timer = scene.add
    .text(width / 2, hud.timerY, '', {
      fontFamily: FONT_FAMILY,
      fontSize: font.huge,
      color: cssColor(COLORS.text),
    })
    .setOrigin(0.5, 0);

  const scrap = statLine(scene, hud.margin, hud.statsTop, COLORS.scrap);
  const crystals = statLine(scene, hud.margin, hud.statsTop + hud.statsLine, COLORS.crystal);
  const depthLine = statLine(scene, hud.margin, hud.statsTop + hud.statsLine * 2, COLORS.textDim);

  const cargoLabel = statLine(scene, hud.margin, hud.cargoTop, COLORS.text);
  const cargoBack = scene.add
    .rectangle(hud.margin, hud.cargoTop + hud.statsLine, hud.cargoBarWidth, hud.cargoBarHeight, COLORS.shaft)
    .setOrigin(0, 0)
    .setStrokeStyle(2, COLORS.domeEdge);
  const cargoFill = scene.add
    .rectangle(hud.margin, hud.cargoTop + hud.statsLine, 0, hud.cargoBarHeight, COLORS.scrap)
    .setOrigin(0, 0);

  const status = scene.add
    .text(width / 2, hud.statusY, '', {
      fontFamily: FONT_FAMILY,
      fontSize: font.small,
      color: cssColor(COLORS.textDim),
    })
    .setOrigin(0.5, 0);

  const buttonX = width - hud.margin - hud.bankButtonWidth;
  const button = scene.add
    .rectangle(buttonX, hud.bankButtonTop, hud.bankButtonWidth, hud.bankButtonHeight, COLORS.button)
    .setOrigin(0, 0)
    .setStrokeStyle(3, COLORS.buttonEdge)
    .setInteractive({ useHandCursor: true });
  button.on('pointerdown', onBank);

  const buttonText = scene.add
    .text(buttonX + hud.bankButtonWidth / 2, hud.bankButtonTop + hud.bankButtonHeight / 2, 'СДАТЬ', {
      fontFamily: FONT_FAMILY,
      fontSize: font.medium,
      color: cssColor(COLORS.text),
    })
    .setOrigin(0.5);

  const parts = [
    panel,
    edge,
    timer,
    scrap,
    crystals,
    depthLine,
    cargoLabel,
    cargoBack,
    cargoFill,
    status,
    button,
    buttonText,
  ];
  for (const part of parts) {
    part.setScrollFactor(0).setDepth(depth);
  }

  return {
    update(state: ShiftState): void {
      setText(timer, `СМЕНА ${formatTime(state.timeLeftSec)}`);
      setText(scrap, `СДАНО ЛОМА: ${state.banked}`);
      setText(crystals, `КРИСТАЛЛЫ: ${state.crystals}`);
      setText(depthLine, `ГЛУБИНА: ${state.deepestRow} / ${state.balance.shift.grid_depth}`);

      const capacity = cargoCapacity(state);
      setText(cargoLabel, `КАРГО: ${state.cargo} / ${capacity}`);
      const share = capacity > 0 ? Math.min(1, state.cargo / capacity) : 0;
      cargoFill.width = VIEW.hud.cargoBarWidth * share;
      const full = state.cargo >= capacity;
      cargoFill.fillColor = full ? COLORS.warning : COLORS.scrap;
      cargoLabel.setColor(cssColor(full ? COLORS.warning : COLORS.text));

      const blocked = isCargoBlocked(state);
      setText(status, statusText(state));
      status.setColor(cssColor(blocked ? COLORS.warning : COLORS.textDim));
    },
  };
}

function statLine(scene: Phaser.Scene, x: number, y: number, color: number): Phaser.GameObjects.Text {
  return scene.add
    .text(x, y, '', {
      fontFamily: FONT_FAMILY,
      fontSize: VIEW.font.medium,
      color: cssColor(color),
    })
    .setOrigin(0, 0);
}

function setText(target: Phaser.GameObjects.Text, value: string): void {
  if (target.text !== value) {
    target.setText(value);
  }
}

/** mm:ss, rounded up so the last second is visible. */
function formatTime(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}

function statusText(state: ShiftState): string {
  if (state.phase === 'finished') {
    return 'СМЕНА ОКОНЧЕНА';
  }
  if (state.phase === 'ending') {
    return 'ВРЕМЯ ВЫШЛО — ПОДЪЁМ С ДОБЫЧЕЙ';
  }
  switch (state.drill.mode) {
    case 'idle':
      return 'ТКНИ КЛЕТКУ РЯДОМ С ПРОКОПАННОЙ';
    case 'moving':
      return state.drill.target?.kind === 'surface' ? 'БУР ЕДЕТ К ЛИФТУ' : 'БУР ЕДЕТ К КЛЕТКЕ';
    case 'digging':
      return 'БУР КОПАЕТ';
    case 'blocked':
      return 'КАРГО ПОЛНО — БУР СТОИТ, СДАЙ ДОБЫЧУ';
    case 'banking':
      return 'СДАЮ ДОБЫЧУ';
  }
}
