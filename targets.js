// Generate target dot grid covering the full sphere.
// Rings at fixed pitches; dot count per ring scales with cos(pitch) so spacing stays roughly uniform.
export function buildTargets() {
  const targets = [];
  const rings = [
    { pitch:  60, count: 4 },
    { pitch:  30, count: 8 },
    { pitch:   0, count: 8 },
    { pitch: -30, count: 8 },
    { pitch: -60, count: 4 },
  ];
  for (const ring of rings) {
    for (let i = 0; i < ring.count; i++) {
      const yaw = (i / ring.count) * 360 - 180;
      targets.push({ yaw, pitch: ring.pitch, captured: false });
    }
  }
  // zenith + nadir
  targets.push({ yaw: 0, pitch:  85, captured: false });
  targets.push({ yaw: 0, pitch: -85, captured: false });
  return targets;
}

export function nearestTarget(targets, yaw, pitch) {
  let best = null, bestD = Infinity;
  for (const t of targets) {
    if (t.captured) continue;
    const dy = ((t.yaw - yaw + 540) % 360) - 180;
    const dp = t.pitch - pitch;
    const d = Math.hypot(dy, dp);
    if (d < bestD) { bestD = d; best = t; }
  }
  return { target: best, distance: bestD };
}
