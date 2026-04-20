import Phaser from "phaser";
import { GridNavMeshUpdater, NavMesh, buildPolysFromGridMap } from "navmesh";

const TILE_SIZE = 32;
const MAP_WIDTH = 50;
const MAP_HEIGHT = 50;
const WORLD_WIDTH = MAP_WIDTH * TILE_SIZE;
const WORLD_HEIGHT = MAP_HEIGHT * TILE_SIZE;
const PLAYER_SPEED = 130;

const TOOLS = {
  move: "move",
  land: "land",
  water: "water",
  wall: "wall",
  eraseWall: "eraseWall",
};

const NAV_MODES = {
  land: "land",
  amphibious: "amphibious",
};

const UPDATE_MODES = {
  accelerated: "accelerated",
  legacy: "legacy",
};

const TOOL_META = {
  move: { label: "Move / Select", color: "#f1c96c" },
  land: { label: "Paint Land", color: "#77b255" },
  water: { label: "Paint Water", color: "#3db7d6" },
  wall: { label: "Paint Wall", color: "#8b6b46" },
  eraseWall: { label: "Erase Wall", color: "#dd6a5f" },
};

const NAV_META = {
  land: { label: "Land Only", color: "#9ed96f" },
  amphibious: { label: "Land + Water", color: "#78dff2" },
};

const UPDATE_META = {
  accelerated: { label: "Accelerated Patch", color: "#f1c96c" },
  legacy: { label: "Legacy Rebuild", color: "#dd6a5f" },
};

const DIRECTION_KEYS = ["down", "down_left", "down_right", "up", "up_left", "up_right"];
const SWIM_KEYS = ["up", "down", "side"];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const formatMs = (value) => `${value.toFixed(2)} ms`;
const average = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const create2D = (fillValue) =>
  Array.from({ length: MAP_HEIGHT }, () => Array(MAP_WIDTH).fill(fillValue));

const createCells = () =>
  Array.from({ length: MAP_HEIGHT }, () =>
    Array.from({ length: MAP_WIDTH }, () => ({
      base: null,
      overlays: [],
      wall: null,
    }))
  );

const getTileCenter = (x, y) => ({
  x: x * TILE_SIZE + TILE_SIZE / 2,
  y: y * TILE_SIZE + TILE_SIZE / 2,
});

const normalizeBounds = (bounds) => {
  if (!bounds) return null;
  const minX = clamp(Math.floor(bounds.minX), 0, MAP_WIDTH - 1);
  const minY = clamp(Math.floor(bounds.minY), 0, MAP_HEIGHT - 1);
  const maxX = clamp(Math.floor(bounds.maxX), 0, MAP_WIDTH - 1);
  const maxY = clamp(Math.floor(bounds.maxY), 0, MAP_HEIGHT - 1);
  if (maxX < minX || maxY < minY) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
};

const expandBounds = (bounds, pad = 1) => {
  const normalized = normalizeBounds(bounds);
  if (!normalized) return null;
  return normalizeBounds({
    minX: normalized.minX - pad,
    minY: normalized.minY - pad,
    maxX: normalized.maxX + pad,
    maxY: normalized.maxY + pad,
  });
};

const ellipseWater = (terrain, centerX, centerY, radiusX, radiusY) => {
  for (let y = 0; y < MAP_HEIGHT; y += 1) {
    for (let x = 0; x < MAP_WIDTH; x += 1) {
      const dx = (x - centerX) / radiusX;
      const dy = (y - centerY) / radiusY;
      if (dx * dx + dy * dy <= 1) terrain[y][x] = "water";
    }
  }
};

const waterRibbon = (terrain, centerY, halfWidth = 1) => {
  for (let x = 4; x < MAP_WIDTH - 4; x += 1) {
    const wave = Math.round(Math.sin(x / 4.2) * 3.3 + Math.cos(x / 7.1) * 1.2);
    const y = clamp(centerY + wave, 3, MAP_HEIGHT - 4);
    for (let offset = -halfWidth; offset <= halfWidth; offset += 1) {
      terrain[clamp(y + offset, 0, MAP_HEIGHT - 1)][x] = "water";
    }
  }
};

const landBridge = (terrain, xStart, xEnd, yStart, yEnd) => {
  for (let y = yStart; y <= yEnd; y += 1) {
    for (let x = xStart; x <= xEnd; x += 1) {
      terrain[y][x] = "grass";
    }
  }
};

const chooseHorizontalDiagonal = (vx, lastDirection) => {
  if (vx > 0) return lastDirection === "up_right" || lastDirection === "up" ? "up_right" : "down_right";
  return lastDirection === "up_left" || lastDirection === "up" ? "up_left" : "down_left";
};

const pickWalkDirection = (vx, vy, lastDirection = "down") => {
  const absX = Math.abs(vx);
  const absY = Math.abs(vy);
  if (absX < 0.001 && absY < 0.001) return lastDirection;
  if (absY <= absX * 0.35) return chooseHorizontalDiagonal(vx, lastDirection);
  if (absY >= absX * 1.2) return vy < 0 ? "up" : "down";
  return vx > 0 ? (vy < 0 ? "up_right" : "down_right") : vy < 0 ? "up_left" : "down_left";
};

const pickSwimDirection = (vx, vy, lastDirection = "down") => {
  const absX = Math.abs(vx);
  const absY = Math.abs(vy);
  if (absX < 0.001 && absY < 0.001) return lastDirection === "side" ? "side" : lastDirection === "up" ? "up" : "down";
  if (absY > absX * 1.15) return vy < 0 ? "up" : "down";
  return "side";
};

export default class RuntimeNavmeshLabScene extends Phaser.Scene {
  constructor({ renderSnapshot }) {
    super({ key: "RuntimeNavmeshLabScene" });
    this.renderSnapshot = renderSnapshot;
    this.tool = TOOLS.move;
    this.navMode = NAV_MODES.land;
    this.updateMode = UPDATE_MODES.accelerated;
    this.stats = { accelerated: [], legacy: [] };
    this.lastSummary = "Accelerated mode rebuilds only the selected grid slice instead of the entire navmesh.";
    this.lastPatchLabel = "Last patch: local 3x3";
    this.cameraPanSpeed = 700;
    this.lastPaintKey = null;
  }

  preload() {
    this.load.image("grass", "assets/terrain/grass/grass_interior.png");
    this.load.image("grass-edge-water", "assets/terrain/grass/grass_edge_water.png");
    this.load.image("grass-corner-water", "assets/terrain/grass/grass_corner_water.png");
    this.load.image("grass-inner-corner-water", "assets/terrain/grass/grass_inner_corner_water.png");
    this.load.spritesheet("water", "assets/terrain/water/water_interior.png", {
      frameWidth: TILE_SIZE,
      frameHeight: TILE_SIZE,
    });
    this.load.image("wall", "assets/wall/stone_interior.png");

    DIRECTION_KEYS.forEach((key) => {
      this.load.spritesheet(`brawler-${key}`, `assets/players/brawler/brawler_walk_${key}.png`, {
        frameWidth: 32,
        frameHeight: 32,
      });
    });
    this.load.spritesheet("brawler-swim-up", "assets/players/brawler/brawler_swim_up.png", {
      frameWidth: 32,
      frameHeight: 32,
    });
    this.load.spritesheet("brawler-swim-down", "assets/players/brawler/brawler_swim_down.png", {
      frameWidth: 32,
      frameHeight: 32,
    });
    this.load.spritesheet("brawler-swim-side", "assets/players/brawler/brawler_swim_sidewards.png", {
      frameWidth: 32,
      frameHeight: 32,
    });
  }

  create() {
    this._createAnimations();
    this._createTerrainData();
    this._createLayers();
    this._createBackdrop();
    this._redrawBounds({ minX: 0, minY: 0, maxX: MAP_WIDTH - 1, maxY: MAP_HEIGHT - 1 });
    this._createMeshes();
    this._createPlayer();
    this._bindInput();
    this._fitCameraToWorld(true);
    this._refreshOverlay();
    this._renderUi();
  }

  handleExternalResize() {
    this._fitCameraToWorld(false);
  }

  setTool(tool) {
    if (!TOOLS[tool]) return;
    this.tool = tool;
    this.lastPaintKey = null;
    if (!this.terrain) return;
    this._refreshOverlay();
    this._renderUi();
  }

  setNavMode(mode) {
    if (!NAV_MODES[mode]) return;
    this.navMode = mode;
    if (!this.terrain) return;
    this._repathToGoal();
    this._refreshOverlay();
    this._renderUi();
  }

  setUpdateMode(mode) {
    if (!UPDATE_MODES[mode]) return;
    this.updateMode = mode;
    this.lastSummary =
      mode === UPDATE_MODES.accelerated
        ? "Accelerated mode rebuilds only the selected grid slice instead of the entire navmesh."
        : "Legacy mode rebuilds the full navmesh after every edit.";
    if (!this.terrain) return;
    this._renderUi();
  }

  update(time, delta) {
    this._updateCamera(delta);
    this._updatePlayer(delta);
    this._drawSelection(time);
    this._drawPath(time);
    this._drawHover();
  }

  _createAnimations() {
    if (!this.anims.exists("water-loop")) {
      this.anims.create({
        key: "water-loop",
        frames: this.anims.generateFrameNumbers("water", { start: 0, end: 2 }),
        frameRate: 3,
        repeat: -1,
      });
    }

    DIRECTION_KEYS.forEach((key) => {
      const animKey = `walk-${key}`;
      if (this.anims.exists(animKey)) return;
      this.anims.create({
        key: animKey,
        frames: this.anims.generateFrameNumbers(`brawler-${key}`, { start: 0, end: 2 }),
        frameRate: 7,
        repeat: -1,
      });
    });

    SWIM_KEYS.forEach((key) => {
      const animKey = `swim-${key}`;
      if (this.anims.exists(animKey)) return;
      this.anims.create({
        key: animKey,
        frames: this.anims.generateFrameNumbers(`brawler-swim-${key}`, { start: 0, end: 2 }),
        frameRate: 8,
        repeat: -1,
      });
    });
  }

  _createTerrainData() {
    this.terrain = create2D("grass");
    this.walls = create2D(false);
    this.landGrid = create2D(true);
    this.amphibiousGrid = create2D(true);
    this.cells = createCells();

    for (let y = 0; y < MAP_HEIGHT; y += 1) {
      for (let x = 0; x < MAP_WIDTH; x += 1) {
        if (x < 3 || y < 3 || x >= MAP_WIDTH - 3 || y >= MAP_HEIGHT - 3) {
          this.terrain[y][x] = "water";
        }
      }
    }

    ellipseWater(this.terrain, 24, 24, 7, 5);
    ellipseWater(this.terrain, 37, 12, 5, 4);
    ellipseWater(this.terrain, 13, 36, 4, 3);
    waterRibbon(this.terrain, 17, 1);
    landBridge(this.terrain, 12, 15, 15, 18);
    landBridge(this.terrain, 26, 29, 16, 19);
    landBridge(this.terrain, 39, 42, 17, 20);

    this._rebuildAllGrids();
  }

  _createLayers() {
    this.groundLayer = this.add.layer();
    this.overlayLayer = this.add.layer();
    this.wallLayer = this.add.layer();
    this.navGraphics = this.add.graphics().setDepth(70);
    this.patchGraphics = this.add.graphics().setDepth(72);
    this.hoverGraphics = this.add.graphics().setDepth(75);
    this.selectionGraphics = this.add.graphics().setDepth(76);
    this.pathGraphics = this.add.graphics().setDepth(77);
    this.commandGraphics = this.add.graphics().setDepth(78);
  }

  _createBackdrop() {
    this.add.rectangle(WORLD_WIDTH / 2, WORLD_HEIGHT / 2, WORLD_WIDTH + 160, WORLD_HEIGHT + 160, 0x0c4251)
      .setDepth(-20)
      .setStrokeStyle(26, 0x2f8597, 0.4);
    this.add.rectangle(WORLD_WIDTH / 2, WORLD_HEIGHT / 2, WORLD_WIDTH + 20, WORLD_HEIGHT + 20, 0x164f3a, 0)
      .setDepth(-19)
      .setStrokeStyle(2, 0xf1c96c, 0.25);
    this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.cameras.main.setBackgroundColor("#0c4251");
  }

  _createMeshes() {
    this.landMesh = this._buildMesh(this.landGrid);
    this.amphibiousMesh = this._buildMesh(this.amphibiousGrid);
    this.landUpdater = new GridNavMeshUpdater(this.landMesh, { tileWidth: TILE_SIZE, tileHeight: TILE_SIZE });
    this.amphibiousUpdater = new GridNavMeshUpdater(this.amphibiousMesh, {
      tileWidth: TILE_SIZE,
      tileHeight: TILE_SIZE,
    });
  }

  _buildMesh(grid) {
    return new NavMesh(buildPolysFromGridMap(grid, TILE_SIZE, TILE_SIZE, undefined, 0));
  }

  _createPlayer() {
    const spawn = getTileCenter(8, 10);
    this.player = this.physics.add.sprite(spawn.x, spawn.y, "brawler-down", 1);
    this.player.setSize(16, 12).setOffset(8, 20);
    this.player.setDepth(30);
    this.player.setInteractive({ useHandCursor: true });
    this.player.setCollideWorldBounds(true);
    this.player.path = [];
    this.player.goalPoint = null;
    this.player.lastWalkDirection = "down";
    this.player.lastSwimDirection = "down";
    this.player.on("pointerdown", (pointer) => {
      pointer.event.stopPropagation();
      this._flashCommand(this.player.x, this.player.y, 0xf1c96c);
    });
    this._setIdleFrame("down", false);
  }

  _bindInput() {
    this.moveKeys = this.input.keyboard.addKeys("W,A,S,D,ONE,TWO,THREE,FOUR,FIVE");

    this.input.on("pointerdown", (pointer) => {
      if (pointer.rightButtonDown()) return;
      const tile = this._pointerToTile(pointer);
      if (!tile) return;

      if (this.tool === TOOLS.move) {
        this._commandPlayer(tile.x, tile.y);
        return;
      }

      this.isPainting = true;
      this._applyTool(tile.x, tile.y);
    });

    this.input.on("pointermove", (pointer) => {
      if (!this.isPainting || !pointer.isDown || this.tool === TOOLS.move) return;
      const tile = this._pointerToTile(pointer);
      if (!tile) return;
      this._applyTool(tile.x, tile.y);
    });

    this.input.on("pointerup", () => {
      this.isPainting = false;
      this.lastPaintKey = null;
    });

    this.input.on("gameout", () => {
      this.isPainting = false;
      this.lastPaintKey = null;
    });

    this.input.on("wheel", (pointer, _objects, _dx, dy) => {
      const camera = this.cameras.main;
      const oldZoom = camera.zoom;
      const nextZoom = clamp(oldZoom * (dy > 0 ? 0.91 : 1.1), 0.48, 1.65);
      const before = pointer.positionToCamera(camera);
      camera.setZoom(nextZoom);
      const after = pointer.positionToCamera(camera);
      camera.scrollX += before.x - after.x;
      camera.scrollY += before.y - after.y;
    });

    this.input.keyboard.on("keydown-ONE", () => this.setTool(TOOLS.move));
    this.input.keyboard.on("keydown-TWO", () => this.setTool(TOOLS.land));
    this.input.keyboard.on("keydown-THREE", () => this.setTool(TOOLS.water));
    this.input.keyboard.on("keydown-FOUR", () => this.setTool(TOOLS.wall));
    this.input.keyboard.on("keydown-FIVE", () => this.setTool(TOOLS.eraseWall));
  }

  _pointerToTile(pointer) {
    const worldPoint = pointer.positionToCamera(this.cameras.main);
    const x = Math.floor(worldPoint.x / TILE_SIZE);
    const y = Math.floor(worldPoint.y / TILE_SIZE);
    if (x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT) return null;
    return { x, y };
  }

  _rebuildAllGrids() {
    for (let y = 0; y < MAP_HEIGHT; y += 1) {
      for (let x = 0; x < MAP_WIDTH; x += 1) {
        this._refreshGridCell(x, y);
      }
    }
  }

  _refreshGridCell(x, y) {
    this.landGrid[y][x] = this.terrain[y][x] === "grass" && !this.walls[y][x];
    this.amphibiousGrid[y][x] = !this.walls[y][x];
  }

  _redrawBounds(bounds) {
    const normalized = normalizeBounds(bounds);
    if (!normalized) return;
    for (let y = normalized.minY; y <= normalized.maxY; y += 1) {
      for (let x = normalized.minX; x <= normalized.maxX; x += 1) {
        this._redrawCell(x, y);
      }
    }
  }

  _redrawCell(x, y) {
    const cell = this.cells[y][x];
    if (cell.base) cell.base.destroy();
    if (cell.wall) cell.wall.destroy();
    cell.overlays.forEach((overlay) => overlay.destroy());
    cell.overlays = [];
    cell.base = null;
    cell.wall = null;

    const center = getTileCenter(x, y);
    if (this.terrain[y][x] === "water") {
      const sprite = this.add.sprite(center.x, center.y, "water").setDepth(2);
      sprite.play("water-loop");
      this.groundLayer.add(sprite);
      cell.base = sprite;
    } else {
      const image = this.add.image(center.x, center.y, "grass").setDepth(2);
      this.groundLayer.add(image);
      cell.base = image;
      cell.overlays = this._createGrassOverlays(x, y, center);
    }

    if (this.walls[y][x]) {
      const wall = this.add.image(center.x, center.y, "wall").setDepth(18);
      this.wallLayer.add(wall);
      cell.wall = wall;
    }
  }

  _createGrassOverlays(x, y, center) {
    const overlays = [];
    const waterN = this._isWater(x, y - 1);
    const waterE = this._isWater(x + 1, y);
    const waterS = this._isWater(x, y + 1);
    const waterW = this._isWater(x - 1, y);
    const waterNW = this._isWater(x - 1, y - 1);
    const waterNE = this._isWater(x + 1, y - 1);
    const waterSE = this._isWater(x + 1, y + 1);
    const waterSW = this._isWater(x - 1, y + 1);

    const add = (key, angle) => {
      const overlay = this.add.image(center.x, center.y, key).setDepth(4);
      overlay.setAngle(angle);
      this.overlayLayer.add(overlay);
      overlays.push(overlay);
    };

    if (waterN) add("grass-edge-water", 0);
    if (waterE) add("grass-edge-water", 90);
    if (waterS) add("grass-edge-water", 180);
    if (waterW) add("grass-edge-water", 270);

    if (!waterN && !waterW && waterNW) add("grass-corner-water", 0);
    if (!waterN && !waterE && waterNE) add("grass-corner-water", 90);
    if (!waterS && !waterE && waterSE) add("grass-corner-water", 180);
    if (!waterS && !waterW && waterSW) add("grass-corner-water", 270);

    if (waterN && waterW && !waterNW) add("grass-inner-corner-water", 0);
    if (waterN && waterE && !waterNE) add("grass-inner-corner-water", 90);
    if (waterS && waterE && !waterSE) add("grass-inner-corner-water", 180);
    if (waterS && waterW && !waterSW) add("grass-inner-corner-water", 270);

    return overlays;
  }

  _isWater(x, y) {
    if (x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT) return true;
    return this.terrain[y][x] === "water";
  }

  _activeMesh() {
    return this.navMode === NAV_MODES.land ? this.landMesh : this.amphibiousMesh;
  }

  _activeGrid() {
    return this.navMode === NAV_MODES.land ? this.landGrid : this.amphibiousGrid;
  }

  _commandPlayer(tileX, tileY) {
    const target = getTileCenter(tileX, tileY);
    const navMesh = this._activeMesh();
    const startResult = navMesh.findClosestMeshPoint(new Phaser.Math.Vector2(this.player.x, this.player.y), TILE_SIZE * 4);
    const endResult = navMesh.findClosestMeshPoint(new Phaser.Math.Vector2(target.x, target.y), TILE_SIZE * 3);

    if (!startResult.point || !endResult.point) {
      this._flashCommand(target.x, target.y, 0xdd6a5f);
      return;
    }

    const path = navMesh.findPath(startResult.point, endResult.point);
    if (!path || path.length === 0) {
      this._flashCommand(target.x, target.y, 0xdd6a5f);
      return;
    }

    this.player.path = path.map((point) => ({ x: point.x, y: point.y }));
    if (this.player.path.length > 1) this.player.path.shift();
    this.player.goalPoint = target;
    this._flashCommand(endResult.point.x, endResult.point.y, 0xf1c96c);
  }

  _repathToGoal() {
    if (!this.player.goalPoint) return;
    const tileX = Math.floor(this.player.goalPoint.x / TILE_SIZE);
    const tileY = Math.floor(this.player.goalPoint.y / TILE_SIZE);
    this._commandPlayer(tileX, tileY);
  }

  _updatePlayer(delta) {
    const body = this.player.body;
    const dt = delta / 1000;

    if (this.player.path.length) {
      const next = this.player.path[0];
      const dx = next.x - this.player.x;
      const dy = next.y - this.player.y;
      const distance = Math.hypot(dx, dy);

      if (distance <= PLAYER_SPEED * dt) {
        this.player.setPosition(next.x, next.y);
        this.player.path.shift();
        if (!this.player.path.length) {
          body.setVelocity(0, 0);
          this.player.goalPoint = null;
        }
      } else {
        body.setVelocity((dx / distance) * PLAYER_SPEED, (dy / distance) * PLAYER_SPEED);
      }
    } else {
      body.setVelocity(0, 0);
    }

    this._syncPlayerAnimation();
  }

  _syncPlayerAnimation() {
    const velocity = this.player.body.velocity;
    const moving = velocity.lengthSq() > 1;
    const swimming = this._isWater(
      Math.floor(this.player.x / TILE_SIZE),
      Math.floor(this.player.y / TILE_SIZE)
    );

    if (!moving) {
      this.player.anims.stop();
      if (swimming) {
        const dir = this.player.lastSwimDirection === "side" ? "side" : this.player.lastSwimDirection;
        this.player.setTexture(`brawler-swim-${dir}`, 1);
        this.player.setFlipX(dir === "side" && this.player.flipX);
      } else {
        this._setIdleFrame(this.player.lastWalkDirection, false);
      }
      return;
    }

    if (swimming) {
      const dir = pickSwimDirection(velocity.x, velocity.y, this.player.lastSwimDirection);
      this.player.lastSwimDirection = dir;
      this.player.setFlipX(dir === "side" && velocity.x < 0);
      const animKey = `swim-${dir}`;
      if (this.player.anims.currentAnim?.key !== animKey) this.player.play(animKey, true);
      return;
    }

    const dir = pickWalkDirection(velocity.x, velocity.y, this.player.lastWalkDirection);
    this.player.lastWalkDirection = dir;
    const animKey = `walk-${dir}`;
    this.player.setFlipX(false);
    if (this.player.anims.currentAnim?.key !== animKey) this.player.play(animKey, true);
  }

  _setIdleFrame(direction) {
    this.player.setTexture(`brawler-${direction}`, 1);
    this.player.setFlipX(false);
  }

  _updateCamera(delta) {
    const camera = this.cameras.main;
    const step = (this.cameraPanSpeed * (delta / 1000)) / camera.zoom;
    if (this.moveKeys.W.isDown) camera.scrollY -= step;
    if (this.moveKeys.S.isDown) camera.scrollY += step;
    if (this.moveKeys.A.isDown) camera.scrollX -= step;
    if (this.moveKeys.D.isDown) camera.scrollX += step;
  }

  _drawSelection(time) {
    this.selectionGraphics.clear();
    const pulse = 1 + Math.sin(time * 0.006) * 0.08;
    this.selectionGraphics.lineStyle(3, 0xf1c96c, 0.92);
    this.selectionGraphics.strokeCircle(this.player.x, this.player.y + 7, 17 * pulse);
    this.selectionGraphics.lineStyle(1, 0xffffff, 0.75);
    this.selectionGraphics.strokeCircle(this.player.x, this.player.y + 7, 22 * pulse);
  }

  _drawPath(time) {
    this.pathGraphics.clear();
    if (!this.player.path.length) return;
    const points = [{ x: this.player.x, y: this.player.y }, ...this.player.path];

    this.pathGraphics.lineStyle(6, 0xffffff, 0.88);
    this.pathGraphics.beginPath();
    this.pathGraphics.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) this.pathGraphics.lineTo(points[i].x, points[i].y);
    this.pathGraphics.strokePath();

    this.pathGraphics.lineStyle(3, this.navMode === NAV_MODES.land ? 0x99db68 : 0x55d9f1, 0.92);
    this.pathGraphics.beginPath();
    this.pathGraphics.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) this.pathGraphics.lineTo(points[i].x, points[i].y);
    this.pathGraphics.strokePath();

    const point = this._samplePolyline(points, (time * 0.00022) % 1);
    if (point) {
      this.pathGraphics.fillStyle(0xf1c96c, 0.92);
      this.pathGraphics.fillCircle(point.x, point.y, 5);
    }
  }

  _samplePolyline(points, t) {
    if (!points || points.length < 2) return null;
    let total = 0;
    const segments = [];
    for (let i = 1; i < points.length; i += 1) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      const length = Math.hypot(dx, dy);
      if (length <= 0.001) continue;
      segments.push({ start: points[i - 1], end: points[i], length });
      total += length;
    }
    if (!total) return null;
    let remaining = total * t;
    for (const segment of segments) {
      if (remaining <= segment.length) {
        const alpha = remaining / segment.length;
        return {
          x: Phaser.Math.Linear(segment.start.x, segment.end.x, alpha),
          y: Phaser.Math.Linear(segment.start.y, segment.end.y, alpha),
        };
      }
      remaining -= segment.length;
    }
    return segments.length ? segments[segments.length - 1].end : null;
  }

  _drawHover() {
    this.hoverGraphics.clear();
    const pointer = this.input.activePointer;
    if (!pointer) return;
    const tile = this._pointerToTile(pointer);
    if (!tile) return;
    const color = Phaser.Display.Color.HexStringToColor(TOOL_META[this.tool].color).color;
    this.hoverGraphics.lineStyle(2, color, 0.9);
    this.hoverGraphics.fillStyle(color, this.tool === TOOLS.move ? 0.06 : 0.18);
    this.hoverGraphics.fillRect(tile.x * TILE_SIZE, tile.y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    this.hoverGraphics.strokeRect(tile.x * TILE_SIZE, tile.y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
  }

  _applyTool(x, y) {
    const key = `${x},${y}`;
    if (key === this.lastPaintKey) return;
    this.lastPaintKey = key;

    let changed = false;
    switch (this.tool) {
      case TOOLS.land:
        if (this.terrain[y][x] !== "grass" || this.walls[y][x]) {
          this.terrain[y][x] = "grass";
          this.walls[y][x] = false;
          changed = true;
        }
        break;
      case TOOLS.water:
        if (this.terrain[y][x] !== "water" || this.walls[y][x]) {
          this.terrain[y][x] = "water";
          this.walls[y][x] = false;
          changed = true;
        }
        break;
      case TOOLS.wall:
        if (!this.walls[y][x]) {
          this.walls[y][x] = true;
          changed = true;
        }
        break;
      case TOOLS.eraseWall:
        if (this.walls[y][x]) {
          this.walls[y][x] = false;
          changed = true;
        }
        break;
      default:
        break;
    }

    if (!changed) return;

    const redrawBounds = expandBounds({ minX: x, minY: y, maxX: x, maxY: y }, 1);
    this._redrawBounds(redrawBounds);

    for (let gy = redrawBounds.minY; gy <= redrawBounds.maxY; gy += 1) {
      for (let gx = redrawBounds.minX; gx <= redrawBounds.maxX; gx += 1) {
        this._refreshGridCell(gx, gy);
      }
    }

    const timing =
      this.updateMode === UPDATE_MODES.accelerated
        ? this._applyAcceleratedPatch(redrawBounds)
        : this._applyLegacyRebuild();

    this.stats[this.updateMode].push(timing);
    if (this.stats[this.updateMode].length > 36) this.stats[this.updateMode].shift();

    this.lastPatchLabel =
      this.updateMode === UPDATE_MODES.accelerated
        ? `Last patch: local ${redrawBounds.width}x${redrawBounds.height}`
        : `Last patch: full ${MAP_WIDTH}x${MAP_HEIGHT}`;

    this.lastSummary =
      this.updateMode === UPDATE_MODES.accelerated
        ? `Accelerated edit patched both navmeshes in ${formatMs(timing)} over a ${redrawBounds.width}x${redrawBounds.height} slice.`
        : `Legacy edit rebuilt both navmeshes from the full ${MAP_WIDTH}x${MAP_HEIGHT} map in ${formatMs(timing)}.`;

    this._flashPatch(redrawBounds, this.updateMode);
    this._repathToGoal();
    this._refreshOverlay();
    this._renderUi();
  }

  _applyAcceleratedPatch(bounds) {
    const started = performance.now();
    this.landUpdater.replaceBounds(bounds, this.landGrid);
    this.amphibiousUpdater.replaceBounds(bounds, this.amphibiousGrid);
    return performance.now() - started;
  }

  _applyLegacyRebuild() {
    const started = performance.now();
    this.landMesh = this._buildMesh(this.landGrid);
    this.amphibiousMesh = this._buildMesh(this.amphibiousGrid);
    this.landUpdater = new GridNavMeshUpdater(this.landMesh, { tileWidth: TILE_SIZE, tileHeight: TILE_SIZE });
    this.amphibiousUpdater = new GridNavMeshUpdater(this.amphibiousMesh, {
      tileWidth: TILE_SIZE,
      tileHeight: TILE_SIZE,
    });
    return performance.now() - started;
  }

  _flashPatch(bounds, mode) {
    this.patchGraphics.clear();
    const color = mode === UPDATE_MODES.accelerated ? 0xf1c96c : 0xdd6a5f;
    this.patchGraphics.lineStyle(3, color, 0.95);
    this.patchGraphics.fillStyle(color, 0.08);
    this.patchGraphics.fillRect(bounds.minX * TILE_SIZE, bounds.minY * TILE_SIZE, bounds.width * TILE_SIZE, bounds.height * TILE_SIZE);
    this.patchGraphics.strokeRect(bounds.minX * TILE_SIZE, bounds.minY * TILE_SIZE, bounds.width * TILE_SIZE, bounds.height * TILE_SIZE);
    this.tweens.killTweensOf(this.patchGraphics);
    this.patchGraphics.alpha = 1;
    this.tweens.add({
      targets: this.patchGraphics,
      alpha: 0,
      duration: 900,
      ease: "Cubic.easeOut",
    });
  }

  _refreshOverlay() {
    this.navGraphics.clear();
    if (this.tool === TOOLS.move) return;

    const navMesh = this._activeMesh();
    const polygons = navMesh.getPolygons();
    const fillColor = this.navMode === NAV_MODES.land ? 0xa7db67 : 0x59d9f4;
    const drawnPortals = new Set();

    polygons.forEach((polygon) => {
      const points = polygon.polygon.points;
      if (!points.length) return;
      this.navGraphics.lineStyle(1, 0xffffff, 0.32);
      this.navGraphics.fillStyle(fillColor, 0.18);
      this.navGraphics.beginPath();
      this.navGraphics.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) this.navGraphics.lineTo(points[i].x, points[i].y);
      this.navGraphics.closePath();
      this.navGraphics.strokePath();
      this.navGraphics.fillPath();

      polygon.portals.forEach((portal) => {
        const forward = `${portal.start.x},${portal.start.y}-${portal.end.x},${portal.end.y}`;
        const reverse = `${portal.end.x},${portal.end.y}-${portal.start.x},${portal.start.y}`;
        if (drawnPortals.has(forward) || drawnPortals.has(reverse)) return;
        drawnPortals.add(forward);
        this.navGraphics.lineStyle(3, 0x0e0e0e, 0.92);
        this.navGraphics.beginPath();
        this.navGraphics.moveTo(portal.start.x, portal.start.y);
        this.navGraphics.lineTo(portal.end.x, portal.end.y);
        this.navGraphics.strokePath();
      });
    });
  }

  _fitCameraToWorld(forceCenter) {
    const camera = this.cameras.main;
    const width = this.scale.width || 1280;
    const height = this.scale.height || 720;
    const zoom = clamp(Math.min((width - 64) / WORLD_WIDTH, (height - 64) / WORLD_HEIGHT), 0.5, 1);
    if (forceCenter || camera.zoom < 0.1) {
      camera.setZoom(zoom);
      camera.centerOn(WORLD_WIDTH / 2, WORLD_HEIGHT / 2);
      return;
    }
    camera.setZoom(clamp(camera.zoom, 0.48, 1.65));
  }

  _flashCommand(x, y, color) {
    this.commandGraphics.clear();
    this.commandGraphics.lineStyle(2, color, 0.95);
    this.commandGraphics.strokeCircle(x, y, 10);
    this.commandGraphics.strokeCircle(x, y, 18);
    this.commandGraphics.alpha = 1;
    this.tweens.killTweensOf(this.commandGraphics);
    this.tweens.add({
      targets: this.commandGraphics,
      alpha: 0,
      duration: 550,
      ease: "Cubic.easeOut",
      onComplete: () => this.commandGraphics.clear(),
    });
  }

  _renderUi() {
    const activeGrid = this._activeGrid();
    let activeWalkableTiles = 0;
    let landTiles = 0;
    let waterTiles = 0;
    let wallTiles = 0;

    for (let y = 0; y < MAP_HEIGHT; y += 1) {
      for (let x = 0; x < MAP_WIDTH; x += 1) {
        if (this.terrain[y][x] === "water") waterTiles += 1;
        else landTiles += 1;
        if (this.walls[y][x]) wallTiles += 1;
        if (activeGrid[y][x]) activeWalkableTiles += 1;
      }
    }

    this.renderSnapshot({
      tool: this.tool,
      toolLabel: TOOL_META[this.tool].label,
      toolColor: TOOL_META[this.tool].color,
      navMode: this.navMode,
      navModeLabel: NAV_META[this.navMode].label,
      navModeColor: NAV_META[this.navMode].color,
      updateMode: this.updateMode,
      updateModeLabel: UPDATE_META[this.updateMode].label,
      updateModeColor: UPDATE_META[this.updateMode].color,
      summary: this.lastSummary,
      lastPatchLabel: this.lastPatchLabel,
      activePolygons: this._activeMesh().getPolygons().length,
      activeWalkableTiles,
      landTiles,
      waterTiles,
      wallTiles,
      note:
        this.stats.accelerated.length || this.stats.legacy.length
          ? "Switch update modes and keep painting to build a direct timing comparison."
          : "Paint the map to populate timing history.",
      stats: {
        accelerated: {
          last: formatMs(this.stats.accelerated.at(-1) || 0),
          avg: formatMs(average(this.stats.accelerated)),
          count: String(this.stats.accelerated.length),
        },
        legacy: {
          last: formatMs(this.stats.legacy.at(-1) || 0),
          avg: formatMs(average(this.stats.legacy)),
          count: String(this.stats.legacy.length),
        },
      },
    });
  }
}
