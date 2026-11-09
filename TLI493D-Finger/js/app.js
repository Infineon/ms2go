'use strict';

// ═══════════════════════════════════════════════════
//  Configuration (from TLI493D-FINGER_MS2GO_GUI1.py)
// ═══════════════════════════════════════════════════
const DEAD_ZONE = 3;              // adjustment to account for hysteresis
const BAUD_RATE = 115200;
const SERIAL_TIMEOUT_MS = 20;     // Python: SERIAL_TIMEOUT = 0.02 s
const MAX_SENSOR_COUNT = 4;

// bx_config, by_config, bz_config, mode_1, mode_2 (see datasheet): setting for M109 chip
const CONFIGURATIONS = [0x80, 0x80, 0x80, 0x98, 0x20];
// active bit for sensor axis xyz & temperature; unused dimensions output zero
const ACTIVE = 0b1111;

const CMD_READ = 0x48;            // trigger measurement of all sensors in the bus
const CMD_ADDRESSING = 0x4F;      // soft reset followed by auto addressing
const CMD_CONF = 0x7A;            // set configuration of all sensors in the bus

// Typical range values [mT] selectable via bx_range bits (3:1), datasheet Table 10
const RANGE_TABLE_MT = [17.4, 34.8, 52.1, 69.5, 87, 104, 122, 139];

function getRangeAndBits(configurations) {
  const rangeBits = (configurations[0] >> 1) & 0b111;
  const outputSizeBits = (configurations[4] >> 5) & 0b11;
  const bits = outputSizeBits === 0 ? 8 : outputSizeBits === 1 ? 10 : 16;
  return [RANGE_TABLE_MT[rangeBits], bits];
}

const [RANGE_MT, OUTPUT_BITS] = getRangeAndBits(CONFIGURATIONS);
// mT per LSB, datasheet equation (5): Res = 2*range / 2^bits
const MT_PER_LSB = (2 * RANGE_MT) / (2 ** OUTPUT_BITS);

// After calibration x and y read ~0 and z reads ~CALIBRATION_Z_TARGET at rest.
const CALIBRATION_SAMPLES = 100;
const CALIBRATION_Z_TARGET = 50;

// Proximity map, in the coordinates of the Python canvas
const CANVAS_SIZE = 600;
const SENSOR_SPACING = 200;
const SCALE_FACTOR = 0.2;
const MOVE_SCALE = 8.0;
const SENSOR_LABELS = ['Sensor 1', 'Sensor 2', 'Sensor 3', 'Sensor 4'];
const SENSOR_OFFSETS = [
  [-SENSOR_SPACING / 2,  SENSOR_SPACING / 2],
  [ SENSOR_SPACING / 2,  SENSOR_SPACING / 2],
  [-SENSOR_SPACING / 2, -SENSOR_SPACING / 2],
  [ SENSOR_SPACING / 2, -SENSOR_SPACING / 2],
];

const BYTES_PER_SENSOR = bitCount(ACTIVE) + 1;
const FRAME_BYTES = BYTES_PER_SENSOR * MAX_SENSOR_COUNT;

// ═══════════════════════════════════════════════════
//  Browser side
// ═══════════════════════════════════════════════════
// Python finds the port by the manufacturer "Cypress"; the picker filters by vendor ID.
const PORT_FILTERS = [{ usbVendorId: 0x04B4 }, { usbVendorId: 0x058B }];

// Replies return as soon as they are complete; the limits only decide when to give up.
// Web Serial adds USB and stream latency, so they are wider than Python's 20 ms.
const RESPONSE_TIMEOUT_MS = 500;  // addressing and configuration replies
const ECHO_TIMEOUT_MS = 40;       // echo of the read command
const PARTIAL_GRACE_MS = 30;      // lets a sensor block that is still arriving complete

// ── Board layout (checked on hardware) ────────────────────────────────────
// The bus delivers the sensors in reverse order of their part numbers: Sensor 1
// (first block) is TLI493D_x4D7_4, … Sensor 4 is TLI493D_x4D7_1 – the same order
// the TLI493D-M4D7 GUI reads (blocks 3, 2, 1, 0), and confirmed by pressing each
// magnet. The proximity map of the Python GUI is then the sensor head seen from
// above with the tip on the left: map X (screen right) runs towards the USB
// socket, map Y (screen down) towards the board edge at -X. The arrows draw
// exactly the X/Y/Z numbers in the model (Y up, tip towards -Z) along these axes.
const BOARD_LAYOUT = {
  parts: ['TLI493D_x4D7_4', 'TLI493D_x4D7_3', 'TLI493D_x4D7_2', 'TLI493D_x4D7_1'],
  mapRight: [0, 0, 1],
  mapDown: [-1, 0, 0],
  up: [0, 1, 0],
};
const MAP_MM_PER_PX = 8 / SENSOR_SPACING;     // sensors sit 8 mm apart on the board
const ARROW_MM_PER_SQRT_LSB = 0.6;            // square root, like the dot on the map
const MAGNET_LIFT_MM_PER_SQRT_LSB = 0.15;
const MAGNET_LIMITS_MM = { lateral: 2.5, down: 2.4, up: 1.2 };

// One colour per sensor; must match .swatch-s1 … .swatch-s4 in style.css.
const SENSOR_COLORS = ['#12a190', '#eb7000', '#c13c86', '#d9a400'];
const CHART_PALETTE = { grid: '#e7ebeb', axis: '#dfe4e4', text: '#6b7a7d' };
const HISTORY_KEEP_MS = 65000;

const MODEL_MODULE = './model3d.js?v=12';     // resolved relative to this script
const MODEL_URL = new URL('../assets/models/tli493d_finger.glb?v=2', document.currentScript.src).href;

// ═══════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════
const zeros3 = () => [0, 0, 0];

const st = {
  port: null, writer: null, reader: null,
  buf: new Uint8Array(0),
  running: false,
  session: null,
  phase: 'offline',              // offline | init | calibrating | streaming
  calProgress: 0,

  offsets: [zeros3(), zeros3(), zeros3(), zeros3()],
  latest: [zeros3(), zeros3(), zeros3(), zeros3()],   // raw - offsets, as in SensorReader
  temps: [null, null, null, null],
  counters: [null, null, null, null],
  sensorCount: 0,
  seen: false,
  recalRequested: false,
  readyTimer: 0,

  unit: 'mT',
  view: 'Delta',

  frames: { valid: 0, failed: 0, times: [] },
  history: [],
  paused: false,
  pausedAt: 0,
  windowMs: 10000,

  recording: false,
  recRows: [],
  csvBlob: null,
};

// Map items as drawn last; sensors that stop answering keep their place, as in Python.
const mapItems = SENSOR_OFFSETS.map(([ox, oy]) => {
  const cx = CANVAS_SIZE / 2 + ox, cy = CANVAS_SIZE / 2 + oy;
  return { cx, cy, r: 0, labelY: cy - 30, text: 'X:0  Y:0  Z:0' };
});

let model = null;

// ═══════════════════════════════════════════════════
//  Python helpers
// ═══════════════════════════════════════════════════
function bitCount(v) { let n = 0; for (; v; v >>= 1) n += v & 1; return n; }

function twosComplement(value, bits) {
  return value & (1 << (bits - 1)) ? value - (1 << bits) : value;
}

// active is binary of xyzt; unused dimensions output zero
function computeBr(rxBytes, active) {
  const b = Array.from(rxBytes);
  if (!(active & 0b1000)) b.splice(0, 0, 0);
  if (!(active & 0b0100)) b.splice(1, 0, 0);
  if (!(active & 0b0010)) b.splice(2, 0, 0);
  if (!(active & 0b0001)) b.splice(3, 0, 0);
  const x = (b[0] << 2) | ((b[4] & 0b11000000) >> 6);
  const y = (b[1] << 2) | ((b[4] & 0b00110000) >> 4);
  const z = (b[2] << 2) | ((b[4] & 0b00001100) >> 2);
  const t = b[3];
  const c = b[4] & 0b00000011;
  return [twosComplement(x, 10), twosComplement(y, 10), twosComplement(z, 10), twosComplement(t, 8), c];
}

// Python's round(): halves go to the even neighbour.
function pyRound(v) {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// ═══════════════════════════════════════════════════
//  Serial
// ═══════════════════════════════════════════════════
const sleep = ms => new Promise(r => setTimeout(r, ms));
const toHex = bytes => Array.from(bytes, b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const alive = token => st.running && st.session === token;

async function write(bytes) { await st.writer.write(new Uint8Array(bytes)); }

function clearBuf() { st.buf = new Uint8Array(0); }

// Like pyserial's read(n): returns once n bytes are there or the time is up.
async function readUpTo(n, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (st.buf.length < n && performance.now() < deadline && st.running) await sleep(1);
  const r = st.buf.slice(0, n);
  st.buf = st.buf.slice(r.length);
  return r;
}

async function readerLoop() {
  try {
    while (st.running) {
      const { value, done } = await st.reader.read();
      if (done) break;
      if (value && value.length) {
        const merged = new Uint8Array(st.buf.length + value.length);
        merged.set(st.buf);
        merged.set(value, st.buf.length);
        st.buf = merged;
      }
    }
  } catch (_) { /* port closed or device lost */ }
  if (st.running) disconnect('Connection lost', 'error');
}

// Python init_serial(): auto addressing, then the shared configuration.
async function initSerial() {
  clearBuf();
  await write([CMD_ADDRESSING]);
  const addressingResponse = await readUpTo(5, RESPONSE_TIMEOUT_MS);
  $('diag-addressing').textContent = `Addressing (0x4F): ${addressingResponse.length ? toHex(addressingResponse) : 'no response'}`;
  if (addressingResponse.length === 0) {
    throw new Error('No response from the sensor board on the selected port. '
      + 'Check that the USB cable supports data (not charge-only) and the board is powered.');
  }
  await sleep(10);

  const cmd = [CMD_CONF, ...CONFIGURATIONS];
  await write(cmd);
  const echo = await readUpTo(CONFIGURATIONS.length + 1, RESPONSE_TIMEOUT_MS);
  const same = echo.length === cmd.length && echo.every((b, i) => b === cmd[i]);
  $('diag-config').textContent = `Configuration (0x7A): sent ${toHex(cmd)} · echo ${echo.length ? toHex(echo) : 'none'}${same ? '' : ' (differs)'}`;
  await sleep(1);
}

// One read command: echo byte, then up to four 5-byte sensor blocks.
async function readFrame() {
  clearBuf();
  await write([CMD_READ]);
  const echo = await readUpTo(1, ECHO_TIMEOUT_MS);                 // Python: ser.read(1)
  let data = await readUpTo(FRAME_BYTES, SERIAL_TIMEOUT_MS);       // Python: ser.read(5 * 4)
  const rest = data.length % BYTES_PER_SENSOR;
  if (rest) {
    const more = await readUpTo(BYTES_PER_SENSOR - rest, PARTIAL_GRACE_MS);
    const joined = new Uint8Array(data.length + more.length);
    joined.set(data); joined.set(more, data.length);
    data = joined;
  }
  $('diag-frame').textContent = `Last frame (0x48): ${echo.length ? toHex(echo) : '—'} | ${data.length ? toHex(data) : 'no data'}`;
  // A missing or wrong echo would shift every byte after it.
  return echo.length === 1 && echo[0] === CMD_READ ? data : new Uint8Array(0);
}

// Python calibrate_offsets(): per-sensor [x, y, z] offsets so that the sensor reads
// [0, 0, CALIBRATION_Z_TARGET] at rest.
async function calibrateOffsets(token, numSamples = CALIBRATION_SAMPLES, maxSensors = 4) {
  const sums = Array.from({ length: maxSensors }, zeros3);
  const counts = new Array(maxSensors).fill(0);
  let collected = 0;
  let failedAttempts = 0;
  const maxFailedAttempts = Math.max(500, numSamples * 20);
  calLog([`Calibrating: collecting ${numSamples} samples (keep magnet away)...`]);
  setCalProgress(0);
  while (collected < numSamples) {
    if (!alive(token)) throw new Error('Disconnected during calibration');
    const rxBytes = await readFrame();
    const sensorCount = rxBytes.length / BYTES_PER_SENSOR;
    if (!Number.isInteger(sensorCount) || sensorCount === 0) {
      failedAttempts += 1;
      if (failedAttempts % 100 === 0) {
        calLog([`...no valid response yet (${failedAttempts} failed reads, last read ${rxBytes.length} bytes). Check board connection/USB cable.`], true);
      }
      if (failedAttempts >= maxFailedAttempts) {
        throw new Error('Calibration aborted: sensor board did not respond with valid data. '
          + 'Check that the MS2GO board is plugged in with a data-capable USB cable.');
      }
      continue;
    }
    failedAttempts = 0;
    const n = Math.min(sensorCount, maxSensors);
    for (let i = 0; i < n; i++) {
      const br = computeBr(rxBytes.subarray(BYTES_PER_SENSOR * i), ACTIVE);
      for (let k = 0; k < 3; k++) sums[i][k] += br[k];
      counts[i] += 1;
    }
    collected += 1;
    setCalProgress(collected);
  }
  const target = [0, 0, CALIBRATION_Z_TARGET];
  const offsets = sums.map((sum, i) => counts[i] > 0
    ? sum.map((v, k) => pyRound(v / counts[i] - target[k]))
    : zeros3());
  calLog([
    'Calibration complete. Offsets per sensor (x, y, z):',
    ...offsets.map((o, i) => `  ${SENSOR_LABELS[i]}: [${o.join(', ')}]${counts[i] ? '' : ' (not detected)'}`),
  ]);
  return offsets;
}

// Python SensorReader.run(), one pass.
async function readOnce(token) {
  try {
    const rxBytes = await readFrame();
    await sleep(SERIAL_TIMEOUT_MS);                                // Python: ser.read(10)
    if (!alive(token)) return;
    const sensorCount = rxBytes.length / BYTES_PER_SENSOR;
    if (!Number.isInteger(sensorCount) || sensorCount === 0) {
      st.frames.failed += 1;
      updateCounts();
      return;
    }
    const n = Math.min(sensorCount, MAX_SENSOR_COUNT);
    const now = performance.now();
    const raw = [];
    for (let i = 0; i < n; i++) {
      const br = computeBr(rxBytes.subarray(BYTES_PER_SENSOR * i), ACTIVE);
      st.latest[i] = [0, 1, 2].map(k => br[k] - st.offsets[i][k]);
      st.temps[i] = br[3];
      st.counters[i] = br[4];
      raw.push(br);
    }
    st.sensorCount = n;
    st.seen = true;
    st.frames.valid += 1;
    st.frames.times.push(now);
    updateCounts();
    pushHistory(now, n);
    captureRecording(raw, n);
    requestRender();
  } catch (err) {
    if (!alive(token)) return;
    $('diag-error').textContent = `reader error: ${err.message}`;
    await sleep(50);
  }
}

async function session(token) {
  try {
    setPhase('init');
    await initSerial();
    setPhase('calibrating');
    setCalStatus('Calibrating...', 'warn');
    st.offsets = await calibrateOffsets(token);
  } catch (err) {
    if (!alive(token)) return;
    initFailed(err);
    return;
  }
  setConnection('Connected · TLI493D Finger', 'online');
  setCalStatus('Ready', 'ok');
  setPhase('streaming');
  while (alive(token)) {
    if (st.recalRequested) {
      st.recalRequested = false;
      await recalibrate(token);
      continue;
    }
    await readOnce(token);
  }
}

// Python recalibrate()
async function recalibrate(token) {
  clearTimeout(st.readyTimer);
  setCalStatus('Calibrating...', 'warn');
  setPhase('calibrating');
  try {
    st.offsets = await calibrateOffsets(token);
    setCalStatus('Calibration complete', 'ok');
  } catch (err) {
    if (!alive(token)) return;
    calLog([`Calibration error: ${err.message}`], true);
    setCalStatus('Calibration failed', 'error');
  } finally {
    if (alive(token)) setPhase('streaming');
  }
  st.readyTimer = setTimeout(() => setCalStatus('Ready', 'ok'), 2000);
}

function initFailed(err) {
  const box = $('init-error');
  box.textContent = `⚠ Sensor initialization failed: ${err.message}`;
  box.hidden = false;
  disconnect('Sensor initialization failed', 'error');
}

// ═══════════════════════════════════════════════════
//  Connection
// ═══════════════════════════════════════════════════
async function connect() {
  if (!('serial' in navigator)) return;
  $('init-error').hidden = true;
  let port;
  try {
    port = await navigator.serial.requestPort({ filters: PORT_FILTERS });
  } catch (err) {
    if (err.name === 'NotFoundError' || err.name === 'AbortError') {
      setConnection('Make sure the MS2GO board is connected', 'offline');
    } else {
      setConnection(`Port selection failed: ${err.message}`, 'error');
    }
    return;
  }
  try {
    await port.open({ baudRate: BAUD_RATE, dataBits: 8, stopBits: 1, parity: 'none' });
  } catch (err) {
    setConnection(`Could not open the port: ${err.message}`, 'error');
    return;
  }

  st.port = port;
  st.writer = port.writable.getWriter();
  st.reader = port.readable.getReader();
  st.buf = new Uint8Array(0);
  st.running = true;
  st.frames = { valid: 0, failed: 0, times: [] };
  st.sensorCount = 0;
  st.recalRequested = false;
  const token = {};
  st.session = token;

  setConnection('Connected · initialising', 'searching');
  setConnectedUi(true);
  $('diag-error').textContent = '';
  updateCounts();

  readerLoop();
  session(token);
}

async function disconnect(message = 'Disconnected', state = 'offline') {
  const wasRunning = st.running;
  st.running = false;
  st.session = null;
  clearTimeout(st.readyTimer);
  try { if (st.reader) { await st.reader.cancel(); st.reader.releaseLock(); } } catch (_) {}
  try { if (st.writer) st.writer.releaseLock(); } catch (_) {}
  try { if (st.port) await st.port.close(); } catch (_) {}
  st.reader = st.writer = st.port = null;
  if (!wasRunning && state === 'offline') return;

  if (st.recording) stopRecording();
  setPhase('offline');
  setCalStatus('', 'ok');
  setConnection(message, state);
  setConnectedUi(false);
  chartsDirty = true;
  if (model) model.reset();
}

// ═══════════════════════════════════════════════════
//  UI status
// ═══════════════════════════════════════════════════
const $ = id => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setConnection(text, state) {
  $('connection-text').textContent = text;
  const label = $('connection-label');
  label.dataset.state = state;
  label.title = text;
}

function setConnectedUi(on) {
  $('connect-button').hidden = on;
  $('disconnect-button').hidden = !on;
  if (!st.recording) $('rec-btn').disabled = !on;
  updateRecalibrateButton();
  updateLiveState();
}

function setPhase(phase) {
  st.phase = phase;
  updateRecalibrateButton();
  updateLiveState();
}

function setCalProgress(n) {
  st.calProgress = n;
  updateLiveState();
}

function updateRecalibrateButton() {
  $('recalibrate').disabled = !(st.running && st.phase === 'streaming' && !st.recalRequested);
}

// Python status_label: Ready / Calibrating... / Calibration complete / Calibration failed
function setCalStatus(text, tone) {
  const s = $('cal-status');
  s.textContent = text;
  s.className = `ack is-${tone}`;
}

function updateLiveState() {
  const box = $('live-state');
  let cls = '', text;
  if (!st.running) text = st.seen ? 'Not connected · last reading shown' : 'Not connected';
  else if (st.phase === 'init') text = 'Initialising board…';
  else if (st.phase === 'calibrating') { cls = 'is-warning'; text = `Calibrating ${st.calProgress}/${CALIBRATION_SAMPLES} · leave the dome untouched`; }
  else if (packetRate() > 0) { cls = 'is-running'; text = `Streaming · ${st.sensorCount} sensor${st.sensorCount === 1 ? '' : 's'}`; }
  else { cls = 'is-warning'; text = 'No valid frames · see Diagnostics'; }
  box.className = cls ? `live-state ${cls}` : 'live-state';
  $('live-state-text').textContent = text;
}

function packetRate() {
  const now = performance.now();
  const t = st.frames.times;
  while (t.length && now - t[0] > 1000) t.shift();
  return t.length;
}

function updateCounts() {
  $('diag-counts').textContent = `Frames: ${st.frames.valid} valid · ${st.frames.failed} invalid · ${st.sensorCount} sensor${st.sensorCount === 1 ? '' : 's'} detected`;
}

function calLog(lines, append = false) {
  const box = $('diag-calibration');
  if (!append) box.replaceChildren();
  for (const line of lines) box.append(el('div', 'status-line', line));
}

// ═══════════════════════════════════════════════════
//  Values (Python update())
// ═══════════════════════════════════════════════════
// "latest" is offset-corrected (raw - offsets); recover raw and the calibration
// baseline so both absolute and delta-from-calibration can be shown.
function readoutVals(lat, off) {
  const v = st.view === 'Absolute'
    ? [lat[0] + off[0], lat[1] + off[1], lat[2] + off[2]]
    : [lat[0], lat[1], lat[2] - CALIBRATION_Z_TARGET];
  return [-v[0], -v[1], v[2]];
}

function formatAxis(rawLsb, spaced = false) {
  const gap = spaced ? ' ' : '';
  if (st.unit === 'mT') {
    const v = rawLsb * MT_PER_LSB;
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)}${gap}mT`;
  }
  return `${rawLsb >= 0 ? '+' : ''}${rawLsb.toFixed(0)}${gap}LSB`;
}

function formatMagnitude(lsb) {
  return st.unit === 'mT' ? `${(lsb * MT_PER_LSB).toFixed(2)} mT` : `${lsb.toFixed(0)} LSB`;
}

const deadZone = v => Math.abs(v) <= DEAD_ZONE ? 0 : Math.sign(v) * (Math.abs(v) - DEAD_ZONE);

// ═══════════════════════════════════════════════════
//  Rendering
// ═══════════════════════════════════════════════════
let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  const active = st.seen ? st.sensorCount : 0;
  let strongest = null;
  for (let i = 0; i < MAX_SENSOR_COUNT; i++) {
    if (i >= active) { setRow(i, null); continue; }
    const [rx, ry, rz] = readoutVals(st.latest[i], st.offsets[i]);
    const mag = Math.hypot(rx, ry, rz);
    setRow(i, [rx, ry, rz, mag]);
    if (!strongest || mag > strongest.mag) strongest = { i, mag };
    updateMapItem(i, rx, ry, rz);
  }
  drawMap();
  $('stage-vectors').textContent = st.view === 'Absolute' ? 'B absolute' : 'ΔB since calibration';
  $('stage-strongest').textContent = strongest ? `${SENSOR_LABELS[strongest.i]} · ${formatMagnitude(strongest.mag)}` : '–';
  updateModel(active);
}

function buildValueTable() {
  const body = $('value-rows');
  for (let i = 0; i < MAX_SENSOR_COUNT; i++) {
    const tr = document.createElement('tr');
    tr.id = `row-${i}`;
    const nameCell = document.createElement('td');
    const name = el('span', 'sensor-name');
    const text = el('span', null, SENSOR_LABELS[i]);
    text.append(el('small', null, BOARD_LAYOUT.parts[i]));
    name.append(el('i', `swatch swatch-s${i + 1}`), text);
    nameCell.append(name);
    tr.append(nameCell);
    for (const key of ['x', 'y', 'z', 'm']) {
      const td = document.createElement('td');
      const cell = el('div', 'value-cell is-empty');
      cell.id = `v${i}${key}`;
      cell.append(el('strong', null, '—'));
      td.append(cell);
      tr.append(td);
    }
    body.append(tr);
  }
}

function setRow(i, vals) {
  const row = $(`row-${i}`);
  const missing = !vals && st.seen;
  row.classList.toggle('is-missing', missing);
  ['x', 'y', 'z', 'm'].forEach((key, k) => {
    const cell = $(`v${i}${key}`);
    const strong = cell.firstChild;
    if (!vals) {
      strong.textContent = '—';
      cell.className = 'value-cell is-empty';
      cell.title = missing ? 'Not detected in the last frame' : '';
      return;
    }
    strong.textContent = key === 'm' ? formatMagnitude(vals[3]) : formatAxis(vals[k], true);
    cell.className = 'value-cell';
    cell.title = '';
  });
}

// ── Proximity map ─────────────────────────────────

function updateMapItem(i, rx, ry, rz) {
  const item = mapItems[i];
  item.text = `X:${formatAxis(rx)}  Y:${formatAxis(ry)}  Z:${formatAxis(rz)}`;

  const lat = st.latest[i];
  const x = deadZone(-lat[0]);
  const y = deadZone(-lat[1]);
  const z = lat[2];
  const magnitude = Math.sqrt(x ** 2 + y ** 2 + z ** 2);
  const displayR = Math.max(magnitude * SCALE_FACTOR, 1);
  const dx = Math.sign(x) * Math.sqrt(Math.abs(x)) * MOVE_SCALE;
  const dy = Math.sign(y) * Math.sqrt(Math.abs(y)) * MOVE_SCALE;
  const [ox, oy] = SENSOR_OFFSETS[i];
  item.dx = dx;
  item.dy = dy;
  item.cx = CANVAS_SIZE / 2 + ox + dx;
  item.cy = CANVAS_SIZE / 2 + oy + dy;
  item.r = displayR;
  item.labelY = item.cy - displayR - 30;
}

function drawMap() {
  const canvas = $('map-canvas');
  const css = canvas.clientWidth;
  if (!css) return;
  const ratio = window.devicePixelRatio || 1;
  const px = Math.round(css * ratio);
  if (canvas.width !== px || canvas.height !== px) { canvas.width = px; canvas.height = px; }
  const ctx = canvas.getContext('2d');
  const s = px / CANVAS_SIZE;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  const rest = SENSOR_OFFSETS.map(([ox, oy]) => [CANVAS_SIZE / 2 + ox, CANVAS_SIZE / 2 + oy]);
  ctx.save();
  ctx.strokeStyle = '#c3cacb';
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 4]);
  for (const [a, b] of [[0, 1], [1, 3], [3, 2], [2, 0]]) {
    ctx.beginPath(); ctx.moveTo(...rest[a]); ctx.lineTo(...rest[b]); ctx.stroke();
  }
  ctx.restore();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  mapItems.forEach((item, i) => {
    const color = SENSOR_COLORS[i];
    if (item.r > 0) {
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = color; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(item.cx, item.cy, item.r + 6, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(item.cx, item.cy, item.r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(item.cx, item.cy, 5, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = '#12262b';
    ctx.font = "700 17px 'Source Sans 3', system-ui, sans-serif";
    ctx.fillText(SENSOR_LABELS[i], item.cx, item.labelY);

    ctx.fillStyle = '#6b7a7d';
    ctx.font = "500 13px 'IBM Plex Mono', Consolas, monospace";
    // Python writes the three values on one line; side by side they would run into
    // each other at this font size, so they stand one below the other.
    item.text.split('  ').forEach((part, line) => ctx.fillText(part, rest[i][0], rest[i][1] + 55 + line * 17));
  });
}

// ── 3D model ──────────────────────────────────────

const axisTo = (v, a, b, c) => [0, 1, 2].map(k => v[0] * a[k] + v[1] * b[k] + v[2] * c[k]);

function updateModel(active) {
  if (!model) return;
  const { mapRight, mapDown, up } = BOARD_LAYOUT;
  const vectors = [], magnets = [];
  for (let i = 0; i < MAX_SENSOR_COUNT; i++) {
    if (!st.running || st.phase !== 'streaming' || i >= active) { vectors.push(null); magnets.push(null); continue; }

    const v = readoutVals(st.latest[i], st.offsets[i]);
    const mag = Math.hypot(...v);
    if (mag <= DEAD_ZONE) vectors.push(null);
    else {
      const dir = axisTo(v.map(c => c / mag), mapRight, mapDown, up);
      vectors.push({ dir, length: Math.sqrt(mag - DEAD_ZONE) * ARROW_MM_PER_SQRT_LSB / 1000 });
    }

    // The magnet follows the dot of the map and sinks as the field grows.
    const item = mapItems[i];
    let lateral = [(item.dx ?? 0) * MAP_MM_PER_PX, (item.dy ?? 0) * MAP_MM_PER_PX];
    const len = Math.hypot(...lateral);
    if (len > MAGNET_LIMITS_MM.lateral) lateral = lateral.map(c => c * MAGNET_LIMITS_MM.lateral / len);
    const dz = deadZone(st.latest[i][2] - CALIBRATION_Z_TARGET);
    const lift = Math.min(MAGNET_LIMITS_MM.up, Math.max(-MAGNET_LIMITS_MM.down,
      -Math.sign(dz) * Math.sqrt(Math.abs(dz)) * MAGNET_LIFT_MM_PER_SQRT_LSB));
    magnets.push(axisTo([lateral[0], lateral[1], lift], mapRight, mapDown, up).map(c => c / 1000));
  }
  model.setVectors(vectors);
  model.setMagnetOffsets(magnets);
}

async function loadModel() {
  const canvas = $('model-canvas');
  try {
    const { FingerModel } = await import(MODEL_MODULE);
    model = new FingerModel(canvas, {
      parts: BOARD_LAYOUT.parts,
      colors: SENSOR_COLORS,
      lateralScale: (MOVE_SCALE * MAP_MM_PER_PX) / MAGNET_LIFT_MM_PER_SQRT_LSB,
    });
    canvas.hidden = false;
    await model.load(MODEL_URL);
  } catch (error) {
    model = null;
    canvas.hidden = true;
    console.warn('3D model unavailable, the drawing stays.', error);
    return;
  }
  $('model-stage').classList.add('has-model');
  $('stage-tools').hidden = false;
  applyView();
  render();
}

// ═══════════════════════════════════════════════════
//  View settings (panel on the stage)
// ═══════════════════════════════════════════════════
const VIEW_DEFAULTS = { silicone: 'transparent', deform: 'on', contours: 'off', forces: 'on' };
const VIEW_STORE = 'ms2go.finger.view';

const viewValue = name => document.querySelector(`input[name="${name}"]:checked`).value;
const currentView = () => Object.fromEntries(Object.keys(VIEW_DEFAULTS).map(name => [name, viewValue(name)]));

function setView(view) {
  for (const [name, value] of Object.entries(view)) {
    const radio = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (radio) radio.checked = true;
  }
}

function applyView() {
  updateViewBadge();
  if (!model) return;
  model.setSilicone(viewValue('silicone'));
  model.setDeformation(viewValue('deform') === 'on');
  model.setContours(viewValue('contours') === 'on');
  model.setForces(viewValue('forces') === 'on');
}

function updateViewBadge() {
  const view = currentView();
  $('view-badge').hidden = Object.keys(VIEW_DEFAULTS).every(name => view[name] === VIEW_DEFAULTS[name]);
}

// Settings survive a reload; unknown or broken entries fall back to the default.
function restoreView() {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_STORE) || '{}');
    setView(Object.fromEntries(Object.keys(VIEW_DEFAULTS).filter(name => typeof saved[name] === 'string').map(name => [name, saved[name]])));
  } catch (_) { /* storage unavailable or corrupt: keep the defaults */ }
  updateViewBadge();
}

function saveView() {
  try { localStorage.setItem(VIEW_STORE, JSON.stringify(currentView())); } catch (_) { /* storage unavailable */ }
}

function setViewPanel(open, { focus = false } = {}) {
  const panel = $('view-panel'), button = $('view-button');
  panel.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  if (open) panel.querySelector('input:checked').focus();
  else if (focus) button.focus();
}

function setupViewPanel() {
  restoreView();
  const panel = $('view-panel'), tools = $('stage-tools');
  $('view-button').addEventListener('click', () => setViewPanel(panel.hidden));
  panel.addEventListener('change', () => { applyView(); saveView(); });
  $('view-reset').addEventListener('click', () => { setView(VIEW_DEFAULTS); applyView(); saveView(); });
  document.addEventListener('pointerdown', e => {
    if (!panel.hidden && !tools.contains(e.target)) setViewPanel(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !panel.hidden) setViewPanel(false, { focus: true });
  });
}

// ═══════════════════════════════════════════════════
//  History
// ═══════════════════════════════════════════════════
const CHARTS = [
  { key: 'x', title: 'X' },
  { key: 'y', title: 'Y' },
  { key: 'z', title: 'Z' },
  { key: 'm', title: '|B|' },
];
const charts = {};

function pushHistory(t, n) {
  st.history.push({
    t,
    lat: st.latest.slice(0, n).map(v => v.slice()),
    off: st.offsets.slice(0, n).map(v => v.slice()),
  });
  while (st.history.length && t - st.history[0].t > HISTORY_KEEP_MS) st.history.shift();
}

function buildCharts() {
  const grid = $('chart-grid');
  for (const c of CHARTS) {
    const card = el('div', 'chart-card');
    const head = el('div', 'chart-head');
    const title = el('span', 'chart-title', c.title);
    const legend = el('span', 'chart-legend');
    for (let i = 0; i < MAX_SENSOR_COUNT; i++) legend.append(el('i', `swatch swatch-s${i + 1}`), `S${i + 1}`);
    head.append(title, legend);
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${c.title} of sensors 1 to 4 over time`);
    card.append(head, canvas);
    grid.append(card);
    charts[c.key] = { canvas, ctx: canvas.getContext('2d'), title };
  }
}

function niceStep(raw) {
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * power >= raw) return m * power;
  return 10 * power;
}

const viewNow = () => st.paused ? st.pausedAt : performance.now();

function sampleValue(sample, i, key) {
  const v = readoutVals(sample.lat[i], sample.off[i]);
  const lsb = key === 'm' ? Math.hypot(...v) : v['xyz'.indexOf(key)];
  return st.unit === 'mT' ? lsb * MT_PER_LSB : lsb;
}

function drawCharts() {
  for (const c of CHARTS) {
    charts[c.key].title.textContent = `${c.title} · ${st.unit}`;
    drawChart(c.key);
  }
}

function drawChart(key) {
  const { canvas, ctx } = charts[key];
  const ratio = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  const pw = Math.round(W * ratio), ph = Math.round(H * ratio);
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const left = 52, right = 10, top = 10, bottom = 22;
  const plotW = W - left - right, plotH = H - top - bottom;
  if (plotW <= 0 || plotH <= 0) return;

  const now = viewNow();
  const start = now - st.windowMs;
  const samples = st.history.filter(s => s.t >= start - 200 && s.t <= now);

  let lo = Infinity, hi = -Infinity;
  for (const s of samples) for (let i = 0; i < s.lat.length; i++) {
    const v = sampleValue(s, i, key);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const minSpan = st.unit === 'mT' ? 1 : 30;
  if (lo > hi) { lo = key === 'm' ? 0 : -minSpan / 2; hi = lo + minSpan; }
  if (key === 'm') lo = Math.min(lo, 0);
  if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; if (key === 'm' && lo < 0) { hi -= lo; lo = 0; } }
  const step = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const span = hi - lo || 1;
  const decimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step) - 1e-9));

  const xOf = t => left + ((t - start) / st.windowMs) * plotW;
  const yOf = v => top + plotH - ((v - lo) / span) * plotH;

  ctx.font = "10px 'IBM Plex Mono', Consolas, monospace";
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = lo; v <= hi + step / 2; v += step) {
    const y = Math.round(yOf(v)) + 0.5;
    ctx.strokeStyle = CHART_PALETTE.grid;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(W - right, y); ctx.stroke();
    ctx.fillStyle = CHART_PALETTE.text;
    ctx.fillText((Math.abs(v) < step / 2 ? 0 : v).toFixed(decimals), left - 8, y);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const seconds = st.windowMs / 1000;
  const tStep = niceStep(seconds / 5);
  for (let rel = 0; rel >= -seconds - 1e-9; rel -= tStep) {
    const x = Math.round(left + ((rel + seconds) / seconds) * plotW) + 0.5;
    ctx.strokeStyle = CHART_PALETTE.grid;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + plotH); ctx.stroke();
    ctx.fillStyle = CHART_PALETTE.text;
    ctx.fillText(rel === 0 ? '0s' : `${rel}s`, x, top + plotH + 6);
  }

  ctx.strokeStyle = CHART_PALETTE.axis;
  ctx.beginPath();
  ctx.moveTo(left + 0.5, top); ctx.lineTo(left + 0.5, top + plotH + 0.5); ctx.lineTo(W - right, top + plotH + 0.5);
  ctx.stroke();

  if (!samples.length) {
    ctx.fillStyle = CHART_PALETTE.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No data', left + plotW / 2, top + plotH / 2);
    return;
  }

  ctx.save();
  ctx.beginPath(); ctx.rect(left, top, plotW, plotH); ctx.clip();
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  for (let i = 0; i < MAX_SENSOR_COUNT; i++) {
    ctx.strokeStyle = SENSOR_COLORS[i];
    ctx.beginPath();
    let pen = false;
    for (const s of samples) {
      if (i >= s.lat.length) { pen = false; continue; }
      const x = xOf(s.t), y = yOf(sampleValue(s, i, key));
      pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
  }
  ctx.restore();
}

// Charts scroll with time, so they are redrawn continuously while data flows.
let lastChartDraw = 0;
function chartLoop(t) {
  if ((st.running && !st.paused) || chartsDirty) {
    if (t - lastChartDraw > 33 || chartsDirty) {
      drawCharts();
      lastChartDraw = t;
      chartsDirty = false;
      $('stage-rate').textContent = st.running && st.phase === 'streaming' ? `${packetRate()} /s` : '–';
      if (st.running) updateLiveState();
    }
  }
  requestAnimationFrame(chartLoop);
}
let chartsDirty = true;

// ═══════════════════════════════════════════════════
//  Recording
// ═══════════════════════════════════════════════════
function captureRecording(raw, n) {
  if (!st.recording) return;
  const ts = new Date().toISOString();
  for (let i = 0; i < n; i++) {
    const [x, y, z, t, c] = raw[i];
    const off = st.offsets[i];
    const lat = st.latest[i];
    st.recRows.push([ts, i + 1, x, y, z, t, c, off[0], off[1], off[2], lat[0], lat[1], lat[2] - CALIBRATION_Z_TARGET].join(','));
  }
  $('rec-count').textContent = `${st.recRows.length} rows`;
}

function startRecording() {
  st.recording = true; st.recRows = []; st.csvBlob = null;
  $('rec-btn').textContent = 'Stop Recording'; $('rec-btn').className = 'danger-button';
  $('rec-dot').classList.add('active');
  $('dl-btn').hidden = true;
  $('rec-count').textContent = '0 rows';
}

function stopRecording() {
  st.recording = false;
  $('rec-btn').textContent = 'Start Recording'; $('rec-btn').className = 'secondary-button';
  $('rec-btn').disabled = !st.running;
  $('rec-dot').classList.remove('active');
  if (!st.recRows.length) return;
  const lines = [
    '# TLI493D Finger recording',
    `# Configuration: ${toHex(CONFIGURATIONS)} (range +/-${RANGE_MT} mT, ${OUTPUT_BITS}-bit, ${MT_PER_LSB.toFixed(6)} mT per LSB)`,
    '# Values in LSB as read from the sensor, without the display sign flips of the GUI.',
    `# delta = raw - offset - (0, 0, ${CALIBRATION_Z_TARGET})`,
    `# Recorded at: ${new Date().toISOString()}`,
    '',
    'timestamp,sensor,x_lsb,y_lsb,z_lsb,temp_lsb,frame_counter,offset_x_lsb,offset_y_lsb,offset_z_lsb,delta_x_lsb,delta_y_lsb,delta_z_lsb',
    ...st.recRows,
  ];
  st.csvBlob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  $('dl-btn').hidden = false;
  $('rec-count').textContent = `${st.recRows.length} rows — ready to download`;
}

function downloadCsv() {
  if (!st.csvBlob) return;
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(st.csvBlob);
  a.download = `finger_recording_${ts}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ═══════════════════════════════════════════════════
//  Initialisation
// ═══════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  if (!('serial' in navigator)) {
    $('unsupported').hidden = false;
    $('connect-button').disabled = true;
    setConnection('Web Serial not available', 'error');
  }

  buildValueTable();
  buildCharts();

  $('connect-button').addEventListener('click', connect);
  $('disconnect-button').addEventListener('click', () => disconnect());

  // Python: "Unit: mT/LSB" and "View: Delta/Absolute"
  document.querySelectorAll('input[name="unit"]').forEach(r => r.addEventListener('change', () => {
    st.unit = r.value; chartsDirty = true; render();
  }));
  document.querySelectorAll('input[name="view"]').forEach(r => r.addEventListener('change', () => {
    st.view = r.value; chartsDirty = true; render();
  }));
  $('recalibrate').addEventListener('click', () => {
    if (!st.running || st.phase !== 'streaming') return;
    st.recalRequested = true;
    updateRecalibrateButton();
  });

  setupViewPanel();

  $('window-select').addEventListener('change', e => { st.windowMs = Number(e.target.value) * 1000; chartsDirty = true; });
  $('pause-button').addEventListener('click', () => {
    st.paused = !st.paused;
    if (st.paused) st.pausedAt = performance.now();
    $('pause-button').textContent = st.paused ? 'Resume' : 'Pause';
    $('pause-button').classList.toggle('is-active', st.paused);
    chartsDirty = true;
  });
  $('clear-button').addEventListener('click', () => { st.history = []; chartsDirty = true; });

  $('rec-btn').addEventListener('click', () => { st.recording ? stopRecording() : startRecording(); });
  $('dl-btn').addEventListener('click', downloadCsv);

  new ResizeObserver(() => { drawMap(); chartsDirty = true; }).observe($('map-canvas'));
  $('map-foldout').addEventListener('toggle', () => drawMap());
  setConnectedUi(false);
  render();
  requestAnimationFrame(chartLoop);
  loadModel();
});
