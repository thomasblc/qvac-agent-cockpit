// QVAC CORE orb: a living audio-reactive entity on a 2D canvas.
// States: standby | listening | thinking | tool | speaking.
// Driven by an external audio level (0..1) for listening/speaking.

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

// Per-CORE shape personality. harmonics = [freq, amplitude, direction] sine terms
// that deform the blob; points + jitter shape the silhouette.
//  AXIS: round, calm, stable.   ECHO: faceted, analytical, sharp.   NOVA: organic, restless.
const PROFILES = {
  AXIS: { points: 64, harmonics: [[3, 1.0, 1], [5, 0.35, -1]], breath: 1.0, jitter: 0.0, spin: 0.12, partSpeed: 1.0 },
  ECHO: { points: 7,  harmonics: [[7, 0.5, 1], [3, 0.5, -1]], breath: 0.7, jitter: 0.0, spin: 0.5, partSpeed: 1.6 },
  NOVA: { points: 72, harmonics: [[4, 0.9, 1], [7, 0.6, -1], [13, 0.35, 1]], breath: 1.7, jitter: 0.12, spin: 0.45, partSpeed: 1.4 },
};

export class Orb {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.state = "standby";
    this.color = "#16E3C1";
    this.profile = PROFILES.AXIS;
    this.secondary = null;          // optional second color (NOVA red halo)
    this.rgb = hexToRgb(this.color);
    this.rgb2 = null;
    this.level = 0;                 // smoothed external audio level 0..1
    this.targetLevel = 0;
    this.t = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.particles = Array.from({ length: 64 }, (_, i) => ({
      a: (i / 64) * Math.PI * 2 + Math.random(),
      d: 0.9 + Math.random() * 0.9,
      s: 0.002 + Math.random() * 0.004,
      r: 0.6 + Math.random() * 1.6,
      ph: Math.random() * Math.PI * 2,
    }));
    this.rings = [];                // transient spin-off rings (tool calls)
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.w = rect.width;
    this.h = rect.height;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  setColor(hex, secondary = null) {
    this.color = hex; this.rgb = hexToRgb(hex);
    this.secondary = secondary; this.rgb2 = secondary ? hexToRgb(secondary) : null;
  }
  setProfile(name) { this.profile = PROFILES[name] || PROFILES.AXIS; }
  setState(s) { if (s === "tool" && this.state !== "tool") this.spawnRing(); this.state = s; }
  setLevel(v) { this.targetLevel = Math.max(0, Math.min(1, v)); }
  spawnRing() { this.rings.push({ r: 1, a: 0 }); }

  rgba(a, useSecondary = false) {
    const c = useSecondary && this.rgb2 ? this.rgb2 : this.rgb;
    return `rgba(${c.r},${c.g},${c.b},${a})`;
  }

  start() {
    const loop = () => { this.draw(); this._raf = requestAnimationFrame(loop); };
    loop();
  }
  stop() { if (this._raf) cancelAnimationFrame(this._raf); }

  draw() {
    const ctx = this.ctx;
    this.t += 1 / 60;
    this.level += (this.targetLevel - this.level) * 0.18;

    const P = this.profile;
    const cx = this.w / 2, cy = this.h / 2;
    const base = Math.min(this.w, this.h) * 0.13;
    const breath = Math.sin(this.t * P.breath) * 0.03;
    let R = base * (1 + breath);

    // State-driven modifiers (seeded by the CORE's shape profile)
    let spin = P.spin, deform = 0.04 + P.jitter * 0.25, particlePull = 0;
    if (this.state === "listening") { R *= 1 + this.level * 0.35; deform = 0.05 + this.level * 0.12; particlePull = -0.35; spin = 0.25; }
    else if (this.state === "thinking") { spin = 0.9; deform = 0.10; particlePull = 0.0; }
    else if (this.state === "tool") { spin = 1.4; deform = 0.07; }
    else if (this.state === "speaking") { R *= 1 + this.level * 0.45; deform = 0.05 + this.level * 0.15; particlePull = 0.4; spin = 0.4; }

    ctx.clearRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = "lighter";

    // Outer glow
    const glowR = R * (3.4 + this.level * 1.2);
    const g = ctx.createRadialGradient(cx, cy, R * 0.3, cx, cy, glowR);
    g.addColorStop(0, this.rgba(0.16 + this.level * 0.12));
    g.addColorStop(0.4, this.rgba(0.05));
    g.addColorStop(1, this.rgba(0));
    ctx.fillStyle = g;
    ctx.fillRect(cx - glowR, cy - glowR, glowR * 2, glowR * 2);

    // Particles
    for (const p of this.particles) {
      p.a += p.s * (1 + spin);
      const targetD = 1 + particlePull * Math.sin(this.t * 2 + p.ph) * 0.5 + particlePull;
      p.d += (Math.max(0.5, targetD) - p.d) * 0.04;
      const dist = R * (1.7 * p.d) + Math.sin(this.t * 3 + p.ph) * 4;
      const px = cx + Math.cos(p.a) * dist;
      const py = cy + Math.sin(p.a) * dist;
      const alpha = 0.5 + 0.5 * Math.sin(this.t * 2 + p.ph);
      ctx.beginPath();
      ctx.fillStyle = this.rgba(0.25 + alpha * 0.4, p.ph > Math.PI && this.rgb2);
      ctx.arc(px, py, p.r * (0.6 + this.level * 0.8), 0, Math.PI * 2);
      ctx.fill();
    }

    // Spin-off rings (tool calls)
    this.rings = this.rings.filter((ring) => {
      ring.r += 0.04; ring.a += 0.03;
      const rr = R * (1 + ring.r * 2.2);
      const alpha = Math.max(0, 0.5 - ring.r * 0.5);
      if (alpha <= 0) return false;
      ctx.beginPath();
      ctx.strokeStyle = this.rgba(alpha, true);
      ctx.lineWidth = 1.5;
      ctx.arc(cx, cy, rr, ring.a, ring.a + Math.PI * 1.4);
      ctx.stroke();
      return true;
    });

    // Halo ring
    ctx.beginPath();
    ctx.strokeStyle = this.rgba(0.3 + this.level * 0.3);
    ctx.lineWidth = 1.5;
    ctx.arc(cx, cy, R * 1.5, 0, Math.PI * 2);
    ctx.stroke();

    // Rotating arcs (thinking/tool feel)
    if (this.state === "thinking" || this.state === "tool") {
      for (let i = 0; i < 3; i++) {
        const off = this.t * spin + (i * Math.PI * 2) / 3;
        ctx.beginPath();
        ctx.strokeStyle = this.rgba(0.4 - i * 0.1, this.state === "tool");
        ctx.lineWidth = 2;
        ctx.arc(cx, cy, R * (1.9 + i * 0.25), off, off + Math.PI * 0.6);
        ctx.stroke();
      }
    }

    // Core blob, shaped by the active CORE's harmonic profile
    ctx.beginPath();
    const N = P.points;
    for (let i = 0; i <= N; i++) {
      const ang = (i / N) * Math.PI * 2;
      let wobble = 1;
      for (const [freq, amp, dir] of P.harmonics) wobble += Math.sin(ang * freq + this.t * 1.8 * dir) * deform * amp;
      if (P.jitter) wobble += Math.sin(ang * 17 + this.t * 3.3) * P.jitter * (0.5 + this.level);
      const rr = R * wobble;
      const x = cx + Math.cos(ang) * rr, y = cy + Math.sin(ang) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    const core = ctx.createRadialGradient(cx - R * 0.2, cy - R * 0.2, R * 0.1, cx, cy, R * 1.1);
    core.addColorStop(0, "rgba(240,240,240,0.95)");
    core.addColorStop(0.3, this.rgba(0.95));
    core.addColorStop(1, this.rgba(0.5, true));
    ctx.fillStyle = core;
    ctx.shadowBlur = 40 + this.level * 40;
    ctx.shadowColor = this.rgba(0.7);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.globalCompositeOperation = "source-over";
  }
}
