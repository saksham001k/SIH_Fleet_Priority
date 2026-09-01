import * as THREE from '../vendor/three/three.module.min.js';
import { OrbitControls } from '../vendor/three/addons/controls/OrbitControls.js';

const PALETTE = {
  cyan: 0x35c6f4,
  green: 0x46d39a,
  amber: 0xf5b843,
  violet: 0xb78cff,
  rose: 0xff6577,
  navy: 0x071019,
  floor: 0x111b26,
  rack: 0x33485b,
  steel: 0x6f8498,
};

const ROBOT_COLOURS = [PALETTE.cyan, PALETTE.green, PALETTE.amber, PALETTE.violet,
  0xff7f50, 0x67e8f9, 0xa3e635, 0xfb7185, 0x60a5fa, 0xf0abfc];

const MATERIALS = {
  carton: () => new THREE.MeshStandardMaterial({color: 0xb9783f, roughness: .9, metalness: .01}),
  darkSteel: () => new THREE.MeshStandardMaterial({color: 0x172b3a, roughness: .34, metalness: .78}),
  blueSteel: () => new THREE.MeshStandardMaterial({color: 0x294b63, roughness: .3, metalness: .74}),
};

function disposeObject(root) {
  root.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const material of materials) {
        if (material.map) material.map.dispose();
        material.dispose();
      }
    }
  });
}

function makeLabel(text, colour = '#eaf6ff', compact = false) {
  const canvas = document.createElement('canvas');
  canvas.width = compact ? 256 : 512;
  canvas.height = compact ? 72 : 96;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(5, 13, 22, .88)';
  ctx.strokeStyle = colour;
  ctx.lineWidth = 3;
  const radius = 16;
  ctx.beginPath();
  ctx.roundRect(3, 3, canvas.width - 6, canvas.height - 6, radius);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${compact ? 30 : 34}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({map: texture, transparent: true, depthTest: false}));
  sprite.scale.set(compact ? 2.5 : 4.2, compact ? 0.7 : 0.8, 1);
  sprite.renderOrder = 100;
  return sprite;
}

function hexCss(value) {
  return `#${value.toString(16).padStart(6, '0')}`;
}

export class DigitalTwin {
  constructor(canvas, onSelect) {
    this.canvas = canvas;
    this.onSelect = onSelect;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x071019);
    this.scene.fog = new THREE.FogExp2(0x071019, 0.009);
    this.camera = new THREE.PerspectiveCamera(43, 1, 0.1, 1000);
    this.camera.position.set(18, 25, 24);
    this.renderer = new THREE.WebGLRenderer({canvas, antialias: true, powerPreference: 'high-performance'});
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.065;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 95;
    this.controls.target.set(0, 0, 0);

    this.world = new THREE.Group();
    this.dynamic = new THREE.Group();
    this.routes = new THREE.Group();
    this.scene.add(this.world, this.routes, this.dynamic);
    this.robots = new Map();
    this.humans = new Map();
    this.obstacles = new Map();
    this.deadZones = [];
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.selectedId = null;
    this.map = null;
    this.meta = null;
    this.cameraMode = 'overview';
    this.lastRouteRefresh = -Infinity;
    this._addLighting();
    canvas.addEventListener('pointerdown', event => this._selectAt(event));
  }

  _addLighting() {
    const hemi = new THREE.HemisphereLight(0xbfe8ff, 0x15202c, 2.2);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 3.4);
    key.position.set(-18, 34, 16);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -35;
    key.shadow.camera.right = 35;
    key.shadow.camera.top = 35;
    key.shadow.camera.bottom = -35;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x35c6f4, 1.2);
    rim.position.set(22, 14, -22);
    this.scene.add(rim);
  }

  load(data) {
    disposeObject(this.world);
    disposeObject(this.routes);
    disposeObject(this.dynamic);
    this.scene.remove(this.world, this.routes, this.dynamic);
    this.world = new THREE.Group();
    this.routes = new THREE.Group();
    this.dynamic = new THREE.Group();
    this.scene.add(this.world, this.routes, this.dynamic);
    this.robots.clear();
    this.humans.clear();
    this.obstacles.clear();
    this.deadZones = [];
    this.map = data.map;
    this.meta = data.meta;
    this._buildWarehouse();
    this._buildTasks();
    const first = data.frames[0] || {robots: [], humans: []};
    for (const robot of first.robots) this._ensureRobot(robot.id);
    for (const human of first.humans || []) this._ensureHuman(human.id);
    this.resize();
    const widthM = this.map.width * this.meta.cell_m;
    const heightM = this.map.height * this.meta.cell_m;
    const span = Math.max(widthM, heightM);
    this.camera.position.set(span * .72, span * .82, span * .78);
    this.controls.target.set(0, 0, 0);
    this.controls.maxDistance = span * 2.8;
    this.controls.update();
  }

  resize() {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  setCameraMode(mode) {
    this.cameraMode = mode;
    this.controls.enabled = mode === 'overview' || mode === 'tactical';
    if (mode === 'tactical' && this.map && this.meta) {
      const span = Math.max(this.map.width, this.map.height) * this.meta.cell_m;
      this.camera.position.set(span * .08, span * 1.18, span * .48);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    }
  }

  setSelected(id) {
    this.selectedId = id || null;
  }

  zoom(delta) {
    if (!this.controls.enabled) return;
    const direction = this.camera.position.clone().sub(this.controls.target);
    const factor = delta > 0 ? .86 : 1.16;
    direction.multiplyScalar(factor);
    this.camera.position.copy(this.controls.target).add(direction);
    this.controls.update();
  }

  _toWorld(xMetres, yMetres, height = 0) {
    const widthM = this.map.width * this.meta.cell_m;
    const heightM = this.map.height * this.meta.cell_m;
    return new THREE.Vector3(xMetres - widthM / 2, height, heightM / 2 - yMetres);
  }

  _cellToWorld(x, y, height = 0) {
    return this._toWorld((x + .5) * this.meta.cell_m, (y + .5) * this.meta.cell_m, height);
  }

  _buildWarehouse() {
    const cell = this.meta.cell_m;
    const widthM = this.map.width * cell;
    const heightM = this.map.height * cell;
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(widthM + 1.2, .35, heightM + 1.2),
      new THREE.MeshStandardMaterial({color: PALETTE.floor, roughness: .88, metalness: .08}),
    );
    floor.position.y = -.22;
    floor.receiveShadow = true;
    this.world.add(floor);

    // Build the warehouse surface from real, separated tile meshes. The narrow gaps
    // and alternating finish make depth visible at every camera angle while keeping
    // the simulation grid and collision map unchanged.
    const tileGeometry = new THREE.BoxGeometry(cell * .965, .055, cell * .965);
    const tileMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: .78,
      metalness: .12,
      vertexColors: true,
    });
    const tiles = new THREE.InstancedMesh(
      tileGeometry,
      tileMaterial,
      this.map.width * this.map.height,
    );
    const tileMatrix = new THREE.Matrix4();
    const tileColours = [new THREE.Color(0x162838), new THREE.Color(0x122331), new THREE.Color(0x192d3d)];
    let tileIndex = 0;
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        const centre = this._cellToWorld(x, y, -.018);
        tileMatrix.setPosition(centre);
        tiles.setMatrixAt(tileIndex, tileMatrix);
        tiles.setColorAt(tileIndex, tileColours[(x + y * 2) % tileColours.length]);
        tileIndex++;
      }
    }
    tiles.receiveShadow = true;
    tiles.instanceMatrix.needsUpdate = true;
    if (tiles.instanceColor) tiles.instanceColor.needsUpdate = true;
    this.world.add(tiles);

    const grid = new THREE.GridHelper(Math.max(widthM, heightM) * 1.05,
      Math.max(this.map.width, this.map.height), 0x29465e, 0x1a2c3b);
    grid.position.y = .012;
    grid.material.transparent = true;
    grid.material.opacity = .55;
    this.world.add(grid);

    // High-contrast pedestrian crossing and aisle guides remain visual-only overlays.
    const markingMaterial = new THREE.MeshBasicMaterial({color: 0xf5c84c, transparent: true, opacity: .58});
    for (let index = -3; index <= 3; index++) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(cell * .12, .012, cell * 1.7), markingMaterial);
      stripe.position.set(index * cell * .22, .018, 0);
      this.world.add(stripe);
    }
    const guideMaterial = new THREE.MeshBasicMaterial({color: 0x35c6f4, transparent: true, opacity: .22});
    for (const x of [-widthM * .24, widthM * .24]) {
      const guide = new THREE.Mesh(new THREE.BoxGeometry(.035, .01, heightM * .72), guideMaterial);
      guide.position.set(x, .017, 0);
      this.world.add(guide);
    }

    // The generated warehouse references show a real facility, not a board floating in
    // space.  These dressings live outside the navigable grid and therefore never alter
    // collision or planning behaviour.
    const wallMaterial = new THREE.MeshStandardMaterial({color: 0x102331, roughness: .7, metalness: .32});
    const wallHeight = Math.max(2.8, cell * 2.4);
    for (const [x, z, w, d] of [
      [0, -heightM / 2 - .55, widthM + 1.4, .18],
      [-widthM / 2 - .55, 0, .18, heightM + 1.4],
      [widthM / 2 + .55, 0, .18, heightM + 1.4],
    ]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, wallHeight, d), wallMaterial);
      wall.position.set(x, wallHeight / 2 - .18, z);
      wall.receiveShadow = true;
      this.world.add(wall);
    }
    const beamMaterial = MATERIALS.darkSteel();
    for (let x = -widthM / 2; x <= widthM / 2; x += Math.max(3, cell * 4)) {
      const column = new THREE.Mesh(new THREE.BoxGeometry(.18, wallHeight, .18), beamMaterial);
      column.position.set(x, wallHeight / 2, -heightM / 2 - .36);
      column.castShadow = true;
      this.world.add(column);
    }
    for (let x = -widthM / 2 + 1.2; x < widthM / 2; x += Math.max(3.2, cell * 4.5)) {
      const lamp = new THREE.PointLight(0xc9efff, 1.8, Math.max(5, cell * 7), 1.6);
      lamp.position.set(x, wallHeight - .25, 0);
      this.world.add(lamp);
      const fixture = this._makeCeilingFixture();
      fixture.position.copy(lamp.position);
      this.world.add(fixture);
    }

    const fireCabinet = this._makeFireCabinet();
    fireCabinet.position.set(-widthM * .34, 1.05, -heightM / 2 - .43);
    this.world.add(fireCabinet);
    const terminal = this._makeControlTerminal();
    terminal.position.set(widthM / 2 + .16, 0, -heightM * .28);
    terminal.rotation.y = -Math.PI / 2;
    this.world.add(terminal);
    const safetySign = this._makeWarningSign();
    safetySign.position.set(widthM * .28, 1.35, -heightM / 2 - .43);
    this.world.add(safetySign);
    for (const x of [-widthM * .4, widthM * .4]) {
      const camera = this._makeSecurityCamera();
      camera.position.set(x, wallHeight - .5, -heightM / 2 - .35);
      camera.rotation.y = x < 0 ? -.35 : .35;
      this.world.add(camera);
    }

    const rackCells = [];
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        if (this.map.grid[y][x] === 1) rackCells.push([x, y]);
      }
    }
    // Build recognisable industrial shelving instead of opaque rack-shaped blocks.
    // Instancing keeps the richer geometry inexpensive even on a large warehouse.
    const uprightGeometry = new THREE.BoxGeometry(cell * .055, cell * 1.18, cell * .055);
    const shelfGeometry = new THREE.BoxGeometry(cell * .9, cell * .045, cell * .9);
    const cartonGeometry = new THREE.BoxGeometry(cell * .62, cell * .24, cell * .64);
    const beamGeometry = new THREE.BoxGeometry(cell * .82, cell * .055, cell * .045);
    const rackMaterial = new THREE.MeshStandardMaterial({color: 0x245778, roughness: .3, metalness: .78});
    const shelfMaterial = new THREE.MeshStandardMaterial({color: 0x1b3345, roughness: .38, metalness: .64});
    const rackBeamMaterial = new THREE.MeshStandardMaterial({color: 0xe89d24, roughness: .48, metalness: .48});
    const cartonMaterial = new THREE.MeshStandardMaterial({color: 0xb47a43, roughness: .84, metalness: .02});
    const uprights = new THREE.InstancedMesh(uprightGeometry, rackMaterial, rackCells.length * 4);
    const shelves = new THREE.InstancedMesh(shelfGeometry, shelfMaterial, rackCells.length * 3);
    const beams = new THREE.InstancedMesh(beamGeometry, rackBeamMaterial, rackCells.length * 6);
    const cartons = new THREE.InstancedMesh(cartonGeometry, cartonMaterial, rackCells.length * 2);
    for (const mesh of [uprights, shelves, beams, cartons]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    const matrix = new THREE.Matrix4();
    let uprightIndex = 0, shelfIndex = 0, beamIndex = 0, cartonIndex = 0;
    rackCells.forEach(([x, y], index) => {
      const centre = this._cellToWorld(x, y, 0);
      const edge = cell * .41;
      for (const [dx, dz] of [[-edge, -edge], [edge, -edge], [-edge, edge], [edge, edge]]) {
        matrix.setPosition(centre.x + dx, cell * .59, centre.z + dz);
        uprights.setMatrixAt(uprightIndex++, matrix);
      }
      for (const level of [cell * .1, cell * .56, cell * 1.02]) {
        matrix.setPosition(centre.x, level, centre.z);
        shelves.setMatrixAt(shelfIndex++, matrix);
        for (const z of [centre.z - edge, centre.z + edge]) {
          matrix.setPosition(centre.x, level + cell * .055, z);
          beams.setMatrixAt(beamIndex++, matrix);
        }
      }
      for (const level of [cell * .3, cell * .76]) {
        const stagger = (index % 2 ? 1 : -1) * cell * .08;
        matrix.setPosition(centre.x + stagger, level, centre.z);
        cartons.setMatrixAt(cartonIndex++, matrix);
      }
      // Place the supplied damaged/open/stacked cargo concepts throughout the
      // shelving without multiplying draw calls on every rack bay.
      if (index % 8 === 0) {
        const displayCargo = this._makeCargoAsset(index % 5, Math.min(.42, cell * .34));
        displayCargo.position.set(centre.x, cell * .13, centre.z);
        displayCargo.rotation.y = index % 2 ? Math.PI / 2 : 0;
        this.world.add(displayCargo);
      }
    });
    this.world.add(uprights, shelves, beams, cartons);

    // A loading-zone vignette gives open-floor scenarios scale and integrates the
    // generated cart/rack/cargo references without occupying a planner cell.
    const loadingZ = heightM / 2 + .28;
    const cart = this._makeSortationCart();
    cart.position.set(-Math.min(widthM * .28, 3.5), 0, loadingZ);
    cart.rotation.y = Math.PI;
    this.world.add(cart);
    const showcaseRack = this._makeShowcaseRack(Math.min(4.5, widthM * .34));
    showcaseRack.position.set(Math.min(widthM * .18, 2.5), 0, loadingZ + .08);
    this.world.add(showcaseRack);
    const pallet = this._makePallet(true);
    pallet.position.set(0, 0, loadingZ + .05);
    this.world.add(pallet);
    const barrier = this._makeSafetyBarrier(Math.min(2.5, widthM * .2));
    barrier.position.set(-widthM * .4, 0, loadingZ - .1);
    this.world.add(barrier);
    const bollards = this._makeBollardCluster();
    bollards.position.set(widthM * .42, 0, loadingZ - .05);
    this.world.add(bollards);
    for (const x of [-widthM * .32, widthM * .33]) {
      const cone = this._makeWarningCone();
      cone.position.set(x, 0, loadingZ - .8);
      this.world.add(cone);
    }

    for (const [x, y] of this.map.stations || []) {
      this.world.add(this._makePad(x, y, 0x3b82f6, 'PICK / DROP'));
    }
    for (const [x, y] of this.map.docks || []) {
      this.world.add(this._makePad(x, y, 0x22c55e, 'CHARGE'));
    }

    for (const zone of this.meta.dead_zones || []) {
      const [x, y, radiusCells] = zone;
      const radius = radiusCells * cell;
      // Make radio coverage a volume, not a subtle floor decal.  Judges can now see
      // exactly where connectivity degrades even when racks obscure the ground plane.
      const geometry = new THREE.CylinderGeometry(radius, radius, 1.6, 64, 1, true);
      const material = new THREE.MeshBasicMaterial({color: PALETTE.rose, transparent: true, opacity: .11,
        side: THREE.DoubleSide, depthWrite: false});
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(this._toWorld(x * cell, y * cell, .82));
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(radius * .96, radius, 64),
        new THREE.MeshBasicMaterial({color: PALETTE.rose, transparent: true, opacity: .58,
          side: THREE.DoubleSide, depthWrite: false}),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = -.79;
      mesh.add(ring);
      const upperRing = ring.clone();
      upperRing.position.y = .79;
      mesh.add(upperRing);
      const label = makeLabel('MESH DEAD ZONE', '#ff6577', true);
      label.position.set(0, 1.02, 0);
      mesh.add(label);
      this.world.add(mesh);
      this.deadZones.push(mesh);
    }

    const boundary = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(widthM + .8, .2, heightM + .8)),
      new THREE.LineBasicMaterial({color: 0x41647f, transparent: true, opacity: .8}),
    );
    boundary.position.y = .02;
    this.world.add(boundary);
  }

  _makeSortationCart() {
    const group = new THREE.Group();
    const frameMaterial = MATERIALS.blueSteel();
    const deckMaterial = new THREE.MeshStandardMaterial({color: 0x7890a3, roughness: .45, metalness: .6});
    const deck = new THREE.Mesh(new THREE.BoxGeometry(2.35, .12, .72), deckMaterial);
    deck.position.y = .48;
    deck.castShadow = true;
    group.add(deck);
    for (const x of [-1.05, 1.05]) {
      for (const z of [-.3, .3]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(.07, 1.15, .07), frameMaterial);
        post.position.set(x, .75, z);
        post.castShadow = true;
        group.add(post);
      }
    }
    const handle = new THREE.Mesh(new THREE.BoxGeometry(.08, .08, 1.05), frameMaterial);
    handle.position.set(-1.18, 1.24, 0);
    group.add(handle);
    for (const x of [-.88, .88]) {
      for (const z of [-.28, .28]) {
        const wheel = new THREE.Mesh(
          new THREE.CylinderGeometry(.13, .13, .07, 18),
          new THREE.MeshStandardMaterial({color: 0x070b0e, roughness: .85}),
        );
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(x, .18, z);
        group.add(wheel);
      }
    }
    const colours = [0xf0b429, 0x32b6df, 0x36c98f];
    colours.forEach((colour, index) => {
      const tote = new THREE.Mesh(
        new THREE.BoxGeometry(.58, .32, .52),
        new THREE.MeshStandardMaterial({color: colour, roughness: .62, metalness: .05}),
      );
      tote.position.set(-.72 + index * .72, .72, 0);
      tote.castShadow = true;
      group.add(tote);
    });
    return group;
  }

  _makeShowcaseRack(width = 4.2) {
    const group = new THREE.Group();
    const steel = MATERIALS.blueSteel();
    const shelfMaterial = MATERIALS.darkSteel();
    const height = 2.35;
    for (const x of [-width / 2, 0, width / 2]) {
      for (const z of [-.38, .38]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(.09, height, .09), steel);
        post.position.set(x, height / 2, z);
        post.castShadow = true;
        group.add(post);
      }
    }
    for (const y of [.32, 1.02, 1.72, 2.28]) {
      const shelf = new THREE.Mesh(new THREE.BoxGeometry(width, .08, .88), shelfMaterial);
      shelf.position.y = y;
      shelf.castShadow = true;
      group.add(shelf);
    }
    for (let bay = 0; bay < 2; bay++) {
      for (let level = 0; level < 3; level++) {
        const cargo = this._makeCargoAsset((bay + level) % 5, .78);
        cargo.position.set(-width * .25 + bay * width * .5, .38 + level * .7, 0);
        group.add(cargo);
      }
    }
    return group;
  }

  _makeCargoAsset(variant = 0, scale = 1) {
    const group = new THREE.Group();
    const carton = MATERIALS.carton();
    const tape = new THREE.MeshStandardMaterial({color: 0xd5b37b, roughness: .76});
    const darkInside = new THREE.MeshStandardMaterial({color: 0x382316, roughness: 1});
    const labelMaterial = new THREE.MeshStandardMaterial({color: 0xe8e2d7, roughness: .88});
    const addBox = (size, position, material = carton, rotation = [0, 0, 0]) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
      mesh.position.set(...position);
      mesh.rotation.set(...rotation);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };

    switch (Math.abs(variant) % 5) {
      case 0: { // bundled parcel: strapped and labelled like the supplied reference
        addBox([.82, .58, .7], [0, .3, 0]);
        addBox([.13, .595, .72], [0, .305, 0], tape);
        addBox([.84, .595, .12], [0, .305, 0], tape);
        addBox([.27, .012, .18], [.19, .602, -.12], labelMaterial, [-Math.PI / 2, 0, 0]);
        break;
      }
      case 1: { // crushed carton with a deterministically deformed shell
        const geometry = new THREE.BoxGeometry(.8, .55, .68, 2, 2, 2);
        const positions = geometry.getAttribute('position');
        for (let index = 0; index < positions.count; index++) {
          const x = positions.getX(index);
          const y = positions.getY(index);
          const z = positions.getZ(index);
          const dent = .62 + .2 * Math.sin(index * 2.37);
          positions.setXYZ(index,
            x * (y > 0 ? .76 + .12 * Math.cos(index) : 1),
            y > 0 ? y * dent + .035 * Math.sin(index * 4.1) : y,
            z * (y > 0 ? .8 + .1 * Math.sin(index * 1.7) : 1));
        }
        geometry.computeVertexNormals();
        const crushed = new THREE.Mesh(geometry, carton);
        crushed.position.y = .27;
        crushed.rotation.set(-.06, .08, -.04);
        crushed.castShadow = true;
        group.add(crushed);
        addBox([.18, .025, .46], [.14, .52, .02], darkInside, [-.18, .3, -.35]);
        break;
      }
      case 2: { // open carton with four outward-folding flaps and a visible cavity
        addBox([.76, .06, .66], [0, .03, 0]);
        addBox([.76, .44, .055], [0, .25, -.305]);
        addBox([.76, .44, .055], [0, .25, .305]);
        addBox([.055, .44, .56], [-.355, .25, 0]);
        addBox([.055, .44, .56], [.355, .25, 0]);
        addBox([.62, .025, .5], [0, .075, 0], darkInside);
        addBox([.7, .035, .28], [0, .52, -.43], carton, [-.52, 0, 0]);
        addBox([.7, .035, .28], [0, .52, .43], carton, [.52, 0, 0]);
        addBox([.28, .035, .54], [-.47, .52, 0], carton, [0, 0, .52]);
        addBox([.28, .035, .54], [.47, .52, 0], carton, [0, 0, -.52]);
        break;
      }
      case 3: { // three visibly separate, slightly unstable stacked cartons
        const levels = [
          [[.84, .4, .7], [0, .2, 0], [0, .02, 0]],
          [[.76, .36, .64], [.03, .58, 0], [0, -.08, .06]],
          [[.66, .32, .56], [-.02, .92, .01], [0, .12, -.1]],
        ];
        for (const [size, position, rotation] of levels) {
          addBox(size, position, carton, rotation);
          addBox([.12, size[1] + .015, size[2] + .015], position, tape, rotation);
        }
        break;
      }
      default: { // torn carton with uneven, splayed strips matching the damaged asset
        addBox([.78, .42, .66], [0, .21, 0]);
        addBox([.64, .025, .5], [0, .4, 0], darkInside);
        const strips = [
          [-.27, -.42, -.65, .24], [-.08, -.45, -.42, .19], [.12, -.43, -.58, .22],
          [.3, -.4, -.72, .17], [-.25, .42, .62, .2], [0, .45, .48, .22], [.27, .41, .7, .18],
        ];
        for (const [x, z, tilt, width] of strips) {
          addBox([width, .028, .34], [x, .49, z], carton, [z < 0 ? tilt : -tilt, 0, x * .55]);
        }
        break;
      }
    }
    group.scale.setScalar(scale);
    return group;
  }

  _makeCeilingFixture() {
    const group = new THREE.Group();
    const housing = new THREE.Mesh(
      new THREE.BoxGeometry(1.75, .09, .28),
      new THREE.MeshStandardMaterial({color: 0x344d5f, roughness: .35, metalness: .8}),
    );
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(1.52, .025, .2),
      new THREE.MeshBasicMaterial({color: 0xcff5ff}),
    );
    panel.position.y = -.055;
    group.add(housing, panel);
    return group;
  }

  _makeChargingDock(cell = 1) {
    const group = new THREE.Group();
    const steel = MATERIALS.darkSteel();
    const base = new THREE.Mesh(new THREE.BoxGeometry(cell * .78, .1, cell * .68), steel);
    base.position.y = .08;
    const tower = new THREE.Mesh(new THREE.BoxGeometry(cell * .62, .86, .16), steel);
    tower.position.set(0, .48, cell * .26);
    tower.castShadow = true;
    const screen = new THREE.Mesh(
      new THREE.BoxGeometry(cell * .28, .19, .025),
      new THREE.MeshStandardMaterial({color: 0x071019, emissive: 0x46d39a, emissiveIntensity: 1.25}),
    );
    screen.position.set(0, .58, cell * .17);
    const contactMaterial = new THREE.MeshStandardMaterial({color: 0xd9ecf5, emissive: 0x46d39a, emissiveIntensity: .48, metalness: .82});
    for (const x of [-cell * .2, cell * .2]) {
      const contact = new THREE.Mesh(new THREE.BoxGeometry(cell * .13, .035, cell * .42), contactMaterial);
      contact.position.set(x, .15, -.1);
      group.add(contact);
    }
    group.add(base, tower, screen);
    return group;
  }

  _makeConveyor(cell = 1) {
    const group = new THREE.Group();
    const frame = MATERIALS.blueSteel();
    const rail = new THREE.Mesh(new THREE.BoxGeometry(cell * .82, .12, cell * .58), frame);
    rail.position.y = .48;
    group.add(rail);
    const rollerMaterial = new THREE.MeshStandardMaterial({color: 0x8ba4b6, roughness: .28, metalness: .86});
    for (let x = -cell * .34; x <= cell * .34; x += cell * .14) {
      const roller = new THREE.Mesh(new THREE.CylinderGeometry(cell * .055, cell * .055, cell * .5, 14), rollerMaterial);
      roller.rotation.x = Math.PI / 2;
      roller.position.set(x, .57, 0);
      group.add(roller);
    }
    for (const x of [-cell * .34, cell * .34]) {
      for (const z of [-cell * .22, cell * .22]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(.055, .46, .055), frame);
        leg.position.set(x, .24, z);
        group.add(leg);
      }
    }
    return group;
  }

  _makePickStation(cell = 1) {
    const group = new THREE.Group();
    group.add(this._makeConveyor(cell));
    const back = new THREE.Mesh(
      new THREE.BoxGeometry(cell * .8, .92, .1),
      MATERIALS.darkSteel(),
    );
    back.position.set(0, .92, cell * .28);
    back.castShadow = true;
    const display = new THREE.Mesh(
      new THREE.BoxGeometry(cell * .34, .23, .025),
      new THREE.MeshStandardMaterial({color: 0x071019, emissive: 0x35c6f4, emissiveIntensity: .82}),
    );
    display.position.set(0, 1.02, cell * .22);
    const bin = new THREE.Mesh(
      new THREE.BoxGeometry(cell * .32, .25, cell * .38),
      new THREE.MeshStandardMaterial({color: 0x2aa6d5, roughness: .62}),
    );
    bin.position.set(-cell * .2, .78, 0);
    group.add(back, display, bin);
    return group;
  }

  _makePallet(loaded = false) {
    const group = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({color: 0x8c5b2f, roughness: .94});
    for (const z of [-.3, 0, .3]) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(1.1, .09, .18), wood);
      slat.position.set(0, .08, z);
      slat.castShadow = true;
      group.add(slat);
    }
    for (const x of [-.42, 0, .42]) {
      const runner = new THREE.Mesh(new THREE.BoxGeometry(.16, .1, .78), wood);
      runner.position.set(x, .16, 0);
      group.add(runner);
    }
    if (loaded) {
      for (const [x, z, variant] of [[-.27, -.18, 0], [.27, -.18, 1], [-.27, .2, 3], [.27, .2, 4]]) {
        const cargo = this._makeCargoAsset(variant, .62);
        cargo.position.set(x, .23, z);
        group.add(cargo);
      }
    }
    return group;
  }

  _makeSafetyBarrier(width = 2.4) {
    const group = new THREE.Group();
    const steel = MATERIALS.darkSteel();
    for (const x of [-width / 2, width / 2]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(.1, 1.05, .1), steel);
      post.position.set(x, .52, 0);
      group.add(post);
    }
    for (const y of [.42, .82]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(width, .14, .09),
        new THREE.MeshStandardMaterial({color: 0xf2b72f, roughness: .55, metalness: .38}),
      );
      rail.position.y = y;
      group.add(rail);
    }
    return group;
  }

  _makeBollardCluster() {
    const group = new THREE.Group();
    for (const x of [-.42, 0, .42]) {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(.1, .12, .82, 18),
        new THREE.MeshStandardMaterial({color: 0xf5b843, roughness: .5, metalness: .4}),
      );
      post.position.set(x, .41, 0);
      post.castShadow = true;
      group.add(post);
    }
    return group;
  }

  _makeWarningCone() {
    const group = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(.42, .05, .42),
      new THREE.MeshStandardMaterial({color: 0x1d2730, roughness: .78}),
    );
    base.position.y = .025;
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(.16, .54, 24),
      new THREE.MeshStandardMaterial({color: 0xf97316, roughness: .54}),
    );
    cone.position.y = .32;
    const stripe = new THREE.Mesh(
      new THREE.CylinderGeometry(.11, .135, .08, 24),
      new THREE.MeshBasicMaterial({color: 0xf8fafc}),
    );
    stripe.position.y = .3;
    group.add(base, cone, stripe);
    return group;
  }

  _makeFireCabinet() {
    const group = new THREE.Group();
    const cabinet = new THREE.Mesh(
      new THREE.BoxGeometry(.62, .82, .16),
      new THREE.MeshStandardMaterial({color: 0xb91c1c, roughness: .5, metalness: .35}),
    );
    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(.4, .5, .018),
      new THREE.MeshBasicMaterial({color: 0xffb4b4, transparent: true, opacity: .42}),
    );
    glass.position.z = .09;
    group.add(cabinet, glass);
    return group;
  }

  _makeWarningSign() {
    const group = new THREE.Group();
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(1.08, .72, .055),
      new THREE.MeshStandardMaterial({color: 0xf5b843, roughness: .52, metalness: .25}),
    );
    const icon = new THREE.Mesh(
      new THREE.ConeGeometry(.22, .42, 3),
      new THREE.MeshBasicMaterial({color: 0x101820}),
    );
    icon.rotation.z = Math.PI;
    icon.position.set(0, 0, .04);
    group.add(plate, icon);
    return group;
  }

  _makeSecurityCamera() {
    const group = new THREE.Group();
    const mount = new THREE.Mesh(new THREE.BoxGeometry(.08, .42, .08), MATERIALS.darkSteel());
    mount.position.y = -.18;
    const body = new THREE.Mesh(new THREE.BoxGeometry(.38, .2, .2), MATERIALS.blueSteel());
    body.position.set(0, -.42, .12);
    body.rotation.x = -.24;
    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(.065, .065, .05, 18),
      new THREE.MeshBasicMaterial({color: 0x35c6f4}),
    );
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0, -.44, .24);
    group.add(mount, body, lens);
    return group;
  }

  _makeControlTerminal() {
    const group = new THREE.Group();
    const stand = new THREE.Mesh(new THREE.BoxGeometry(.18, 1.12, .18), MATERIALS.darkSteel());
    stand.position.y = .56;
    const consoleBody = new THREE.Mesh(new THREE.BoxGeometry(.72, .52, .28), MATERIALS.blueSteel());
    consoleBody.position.y = 1.12;
    consoleBody.rotation.x = -.16;
    const screen = new THREE.Mesh(
      new THREE.BoxGeometry(.52, .31, .025),
      new THREE.MeshStandardMaterial({color: 0x071019, emissive: 0x35c6f4, emissiveIntensity: 1.1}),
    );
    screen.position.set(0, 1.16, .15);
    screen.rotation.x = -.16;
    group.add(stand, consoleBody, screen);
    return group;
  }

  _makePad(x, y, colour, labelText) {
    const cell = this.meta.cell_m;
    const group = new THREE.Group();
    group.position.copy(this._cellToWorld(x, y, .02));
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(cell * .42, cell * .42, .08, 32),
      new THREE.MeshStandardMaterial({color: colour, emissive: colour, emissiveIntensity: .28,
        roughness: .45, metalness: .35}),
    );
    pad.receiveShadow = true;
    group.add(pad);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(cell * .35, .025, 8, 40),
      new THREE.MeshBasicMaterial({color: 0xffffff, transparent: true, opacity: .72}),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = .07;
    group.add(ring);
    const label = makeLabel(labelText, hexCss(colour), true);
    label.position.y = 1.15;
    label.scale.multiplyScalar(.58);
    group.add(label);
    const equipment = labelText === 'CHARGE'
      ? this._makeChargingDock(cell)
      : this._makePickStation(cell);
    equipment.scale.setScalar(.74);
    equipment.position.y = .08;
    group.add(equipment);
    return group;
  }

  _buildTasks() {
    const catalog = this.meta.tasks_catalog || [];
    const colours = {normal: 0x5caeff, fragile: 0xc084fc, heavy: 0xf59e0b, hazardous: 0xfb7185};
    for (const task of catalog) {
      const colour = colours[task.cargo_type] || PALETTE.cyan;
      const marker = new THREE.Group();
      marker.position.copy(this._cellToWorld(task.pick[0], task.pick[1], .12));
      const variant = {normal: 0, heavy: 3, fragile: 2, hazardous: 4}[task.cargo_type] || 0;
      const cargo = this._makeCargoAsset(variant, .78);
      cargo.traverse(child => {
        if (child.isMesh) child.material = child.material.clone();
      });
      cargo.position.y = .05;
      marker.add(cargo);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(.42, .49, 32),
        new THREE.MeshBasicMaterial({color: colour, transparent: true, opacity: .75,
          side: THREE.DoubleSide, depthWrite: false}),
      );
      ring.rotation.x = -Math.PI / 2;
      marker.add(ring);
      marker.userData.taskMarker = true;
      this.world.add(marker);
    }
  }

  _ensureRobot(id) {
    if (this.robots.has(id)) return this.robots.get(id);
    const index = Math.max(0, (parseInt(id.replace(/\D/g, ''), 10) || 1) - 1);
    const colour = ROBOT_COLOURS[index % ROBOT_COLOURS.length];
    const group = new THREE.Group();
    group.userData.robotId = id;
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(.48, .5, .24, 32),
      new THREE.MeshStandardMaterial({color: colour, roughness: .25, metalness: .64}),
    );
    base.position.y = .22;
    base.castShadow = true;
    base.userData.robotId = id;
    group.add(base);
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(.68, .22, .66),
      new THREE.MeshStandardMaterial({color: 0x10202c, roughness: .28, metalness: .68}),
    );
    top.position.y = .43;
    top.castShadow = true;
    top.userData.robotId = id;
    group.add(top);
    const wheelMaterial = new THREE.MeshStandardMaterial({color: 0x05090d, roughness: .76, metalness: .28});
    const wheels = [];
    for (const [x, z] of [[-.43, -.25], [.43, -.25], [-.43, .25], [.43, .25]]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(.105, .105, .09, 18), wheelMaterial);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, .16, z);
      wheel.castShadow = true;
      wheel.userData.robotId = id;
      wheels.push(wheel);
      group.add(wheel);
    }
    const bumper = new THREE.Mesh(
      new THREE.BoxGeometry(.66, .13, .08),
      new THREE.MeshStandardMaterial({color: 0x182d3b, roughness: .5, metalness: .54}),
    );
    bumper.position.set(0, .24, -.49);
    bumper.userData.robotId = id;
    group.add(bumper);
    const sensor = new THREE.Mesh(
      new THREE.BoxGeometry(.48, .08, .09),
      new THREE.MeshStandardMaterial({color: 0x081019, emissive: colour, emissiveIntensity: .95}),
    );
    sensor.position.set(0, .47, -.36);
    sensor.userData.robotId = id;
    group.add(sensor);
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(.035, .045, .19, 16),
      new THREE.MeshStandardMaterial({color: 0x7d91a1, roughness: .3, metalness: .78}),
    );
    mast.position.set(0, .62, .08);
    const lidar = new THREE.Mesh(
      new THREE.CylinderGeometry(.13, .13, .085, 24),
      new THREE.MeshStandardMaterial({color: 0x071019, emissive: colour, emissiveIntensity: .38,
        roughness: .18, metalness: .64}),
    );
    lidar.position.set(0, .75, .08);
    lidar.userData.robotId = id;
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(.055, 16, 10),
      new THREE.MeshBasicMaterial({color: PALETTE.green}),
    );
    beacon.position.set(.24, .6, .15);
    group.add(mast, lidar, beacon);
    // Forklift-style lift and forks reproduce the generated AMR silhouette while the
    // compact base keeps the simulation footprint unchanged.
    const liftMaterial = MATERIALS.darkSteel();
    for (const x of [-.2, .2]) {
      const liftRail = new THREE.Mesh(new THREE.BoxGeometry(.055, .82, .055), liftMaterial);
      liftRail.position.set(x, .72, -.35);
      liftRail.userData.robotId = id;
      group.add(liftRail);
      const fork = new THREE.Mesh(new THREE.BoxGeometry(.07, .045, .62), liftMaterial);
      fork.position.set(x, .18, -.68);
      fork.userData.robotId = id;
      group.add(fork);
    }
    const carriage = new THREE.Mesh(new THREE.BoxGeometry(.5, .08, .08), liftMaterial);
    carriage.position.set(0, .42, -.37);
    carriage.userData.robotId = id;
    group.add(carriage);
    const deckRailMaterial = new THREE.MeshStandardMaterial({color: 0x8da2b5, roughness: .34, metalness: .78});
    for (const x of [-.32, .32]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(.035, .07, .56), deckRailMaterial);
      rail.position.set(x, .57, .02);
      group.add(rail);
    }
    // All five supplied cargo concepts are real meshes on every AMR. Telemetry selects
    // the matching payload only while the robot is travelling from pick to drop.
    const payloads = [];
    for (let variant = 0; variant < 5; variant++) {
      const payload = this._makeCargoAsset(variant, .42);
      payload.position.set(0, .6, .02);
      payload.visible = false;
      payload.traverse(child => { child.userData.robotId = id; });
      payloads.push(payload);
      group.add(payload);
    }
    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(.13, .35, 3),
      new THREE.MeshBasicMaterial({color: 0xffffff}),
    );
    arrow.rotation.x = -Math.PI / 2;
    arrow.position.set(0, .58, -.18);
    group.add(arrow);
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(.58, .68, 48),
      new THREE.MeshBasicMaterial({color: colour, transparent: true, opacity: .65,
        side: THREE.DoubleSide, depthWrite: false}),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = .035;
    group.add(halo);
    const selection = new THREE.Mesh(
      new THREE.RingGeometry(.76, .80, 48),
      new THREE.MeshBasicMaterial({color: 0xffffff, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthWrite: false}),
    );
    selection.rotation.x = -Math.PI / 2;
    selection.position.y = .045;
    group.add(selection);
    const label = makeLabel(id, hexCss(colour), true);
    label.position.y = 1.34;
    label.scale.multiplyScalar(.84);
    group.add(label);
    group.userData = {robotId: id, colour, halo, selection, label, beacon, wheels, payloads};
    this.dynamic.add(group);
    this.robots.set(id, group);
    return group;
  }

  _ensureHuman(id) {
    if (this.humans.has(id)) return this.humans.get(id);
    const group = new THREE.Group();
    const uniform = new THREE.MeshStandardMaterial({color: 0x24384a, roughness: .78});
    const vestMaterial = new THREE.MeshStandardMaterial({color: 0xf5b843, roughness: .64});
    const skin = new THREE.MeshStandardMaterial({color: 0xd9a276, roughness: .82});
    const limbs = [];
    for (const x of [-.1, .1]) {
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(.075, .47, 5, 10), uniform);
      leg.position.set(x, .34, 0);
      leg.castShadow = true;
      limbs.push(leg);
      group.add(leg);
    }
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(.2, .47, 6, 14), vestMaterial);
    body.position.y = .97;
    body.castShadow = true;
    for (const x of [-.27, .27]) {
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(.055, .39, 5, 9), uniform);
      arm.position.set(x, .96, 0);
      arm.rotation.z = x < 0 ? -.12 : .12;
      arm.castShadow = true;
      limbs.push(arm);
      group.add(arm);
    }
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(.2, 20, 14),
      skin,
    );
    head.position.y = 1.48;
    head.castShadow = true;
    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(.215, 20, 10, 0, Math.PI * 2, 0, Math.PI * .58),
      new THREE.MeshStandardMaterial({color: 0xf2cf45, roughness: .48}),
    );
    helmet.position.y = 1.56;
    const stripe = new THREE.Mesh(
      new THREE.TorusGeometry(.215, .026, 8, 28),
      new THREE.MeshBasicMaterial({color: 0xf8ffb5}),
    );
    stripe.rotation.x = Math.PI / 2;
    stripe.position.y = 1.02;
    const pauseRing = new THREE.Mesh(
      new THREE.RingGeometry(.42, .5, 36),
      new THREE.MeshBasicMaterial({color: PALETTE.amber, transparent: true, opacity: .72,
        side: THREE.DoubleSide, depthWrite: false}),
    );
    pauseRing.rotation.x = -Math.PI / 2;
    pauseRing.position.y = .025;
    pauseRing.visible = false;
    group.add(body, head, helmet, stripe, pauseRing);
    const label = makeLabel(`${id} · WORKER`, '#f5b843', true);
    label.position.y = 2.08;
    label.scale.multiplyScalar(.72);
    group.add(label);
    group.userData = {limbs, pauseRing};
    this.dynamic.add(group);
    this.humans.set(id, group);
    return group;
  }

  _ensureObstacle(id) {
    if (this.obstacles.has(id)) return this.obstacles.get(id);
    const group = new THREE.Group();
    const pallet = this._makePallet(true);
    pallet.rotation.z = -.09;
    pallet.rotation.y = .18;
    group.add(pallet);
    const warning = new THREE.Mesh(
      new THREE.RingGeometry(.56, .65, 36),
      new THREE.MeshBasicMaterial({color: PALETTE.rose, transparent: true, opacity: .8,
        side: THREE.DoubleSide, depthWrite: false}),
    );
    warning.rotation.x = -Math.PI / 2;
    warning.position.y = .025;
    group.add(warning);
    const label = makeLabel('BLOCKED AISLE', '#ff6577', true);
    label.position.y = 1.25;
    label.scale.multiplyScalar(.72);
    group.add(label);
    group.userData.warning = warning;
    this.dynamic.add(group);
    this.obstacles.set(id, group);
    return group;
  }

  update(frame, selectedId, cameraMode, simTime) {
    if (!this.map || !frame) return;
    this.selectedId = selectedId || null;
    if (cameraMode !== this.cameraMode) this.setCameraMode(cameraMode);
    const fleetById = new Map((frame.fleet || []).map(item => [item.id, item]));
    for (const robot of frame.robots || []) {
      const group = this._ensureRobot(robot.id);
      group.position.copy(this._toWorld(robot.x, robot.y, 0));
      group.rotation.y = -robot.th - Math.PI / 2;
      const info = fleetById.get(robot.id) || {};
      const stateColour = info.failed ? PALETTE.rose
        : info.state === 'charging' ? PALETTE.green
        : info.state === 'blocked' ? PALETTE.rose
        : info.state === 'retreat' ? PALETTE.amber
        : group.userData.colour;
      group.userData.halo.material.color.setHex(stateColour);
      group.userData.halo.material.opacity = .48 + .24 * (1 + Math.sin(simTime * 4)) / 2;
      group.userData.selection.material.opacity = robot.id === this.selectedId ? .95 : 0;
      group.userData.selection.rotation.z = simTime * 1.4;
      group.userData.beacon.material.color.setHex(stateColour);
      group.userData.beacon.scale.setScalar(.82 + .25 * (1 + Math.sin(simTime * 5)) / 2);
      for (const wheel of group.userData.wheels) wheel.rotation.x = -simTime * 4;
      const payloadVariant = {normal: 0, heavy: 3, fragile: 2, hazardous: 4}[info.cargo_type] ?? 1;
      group.userData.payloads.forEach((payload, index) => {
        payload.visible = Boolean(info.carry) && index === payloadVariant;
      });
      group.visible = true;
    }
    for (const human of frame.humans || []) {
      const group = this._ensureHuman(human.id);
      group.position.copy(this._toWorld(human.x, human.y, 0));
      group.rotation.y = -human.th - Math.PI / 2;
      const stride = human.paused ? 0 : Math.sin(simTime * 7 + Number(human.id.replace(/\D/g, '') || 0)) * .32;
      group.userData.limbs.forEach((limb, index) => {
        limb.rotation.x = index % 2 ? -stride : stride;
      });
      group.userData.pauseRing.visible = Boolean(human.paused);
      group.userData.pauseRing.rotation.z = simTime * 1.5;
    }
    const activeObstacles = new Set();
    for (const obstacle of frame.obstacles || []) {
      const group = this._ensureObstacle(obstacle.id);
      group.position.copy(this._toWorld(obstacle.x, obstacle.y, 0));
      group.userData.warning.rotation.z = simTime * 1.1;
      group.visible = true;
      activeObstacles.add(obstacle.id);
    }
    for (const [id, group] of this.obstacles) {
      if (!activeObstacles.has(id)) group.visible = false;
    }
    for (const zone of this.deadZones) {
      zone.material.opacity = .08 + .045 * (1 + Math.sin(simTime * 1.8)) / 2;
    }
    if (simTime - this.lastRouteRefresh > .09 || simTime < this.lastRouteRefresh) {
      this._refreshRoutes(frame);
      this.lastRouteRefresh = simTime;
    }
    this._updateCamera(frame, simTime);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  _refreshRoutes(frame) {
    disposeObject(this.routes);
    this.scene.remove(this.routes);
    this.routes = new THREE.Group();
    this.scene.add(this.routes);
    const posById = new Map((frame.robots || []).map(robot => [robot.id, robot]));
    const drawn = new Set();
    for (const info of frame.fleet || []) {
      const robot = posById.get(info.id);
      if (!robot) continue;
      const group = this.robots.get(info.id);
      const colour = group ? group.userData.colour : PALETTE.cyan;
      const points = [this._toWorld(robot.x, robot.y, .08),
        ...(info.path || []).map(([x, y]) => this._cellToWorld(x, y, .08))];
      if (points.length > 1) {
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineBasicMaterial({color: colour, transparent: true, opacity: .82}),
        );
        this.routes.add(line);
        for (const [x, y] of (info.path || []).slice(0, 5)) {
          const lease = new THREE.Mesh(
            new THREE.BoxGeometry(this.meta.cell_m * .68, .035, this.meta.cell_m * .68),
            new THREE.MeshBasicMaterial({color: colour, transparent: true, opacity: .14,
              depthWrite: false}),
          );
          lease.position.copy(this._cellToWorld(x, y, .035));
          this.routes.add(lease);
        }
      }
      for (const peerId of info.peers || []) {
        const key = info.id < peerId ? `${info.id}|${peerId}` : `${peerId}|${info.id}`;
        if (drawn.has(key)) continue;
        drawn.add(key);
        const peer = posById.get(peerId);
        if (!peer) continue;
        const link = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            this._toWorld(robot.x, robot.y, .72),
            this._toWorld(peer.x, peer.y, .72),
          ]),
          new THREE.LineDashedMaterial({color: PALETTE.cyan, transparent: true,
            opacity: .22, dashSize: .25, gapSize: .18}),
        );
        link.computeLineDistances();
        this.routes.add(link);
      }
    }
  }

  _updateCamera(frame, simTime) {
    const selected = (frame.robots || []).find(robot => robot.id === this.selectedId)
      || (frame.robots || [])[0];
    if (!selected || this.cameraMode === 'overview' || this.cameraMode === 'tactical') return;
    const target = this._toWorld(selected.x, selected.y, .42);
    const forward = new THREE.Vector3(Math.cos(selected.th), 0, -Math.sin(selected.th));
    let desired;
    if (this.cameraMode === 'pov') {
      desired = target.clone().addScaledVector(forward, .55);
      desired.y = .82;
      this.camera.position.lerp(desired, .18);
      this.camera.lookAt(target.clone().addScaledVector(forward, 7).setY(.7));
    } else {
      desired = target.clone().addScaledVector(forward, -5.5);
      desired.y = 3.7;
      this.camera.position.lerp(desired, .085);
      const look = target.clone().addScaledVector(forward, 1.25);
      this.camera.lookAt(look);
    }
  }

  _selectAt(event) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([...this.robots.values()], true);
    const hit = hits.find(item => {
      let node = item.object;
      while (node && !node.userData.robotId) node = node.parent;
      return Boolean(node && node.userData.robotId);
    });
    if (!hit) return;
    let node = hit.object;
    while (node && !node.userData.robotId) node = node.parent;
    if (node && node.userData.robotId && this.onSelect) this.onSelect(node.userData.robotId);
  }
}
