// Orientation-based equirectangular stitching.
// For each output pixel (longitude, latitude), find the captured frame whose
// optical axis is closest to that direction, then sample its source pixel via
// pinhole projection. Feathered blending across overlap reduces seams.

const DEG = Math.PI / 180;

function rotMat(yawDeg, pitchDeg, rollDeg) {
  // R = Rz(-roll) * Rx(-pitch) * Ry(-yaw) -- camera-to-world inverse
  // We want world->camera so we can project a world ray into the camera frame.
  const y = -yawDeg * DEG, p = -pitchDeg * DEG, r = -rollDeg * DEG;
  const cy = Math.cos(y), sy = Math.sin(y);
  const cp = Math.cos(p), sp = Math.sin(p);
  const cr = Math.cos(r), sr = Math.sin(r);
  // Ry(yaw): rotate around Y (up)
  const Ry = [[cy,0,sy],[0,1,0],[-sy,0,cy]];
  // Rx(pitch): rotate around X
  const Rx = [[1,0,0],[0,cp,-sp],[0,sp,cp]];
  // Rz(roll): rotate around Z (camera forward)
  const Rz = [[cr,-sr,0],[sr,cr,0],[0,0,1]];
  return mul(mul(Rz, Rx), Ry);
}
function mul(A, B) {
  const C = [[0,0,0],[0,0,0],[0,0,0]];
  for (let i=0;i<3;i++) for (let j=0;j<3;j++)
    C[i][j] = A[i][0]*B[0][j] + A[i][1]*B[1][j] + A[i][2]*B[2][j];
  return C;
}
function applyR(R, v) {
  return [
    R[0][0]*v[0]+R[0][1]*v[1]+R[0][2]*v[2],
    R[1][0]*v[0]+R[1][1]*v[1]+R[1][2]*v[2],
    R[2][0]*v[0]+R[2][1]*v[1]+R[2][2]*v[2],
  ];
}

export async function stitchEquirectangular(captures, opts) {
  const W = opts.width, H = opts.height;
  const fov = opts.fovDeg * DEG;
  const onProgress = opts.onProgress || (() => {});

  // pre-extract source pixel data
  const sources = captures.map(c => {
    const ctx = c.canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, c.canvas.width, c.canvas.height);
    const fx = (c.canvas.width / 2) / Math.tan(fov / 2);
    const fy = fx; // assume square pixels
    return {
      data: img.data,
      W: c.canvas.width, H: c.canvas.height,
      fx, fy,
      cx: c.canvas.width / 2, cy: c.canvas.height / 2,
      R: rotMat(c.yaw, c.pitch, c.roll),
      forward: dirFromYawPitch(c.yaw, c.pitch),
    };
  });

  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const outCtx = out.getContext('2d');
  const outImg = outCtx.createImageData(W, H);
  const outData = outImg.data;

  // process row-by-row, yield to UI between bands
  const BAND = 32;
  for (let y0 = 0; y0 < H; y0 += BAND) {
    const y1 = Math.min(H, y0 + BAND);
    for (let y = y0; y < y1; y++) {
      const lat = (0.5 - y / H) * Math.PI; // +π/2 .. -π/2
      const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
      for (let x = 0; x < W; x++) {
        const lon = (x / W - 0.5) * 2 * Math.PI; // -π .. +π
        // world ray (unit vector). Convention: x=east, y=up, z=south(forward at lon=0).
        const wx = cosLat * Math.sin(lon);
        const wy = sinLat;
        const wz = cosLat * Math.cos(lon);

        // pick best source(s) by smallest angle to optical axis
        let r=0,g=0,b=0,wsum=0;
        for (const s of sources) {
          const dot = wx*s.forward[0] + wy*s.forward[1] + wz*s.forward[2];
          if (dot < 0.2) continue; // >~78° off axis: skip
          // project ray into camera frame
          const cv = applyR(s.R, [wx, wy, wz]);
          if (cv[2] <= 0) continue; // behind camera
          const u = s.fx * cv[0] / cv[2] + s.cx;
          const v = -s.fy * cv[1] / cv[2] + s.cy;
          if (u < 0 || u >= s.W - 1 || v < 0 || v >= s.H - 1) continue;
          // bilinear sample
          const x0 = Math.floor(u), y0 = Math.floor(v);
          const fx = u - x0, fy = v - y0;
          const i00 = (y0*s.W + x0) * 4;
          const i10 = i00 + 4;
          const i01 = i00 + s.W*4;
          const i11 = i01 + 4;
          const d = s.data;
          const sr = d[i00]*(1-fx)*(1-fy) + d[i10]*fx*(1-fy) + d[i01]*(1-fx)*fy + d[i11]*fx*fy;
          const sg = d[i00+1]*(1-fx)*(1-fy) + d[i10+1]*fx*(1-fy) + d[i01+1]*(1-fx)*fy + d[i11+1]*fx*fy;
          const sb = d[i00+2]*(1-fx)*(1-fy) + d[i10+2]*fx*(1-fy) + d[i01+2]*(1-fx)*fy + d[i11+2]*fx*fy;
          // weight: cos(angle) raised, plus distance from frame edge for feathering
          const edgeU = Math.min(u, s.W - 1 - u) / (s.W/2);
          const edgeV = Math.min(v, s.H - 1 - v) / (s.H/2);
          const edge = Math.min(edgeU, edgeV); // 0 at border, 1 at center
          const w = Math.pow(dot, 4) * Math.max(0, edge);
          if (w <= 0) continue;
          r += sr*w; g += sg*w; b += sb*w; wsum += w;
        }
        const o = (y*W + x) * 4;
        if (wsum > 0) {
          outData[o] = r/wsum; outData[o+1] = g/wsum; outData[o+2] = b/wsum; outData[o+3] = 255;
        } else {
          outData[o] = 0; outData[o+1] = 0; outData[o+2] = 0; outData[o+3] = 255;
        }
      }
    }
    onProgress(y1 / H);
    await new Promise(r => setTimeout(r, 0));
  }

  outCtx.putImageData(outImg, 0, 0);
  return out;
}

function dirFromYawPitch(yawDeg, pitchDeg) {
  const y = yawDeg * DEG, p = pitchDeg * DEG;
  return [
    Math.cos(p) * Math.sin(y),
    Math.sin(p),
    Math.cos(p) * Math.cos(y),
  ];
}
