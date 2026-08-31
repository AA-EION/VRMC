/**
 * Headless render smoke test.
 *
 * The unit tests in packages/* are pure maths — they never touch three.js and
 * would pass even if the scene threw on mount. This actually loads the built
 * app in Chromium, mounts the React tree, builds the three.js scene, and draws
 * frames through a real WebGL context (SwiftShader, in software).
 *
 * What this can prove: the component tree mounts, three.js accepts the
 * geometry and instanced meshes we build, the label canvas renders, the frame
 * loop runs without throwing, and pixels come out.
 *
 * What it cannot prove: anything inside an XR session. There is no XR device
 * here, so `immersive-ar`, passthrough blending and hand joint reading are all
 * still unverified — see docs/ARCHITECTURE.md.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(fileURLToPath(new URL('../dist', import.meta.url)));
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
};

function serve() {
  const server = createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const rel = url === '/' ? '/index.html' : url;
    // normalize() collapses any ../ before it can escape the dist directory.
    const path = join(DIST, normalize(rel));
    if (!path.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

const { server, port } = await serve();
/**
 * Use whichever Chromium the host already provides.
 *
 * Playwright pins an exact browser build and refuses to launch a different one,
 * but CI images commonly ship their own. Point at it explicitly rather than
 * downloading a second copy.
 */
function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

const executablePath = findChromium();
if (!executablePath) {
  // Skip rather than fail: this test needs a browser binary the host may not
  // have, and a machine without one should still be able to run `pnpm test`
  // and get a meaningful result from everything else.
  console.log('render-smoke: no Chromium found, skipping. Set CHROMIUM_PATH to run it.');
  server.close();
  process.exit(0);
}

const browser = await chromium.launch({
  executablePath,
  args: [
    // Force a real (software) WebGL implementation rather than letting the
    // page fall back to no context at all.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
  ],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
const pageErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(err.message));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

// Give the render loop a moment to run several frames.
await page.waitForTimeout(1500);

check('page loaded with no uncaught exceptions', pageErrors.length === 0, pageErrors.join(' | '));

// The client tries to reach a bridge that is not running here; a failed
// WebSocket logs a console error that is expected and not a defect.
const unexpected = consoleErrors.filter(
  (e) => !/websocket|ws:\/\/|wss:\/\/|failed to connect|ERR_CONNECTION/i.test(e),
);
check('no unexpected console errors', unexpected.length === 0, unexpected.join(' | '));

check('React overlay mounted', (await page.locator('.overlay h1').count()) === 1);

const webgl = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  if (!canvas) return { ok: false, reason: 'no canvas element' };
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  if (!gl) return { ok: false, reason: 'no WebGL context' };
  return {
    ok: true,
    version: gl.getParameter(gl.VERSION),
    renderer: gl.getParameter(gl.RENDERER),
    width: canvas.width,
    height: canvas.height,
  };
});
check('WebGL context created', webgl.ok, webgl.ok ? webgl.version : webgl.reason);
check('canvas has non-zero size', webgl.ok && webgl.width > 0 && webgl.height > 0,
  webgl.ok ? `${webgl.width}x${webgl.height}` : '');

// Reach into the running scene through the debug handle the app publishes.
const scene = await page.evaluate(() => {
  const h = window.__vrmc;
  if (!h) return { ok: false, reason: 'no window.__vrmc handle' };
  let instanced = 0;
  let totalInstances = 0;
  let meshes = 0;
  let withInstanceColor = 0;
  h.scene.traverse((o) => {
    if (o.isInstancedMesh) {
      instanced++;
      totalInstances += o.count;
      if (o.instanceColor) withInstanceColor++;
    } else if (o.isMesh) {
      meshes++;
    }
  });
  const info = h.renderer.info.render;
  return {
    ok: true,
    instanced,
    totalInstances,
    meshes,
    withInstanceColor,
    frames: info.frame,
    triangles: info.triangles,
  };
});
check('R3F scene reachable', scene.ok, scene.ok ? '' : scene.reason);

if (scene.ok) {
  check('both instrument surfaces built as instanced meshes', scene.instanced === 2,
    `${scene.instanced} instanced`);
  check('all 41 zones instanced (25 keys + 16 pads)', scene.totalInstances === 41,
    `${scene.totalInstances} instances`);
  check('instance colours allocated by the highlighter', scene.withInstanceColor === 2,
    `${scene.withInstanceColor}/2`);
  // 2 backing plates + 1 label plane (pads only) + 4 knobs x 2 meshes each.
  check('knobs, plates and labels present', scene.meshes === 11, `${scene.meshes} plain meshes`);
  check('geometry rasterised', scene.triangles > 400, `${scene.triangles} triangles/frame`);
}

// Assert the loop is *advancing* rather than asserting an absolute frame count:
// software rendering here is far slower than a GPU, and a fixed threshold would
// be testing the host's speed rather than the app's behaviour.
{
  const first = await page.evaluate(() => window.__vrmc?.renderer.info.render.frame ?? -1);
  await page.waitForTimeout(600);
  const second = await page.evaluate(() => window.__vrmc?.renderer.info.render.frame ?? -1);
  check('frame loop is advancing', second > first, `${first} -> ${second} frames`);
}

// Every instrument must actually fall inside the preview camera's frustum.
// Getting this wrong does not throw — it just renders an empty page, which is
// exactly what happened the first time this test ran.
const framing = await page.evaluate(() => {
  const h = window.__vrmc;
  if (!h) return { ok: false };
  const cam = h.camera;
  const out = [];
  for (const inst of h.engine.instruments) {
    const [ox, oy, oz] = inst.transform.origin;
    // Centre of the surface, in world space.
    const [qx, , , qw] = inst.transform.quaternion;
    const th = 2 * Math.atan2(qx, qw);
    const cx = ox + inst.locator.width / 2;
    const cy = oy + (inst.locator.height / 2) * Math.cos(th);
    const cz = oz + (inst.locator.height / 2) * Math.sin(th);
    const v = new h.THREE.Vector3(cx, cy, cz).project(cam);
    out.push({ id: inst.id, x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3) });
  }
  return { ok: true, projected: out };
});
if (framing.ok) {
  for (const p of framing.projected) {
    const inView = Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z > -1 && p.z < 1;
    check(`${p.id} surface inside the preview frustum`, inView,
      `ndc x=${p.x} y=${p.y} z=${p.z}`);
  }
}

/*
 * Confirm real pixels reached the screen.
 *
 * Reading back from the WebGL canvas directly does not work: without
 * preserveDrawingBuffer the buffer is cleared after compositing, so
 * drawImage() yields a blank result whether or not anything was drawn. The
 * composited screenshot is the honest source, decoded back through the browser
 * so no PNG decoder is needed here.
 *
 * The overlay is hidden first, and the metric is near-white pixels: only the
 * keyboard's white keys are that bright, so this specifically proves the
 * instruments rendered rather than merely that the page has a background.
 */
await page.addStyleTag({ content: '.overlay { display: none !important; }' });
await page.waitForTimeout(300);
const shot = (await page.screenshot()).toString('base64');
const pixels = await page.evaluate(async (b64) => {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const off = document.createElement('canvas');
  off.width = img.width;
  off.height = img.height;
  const ctx = off.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, off.width, off.height);
  let bright = 0;
  let nonBackground = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r > 200 && g > 200 && b > 200) bright++;
    if (r > 60 || g > 60 || b > 90) nonBackground++;
  }
  return { bright, nonBackground, total: data.length / 4 };
}, shot);
check('white keys visibly rendered', pixels.bright > 2000,
  `${pixels.bright} near-white px`);
check('scene occupies a plausible share of the frame', pixels.nonBackground > 10000,
  `${pixels.nonBackground} of ${pixels.total} px`);

/*
 * Drive the real interaction chain.
 *
 * Everything above proves the scene builds and draws. This pushes synthetic
 * fingertip positions through the *actual* PokeDetector and NoteRouter that run
 * in a session, and checks a note comes out and the pad lights up. It is the
 * only test that exercises detection, routing, feedback and the GPU together —
 * the units are covered in packages/interaction, but the wiring between them
 * only exists here.
 *
 * The XR session itself is still out of reach: there is no XR device, so the
 * hand poses are supplied directly rather than read from XRFrame.
 */
const interaction = await page.evaluate(async () => {
  const h = window.__vrmc;
  if (!h) return { ok: false, reason: 'no handle' };

  const engine = h.engine;
  const pads = engine.instruments.find((i) => i.id === 'pads');
  if (!pads) return { ok: false, reason: 'no pad instrument' };

  const zone = pads.locator.zones[0];
  const t = pads.transform;
  const [qx, , , qw] = t.quaternion;
  const th = 2 * Math.atan2(qx, qw);
  const cos = Math.cos(th);
  const sin = Math.sin(th);

  // Surface-local -> world, for the tilt-only orientation these panels use.
  const toWorld = (lx, ly, lz) => [
    t.origin[0] + lx,
    t.origin[1] + ly * cos - lz * sin,
    t.origin[2] + ly * sin + lz * cos,
  ];

  const lx = zone.rect.x + zone.rect.width / 2;
  const ly = zone.rect.y + zone.rect.height / 2;

  // Count notes by wrapping the router's sink methods.
  const notes = [];
  const router = pads.router;
  const realOn = router.noteOn.bind(router);
  router.noteOn = (zi, note, vel, off, flags) => {
    notes.push({ zone: zi, note, vel });
    realOn(zi, note, vel, off, flags);
  };

  const RADIUS = 0.008;
  const frame = engine.fingers;
  const RIGHT_INDEX = 6;
  let clock = performance.now();

  // Descend through the pad face over several frames: above -> through.
  for (let i = 0; i <= 6; i++) {
    const depth = 0.04 - (0.05 * i) / 6;
    const [wx, wy, wz] = toWorld(lx, ly, zone.raise + RADIUS + depth);
    clock += 1000 / 90;
    frame.beginFrame(clock, 1 / 90);
    frame.setFinger(RIGHT_INDEX, wx, wy, wz, RADIUS);
    pads.detector.update(frame, router);
  }

  // Leave the finger resting on the pad. A held zone must stay lit, so the
  // screenshot below captures a deterministic state rather than racing a fade.
  for (let i = 0; i < 3; i++) {
    const [wx, wy, wz] = toWorld(lx, ly, zone.raise + RADIUS - 0.004);
    clock += 1000 / 90;
    frame.beginFrame(clock, 1 / 90);
    frame.setFinger(RIGHT_INDEX, wx, wy, wz, RADIUS);
    pads.detector.update(frame, router);
  }

  // Read the instance colour the highlighter wrote for that pad.
  let padColor = null;
  h.scene.traverse((o) => {
    if (o.isInstancedMesh && o.count === 16 && o.instanceColor) {
      const a = o.instanceColor.array;
      padColor = [a[0], a[1], a[2]].map((v) => +v.toFixed(3));
    }
  });

  router.noteOn = realOn;
  return { ok: true, notes, padColor };
});

check('poke produced a note', interaction.ok && interaction.notes.length === 1,
  interaction.ok ? JSON.stringify(interaction.notes) : interaction.reason);
if (interaction.ok && interaction.notes.length === 1) {
  const n = interaction.notes[0];
  check('note is pad 1 (C1, MIDI 36)', n.note === 36 && n.zone === 0, `note=${n.note} zone=${n.zone}`);
  check('velocity derived from approach speed', n.vel > 1 && n.vel <= 127, `velocity=${n.vel}`);
}
check('struck pad lit up in the instance colour buffer',
  interaction.ok && interaction.padColor !== null &&
    interaction.padColor[2] > interaction.padColor[0],
  `rgb=${JSON.stringify(interaction.padColor)}`);

// A held zone must not fade. Let several frames elapse, then confirm it is
// still lit — this is the regression guard for the highlighter's held state.
await page.waitForTimeout(400);
const stillLit = await page.evaluate(() => {
  const h = window.__vrmc;
  let colour = null;
  h.scene.traverse((o) => {
    if (o.isInstancedMesh && o.count === 16 && o.instanceColor) {
      const a = o.instanceColor.array;
      colour = [a[0], a[1], a[2]].map((v) => +v.toFixed(3));
    }
  });
  return colour;
});
check('held pad stays lit across frames', stillLit !== null && stillLit[2] > stillLit[0] + 0.3,
  `rgb=${JSON.stringify(stillLit)}`);

await page.screenshot({ path: process.env.VRMC_SHOT ?? 'render-smoke.png' });

await browser.close();
server.close();

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
