// Equirectangular stitching using captured rotation matrices (no Euler angles).
//
// Each capture stores R = R_userworld_to_device captured at the moment the
// frame was grabbed. For each output equirect pixel we build a user-world
// direction, rotate it into the capture's device frame, and project through a
// pinhole model where the back camera looks down -Z.

const DEG = Math.PI / 180;

function applyMat(M, v) {
  return [
    M[0][0]*v[0] + M[0][1]*v[1] + M[0][2]*v[2],
    M[1][0]*v[0] + M[1][1]*v[1] + M[1][2]*v[2],
    M[2][0]*v[0] + M[2][1]*v[1] + M[2][2]*v[2],
  ];
}

export async function stitchEquirectangular(captures, opts) {
  const W = opts.width, H = opts.height;
  const fovX = (opts.fovXDeg ?? 46) * DEG;
  const fovY = (opts.fovYDeg ?? 75) * DEG;
  const onProgress = opts.onProgress || (() => {});

  const sources = captures.map(c => {
    const ctx = c.canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, c.canvas.width, c.canvas.height);
    return {
      data: img.data,
      W: c.canvas.width, H: c.canvas.height,
      fx: (c.canvas.width  / 2) / Math.tan(fovX / 2),
      fy: (c.canvas.height / 2) / Math.tan(fovY / 2),
      cx: c.canvas.width  / 2,
      cy: c.canvas.height / 2,
      R: c.R,
      // forward direction in user-world: -Rᵀ · ẑ_device → -[col 2 of R]
      forward: [-c.R[0][2], -c.R[1][2], -c.R[2][2]],
    };
  });

  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const outCtx = out.getContext('2d');
  const outImg = outCtx.createImageData(W, H);
  const outData = outImg.data;

  const BAND = 32;
  for (let y0 = 0; y0 < H; y0 += BAND) {
    const y1 = Math.min(H, y0 + BAND);
    for (let y = y0; y < y1; y++) {
      const lat = (0.5 - y / H) * Math.PI;
      const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
      for (let x = 0; x < W; x++) {
        const lon = (x / W - 0.5) * 2 * Math.PI;
        // user-world direction matching targetDirUserWorld in main.js:
        //   yaw=0,pitch=0 → (0,0,-1)
        const wx =  Math.sin(lon) * cosLat;
        const wy =  sinLat;
        const wz = -Math.cos(lon) * cosLat;

        let r = 0, g = 0, b = 0, wsum = 0;
        for (const s of sources) {
          const dot = wx*s.forward[0] + wy*s.forward[1] + wz*s.forward[2];
          if (dot < 0.2) continue;
          const td = applyMat(s.R, [wx, wy, wz]);
          if (td[2] >= 0) continue; // behind back camera (forward = -Z)
          const u = s.cx + s.fx * td[0] / (-td[2]);
          const v = s.cy - s.fy * td[1] / (-td[2]);
          if (u < 0 || u >= s.W - 1 || v < 0 || v >= s.H - 1) continue;
          const x0 = Math.floor(u), y0p = Math.floor(v);
          const fxr = u - x0, fyr = v - y0p;
          const i00 = (y0p * s.W + x0) * 4;
          const i10 = i00 + 4;
          const i01 = i00 + s.W * 4;
          const i11 = i01 + 4;
          const d = s.data;
          const w00 = (1-fxr)*(1-fyr), w10 = fxr*(1-fyr), w01 = (1-fxr)*fyr, w11 = fxr*fyr;
          const sr = d[i00]*w00 + d[i10]*w10 + d[i01]*w01 + d[i11]*w11;
          const sg = d[i00+1]*w00 + d[i10+1]*w10 + d[i01+1]*w01 + d[i11+1]*w11;
          const sb = d[i00+2]*w00 + d[i10+2]*w10 + d[i01+2]*w01 + d[i11+2]*w11;
          const edgeU = Math.min(u, s.W - 1 - u) / (s.W / 2);
          const edgeV = Math.min(v, s.H - 1 - v) / (s.H / 2);
          const edge = Math.min(edgeU, edgeV);
          const w = Math.pow(dot, 4) * Math.max(0, edge);
          if (w <= 0) continue;
          r += sr*w; g += sg*w; b += sb*w; wsum += w;
        }
        const o = (y * W + x) * 4;
        if (wsum > 0) {
          outData[o] = r / wsum;
          outData[o+1] = g / wsum;
          outData[o+2] = b / wsum;
          outData[o+3] = 255;
        } else {
          outData[o+3] = 255;
        }
      }
    }
    onProgress(y1 / H);
    await new Promise(r => setTimeout(r, 0));
  }

  outCtx.putImageData(outImg, 0, 0);
  return out;
}
