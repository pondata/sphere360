import * as THREE from 'three';
import { buildTargets } from './targets.js';
import { stitchEquirectangular } from './stitch.js';
import { injectGPano } from './gpano.js';

const $ = (id) => document.getElementById(id);

const state = {
  video: null,
  stream: null,
  orientation: { alpha: 0, beta: 0, gamma: 0 },
  screenAngle: 0,
  targets: buildTargets(),
  captures: [],
  alignedTarget: null,
  alignedSince: 0,
  capturing: false,
  wakeLock: null,
};

const HOLD_MS = 600;
const ALIGN_TOLERANCE_DEG = 8;

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
  window.addEventListener('deviceorientation', (e) => {
    state.orientation.alpha = e.alpha ?? 0;
    state.orientation.beta = e.beta ?? 0;
    state.orientation.gamma = e.gamma ?? 0;
  }, true);
  const onScreenAngle = () => {
    state.screenAngle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  };
  onScreenAngle();
  window.addEventListener('orientationchange', onScreenAngle);
  if (screen.orientation) screen.orientation.addEventListener('change', onScreenAngle);
}

// Convert device orientation -> camera yaw/pitch (where the back camera is pointing).
// Approximation good enough for stitching when phone held vertically.
function cameraYawPitch() {
  const { alpha, beta, gamma } = state.orientation;
  // Phone vertical, back camera horizontal: yaw ~ alpha, pitch ~ beta - 90.
  let yaw = -alpha;
  let pitch = beta - 90;
  // wrap
  yaw = ((yaw + 540) % 360) - 180;
  pitch = Math.max(-90, Math.min(90, pitch));
  return { yaw, pitch };
}

// --- capture loop ---
function angularDistance(a, b) {
  // both in degrees, on sphere (yaw,pitch). use haversine-ish approximation.
  const toRad = Math.PI / 180;
  const φ1 = a.pitch * toRad, φ2 = b.pitch * toRad;
  const dφ = (b.pitch - a.pitch) * toRad;
  const dλ = (b.yaw - a.yaw) * toRad;
  const h = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) * 180 / Math.PI;
}

function captureLoop(ts) {
  if (!state.video) return;
  drawOverlay();
  const here = cameraYawPitch();

  // find nearest uncaptured target
  let best = null, bestDist = Infinity;
  for (const t of state.targets) {
    if (t.captured) continue;
    const d = angularDistance(here, t);
    if (d < bestDist) { bestDist = d; best = t; }
  }

  const aligned = best && bestDist < ALIGN_TOLERANCE_DEG;
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
    $('status').textContent = best ? `aim at the bright dot (${Math.round(bestDist)}°)` : 'all dots captured — tap Finish';
  }

  requestAnimationFrame(captureLoop);
}

function grabFrame(target) {
  state.capturing = true;
  const v = state.video;
  const w = v.videoWidth, h = v.videoHeight;
  if (!w || !h) { state.capturing = false; return; }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(v, 0, 0, w, h);
  const here = cameraYawPitch();
  state.captures.push({ canvas, yaw: here.yaw, pitch: here.pitch, roll: state.orientation.gamma });
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

  const here = cameraYawPitch();
  const fovX = 65; // approx iPhone back cam horizontal FOV
  const fovY = fovX * (H / W);

  for (const t of state.targets) {
    const dy = ((t.yaw - here.yaw + 540) % 360) - 180;
    const dp = t.pitch - here.pitch;
    if (Math.abs(dy) > fovX || Math.abs(dp) > fovY) continue;
    const x = W/2 + (dy / (fovX/2)) * (W/2);
    const y = H/2 - (dp / (fovY/2)) * (H/2);
    const aligned = state.alignedTarget === t;
    ctx.beginPath();
    ctx.arc(x, y, t.captured ? 14*dpr : (aligned ? 22*dpr : 16*dpr), 0, Math.PI*2);
    if (t.captured) {
      ctx.fillStyle = 'rgba(60,200,120,0.85)';
      ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2*dpr;
      ctx.beginPath();
      ctx.moveTo(x-5*dpr, y); ctx.lineTo(x-1*dpr, y+5*dpr); ctx.lineTo(x+6*dpr, y-4*dpr);
      ctx.stroke();
    } else {
      ctx.fillStyle = aligned ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.25)';
      ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2*dpr; ctx.stroke();
    }
  }

  // crosshair
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.5*dpr;
  ctx.beginPath();
  ctx.moveTo(W/2 - 12*dpr, H/2); ctx.lineTo(W/2 + 12*dpr, H/2);
  ctx.moveTo(W/2, H/2 - 12*dpr); ctx.lineTo(W/2, H/2 + 12*dpr);
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
    width: 4096, height: 2048, fovDeg: 65,
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
  $('counter').textContent = `0 / ${state.targets.length}`;
  show('start-screen');
}
