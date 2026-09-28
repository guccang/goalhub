// 上游办公室原始实现，保留 MIT 许可；本地适配详见 office-engine/README.md。
import { AnimatedSprite, Container, Graphics, Texture, type Ticker } from 'pixi.js';

export type Direction = 'down' | 'up' | 'right' | 'left';
export type AnimState = 'walk' | 'type' | 'read' | 'idle';

// Output rows from SpriteAdapter: down=0, up=1, right=2 (left = flipped right)
const DIRECTION_ROW: Record<Direction, number> = {
  down: 0,
  up: 1,
  right: 2,
  left: 2,
};

const ANIM_FRAMES: Record<AnimState, number[]> = {
  walk: [0, 1, 2, 1],
  type: [0, 1, 2, 1],
  read: [0, 1, 2, 1],
  idle: [0],
};

// Render characters a bit larger than their native 18×32 so heads/faces read
// clearly on the floor. Applied to the container so the leg-crop mask (a child)
// scales with the sprite and stays aligned.
const CHAR_SCALE = 1.08;

/** Ported from shahar061/the-office (office/characters/CharacterSprite.ts). */
export class CharacterSprite {
  readonly container: Container;
  private sprite: AnimatedSprite;
  private frames: Texture[][];
  private currentDirection: Direction = 'down';
  private currentAnim: AnimState = 'idle';
  private frameSpeed = 0.15;
  private frameW: number;
  private frameH: number;
  private cropMask: Graphics | null = null;

  // advance 由场景统一推进精灵帧，隐藏或减少动态时不会运行共享计时器。
  // advance：保留原版办公室的绘制、交互或资源管理行为。
  advance(dt: number): void { this.sprite.update({ deltaTime: dt * 60 } as Ticker); }

  // constructor：保留原版办公室的绘制、交互或资源管理行为。
  constructor(frames: Texture[][]) {
    this.frames = frames;
    this.container = new Container();

    const initialFrames = this.getFrames('down', 'idle');
    this.sprite = new AnimatedSprite(initialFrames);
    this.sprite.anchor.set(0.5, 1);
    this.sprite.animationSpeed = this.frameSpeed;
    this.sprite.autoUpdate = false;
    this.sprite.play();
    // Anchor is (0.5, 1): in container space the sprite spans x∈[-w/2, w/2],
    // y∈[-h, 0] (feet at the origin). Used by the seated leg-crop mask.
    this.frameW = this.sprite.texture.frame.width || this.sprite.width || 16;
    this.frameH = this.sprite.texture.frame.height || this.sprite.height || 32;

    this.container.addChild(this.sprite);
    this.container.scale.set(CHAR_SCALE);
  }

  /**
   * Crop `cropPx` off the bottom of the sprite (the legs) so a seated agent
   * reads as tucked under the desk instead of standing on top of it. Pass 0 to
   * clear the crop (standing / walking). The mask only covers the sprite, so
   * status glyphs / bubbles parented elsewhere are unaffected.
   */
  // setSeatedCrop：保留原版办公室的绘制、交互或资源管理行为。
  setSeatedCrop(cropPx: number): void {
    if (cropPx <= 0) {
      if (this.cropMask) {
        this.sprite.mask = null;
        this.cropMask.visible = false;
      }
      return;
    }
    if (!this.cropMask) {
      this.cropMask = new Graphics();
      this.container.addChild(this.cropMask);
    }
    const w = this.frameW;
    const h = this.frameH;
    this.cropMask.clear();
    // Keep the top (h - cropPx) of the sprite; reveal whatever (the desk) is
    // behind where the legs were.
    this.cropMask
      .rect(-w / 2 - 2, -h - 2, w + 4, h - cropPx + 2)
      .fill(0xffffff);
    this.cropMask.visible = true;
    this.sprite.mask = this.cropMask;
  }

  // getFrames：保留原版办公室的绘制、交互或资源管理行为。
  private getFrames(direction: Direction, anim: AnimState): Texture[] {
    const row = DIRECTION_ROW[direction];
    return ANIM_FRAMES[anim].map((col) => this.frames[row][col]);
  }

  // setAnimation：保留原版办公室的绘制、交互或资源管理行为。
  setAnimation(anim: AnimState, direction: Direction): void {
    if (anim === this.currentAnim && direction === this.currentDirection) return;

    this.currentAnim = anim;
    this.currentDirection = direction;

    this.sprite.textures = this.getFrames(direction, anim);
    this.sprite.scale.x = direction === 'left' ? -1 : 1;
    this.sprite.animationSpeed = anim === 'walk' ? 0.15 : anim === 'idle' ? 0.08 : 0.06;
    this.sprite.autoUpdate = false;
    this.sprite.play();
  }

  // setPosition：保留原版办公室的绘制、交互或资源管理行为。
  setPosition(x: number, y: number): void {
    this.container.x = x;
    this.container.y = y;
  }

  // setAlpha：保留原版办公室的绘制、交互或资源管理行为。
  setAlpha(alpha: number): void {
    this.container.alpha = alpha;
  }

  // destroy：保留原版办公室的绘制、交互或资源管理行为。
  destroy(): void {
    this.container.destroy({ children: true });
  }
}
