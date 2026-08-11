import Phaser from 'phaser';
import type { Balance } from '../sim/balance.js';
import { layerIndexForRow } from '../sim/mining.js';
import {
  aimDrill,
  callElevator,
  cellAt,
  createShift,
  digProgress,
  ENTRANCE_ROW,
  isCargoBlocked,
  shiftReport,
  step,
  type ShiftState,
} from '../sim/shift.js';
import { createHud, type Hud } from '../ui/hud.js';
import { createShiftReport } from '../ui/shiftReport.js';
import { COLORS, cssColor, FONT_FAMILY, VIEW } from './layout.js';

/** Depth order of the drawn parts. */
const LAYER_DEPTH = {
  cells: 0,
  labels: 1,
  target: 2,
  progress: 3,
  drill: 4,
  hud: 10,
  report: 20,
} as const;

/**
 * Draws one shift and feeds taps into it. Everything that decides anything
 * lives in src/sim: this scene only reads the state and paints it.
 */
export class MainScene extends Phaser.Scene {
  private readonly balance: Balance;

  private state!: ShiftState;
  private cellRects: Phaser.GameObjects.Rectangle[] = [];
  /** What each cell currently shows; null until it is painted the first time. */
  private cellPainted: (boolean | null)[] = [];
  private cellSize = 0;
  private domeHeight = 0;

  private target!: Phaser.GameObjects.Rectangle;
  private progress!: Phaser.GameObjects.Rectangle;
  private drill!: Phaser.GameObjects.Rectangle;
  private hud!: Hud;
  private reportShown = false;

  constructor(balance: Balance) {
    super('main');
    this.balance = balance;
  }

  create(): void {
    const { width, height } = this.scale.gameSize;
    this.domeHeight = height * VIEW.domeHeightShare;

    // The seed comes from outside the simulation: src/sim never reads a clock.
    this.state = createShift(this.balance, Date.now());
    this.cellSize = width / this.state.width;
    this.cellRects = [];
    this.cellPainted = [];
    this.reportShown = false;

    this.drawShaft();
    this.hud = createHud(this, {
      width,
      domeHeight: this.domeHeight,
      depth: LAYER_DEPTH.hud,
      onBank: () => {
        callElevator(this.state);
      },
    });

    this.input.on(Phaser.Input.Events.POINTER_DOWN, this.onTap, this);
    this.followDrill();
    this.hud.update(this.state);
  }

  override update(_time: number, deltaMs: number): void {
    step(this.state, deltaMs / 1000);
    this.paintCells();
    this.paintDrill();
    this.followDrill();
    this.hud.update(this.state);

    if (this.state.phase === 'finished' && !this.reportShown) {
      this.showReport();
    }
  }

  /** One rectangle per cell plus the surface label; colours change later. */
  private drawShaft(): void {
    const size = this.cellSize;
    const gap = VIEW.cellGap;
    for (let row = 0; row < this.state.rowCount; row += 1) {
      for (let col = 0; col < this.state.width; col += 1) {
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
        (this.state.width * size) / 2,
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
    for (let row = 0; row < this.state.rowCount; row += 1) {
      const rockColor = this.rockColor(row);
      for (let col = 0; col < this.state.width; col += 1) {
        const index = row * this.state.width + col;
        const dug = cellAt(this.state, col, row) === 'dug';
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
    const size = this.cellSize;
    const { drill } = this.state;
    const target = drill.target;
    this.drill.setPosition((drill.col + 0.5) * size, (drill.row + 0.5) * size);
    this.drill.fillColor = isCargoBlocked(this.state) ? COLORS.drillStuck : COLORS.drill;

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
    this.progress.width = (size - gap) * digProgress(this.state);
  }

  /** Camera keeps the drill in the middle of the shaft zone, below the dome. */
  private followDrill(): void {
    const { height } = this.scale.gameSize;
    const shaftHeight = height - this.domeHeight;
    const drillY = (this.state.drill.row + 0.5) * this.cellSize;
    const worldHeight = this.state.rowCount * this.cellSize;
    const wanted = drillY - (this.domeHeight + shaftHeight / 2);
    const maxScroll = Math.max(-this.domeHeight, worldHeight - height);
    this.cameras.main.setScroll(0, Phaser.Math.Clamp(wanted, -this.domeHeight, maxScroll));
  }

  private onTap(pointer: Phaser.Input.Pointer): void {
    if (this.state.phase === 'finished' || pointer.y < this.domeHeight) {
      return;
    }
    const worldY = pointer.y + this.cameras.main.scrollY;
    const col = Math.floor((pointer.x + this.cameras.main.scrollX) / this.cellSize);
    const row = Math.floor(worldY / this.cellSize);
    if (row === ENTRANCE_ROW) {
      callElevator(this.state);
      return;
    }
    aimDrill(this.state, col, row);
  }

  private showReport(): void {
    const { width, height } = this.scale.gameSize;
    this.reportShown = true;
    createShiftReport(this, shiftReport(this.state), {
      width,
      height,
      depth: LAYER_DEPTH.report,
      maxDepthRow: this.balance.shift.grid_depth,
      onNewShift: () => {
        this.scene.restart();
      },
    });
  }
}
