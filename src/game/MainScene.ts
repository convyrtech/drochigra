import Phaser from 'phaser';
import type { Balance } from '../sim/balance.js';
import { layerIndexForRow } from '../sim/mining.js';
import {
  applyShiftResult,
  buyUpgrade,
  effectiveBalance,
  hasConveyor,
  type Profile,
} from '../sim/progress.js';
import {
  aimDrill,
  aimTurret,
  callElevator,
  cellAt,
  createShift,
  digProgress,
  ENTRANCE_ROW,
  fireSalvo,
  isCargoBlocked,
  shiftReport,
  step,
  type ShiftState,
} from '../sim/shift.js';
import { createBaseScreen, type BaseScreen } from '../ui/baseScreen.js';
import { createHud, type Hud } from '../ui/hud.js';
import { createShiftReport } from '../ui/shiftReport.js';
import { createDomeView, type DomeView } from './domeView.js';
import { COLORS, cssColor, FONT_FAMILY, VIEW } from './layout.js';
import { loadProfile, saveProfile } from './saveStorage.js';

/** Depth order of the drawn parts. */
const LAYER_DEPTH = {
  cells: 0,
  labels: 1,
  target: 2,
  progress: 3,
  drill: 4,
  hud: 10,
  dome: 11,
  alarm: 12,
  report: 20,
  base: 30,
} as const;

/**
 * The loop of the game: base → shift → report → base. The base screen and the
 * report are views over the profile (src/sim/progress.ts); the shift itself is
 * a state machine in src/sim. This scene only paints what it finds and feeds
 * taps back in.
 *
 * The profile lives on the scene and is written to storage after every purchase
 * and every shift, so a scene restart never costs the player what was bought.
 */
export class MainScene extends Phaser.Scene {
  private readonly balance: Balance;

  /** Loaded once, then kept across restarts of the scene. */
  private profile: Profile | null = null;

  private state: ShiftState | null = null;
  private cellRects: Phaser.GameObjects.Rectangle[] = [];
  /** What each cell currently shows; null until it is painted the first time. */
  private cellPainted: (boolean | null)[] = [];
  private cellSize = 0;
  private domeHeight = 0;

  private target!: Phaser.GameObjects.Rectangle;
  private progress!: Phaser.GameObjects.Rectangle;
  private drill!: Phaser.GameObjects.Rectangle;
  private hud!: Hud;
  private domeView!: DomeView;
  private baseScreen: BaseScreen | null = null;
  private reportShown = false;

  constructor(balance: Balance) {
    super('main');
    this.balance = balance;
  }

  create(): void {
    const { height } = this.scale.gameSize;
    this.domeHeight = height * VIEW.domeHeightShare;
    this.state = null;
    this.cellRects = [];
    this.cellPainted = [];
    this.reportShown = false;

    // localStorage is the view's business, never the simulation's.
    this.profile ??= loadProfile(this.balance);
    this.showBase();
  }

  override update(_time: number, deltaMs: number): void {
    const state = this.state;
    if (!state) {
      return;
    }
    step(state, deltaMs / 1000);
    this.paintCells();
    this.paintDrill();
    this.followDrill();
    this.hud.update(state);
    this.domeView.update(state);

    if (state.phase === 'finished' && !this.reportShown) {
      this.showReport();
    }
  }

  /** The base between shifts: the wallet, the upgrades and the depth to start at. */
  private showBase(): void {
    const { width, height } = this.scale.gameSize;
    const profile = this.currentProfile();
    this.cameras.main.setScroll(0, 0);
    this.baseScreen = createBaseScreen(this, {
      width,
      height,
      depth: LAYER_DEPTH.base,
      balance: this.balance,
      profile,
      onBuy: (upgradeId) => {
        this.buy(upgradeId);
      },
      onStartShift: (startRow) => {
        // Next tick on purpose: this runs inside the button's own pointer event,
        // and the shift registers a screen-wide tap handler that would otherwise
        // catch the very same tap and aim the drill at it.
        this.time.delayedCall(0, () => {
          this.startShift(startRow);
        });
      },
    });
  }

  private buy(upgradeId: string): void {
    const bought = buyUpgrade(this.balance, this.currentProfile(), upgradeId);
    if (!bought) {
      return;
    }
    this.profile = bought;
    saveProfile(bought);
    this.baseScreen?.update(bought);
  }

  /**
   * Starts a shift on the balance the upgrades bend, from the checkpoint the
   * player picked. The seed comes from outside: src/sim never reads a clock.
   */
  private startShift(startRow: number): void {
    const { width, height } = this.scale.gameSize;
    const profile = this.currentProfile();

    this.baseScreen?.destroy();
    this.baseScreen = null;

    const state = createShift(effectiveBalance(this.balance, profile.upgrades), Date.now(), {
      startRow,
      autoBank: hasConveyor(profile),
    });
    this.state = state;
    this.cellSize = width / state.width;
    this.cellRects = [];
    this.cellPainted = [];
    this.reportShown = false;

    this.drawShaft();
    this.hud = createHud(this, {
      width,
      domeHeight: this.domeHeight,
      depth: LAYER_DEPTH.hud,
      onBank: () => {
        callElevator(state);
      },
      onSalvo: () => {
        fireSalvo(state);
      },
    });
    this.domeView = createDomeView(this, {
      width,
      height,
      depth: LAYER_DEPTH.dome,
      frameDepth: LAYER_DEPTH.alarm,
    });

    this.input.on(Phaser.Input.Events.POINTER_DOWN, this.onTap, this);
    this.followDrill();
    this.hud.update(state);
    this.domeView.update(state);
  }

  private currentProfile(): Profile {
    this.profile ??= loadProfile(this.balance);
    return this.profile;
  }

  /** One rectangle per cell plus the surface label; colours change later. */
  private drawShaft(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const size = this.cellSize;
    const gap = VIEW.cellGap;
    for (let row = 0; row < state.rowCount; row += 1) {
      for (let col = 0; col < state.width; col += 1) {
        const rect = this.add
          .rectangle(col * size + gap / 2, row * size + gap / 2, size - gap, size - gap, COLORS.dug)
          .setOrigin(0, 0)
          .setDepth(LAYER_DEPTH.cells);
        this.cellRects.push(rect);
        this.cellPainted.push(null);
      }
    }
    this.paintCells();

    this.add
      .text(
        (state.width * size) / 2,
        ENTRANCE_ROW * size + size * VIEW.surfaceLabelYShare,
        'ЛИФТ · ПОВЕРХНОСТЬ',
        {
          fontFamily: FONT_FAMILY,
          fontSize: VIEW.font.small,
          color: cssColor(COLORS.text),
        },
      )
      .setOrigin(0.5)
      .setDepth(LAYER_DEPTH.labels);

    this.target = this.add
      .rectangle(0, 0, size - gap, size - gap)
      .setOrigin(0, 0)
      .setStrokeStyle(3, COLORS.target)
      .setDepth(LAYER_DEPTH.target)
      .setVisible(false);

    this.progress = this.add
      .rectangle(0, 0, 0, size * VIEW.digBarHeightShare, COLORS.progress)
      .setOrigin(0, 0)
      .setDepth(LAYER_DEPTH.progress)
      .setVisible(false);

    const drillSize = size * VIEW.drillSizeShare;
    this.drill = this.add
      .rectangle(0, 0, drillSize, drillSize, COLORS.drill)
      .setDepth(LAYER_DEPTH.drill);
    this.paintDrill();
  }

  /** Repaints only the cells that changed since the last frame. */
  private paintCells(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    for (let row = 0; row < state.rowCount; row += 1) {
      const rockColor = this.rockColor(row);
      for (let col = 0; col < state.width; col += 1) {
        const index = row * state.width + col;
        const dug = cellAt(state, col, row) === 'dug';
        if (this.cellPainted[index] === dug) {
          continue;
        }
        const rect = this.cellRects[index];
        if (!rect) {
          continue;
        }
        if (dug) {
          rect.fillColor = row === ENTRANCE_ROW ? COLORS.surface : COLORS.dug;
          rect.setStrokeStyle(1, COLORS.dugEdge);
        } else {
          rect.fillColor = rockColor;
          rect.setStrokeStyle(0);
        }
        this.cellPainted[index] = dug;
      }
    }
  }

  private rockColor(row: number): number {
    const index = layerIndexForRow(this.balance.layers, row);
    return COLORS.rockByLayer[index] ?? COLORS.rockByLayer[0];
  }

  private paintDrill(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const size = this.cellSize;
    const { drill } = state;
    const target = drill.target;
    this.drill.setPosition((drill.col + 0.5) * size, (drill.row + 0.5) * size);
    this.drill.fillColor = isCargoBlocked(state) ? COLORS.drillStuck : COLORS.drill;

    const digging = target?.kind === 'cell';
    this.target.setVisible(digging);
    this.progress.setVisible(digging);
    if (!digging || !target) {
      return;
    }
    const gap = VIEW.cellGap;
    this.target.setPosition(target.col * size + gap / 2, target.row * size + gap / 2);
    this.progress.setPosition(
      target.col * size + gap / 2,
      (target.row + 1) * size - gap / 2 - size * VIEW.digBarHeightShare,
    );
    this.progress.width = (size - gap) * digProgress(state);
  }

  /** Camera keeps the drill in the middle of the shaft zone, below the dome. */
  private followDrill(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const { height } = this.scale.gameSize;
    const shaftHeight = height - this.domeHeight;
    const drillY = (state.drill.row + 0.5) * this.cellSize;
    const worldHeight = state.rowCount * this.cellSize;
    const wanted = drillY - (this.domeHeight + shaftHeight / 2);
    const maxScroll = Math.max(-this.domeHeight, worldHeight - height);
    this.cameras.main.setScroll(0, Phaser.Math.Clamp(wanted, -this.domeHeight, maxScroll));
  }

  private onTap(pointer: Phaser.Input.Pointer): void {
    const state = this.state;
    if (!state || state.phase === 'finished') {
      return;
    }
    // Up in the dome zone a tap is an order for the turret, not for the drill.
    if (pointer.y < this.domeHeight) {
      const enemyId = this.domeView.pickEnemy(pointer.x, pointer.y);
      if (enemyId !== null) {
        aimTurret(state, enemyId);
      }
      return;
    }
    const worldY = pointer.y + this.cameras.main.scrollY;
    const col = Math.floor((pointer.x + this.cameras.main.scrollX) / this.cellSize);
    const row = Math.floor(worldY / this.cellSize);
    if (row === ENTRANCE_ROW) {
      callElevator(state);
      return;
    }
    aimDrill(state, col, row);
  }

  /**
   * The shift is over: fold it into the profile, save, and show what it brought.
   * The button leads back to the base, where the earnings are spent.
   */
  private showReport(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    const { width, height } = this.scale.gameSize;
    this.reportShown = true;

    const report = shiftReport(state);
    const outcome = applyShiftResult(this.balance, this.currentProfile(), report);
    this.profile = outcome.profile;
    saveProfile(outcome.profile);

    createShiftReport(this, report, {
      width,
      height,
      depth: LAYER_DEPTH.report,
      maxDepthRow: this.balance.shift.grid_depth,
      outcome,
      // A restart wipes the shaft of the finished shift; the profile is a field
      // of the scene and survives it, and it is on disk either way.
      onBack: () => {
        this.scene.restart();
      },
    });
  }
}
