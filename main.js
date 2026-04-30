import * as THREE from 'three';
import { buildTargets } from './targets.js';
import { stitchEquirectangular } from './stitch.js';
import { injectGPano } from './gpano.js';

const $ = (id) => document.getElementById(id);

const state = {
  video: null,
  stream: null,
  orientation: { alpha: 0, beta: 0, gamma: 0 },
  initialR: null, // device->earth rotation captured on first reading; defines user-world frame
  screenAngle: 0,
  targets: buildTargets(),
  captures: [],
  alignedTarget: null,
  alignedSince: 0,
  capturing: false,
  wakeLock: null,
};

const HOLD_MS = 600;
// Screen-space tolerance: distance from the crosshair, normalized so the
// horizontal half-screen = 1 and the vertical half-screen = 1. ~0.18 ≈ a
// small circle around the center on a portrait phone.
const ALIGN_SCREEN_TOLERANCE = 0.18;
// iPhone main back camera, portrait orientation (sensor short side = screen width).
const FOV_X_DEG = 46;
const FOV_Y_DEG = 75;
const DEG = Math.PI / 180;

// --- screens ---
function show(id) {
  for (const el of document.querySelectorAll('.screen')) el.classList.add('hidden');
  $(id).classList.remove('hidden');
}

// --- start ---
$('start-btn').addEventListener('click', async () => {
  try {
    await requestPermissions();
    await startCamera();
    attachOrientation();
    await acquireWakeLock();
    show('capture-screen');
    requestAnimationFrame(captureLoop);
  } catch (err) {
    alert('Could not start: ' + err.message);
  }
});

$('cancel-btn').addEventListener('click', () => teardownAndReset());
$('finish-btn').addEventListener('click', () => finish());
$('restart-btn').addEventListener('click', () => location.reload());

// --- permissions ---
async function requestPermissions() {
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    const res = await DeviceOrientationEvent.requestPermission();
    if (res !== 'granted') throw new Error('Motion permission denied');
  }
}

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  });
  state.stream = stream;
  state.video = $('video');
  state.video.srcObject = stream;
  await state.video.play();
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen');
  } catch {}
}

// --- orientation ---
function attachOrientation() {
  const handler = (e) => {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    state.orientation.alpha = e.alpha;
    state.orientation.beta = e.beta;
    state.orientation.gamma = e.gamma;
    if (state.initialR === null) {
      state.initialR = deviceToEarth(e.alpha, e.beta, e.gamma);
    }
  };
  window.addEventListener('deviceorientation', handler, true);
  window.addEventListener('deviceorientationabsolute', handler, true);
  const onScreenAngle = () => {
    state.screenAngle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  };
  onScreenAngle();
  window.addEventListener('orientationchange', onScreenAngle);
  if (screen.orientation) screen.orientation.addEventListener('change', onScreenAngle);
}

// W3C DeviceOrientation: device->earth rotation matrix R = Rz(α)·Rx(β)·Ry(γ)
// applied to the device frame (X=right, Y=top, Z=out-of-screen) to get earth frame.
function deviceToEarth(alphaDeg, betaDeg, gammaDeg) {
  const a = alphaDeg * DEG, b = betaDeg * DEG, g = gammaDeg * DEG;
  const ca = Math.cos(a), sa = Math.sin(a);
  const cb = Math.cos(b), sb = Math.sin(b);
  const cg = Math.cos(g), sg = Math.sin(g);
  return [
    [ ca*cg - sa*sb*sg, -sa*cb, ca*sg + sa*sb*cg ],
    [ sa*cg + ca*sb*sg,  ca*cb, sa*sg - ca*sb*cg ],
    [          -cb*sg,      sb,            cb*cg ],
  ];
}

// Mat3 helpers
function applyMat(M, v) {
  return [
    M[0][0]*v[0] + M[0][1]*v[1] + M[0][2]*v[2],
    M[1][0]*v[0] + M[1][1]*v[1] + M[1][2]*v[2],
    M[2][0]*v[0] + M[2][1]*v[1] + M[2][2]*v[2],
  ];
}
// Returns Aᵀ · B
function tmm(A, B) {
  const C = [[0,0,0],[0,0,0],[0,0,0]];
  for (let i=0;i<3;i++) for (let j=0;j<3;j++)
    C[i][j] = A[0][i]*B[0][j] + A[1][i]*B[1][j] + A[2][i]*B[2][j];
  return C;
}

// User-world direction for a target at (yaw, pitch).
// Convention: yaw=0,pitch=0 is the camera's forward direction at start (device -Z at t0).
//   yaw  -> rotation around user-world +Y (vertical, up)
//   pitch -> tilt up
function targetDirUserWorld(yawDeg, pitchDeg) {
  const y = yawDeg * DEG, p = pitchDeg * DEG;
  return [
     Math.sin(y) * Math.cos(p),
     Math.sin(p),
    -Math.cos(y) * Math.cos(p),
  ];
}

// R that maps user-world vectors into the current device frame.
// user-world ≡ device frame at t0, so:
//   v_device(t) = deviceToEarth(t)ᵀ · deviceToEarth(t0) · v_userworld
function currentRwd() {
  if (!state.initialR) return [[1,0,0],[0,1,0],[0,0,1]];
  const Rcur = deviceToEarth(state.orientation.alpha, state.orientation.beta, state.orientation.gamma);
  return tmm(Rcur, state.initialR);
}

// Camera forward in user-world (back camera looks down device -Z).
//   forward_userworld = (R_device_to_userworld) · (0,0,-1) = Rwdᵀ · (0,0,-1) = -[col 2 of Rwd]
function cameraForwardUserWorld() {
  const R = currentRwd();
  return [-R[0][2], -R[1][2], -R[2][2]];
}

// Convert a unit forward direction to (yaw, pitch) under our convention.
function dirToYawPitch(d) {
  const pitch = Math.asin(Math.max(-1, Math.min(1, d[1]))) / DEG;
  const yaw = Math.atan2(d[0], -d[2]) / DEG;
  return { yaw, pitch };
}

// --- capture loop ---
function captureLoop(ts) {
  if (!state.video) return;
  drawOverlay();

  // Pick the target whose projected screen position is closest to the crosshair.
  // Using projected distance (rather than angular distance) is what matches the
  // user's eye, since FOV_X ≠ FOV_Y on a portrait phone.
  const Rwd = currentRwd();
  const tanX = Math.tan(FOV_X_DEG / 2 * DEG);
  const tanY = Math.tan(FOV_Y_DEG / 2 * DEG);
  let best = null, bestScreenDist = Infinity;
  for (const t of state.targets) {
    if (t.captured) continue;
    const td = applyMat(Rwd, targetDirUserWorld(t.yaw, t.pitch));
    if (td[2] >= 0) continue; // behind back camera
    const nx = (td[0] / (-td[2])) / tanX;
    const ny = (td[1] / (-td[2])) / tanY;
    const sd = Math.hypot(nx, ny);
    if (sd < bestScreenDist) { bestScreenDist = sd; best = t; }
  }

  const aligned = best && bestScreenDist < ALIGN_SCREEN_TOLERANCE;
  if (aligned) {
    if (state.alignedTarget !== best) {
      state.alignedTarget = best;
      state.alignedSince = ts;
    } else if (!state.capturing && ts - state.alignedSince > HOLD_MS) {
      grabFrame(best);
    }
    $('status').textContent = state.capturing ? 'captured ✓' : `hold still… ${Math.max(0, Math.round((HOLD_MS - (ts - state.alignedSince))/100)/10)}s`;
  } else {
    state.alignedTarget = null;
    if (state.targets.every(t => t.captured)) {
      $('status').textContent = 'all dots captured — tap Finish';
    } else if (best) {
      $('status').textContent = 'aim the crosshair at the nearest dot';
    } else {
      $('status').textContent = 'rotate to find a dot';
    }
  }

  requestAnimationFrame(captureLoop);
}

function grabFrame(target) {
  state.capturing = true;
  const v = state.video;
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh) { state.capturing = false; return; }

  // Always normalize the captured canvas into "portrait" orientation so that
  // pixel +X = device +X (right edge) and pixel +Y = device -Y (down). On iOS
  // Safari the raw stream is often the sensor's native landscape (vw > vh);
  // rotate it 90° clockwise so the captured frame matches the device pose.
  const canvas = document.createElement('canvas');
  const ctx0 = canvas.getContext('2d');
  if (vh >= vw) {
    canvas.width = vw; canvas.height = vh;
    ctx0.drawImage(v, 0, 0, vw, vh);
  } else {
    canvas.width = vh; canvas.height = vw;
    ctx0.translate(vh, 0);
    ctx0.rotate(Math.PI / 2);
    ctx0.drawImage(v, 0, 0, vw, vh);
  }

  state.captures.push({ canvas, R: currentRwd() });
  target.captured = true;
  $('counter').textContent = `${state.captures.filter(()=>true).length} / ${state.targets.length}`;
  setTimeout(() => { state.capturing = false; }, 250);

  // auto-finish when all captured
  if (state.targets.every(t => t.captured)) setTimeout(finish, 400);
}

// --- overlay ---
function drawOverlay() {
  const c = $('overlay');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = c.clientWidth * dpr, H = c.clientHeight * dpr;
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const Rwd = currentRwd();
  const fx = (W / 2) / Math.tan(FOV_X_DEG / 2 * DEG);
  const fy = (H / 2) / Math.tan(FOV_Y_DEG / 2 * DEG);

  // Project a user-world direction (yaw, pitch) into screen pixels.
  // td = Rwd · target_userworld; back camera looks down -Z, so visible iff td.z < 0.
  const project = (worldYaw, worldPitch) => {
    const td = applyMat(Rwd, targetDirUserWorld(worldYaw, worldPitch));
    if (td[2] >= -0.05) return null;
    return { x: W/2 + fx * td[0] / (-td[2]), y: H/2 - fy * td[1] / (-td[2]) };
  };

  // horizon line (great circle at pitch=0) — gives a stable visual anchor
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1*dpr;
  ctx.beginPath();
  let started = false;
  for (let yawW = -180; yawW <= 180; yawW += 2) {
    const p = project(yawW, 0);
    if (!p || p.x < -50 || p.x > W+50 || p.y < -50 || p.y > H+50) { started = false; continue; }
    if (!started) { ctx.moveTo(p.x, p.y); started = true; } else { ctx.lineTo(p.x, p.y); }
  }
  ctx.stroke();

  for (const t of state.targets) {
    const p = project(t.yaw, t.pitch);
    if (!p) continue;
    if (p.x < -40 || p.x > W+40 || p.y < -40 || p.y > H+40) continue;
    const aligned = state.alignedTarget === t;
    ctx.beginPath();
    ctx.arc(p.x, p.y, t.captured ? 14*dpr : (aligned ? 22*dpr : 16*dpr), 0, Math.PI*2);
    if (t.captured) {
      ctx.fillStyle = 'rgba(60,200,120,0.85)';
      ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2*dpr;
      ctx.beginPath();
      ctx.moveTo(p.x-5*dpr, p.y); ctx.lineTo(p.x-1*dpr, p.y+5*dpr); ctx.lineTo(p.x+6*dpr, p.y-4*dpr);
      ctx.stroke();
    } else {
      ctx.fillStyle = aligned ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.30)';
      ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2*dpr; ctx.stroke();
    }
  }

  // fixed-on-screen crosshair (this one IS supposed to track the phone)
  ctx.strokeStyle = 'rgba(255,255,255,0.65)';
  ctx.lineWidth = 1.5*dpr;
  ctx.beginPath();
  ctx.moveTo(W/2 - 14*dpr, H/2); ctx.lineTo(W/2 + 14*dpr, H/2);
  ctx.moveTo(W/2, H/2 - 14*dpr); ctx.lineTo(W/2, H/2 + 14*dpr);
  ctx.stroke();
}

// --- finish + stitch ---
async function finish() {
  if (state.captures.length < 2) {
    alert('Capture at least 2 frames first.');
    return;
  }
  show('stitch-screen');
  $('stitch-status').textContent = `Stitching ${state.captures.length} frames…`;

  // release camera before heavy work
  if (state.stream) { for (const t of state.stream.getTracks()) t.stop(); state.stream = null; }

  await new Promise(r => setTimeout(r, 50));
  const equirect = await stitchEquirectangular(state.captures, {
    width: 4096, height: 2048, fovXDeg: FOV_X_DEG, fovYDeg: FOV_Y_DEG,
    onProgress: (p) => { $('stitch-status').textContent = `Stitching… ${Math.round(p*100)}%`; },
  });

  $('stitch-status').textContent = 'Encoding JPEG…';
  await new Promise(r => setTimeout(r, 30));

  const blob = await new Promise(res => equirect.toBlob(res, 'image/jpeg', 0.92));
  const arrayBuf = await blob.arrayBuffer();
  const tagged = injectGPano(new Uint8Array(arrayBuf), equirect.width, equirect.height);
  const finalBlob = new Blob([tagged], { type: 'image/jpeg' });
  const url = URL.createObjectURL(finalBlob);

  $('download-link').href = url;
  show('result-screen');
  initViewer(equirect);
}

// --- viewer ---
function initViewer(canvasTexture) {
  const container = $('viewer-container');
  container.innerHTML = '';
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
  camera.position.set(0, 0, 0.01);

  const tex = new THREE.CanvasTexture(canvasTexture);
  tex.colorSpace = THREE.SRGBColorSpace;
  const geo = new THREE.SphereGeometry(500, 60, 40);
  geo.scale(-1, 1, 1);
  const mat = new THREE.MeshBasicMaterial({ map: tex });
  scene.add(new THREE.Mesh(geo, mat));

  // simple touch drag
  let lon = 0, lat = 0, isDown = false, downX = 0, downY = 0, downLon = 0, downLat = 0;
  const onDown = (e) => {
    isDown = true;
    const p = e.touches ? e.touches[0] : e;
    downX = p.clientX; downY = p.clientY; downLon = lon; downLat = lat;
  };
  const onMove = (e) => {
    if (!isDown) return;
    const p = e.touches ? e.touches[0] : e;
    lon = downLon - (p.clientX - downX) * 0.2;
    lat = Math.max(-85, Math.min(85, downLat + (p.clientY - downY) * 0.2));
  };
  const onUp = () => { isDown = false; };
  renderer.domElement.addEventListener('touchstart', onDown, { passive: true });
  renderer.domElement.addEventListener('touchmove', onMove, { passive: true });
  renderer.domElement.addEventListener('touchend', onUp);
  renderer.domElement.addEventListener('mousedown', onDown);
  renderer.domElement.addEventListener('mousemove', onMove);
  renderer.domElement.addEventListener('mouseup', onUp);

  function tick() {
    const phi = THREE.MathUtils.degToRad(90 - lat);
    const theta = THREE.MathUtils.degToRad(lon);
    camera.lookAt(
      500 * Math.sin(phi) * Math.cos(theta),
      500 * Math.cos(phi),
      500 * Math.sin(phi) * Math.sin(theta),
    );
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  tick();

  window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });
}

// --- teardown ---
function teardownAndReset() {
  if (state.stream) { for (const t of state.stream.getTracks()) t.stop(); state.stream = null; }
  if (state.wakeLock) { try { state.wakeLock.release(); } catch {} state.wakeLock = null; }
  state.captures = [];
  state.targets = buildTargets();
  state.initialR = null;
  $('counter').textContent = `0 / ${state.targets.length}`;
  show('start-screen');
}
