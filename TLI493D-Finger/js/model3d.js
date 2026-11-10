// TLI493D Finger – 3D stage: board, silicone dome, magnets and field vectors.
// Loaded by app.js through import(); without WebGL the page keeps its drawing.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Camera around the dome: from the tip side, above the board, which runs off to the back.
const HOME = { azimuth: Math.PI - 0.62, polar: 0.95 };
const POLAR_LIMITS = [0.12, 2.6];
const RETURN_DELAY = 2200;
const RETURN_EASE = 0.055;
const FIT_MARGIN = 1.0;
// Idle sway up and down around the home view, so the view reads as a 3D model.
const SWAY_AMPLITUDE = THREE.MathUtils.degToRad(5);   // ±5° = 10° from top to bottom
const SWAY_FREQUENCY = 0.1;                           // Hz
const SWAY = !matchMedia('(prefers-reduced-motion: reduce)').matches;
// The framed region in model metres: the dome and the board right behind it.
const FRAME_BOX = new THREE.Box3(new THREE.Vector3(-0.0092, -0.0015, -0.0086), new THREE.Vector3(0.0092, 0.0104, 0.0130));

const MAGNET_EASE = 0.35;
const SHAFT_RADIUS = 0.0002;
const HEAD_RADIUS = 0.00056;
const HEAD_LENGTH = 0.0013;
const UP = new THREE.Vector3(0, 1, 0);

// Force pair: one pair of arrows for the stronger of two loads on the silicone.
// - Load (press and push): along the mean movement of the most deformed part of the
//   dome surface (SoftDome.loadPoint) – vertical for a press, horizontal for a push
//   along the board, tilted in between. From above onto the surface, the
//   counter-force from below onto the underside.
// - Squeeze from two sides: horizontally onto the two flanks of the dome, along the
//   axis on which the magnets move together (#squeeze).
// Both loads are displacements in metres on the scale of the magnet lift, so they
// can be compared and share the thresholds below.
const FORCE_COLOR = 0xeaf6f4;
const FORCE_ON = 0.0005;           // load above the resting level before the pair appears (m)
const FORCE_OFF = 0.00024;         // below this the pair is always hidden (m)
const FORCE_RELEASE = 0.4;         // hidden once the field change falls below this share of the peak
const FORCE_STILL_SHARE = 0.6;     // … or below this share and still for FORCE_STILL_TIME
const FORCE_STILL_TIME = 1.5;      // s
const FORCE_STILL_TOL = 0.06;      // change of the load, as share of the peak, that still counts as still
const FORCE_FLOOR_TAU = 10;        // resting level follows a slow drift upwards (s)
const FORCE_SWITCH = 1.25;         // the other load must be this much stronger to take over the pair
const FORCE_LENGTH_GAIN = 3.6;     // arrow length per metre of load
const FORCE_LENGTH_MIN = 0.0015;   // shortest arrow that is still drawn (m)
const FORCE_MAX = 0.01;            // longest arrow (m)
const LOAD_REGION = 0.5;           // share of the strongest movement that still counts as the load
const PRESS_GRID_STEP = 0.00025;   // sampling of the sensor area for the load point (m)
const PRESS_GRID_HALF = 0.008;     // half width of that area around the sensor centre (m)
const FORCE_GAP = 0.0003;          // between arrow tip and surface (m)
const FORCE_SHAFT = 0.00035;
const FORCE_HEAD_RADIUS = 0.0009;
const FORCE_HEAD_LENGTH = 0.0018;

export class FingerModel {
  // lateralScale: magnet travel sideways per unit of field change, relative to the
  // travel up and down (see app.js). Makes a squeeze comparable with a press.
  constructor(canvas, { parts, colors, lateralScale = 1 }) {
    this.canvas = canvas;
    this.parts = parts;
    this.colors = colors;
    this.lateralScale = lateralScale;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.001, 2);
    this.target = FRAME_BOX.getCenter(new THREE.Vector3());
    this.radius = FRAME_BOX.getBoundingSphere(new THREE.Sphere()).radius;
    this.distance = 0.1;

    this.azimuth = HOME.azimuth;
    this.polar = HOME.polar;
    this.lastInput = -Infinity;
    this.visible = true;
    this.pending = false;

    this.root = null;
    this.silicone = null;
    this.soft = null;
    this.forces = null;
    this.arrows = [];
    this.magnets = [];

    this.#setupStage();
    this.#setupInput();

    this.resizeObserver = new ResizeObserver(() => this.#resize());
    this.resizeObserver.observe(canvas);
    this.intersectionObserver = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      if (this.visible) this.#invalidate();
    });
    this.intersectionObserver.observe(canvas);
    document.addEventListener('visibilitychange', () => this.#invalidate());
    this.#resize();
  }

  // ─── Public ─────────────────────────────────────

  async load(url) {
    const gltf = await new GLTFLoader().loadAsync(url);
    this.root = gltf.scene;
    this.scene.add(this.root);
    this.root.updateMatrixWorld(true);

    // The dome is drawn see-through so that sensors, magnets and arrows stay visible.
    const siliconeNode = this.root.getObjectByName('Silicone');
    if (!siliconeNode) throw new Error('Model has no "Silicone" node');
    const silicone = new THREE.MeshPhysicalMaterial({
      color: 0xdbe7e3, roughness: 0.3, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.3,
      transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide,
    });

    let baseY = Infinity;
    const centres = [];
    for (const [i, name] of this.parts.entries()) {
      const sensor = this.root.getObjectByName(name);
      if (!sensor) throw new Error(`Model has no sensor "${name}"`);
      const box = new THREE.Box3().setFromObject(sensor);
      baseY = Math.min(baseY, box.min.y);
      const origin = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
      const arrow = this.#makeArrow(this.colors[i]);
      arrow.group.position.copy(this.root.worldToLocal(origin.clone()));
      this.root.add(arrow.group);
      this.arrows.push(arrow);

      const magnet = this.root.getObjectByName(`Magnet_${name.slice(-1)}`);
      if (!magnet) throw new Error(`Model has no magnet above "${name}"`);
      magnet.traverse(o => { if (o.isMesh) o.material = makePoleMaterial(o.geometry); });
      const centre = this.root.worldToLocal(new THREE.Box3().setFromObject(magnet).getCenter(new THREE.Vector3()));
      centres.push(centre);
      this.magnets.push({ node: magnet, home: magnet.position.clone(), now: new THREE.Vector3(), want: new THREE.Vector3(), shift: new THREE.Vector3() });
    }

    // The silicone follows the magnets (see SoftDome below).
    this.soft = new SoftDome(this.root, siliconeNode, silicone, centres, this.root.worldToLocal(new THREE.Vector3(0, baseY, 0)).y);
    this.silicone = this.soft.group;

    this.forces = {
      enabled: true,
      dirty: true,
      mode: null,
      gates: { load: newGate(), squeeze: newGate() },
      top: this.#makeArrow(FORCE_COLOR, 0.2),
      bottom: this.#makeArrow(FORCE_COLOR, 0.2),
      ray: new THREE.Raycaster(),
    };
    this.root.add(this.forces.top.group, this.forces.bottom.group);
    this.#invalidate();
  }

  setSilicone(mode) {
    if (!this.silicone) return;
    this.silicone.visible = mode !== 'hidden';
    this.#refreshSoft();
  }

  // Off: the dome stays at rest and untinted; the magnets keep moving.
  setDeformation(on) {
    if (!this.soft) return;
    this.soft.enabled = on;
    this.#refreshSoft();
  }

  // Contour lines on the silicone, one per CONTOUR_STEP of displacement.
  setContours(on) {
    if (!this.soft) return;
    this.soft.contours.value = on ? 1 : 0;
    this.#invalidate();
  }

  #refreshSoft() {
    if (this.soft) this.soft.update(this.magnets.map(m => m.now));
    if (this.forces) this.forces.dirty = true;
    this.#invalidate();
  }

  setForces(on) {
    if (!this.forces) return;
    this.forces.enabled = on;
    this.forces.dirty = true;
    this.#invalidate();
  }

  // One entry per sensor: { dir: [x, y, z] unit vector in the model, length: metres } or null.
  setVectors(list) {
    list.forEach((v, i) => {
      const arrow = this.arrows[i];
      if (!arrow) return;
      if (!v || !(v.length > 0)) { arrow.group.visible = false; return; }
      shapeArrow(arrow, v.length, SHAFT_RADIUS, HEAD_RADIUS, HEAD_LENGTH);
      arrow.group.quaternion.setFromUnitVectors(UP, arrow.dir.set(...v.dir).normalize());
      arrow.group.visible = true;
    });
    this.#invalidate();
  }

  // One entry per sensor: [dx, dy, dz] in metres from the resting place, or null for rest.
  setMagnetOffsets(list) {
    list.forEach((offset, i) => {
      const magnet = this.magnets[i];
      if (!magnet) return;
      if (offset) magnet.want.set(...offset); else magnet.want.set(0, 0, 0);
    });
    this.#invalidate();
  }

  reset() {
    for (const arrow of this.arrows) arrow.group.visible = false;
    for (const magnet of this.magnets) if (magnet) magnet.want.set(0, 0, 0);
    if (this.forces) {
      this.forces.gates = { load: newGate(), squeeze: newGate() };
      this.forces.mode = null;
      this.forces.dirty = true;
    }
    this.#invalidate();
  }

  // ─── Setup ──────────────────────────────────────

  #setupStage() {
    const generator = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = generator.fromScene(new RoomEnvironment(), 0.04).texture;
    generator.dispose();
    if ('environmentIntensity' in this.scene) this.scene.environmentIntensity = 0.5;

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(0.3, 0.5, -0.35);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfe6ea, 0.75);
    rim.position.set(-0.35, 0.2, 0.3);
    this.scene.add(rim);
  }

  #makeArrow(color, glow = 0.45) {
    const material = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: glow, roughness: 0.45, metalness: 0.05,
    });
    const shaftGeometry = new THREE.CylinderGeometry(1, 1, 1, 18);
    shaftGeometry.translate(0, 0.5, 0);
    const headGeometry = new THREE.ConeGeometry(1, 1, 24);
    headGeometry.translate(0, 0.5, 0);
    const shaft = new THREE.Mesh(shaftGeometry, material);
    const head = new THREE.Mesh(headGeometry, material);
    const group = new THREE.Group();
    group.add(shaft, head);
    group.visible = false;
    return { group, shaft, head, dir: new THREE.Vector3() };
  }

  #setupInput() {
    const pointers = new Set();
    let last = null;
    this.canvas.addEventListener('pointerdown', event => {
      pointers.add(event.pointerId);
      last = event;
      this.canvas.setPointerCapture(event.pointerId);
      this.lastInput = Infinity;
    });
    this.canvas.addEventListener('pointermove', event => {
      if (!pointers.has(event.pointerId) || !last) return;
      this.azimuth -= (event.clientX - last.clientX) * 0.008;
      this.polar = clamp(this.polar - (event.clientY - last.clientY) * 0.008, ...POLAR_LIMITS);
      last = event;
      this.#invalidate();
    });
    const release = event => {
      pointers.delete(event.pointerId);
      last = null;
      this.lastInput = performance.now();
      clearTimeout(this.returnTimer);
      this.returnTimer = setTimeout(() => this.#invalidate(), RETURN_DELAY + 20);
    };
    this.canvas.addEventListener('pointerup', release);
    this.canvas.addEventListener('pointercancel', release);
  }

  // ─── Frame loop ─────────────────────────────────

  #resize() {
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    // Fit the framed sphere into the narrower of the two field angles.
    const vertical = THREE.MathUtils.degToRad(this.camera.fov);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * this.camera.aspect);
    this.distance = this.radius / Math.sin(Math.min(vertical, horizontal) / 2) * FIT_MARGIN;
    this.camera.near = this.distance / 50;
    this.camera.far = this.distance * 20;
    this.camera.updateProjectionMatrix();
    this.#invalidate();
  }

  #invalidate() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.#frame(); });
  }

  #frame() {
    if (!this.visible || document.hidden) return;
    let moving = false;

    // Back to the (swaying) home view a while after the last drag.
    const now = performance.now();
    if (now - this.lastInput > RETURN_DELAY) {
      const sway = SWAY ? SWAY_AMPLITUDE * Math.sin(2 * Math.PI * SWAY_FREQUENCY * now / 1000) : 0;
      const da = shortestAngle(this.azimuth, HOME.azimuth), dp = HOME.polar + sway - this.polar;
      if (Math.abs(da) > 1e-3 || Math.abs(dp) > 1e-3) {
        this.azimuth += da * RETURN_EASE;
        this.polar += dp * RETURN_EASE;
        moving = true;
      }
      if (SWAY) moving = true;
    }

    let shifted = false;
    for (const magnet of this.magnets) {
      const gap = magnet.want.clone().sub(magnet.now);
      if (gap.lengthSq() > 1e-12) {
        magnet.now.addScaledVector(gap, MAGNET_EASE);
        moving = true;
        shifted = true;
      } else if (!magnet.now.equals(magnet.want)) {
        magnet.now.copy(magnet.want);
        shifted = true;
      }
    }
    // Dome and magnets take their places from the same displacement field.
    if ((shifted || this.soft?.stale) && this.soft) {
      this.soft.update(this.magnets.map(m => m.now));
      for (const [i, magnet] of this.magnets.entries()) {
        this.soft.displacementAt(this.soft.centres[i], magnet.shift);
        magnet.node.position.copy(magnet.home).add(magnet.shift);
      }
    }
    if (this.forces && (shifted || this.forces.dirty)) this.#updateForces();

    const s = Math.sin(this.polar);
    this.camera.position.set(
      this.target.x + this.distance * s * Math.sin(this.azimuth),
      this.target.y + this.distance * Math.cos(this.polar),
      this.target.z + this.distance * s * Math.cos(this.azimuth));
    this.camera.lookAt(this.target);
    this.renderer.render(this.scene, this.camera);

    if (moving) this.#invalidate();
  }

  // One pair for the stronger load. Each load has its own gate (adaptive threshold);
  // if both are on, the pair stays with its current load until the other one is
  // clearly stronger, so it does not flicker between the two.
  #updateForces() {
    const f = this.forces;
    f.dirty = false;
    const now = performance.now();
    const load = f.enabled ? this.soft.loadPoint(this.lateralScale) : null;
    const squeeze = f.enabled ? this.#squeeze() : null;
    const loads = { load: load ? load.depth : 0, squeeze: squeeze ? squeeze.load : 0 };
    const on = {
      load: passGate(f.gates.load, loads.load, now),
      squeeze: passGate(f.gates.squeeze, loads.squeeze, now),
    };

    let mode = f.mode && on[f.mode] ? f.mode : null;
    const other = mode === 'load' ? 'squeeze' : 'load';
    if (!mode) mode = on.load && on.squeeze ? (loads.load >= loads.squeeze ? 'load' : 'squeeze') : on.load ? 'load' : on.squeeze ? 'squeeze' : null;
    else if (on[other] && loads[other] > loads[mode] * FORCE_SWITCH) mode = other;
    f.mode = mode;

    // A load that is held still has to be looked at again after a while, even if
    // nothing moves: the stillness check needs the time to pass.
    clearTimeout(f.recheck);
    if (on.load || on.squeeze) f.recheck = setTimeout(() => { f.dirty = true; this.#invalidate(); }, 250);

    if (!mode) {
      f.top.group.visible = f.bottom.group.visible = false;
      return;
    }
    const length = clamp(loads[mode] * FORCE_LENGTH_GAIN, FORCE_LENGTH_MIN, FORCE_MAX);
    if (mode === 'load') this.#placeLoad(load, length);
    else this.#placeSqueeze(squeeze, length);
  }

  // Press and push: from above onto the displayed surface along the load, and from
  // below onto the underside of the silicone right beneath it, opposite. The more the
  // pair leans towards the horizontal, the more it is lifted off the surface, so a
  // pure push does not run inside the silicone. On the force line itself the lower
  // arrow would leave the board as soon as the pair tilts.
  #placeLoad(load, length) {
    const f = this.forces;
    const dir = load.move;
    const lift = (1 - Math.abs(dir.y)) * FORCE_HEAD_RADIUS * 1.5;
    f.ray.set(new THREE.Vector3(load.x, this.soft.topY + 0.005, load.z), new THREE.Vector3(0, -1, 0));
    const hit = f.ray.intersectObject(this.soft.group, true)[0];
    const contact = hit ? hit.point : new THREE.Vector3(load.x, this.soft.topY, load.z);

    const topTip = contact.clone().addScaledVector(dir, -FORCE_GAP);
    topTip.y += lift;
    placeArrow(f.top, topTip.clone().addScaledVector(dir, -length), dir, length);

    const bottomTip = new THREE.Vector3(contact.x, this.soft.bottomY - FORCE_GAP - lift, contact.z);
    placeArrow(f.bottom, bottomTip.clone().addScaledVector(dir, length), dir.clone().negate(), length);
  }

  // Squeeze: horizontally onto both flanks of the dome at the height of the magnets,
  // pointing inwards along the axis on which they move together.
  #placeSqueeze(squeeze, length) {
    const f = this.forces;
    const n = new THREE.Vector3(squeeze.n[0], 0, squeeze.n[1]);
    const centre = new THREE.Vector3(squeeze.x, this.soft.magnetY, squeeze.z);
    for (const [arrow, side] of [[f.top, 1], [f.bottom, -1]]) {
      const outside = n.clone().multiplyScalar(side);
      f.ray.set(centre.clone().addScaledVector(outside, 0.03), outside.clone().negate());
      const hit = f.ray.intersectObject(this.soft.group, true)[0];
      const flank = hit ? hit.point : centre.clone().addScaledVector(outside, 0.009);
      const tip = flank.addScaledVector(outside, FORCE_GAP);
      placeArrow(arrow, tip.clone().addScaledVector(outside, length), outside.negate(), length);
    }
  }

  // How far the magnets move together, from the strain of their sideways motion:
  // a plane fit of the displacements over the 2 × 2 array gives the gradient, its
  // symmetric part the strain. The most negative principal strain is the squeeze,
  // its axis the direction of the pair. A shift of all magnets together (shear) and
  // a rotation leave no strain. The load is the approach of the two sides across
  // the array, scaled like the magnet lift. Null while nothing moves together.
  #squeeze() {
    const count = this.magnets.length;
    let cx = 0, cz = 0, ux = 0, uz = 0;
    for (const [i, m] of this.magnets.entries()) {
      cx += this.soft.centres[i].x; cz += this.soft.centres[i].z;
      ux += m.now.x; uz += m.now.z;
    }
    cx /= count; cz /= count; ux /= count; uz /= count;

    let sxx = 0, sxz = 0, szz = 0, axx = 0, axz = 0, azx = 0, azz = 0;
    const p = [], d = [];
    for (const [i, m] of this.magnets.entries()) {
      const px = this.soft.centres[i].x - cx, pz = this.soft.centres[i].z - cz;
      const dx = m.now.x - ux, dz = m.now.z - uz;
      p.push([px, pz]); d.push([dx, dz]);
      sxx += px * px; sxz += px * pz; szz += pz * pz;
      axx += dx * px; axz += dx * pz; azx += dz * px; azz += dz * pz;
    }
    const det = sxx * szz - sxz * sxz;
    if (!(det > 0)) return null;
    // Gradient G with (dx, dz) = G · (px, pz).
    const g11 = (axx * szz - axz * sxz) / det, g12 = (axz * sxx - axx * sxz) / det;
    const g21 = (azx * szz - azz * sxz) / det, g22 = (azz * sxx - azx * sxz) / det;
    const a = g11, b = (g12 + g21) / 2, c = g22;
    const lambda = (a + c) / 2 - Math.hypot((a - c) / 2, b);
    if (lambda >= 0) return null;

    const angle = 0.5 * Math.atan2(2 * b, a - c) + Math.PI / 2;
    const nx = Math.cos(angle), nz = Math.sin(angle);
    const span = 2 * Math.sqrt((nx * nx * sxx + 2 * nx * nz * sxz + nz * nz * szz) / count);

    // The pair runs through the part of the dome that moves together most.
    let weight = 0, offset = 0;
    for (let i = 0; i < count; i++) {
      const along = p[i][0] * nx + p[i][1] * nz;
      const inward = -(d[i][0] * nx + d[i][1] * nz) * Math.sign(along);
      if (inward <= 0) continue;
      weight += inward;
      offset += inward * (-p[i][0] * nz + p[i][1] * nx);
    }
    if (weight > 0) offset /= weight;
    return {
      load: -lambda * span / this.lateralScale,
      n: [nx, nz],
      x: cx - nz * offset,
      z: cz + nx * offset,
    };
  }
}

// Adaptive threshold for one load. The pair appears once the load rises clearly
// above its resting level. It disappears again when the field change falls below
// FORCE_RELEASE of the peak of this press, or below FORCE_STILL_SHARE while it has
// hardly changed for FORCE_STILL_TIME – a residue the silicone keeps after release
// creeps back slowly or not at all, while a hand that still holds a load is rarely
// that quiet below its peak. The peak does not fade while the pair is shown, so a slow
// creep cannot drag it along. The loads grow with the square root of the field
// change (the magnet travel is square-root scaled), hence the root of the shares.
// While hidden, the resting level follows the load down at once and up only
// slowly, so a slow drift does not count as a press.
// Magnet poles: blue on top, red at the bottom, blended across the middle.
const POLE_TOP = new THREE.Color(0x1f5fd6);
const POLE_BOTTOM = new THREE.Color(0xd62f2f);
const POLE_BLEND = 0.08;           // half width of the colour change, as share of the height

function makePoleMaterial(geometry) {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox;
  const material = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.1 });
  material.onBeforeCompile = shader => {
    shader.uniforms.poleTop = { value: POLE_TOP };
    shader.uniforms.poleBottom = { value: POLE_BOTTOM };
    shader.uniforms.poleRange = { value: new THREE.Vector2(min.y, max.y) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'varying float vPoleY;\n#include <common>')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPoleY = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'varying float vPoleY;\nuniform vec3 poleTop;\nuniform vec3 poleBottom;\nuniform vec2 poleRange;\n#include <common>')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float poleT = (vPoleY - poleRange.x) / max(poleRange.y - poleRange.x, 1e-6);
        diffuseColor.rgb = mix(poleBottom, poleTop, smoothstep(${(0.5 - POLE_BLEND).toFixed(3)}, ${(0.5 + POLE_BLEND).toFixed(3)}, poleT));`);
  };
  material.customProgramCacheKey = () => 'magnet-poles';
  return material;
}

function newGate() { return { on: false, peak: 0, floor: 0, time: 0, still: 0, stillSince: 0 }; }

function passGate(gate, load, now) {
  const dt = gate.time ? (now - gate.time) / 1000 : 0;
  gate.time = now;
  if (gate.on) {
    gate.peak = Math.max(gate.peak, load);
    if (Math.abs(load - gate.still) > gate.peak * FORCE_STILL_TOL) {
      gate.still = load;
      gate.stillSince = now;
    }
    const quiet = (now - gate.stillSince) / 1000 >= FORCE_STILL_TIME;
    if (load < FORCE_OFF
        || load < gate.peak * Math.sqrt(FORCE_RELEASE)
        || (quiet && load < gate.peak * Math.sqrt(FORCE_STILL_SHARE))) {
      gate.on = false;
      gate.floor = load;
    }
  } else {
    gate.floor = load < gate.floor ? load : gate.floor + (load - gate.floor) * (1 - Math.exp(-dt / FORCE_FLOOR_TAU));
    if (load > FORCE_OFF && load > gate.floor + FORCE_ON) {
      gate.on = true;
      gate.peak = load;
      gate.still = load;
      gate.stillSince = now;
    }
  }
  return gate.on;
}

function shapeArrow(arrow, length, shaftRadius, headRadius, headLength) {
  const head = Math.min(headLength, length * 0.45);
  const shaft = length - head;
  arrow.shaft.scale.set(shaftRadius, Math.max(shaft, 1e-6), shaftRadius);
  const radius = headRadius * Math.min(1, head / headLength + 0.35);
  arrow.head.scale.set(radius, head, radius);
  arrow.head.position.y = shaft;
}

function placeArrow(arrow, tail, dir, length) {
  shapeArrow(arrow, length, FORCE_SHAFT, FORCE_HEAD_RADIUS, FORCE_HEAD_LENGTH);
  arrow.group.position.copy(tail);
  arrow.group.quaternion.setFromUnitVectors(UP, dir);
  arrow.group.visible = true;
}

function clamp(value, low, high) { return Math.min(high, Math.max(low, value)); }

function shortestAngle(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

// ─── Silicone deformation ─────────────────────────────
// The dome is bonded to the board: nothing moves below the board's top face, the
// displacement grows with the height up to the magnets and stays there above them,
// so the surface moves as far as the magnet below it (1x). Sideways each magnet
// carries its surroundings along a Gaussian; the weights are solved so that the
// field passes exactly through the magnet displacements and the magnets stay
// embedded. A press also pushes the material outwards at mid-height, as silicone
// keeps its volume.

const SOFT_MAX_EDGE = 0.0007;      // dome mesh is refined to this edge length (m)
const SOFT_SIGMA = 0.0045;         // sideways reach of one magnet (m)
const SOFT_HEIGHT_MAX = 1;         // the surface moves at most this many times its magnet
const SOFT_BULGE = 0.5;            // sideways bulge per unit of press
const HEAT_START = 0.00005;        // displacement (m) below which the silicone stays untinted
const HEAT_FULL = 0.0008;          // displacement (m) that gives the full tint
const HEAT_LOW = new THREE.Color(0x12a190);
const HEAT_HIGH = new THREE.Color(0xeb7000);
const CONTOUR_STEP = 0.00015;      // displacement between two contour lines (m)
const CONTOUR_START = 0.00008;     // no contour lines below this displacement (m)

// Tints the silicone where it has moved: teal for a little, orange for a lot. The
// tint rises steeply (square root), so a light press already shows clearly; it
// replaces the colour of the silicone, makes it nearly opaque and lets it glow, so
// it reads through the transparent dome from any side.
// An edge light (Fresnel) brightens the surface where it turns away from the
// viewer, so the shape of the dome and of a dent reads in depth.
// Optional contour lines mark every CONTOUR_STEP of displacement, like the height
// lines of a map; the returned uniform switches them (0 off, 1 on).
function addHeatTint(material) {
  const contours = { value: 0 };
  material.onBeforeCompile = shader => {
    shader.uniforms.heatLow = { value: HEAT_LOW };
    shader.uniforms.heatHigh = { value: HEAT_HIGH };
    shader.uniforms.contours = contours;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'attribute float heat;\nattribute float disp;\nvarying float vHeat;\nvarying float vDisp;\n#include <common>')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeat = heat;\nvDisp = disp;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'varying float vHeat;\nvarying float vDisp;\nuniform vec3 heatLow;\nuniform vec3 heatHigh;\nuniform float contours;\n#include <common>')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float heatAmount = sqrt(clamp(vHeat, 0.0, 1.0));
        vec3 heatColor = mix(heatLow, heatHigh, smoothstep(0.3, 1.0, vHeat));
        diffuseColor.rgb = mix(diffuseColor.rgb, heatColor, heatAmount);
        diffuseColor.a = mix(diffuseColor.a, 0.85, heatAmount);
        float level = vDisp / ${CONTOUR_STEP.toFixed(6)};
        float ring = 1.0 - min(abs(fract(level - 0.5) - 0.5) / max(fwidth(level), 1e-4) * 0.8, 1.0);
        ring *= contours * step(${CONTOUR_START.toFixed(6)}, vDisp);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), ring * 0.9);
        diffuseColor.a = max(diffuseColor.a, ring * 0.9);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        float rim = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.5);
        diffuseColor.a = clamp(diffuseColor.a + rim * 0.55, 0.0, 1.0);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += heatColor * heatAmount * 0.9;
        totalEmissiveRadiance += vec3(0.85, 0.95, 0.95) * rim * 0.6;`);
  };
  material.customProgramCacheKey = () => 'silicone-heat';
  return contours;
}

class SoftDome {
  constructor(root, node, material, centres, baseY) {
    this.centres = centres;
    this.baseY = baseY;
    this.magnetY = centres.reduce((s, c) => s + c.y, 0) / centres.length;
    this.coeff = centres.map(() => new THREE.Vector3());
    this.c = new Float64Array(centres.length * 3);
    this.u = new Float64Array(3);
    this.press = new Float64Array(centres.length);
    this.inverse = invertSmall(centres.map(a => centres.map(b => gauss(a.x - b.x, a.z - b.z))));
    this.enabled = true;
    this.atRest = true;
    this.stale = false;
    this.contours = addHeatTint(material);

    const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const meshes = [];
    node.traverse(o => { if (o.isMesh) meshes.push(o); });
    this.group = new THREE.Group();
    this.group.name = 'Silicone';
    this.parts = [];
    this.topY = -Infinity;
    this.bottomY = Infinity;
    for (const mesh of meshes) {
      const data = refine(readGeometry(mesh.geometry, toRoot.clone().multiply(mesh.matrixWorld)), baseY, SOFT_MAX_EDGE);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions.slice(), 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals.slice(), 3));
      geometry.setAttribute('heat', new THREE.BufferAttribute(new Float32Array(data.positions.length / 3), 1));
      geometry.setAttribute('disp', new THREE.BufferAttribute(new Float32Array(data.positions.length / 3), 1));
      geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
      geometry.computeBoundingSphere();
      const soft = new THREE.Mesh(geometry, material);
      soft.renderOrder = 2;
      soft.frustumCulled = false;
      this.group.add(soft);
      this.parts.push({ geometry, rest: data.positions, cadNormals: data.normals, index: data.index });
      for (let i = 1; i < data.positions.length; i += 3) {
        this.topY = Math.max(this.topY, data.positions[i]);
        this.bottomY = Math.min(this.bottomY, data.positions[i]);
      }
    }
    for (const part of this.parts) this.#prepare(part);
    this.#prepareGrid();
    node.removeFromParent();
    root.add(this.group);
    this.triangles = this.parts.reduce((s, p) => s + p.geometry.index.count / 3, 0);
  }

  // Everything that depends only on the resting shape is worked out once here, so
  // that a frame only adds up a few products per vertex.
  #prepare(part) {
    const C = this.centres.length, rest = part.rest;
    const movable = [];
    for (let v = 0; v < rest.length / 3; v++) if (rest[v * 3 + 1] > this.baseY) movable.push(v);
    const m = movable.length;
    part.movable = Uint32Array.from(movable);
    part.h = new Float32Array(m);
    part.b = new Float32Array(m);
    part.w = new Float32Array(m * C);
    part.wx = new Float32Array(m * C);
    part.wz = new Float32Array(m * C);
    for (let k = 0; k < m; k++) {
      const v = movable[k], x = rest[v * 3], y = rest[v * 3 + 1], z = rest[v * 3 + 2];
      part.h[k] = Math.min((y - this.baseY) / (this.magnetY - this.baseY), SOFT_HEIGHT_MAX);
      part.b[k] = Math.sin(Math.PI * clamp((y - this.baseY) / (this.topY - this.baseY), 0, 1)) * SOFT_BULGE / SOFT_SIGMA;
      for (let i = 0; i < C; i++) {
        const dx = x - this.centres[i].x, dz = z - this.centres[i].z, w = gauss(dx, dz);
        part.w[k * C + i] = w;
        part.wx[k * C + i] = w * dx;
        part.wz[k * C + i] = w * dz;
      }
    }

    // Normals change only on triangles that touch a moving vertex. Their rest
    // normals come from the same set of triangles, so the change is exactly zero
    // at rest – also at the border of that region.
    const isMoving = new Uint8Array(rest.length / 3);
    for (const v of movable) isMoving[v] = 1;
    const tris = [], touched = new Uint8Array(rest.length / 3);
    for (let t = 0; t < part.index.length; t += 3) {
      const a = part.index[t], b = part.index[t + 1], c = part.index[t + 2];
      if (isMoving[a] || isMoving[b] || isMoving[c]) { tris.push(t); touched[a] = touched[b] = touched[c] = 1; }
    }
    part.tris = Uint32Array.from(tris);
    part.touched = Uint32Array.from(touched.reduce((list, flag, v) => (flag && list.push(v), list), []));
    part.face = new Float32Array(rest.length);
    faceNormals(rest, part.index, part.tris, part.touched, part.face);
    part.restFace = part.face.slice();
  }

  // Displacement of movable vertex k of a part under the current field, from the
  // weights worked out in #prepare().
  #field(part, k, out) {
    const C = this.centres.length, c = this.c, press = this.press;
    let sx = 0, sy = 0, sz = 0, bx = 0, bz = 0;
    for (let i = 0, o = k * C; i < C; i++, o++) {
      const w = part.w[o];
      sx += c[i * 3] * w; sy += c[i * 3 + 1] * w; sz += c[i * 3 + 2] * w;
      if (press[i] > 0) { bx += press[i] * part.wx[o]; bz += press[i] * part.wz[o]; }
    }
    out[0] = part.h[k] * sx + part.b[k] * bx;
    out[1] = part.h[k] * sy;
    out[2] = part.h[k] * sz + part.b[k] * bz;
  }

  // An even grid over the sensor area. Above the magnets the dome moves exactly
  // with the field (1x), so the field on this grid is the displacement of the top
  // surface – sampled evenly, unlike the mesh, whose vertices crowd where it was
  // refined.
  #prepareGrid() {
    const C = this.centres.length;
    const mx = this.centres.reduce((s, c) => s + c.x, 0) / C, mz = this.centres.reduce((s, c) => s + c.z, 0) / C;
    const steps = Math.round(2 * PRESS_GRID_HALF / PRESS_GRID_STEP) + 1;
    const x = [], z = [], w = [];
    for (let a = 0; a < steps; a++) for (let b = 0; b < steps; b++) {
      const px = mx - PRESS_GRID_HALF + a * PRESS_GRID_STEP, pz = mz - PRESS_GRID_HALF + b * PRESS_GRID_STEP;
      x.push(px); z.push(pz);
      for (const c of this.centres) w.push(gauss(px - c.x, pz - c.z));
    }
    this.grid = { count: x.length, x: Float32Array.from(x), z: Float32Array.from(z), w: Float32Array.from(w) };
  }

  // The load as the deformation shows it: where the top of the dome moves most, how
  // far, and which way. Sideways movement counts divided by lateralScale, so it is on
  // the scale of the sinking; rising is no push from outside and does not count.
  // Only the region that moves at least LOAD_REGION of the strongest point counts,
  // so small changes at the other sensors do not pull the result towards them. The
  // size is that strongest movement times the coherence of the region: where the
  // magnets move against each other (a squeeze) the movements cancel and the load
  // stays small – the squeeze has its own pair. The sideways bulge is left out: it
  // spreads the material, it is not a force from outside. Null while nothing moves.
  loadPoint(lateralScale) {
    const C = this.centres.length, c = this.c, g = this.grid;
    const ex = new Float64Array(g.count), ey = new Float64Array(g.count), ez = new Float64Array(g.count), m = new Float64Array(g.count);
    let strongest = 0;
    for (let n = 0; n < g.count; n++) {
      let sx = 0, sy = 0, sz = 0;
      for (let i = 0, o = n * C; i < C; i++, o++) {
        const w = g.w[o];
        sx += c[i * 3] * w; sy += c[i * 3 + 1] * w; sz += c[i * 3 + 2] * w;
      }
      ex[n] = sx / lateralScale; ey[n] = Math.min(sy, 0); ez[n] = sz / lateralScale;
      m[n] = Math.hypot(ex[n], ey[n], ez[n]);
      if (m[n] > strongest) strongest = m[n];
    }
    if (strongest <= 0) return null;
    const floor = strongest * LOAD_REGION;
    let sum = 0, size = 0, x = 0, z = 0, mx = 0, my = 0, mz = 0;
    for (let n = 0; n < g.count; n++) {
      if (m[n] < floor) continue;
      x += m[n] * g.x[n]; z += m[n] * g.z[n];
      mx += m[n] * ex[n]; my += m[n] * ey[n]; mz += m[n] * ez[n];
      size += m[n] * m[n];
      sum += m[n];
    }
    const mean = Math.hypot(mx, my, mz);
    if (!(mean > 0)) return null;
    return { x: x / sum, z: z / sum, depth: strongest * mean / size, move: new THREE.Vector3(mx, my, mz).normalize() };
  }

  // Displacement of a point (root space) under the current field.
  displacementAt(p, out) {
    const t = (p.y - this.baseY) / (this.magnetY - this.baseY);
    if (t <= 0) return out.set(0, 0, 0);
    const h = Math.min(t, SOFT_HEIGHT_MAX);
    const bulge = Math.sin(Math.PI * clamp((p.y - this.baseY) / (this.topY - this.baseY), 0, 1)) * SOFT_BULGE / SOFT_SIGMA;
    let ux = 0, uy = 0, uz = 0, bx = 0, bz = 0;
    for (let i = 0; i < this.centres.length; i++) {
      const dx = p.x - this.centres[i].x, dz = p.z - this.centres[i].z;
      const w = gauss(dx, dz);
      const c = this.coeff[i];
      ux += c.x * w; uy += c.y * w; uz += c.z * w;
      if (this.press[i] > 0) { const k = this.press[i] * w * bulge; bx += k * dx; bz += k * dz; }
    }
    return out.set(h * ux + bx, h * uy, h * uz + bz);
  }

  // displacements: one Vector3 per magnet (root space, metres).
  update(displacements) {
    for (let i = 0; i < this.coeff.length; i++) {
      this.coeff[i].set(0, 0, 0);
      for (let j = 0; j < displacements.length; j++) this.coeff[i].addScaledVector(displacements[j], this.inverse[i][j]);
      this.coeff[i].toArray(this.c, i * 3);
      this.press[i] = Math.max(0, -displacements[i].y);
    }
    // A hidden dome is brought up to date once it is shown again.
    this.stale = !this.group.visible;
    if (this.stale) return;
    if (!this.enabled) { if (!this.atRest) this.#rest(); return; }
    this.atRest = false;

    const u = this.u;
    for (const part of this.parts) {
      const pos = part.geometry.attributes.position.array, rest = part.rest;
      const heat = part.geometry.attributes.heat.array;
      const disp = part.geometry.attributes.disp.array;
      const movable = part.movable;
      for (let k = 0; k < movable.length; k++) {
        this.#field(part, k, u);
        const v = movable[k], j = v * 3;
        pos[j] = rest[j] + u[0]; pos[j + 1] = rest[j + 1] + u[1]; pos[j + 2] = rest[j + 2] + u[2];
        disp[v] = Math.hypot(u[0], u[1], u[2]);
        heat[v] = clamp((disp[v] - HEAT_START) / (HEAT_FULL - HEAT_START), 0, 1);
      }
      part.geometry.attributes.position.needsUpdate = true;
      part.geometry.attributes.heat.needsUpdate = true;
      part.geometry.attributes.disp.needsUpdate = true;

      faceNormals(pos, part.index, part.tris, part.touched, part.face);
      const nor = part.geometry.attributes.normal.array, face = part.face;
      for (const v of part.touched) {
        const j = v * 3;
        const x = part.cadNormals[j] + face[j] - part.restFace[j];
        const y = part.cadNormals[j + 1] + face[j + 1] - part.restFace[j + 1];
        const z = part.cadNormals[j + 2] + face[j + 2] - part.restFace[j + 2];
        const l = Math.hypot(x, y, z) || 1;
        nor[j] = x / l; nor[j + 1] = y / l; nor[j + 2] = z / l;
      }
      part.geometry.attributes.normal.needsUpdate = true;
    }
  }

  #rest() {
    for (const part of this.parts) {
      part.geometry.attributes.position.array.set(part.rest);
      part.geometry.attributes.normal.array.set(part.cadNormals);
      part.geometry.attributes.heat.array.fill(0);
      part.geometry.attributes.disp.array.fill(0);
      for (const name of ['position', 'normal', 'heat', 'disp']) part.geometry.attributes[name].needsUpdate = true;
    }
    this.atRest = true;
  }
}

function gauss(dx, dz) { return Math.exp(-(dx * dx + dz * dz) / (SOFT_SIGMA * SOFT_SIGMA)); }

// Area-weighted vertex normals over the given triangles, like computeVertexNormals(),
// written for the listed vertices only.
function faceNormals(pos, index, tris, verts, out) {
  for (const v of verts) out[v * 3] = out[v * 3 + 1] = out[v * 3 + 2] = 0;
  for (const t of tris) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    const ex = pos[c] - pos[b], ey = pos[c + 1] - pos[b + 1], ez = pos[c + 2] - pos[b + 2];
    const fx = pos[a] - pos[b], fy = pos[a + 1] - pos[b + 1], fz = pos[a + 2] - pos[b + 2];
    const nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
    out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
    out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
  }
  for (const v of verts) {
    const j = v * 3, l = Math.hypot(out[j], out[j + 1], out[j + 2]) || 1;
    out[j] /= l; out[j + 1] /= l; out[j + 2] /= l;
  }
}

function invertSmall(a) {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    const d = m[c][c];
    for (let k = 0; k < 2 * n; k++) m[c][k] /= d;
    for (let r = 0; r < n; r++) if (r !== c) {
      const f = m[r][c];
      for (let k = 0; k < 2 * n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map(row => row.slice(n));
}

// Positions and normals as plain floats in the given frame (the model stores them quantised).
function readGeometry(geometry, matrix) {
  const pos = geometry.attributes.position, nor = geometry.attributes.normal;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
  const v = new THREE.Vector3();
  const positions = new Float32Array(pos.count * 3), normals = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(matrix).toArray(positions, i * 3);
    if (nor) v.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize().toArray(normals, i * 3);
  }
  const index = geometry.index ? Uint32Array.from(geometry.index.array) : Uint32Array.from({ length: pos.count }, (_, i) => i);
  return { positions, normals, index };
}

// Splits every edge above `baseY` that is longer than maxEdge. The decision is made
// per edge, so both triangles on an edge agree and no cracks appear.
function refine({ positions, normals, index }, baseY, maxEdge) {
  const P = Array.from(positions), N = Array.from(normals);
  let I = Array.from(index);
  const limit = maxEdge * maxEdge;
  for (let pass = 0; pass < 16; pass++) {
    const mids = new Map();
    let split = false;
    const mid = (a, b) => {
      const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2], bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
      if (Math.max(ay, by) <= baseY) return -1;
      if ((ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2 <= limit) return -1;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let m = mids.get(key);
      if (m === undefined) {
        m = P.length / 3;
        P.push((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
        const nx = N[a * 3] + N[b * 3], ny = N[a * 3 + 1] + N[b * 3 + 1], nz = N[a * 3 + 2] + N[b * 3 + 2];
        const l = Math.hypot(nx, ny, nz) || 1;
        N.push(nx / l, ny / l, nz / l);
        mids.set(key, m);
      }
      split = true;
      return m;
    };
    const out = [];
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t], b = I[t + 1], c = I[t + 2];
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      const mask = (ab >= 0 ? 1 : 0) | (bc >= 0 ? 2 : 0) | (ca >= 0 ? 4 : 0);
      switch (mask) {
        case 0: out.push(a, b, c); break;
        case 1: out.push(a, ab, c, ab, b, c); break;
        case 2: out.push(a, b, bc, a, bc, c); break;
        case 4: out.push(a, b, ca, ca, b, c); break;
        case 3: out.push(ab, b, bc, a, ab, bc, a, bc, c); break;
        case 6: out.push(ca, bc, c, a, b, bc, a, bc, ca); break;
        case 5: out.push(a, ab, ca, ab, b, c, ab, c, ca); break;
        default: out.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
      }
    }
    I = out;
    if (!split) break;
  }
  return { positions: Float32Array.from(P), normals: Float32Array.from(N), index: Uint32Array.from(I) };
}
