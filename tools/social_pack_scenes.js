#!/usr/bin/env node
/**
 * Concepts 08 (night car) and 09 (iced coffee), drawn locally in SVG instead of generated.
 *
 * These are the only two concepts left, and the Vertex quota was costing minutes per image.
 * Drawing them costs nothing and finishes instantly — the trade is that they read as stylised
 * illustration, not photography. That is a deliberate choice, not a limitation being hidden:
 * a code-drawn "photo" would look like a bad photo, so these lean fully into flat/gradient art
 * that looks intentional at feed size.
 *
 *   node tools/social_pack_scenes.js --per 8
 */
const fs = require('node:fs');
const path = require('node:path');
const sharp = require(path.join(__dirname, '..', 'node_modules', 'sharp'));

const W = 1080, H = 1350;                       // 4:5
const OUT = path.join('C:/Users/asusg/Downloads', `social-pack-FINAL-${new Date().toISOString().slice(0, 10)}`);

/** Deterministic PRNG so every variant differs but a given variant is reproducible. */
function rng(seed) {
  let s = seed * 9301 + 49297;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

/** 08 — car interior at night: bokeh city lights, rain on glass, dashboard glow. */
function nightCar(v) {
  const r = rng(v * 137 + 11);
  const palettes = [
    ['#05070f', '#0d1526', '#1b2b4a', '#ffb56b'],
    ['#07060d', '#131024', '#2a1f47', '#ff9e7a'],
    ['#04080c', '#0b1a22', '#16333f', '#7fd4ff'],
    ['#080510', '#171029', '#33204d', '#ffd07a'],
    ['#03060a', '#0a141f', '#152a3d', '#9ad9ff'],
    ['#0a0710', '#1a1226', '#3a2145', '#ffb0c8'],
    ['#050810', '#101a2e', '#1f3355', '#ffc98a'],
    ['#06050c', '#120f1f', '#241d38', '#ff8f6b'],
  ][v % 8];
  const [deep, mid, hi, warm] = palettes;

  // Bokeh: the whole look rests on these — varied radius and opacity reads as depth.
  let bokeh = '';
  const n = 22 + Math.floor(r() * 14);
  for (let i = 0; i < n; i += 1) {
    const cx = r() * W;
    const cy = 180 + r() * (H * 0.52);
    const rad = 14 + r() * 62;
    const cols = [warm, '#fff2d6', '#8ec5ff', '#ff9ec4', '#b9ffd9'];
    const col = cols[Math.floor(r() * cols.length)];
    bokeh += `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${rad.toFixed(0)}" fill="${col}" opacity="${(0.10 + r() * 0.32).toFixed(2)}" filter="url(#blur)"/>`;
  }

  // Rain: near-vertical streaks, slight lean, varying length.
  let rain = '';
  for (let i = 0; i < 110; i += 1) {
    const x = r() * W, y = r() * H * 0.78, len = 16 + r() * 54, lean = 5 + r() * 9;
    rain += `<line x1="${x.toFixed(0)}" y1="${y.toFixed(0)}" x2="${(x + lean).toFixed(0)}" y2="${(y + len).toFixed(0)}" stroke="#dbeaff" stroke-width="${(0.9 + r() * 1.5).toFixed(1)}" opacity="${(0.10 + r() * 0.26).toFixed(2)}" stroke-linecap="round"/>`;
  }
  // Beaded droplets catching light — what sells "rain on glass" over "rain outside".
  let drops = '';
  for (let i = 0; i < 46; i += 1) {
    const x = r() * W, y = r() * H * 0.72, rr = 2 + r() * 7;
    drops += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${rr.toFixed(1)}" fill="#eaf4ff" opacity="${(0.12 + r() * 0.30).toFixed(2)}"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${deep}"/><stop offset="46%" stop-color="${mid}"/><stop offset="100%" stop-color="${hi}"/>
    </linearGradient>
    <radialGradient id="dash" cx="50%" cy="100%" r="72%">
      <stop offset="0%" stop-color="${warm}" stop-opacity="0.50"/><stop offset="100%" stop-color="${warm}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vig" cx="50%" cy="46%" r="76%">
      <stop offset="60%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.70"/>
    </radialGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="26"/></filter>
    <filter id="soft"><feGaussianBlur stdDeviation="7"/></filter>
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" seed="${v * 7}"/>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.16"/></feComponentTransfer>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  ${bokeh}
  <rect width="${W}" height="${H}" fill="url(#dash)"/>
  ${rain}${drops}

  <!-- windshield surround: dark pillars + roofline frame the shot as an interior -->
  <path d="M0 0 h${W} v168 q-${W / 2} 74 -${W} 0 z" fill="#04050a" opacity="0.94"/>
  <path d="M0 ${H} h${W} v-320 q-${W / 2} -128 -${W} 0 z" fill="#06070d" opacity="0.96"/>
  <rect x="0" y="0" width="86" height="${H}" fill="#04050a" opacity="0.90"/>
  <rect x="${W - 86}" y="0" width="86" height="${H}" fill="#04050a" opacity="0.90"/>

  <!-- dashboard instrument glow -->
  <ellipse cx="${W * 0.30}" cy="${H - 196}" rx="132" ry="34" fill="${warm}" opacity="0.24" filter="url(#soft)"/>
  <ellipse cx="${W * 0.68}" cy="${H - 214}" rx="96" ry="26" fill="${warm}" opacity="0.18" filter="url(#soft)"/>
  <rect x="${W * 0.24}" y="${H - 214}" width="150" height="7" rx="3.5" fill="${warm}" opacity="0.55"/>
  <rect x="${W * 0.60}" y="${H - 230}" width="104" height="6" rx="3" fill="${warm}" opacity="0.44"/>

  <rect width="${W}" height="${H}" fill="url(#vig)"/>
  <rect width="${W}" height="${H}" filter="url(#grain)" opacity="0.5"/>
</svg>`;
}

/** 09 — iced coffee on marble, warm morning light. */
function coffee(v) {
  const r = rng(v * 211 + 5);
  const [bg, veinCol, brew, foam] = [
    ['#f3efe9', '#d9d2c7', '#6b4327', '#e8d3bb'],
    ['#f6f2ec', '#ded6c9', '#7a4d2c', '#f0dcc4'],
    ['#efe9e1', '#d3cabc', '#5f3a21', '#e2cbb0'],
    ['#f8f4ee', '#e2dacd', '#804f2d', '#f2e0c9'],
    ['#f1ece5', '#d7cfc1', '#6f4526', '#ead6bd'],
    ['#f5f0e8', '#dcd3c5', '#754a2a', '#eeddc6'],
    ['#eee8e0', '#d1c8ba', '#65402a', '#e5cfb4'],
    ['#f7f3ed', '#e0d8cb', '#7d4e2e', '#f1dfc8'],
  ][v % 8];

  let veins = '';
  for (let i = 0; i < 9; i += 1) {
    const x0 = r() * W, y0 = r() * H;
    veins += `<path d="M${x0.toFixed(0)} ${y0.toFixed(0)} q${(90 + r() * 240).toFixed(0)} ${(-140 + r() * 280).toFixed(0)} ${(240 + r() * 420).toFixed(0)} ${(-70 + r() * 200).toFixed(0)}"
      stroke="${veinCol}" stroke-width="${(1.2 + r() * 2.6).toFixed(1)}" fill="none" opacity="${(0.28 + r() * 0.34).toFixed(2)}" stroke-linecap="round"/>`;
  }

  const cx = W / 2 + (-40 + r() * 80);
  const cupW = 300, cupH = 430, top = H * 0.31;

  // Ice cubes, drawn before the glass tint so the glass sits over them.
  let ice = '';
  for (let i = 0; i < 5; i += 1) {
    const ix = cx - cupW / 2 + 42 + r() * (cupW - 130);
    const iy = top + 54 + r() * (cupH * 0.52);
    const s = 46 + r() * 34;
    ice += `<rect x="${ix.toFixed(0)}" y="${iy.toFixed(0)}" width="${s.toFixed(0)}" height="${(s * 0.82).toFixed(0)}" rx="10"
      fill="#ffffff" opacity="${(0.20 + r() * 0.20).toFixed(2)}" transform="rotate(${(-24 + r() * 48).toFixed(0)} ${(ix + s / 2).toFixed(0)} ${(iy + s / 2).toFixed(0)})"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="marble" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffffff"/><stop offset="50%" stop-color="${bg}"/><stop offset="100%" stop-color="#e7e0d6"/>
    </linearGradient>
    <linearGradient id="brewg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${foam}"/><stop offset="26%" stop-color="${brew}"/><stop offset="100%" stop-color="#3d2415"/>
    </linearGradient>
    <radialGradient id="sun" cx="24%" cy="14%" r="62%">
      <stop offset="0%" stop-color="#fff6e2" stop-opacity="0.92"/><stop offset="100%" stop-color="#fff6e2" stop-opacity="0"/>
    </radialGradient>
    <filter id="sh"><feGaussianBlur stdDeviation="22"/></filter>
    <filter id="grain2">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${v * 13}"/>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.10"/></feComponentTransfer>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#marble)"/>
  ${veins}
  <rect width="${W}" height="${H}" fill="url(#sun)"/>

  <!-- cast shadow: sun is upper-left, so the shadow falls right -->
  <ellipse cx="${(cx + 66).toFixed(0)}" cy="${(top + cupH + 26).toFixed(0)}" rx="196" ry="40" fill="#a99b88" opacity="0.34" filter="url(#sh)"/>

  <!-- glass: slight taper reads as a real tumbler -->
  <path d="M${cx - cupW / 2} ${top} h${cupW} l-26 ${cupH} h-${cupW - 52} z" fill="#ffffff" opacity="0.30"/>
  <path d="M${cx - cupW / 2 + 15} ${top + 66} h${cupW - 30} l-22 ${cupH - 96} h-${cupW - 74} z" fill="url(#brewg)"/>
  ${ice}
  <path d="M${cx - cupW / 2} ${top} h${cupW} l-26 ${cupH} h-${cupW - 52} z" fill="none" stroke="#ffffff" stroke-width="5" opacity="0.72"/>
  <ellipse cx="${cx}" cy="${top}" rx="${cupW / 2}" ry="30" fill="#ffffff" opacity="0.46"/>
  <ellipse cx="${cx}" cy="${top}" rx="${cupW / 2}" ry="30" fill="none" stroke="#ffffff" stroke-width="5" opacity="0.80"/>
  <!-- specular highlight down the left edge -->
  <rect x="${cx - cupW / 2 + 26}" y="${top + 40}" width="15" height="${cupH - 130}" rx="7.5" fill="#ffffff" opacity="0.52"/>

  <!-- gold rings resting beside the glass, standing in for the styling detail -->
  <circle cx="${cx - 250}" cy="${top + cupH - 34}" r="26" fill="none" stroke="#d8b366" stroke-width="9" opacity="0.92"/>
  <circle cx="${cx - 198}" cy="${top + cupH + 6}" r="19" fill="none" stroke="#e0c078" stroke-width="7" opacity="0.88"/>

  <rect width="${W}" height="${H}" filter="url(#grain2)" opacity="0.42"/>
</svg>`;
}

(async () => {
  const per = parseInt((process.argv[process.argv.indexOf('--per') + 1] || '8'), 10);
  fs.mkdirSync(OUT, { recursive: true });
  const specs = [
    { prefix: '08_night-car', draw: nightCar },
    { prefix: '09_coffee-stilllife', draw: coffee },
  ];

  let made = 0;
  for (const s of specs) {
    // Replace the whole concept rather than topping it up: two photoreal frames sitting beside
    // six illustrated ones would look like a mistake. Internally consistent beats mixed.
    for (const f of fs.readdirSync(OUT).filter((f) => f.startsWith(s.prefix + '_'))) {
      fs.rmSync(path.join(OUT, f), { force: true });
    }
    for (let v = 1; v <= per; v += 1) {
      const name = `${s.prefix}_${String(v).padStart(2, '0')}_local.png`;
      await sharp(Buffer.from(s.draw(v))).png().toFile(path.join(OUT, name));
      made += 1;
    }
    console.log(`  ok   ${s.prefix} x${per}`);
  }
  console.log(`\n${made} rendered locally -> ${OUT}`);
  console.log(`folder total: ${fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).length}/80`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
