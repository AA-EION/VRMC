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

// The panel must be on screen without scrolling. React Three Fiber renders its
// own full-height container, and leaving it in normal flow pushed the entire UI
// below the fold — a first-time user saw a blank page. That went unnoticed for
// a long time because these tests hide the overlay before measuring anything.
const overlayTop = await page.evaluate(() => {
  const el = document.querySelector('.overlay');
  return el === null ? null : el.getBoundingClientRect().top;
});
check('overlay starts inside the viewport', overlayTop !== null && overlayTop < 200,
  overlayTop === null ? 'no overlay' : `top at ${Math.round(overlayTop)}px`);

// The pairing field is the first thing a user touches; it must not be squashed
// by the button beside it.
const codeBox = await page.evaluate(() => {
  const el = document.querySelector('.code-input');
  return el === null ? null : el.getBoundingClientRect().width;
});
check('pairing code field is usably wide', codeBox !== null && codeBox > 120,
  codeBox === null ? 'missing' : `${Math.round(codeBox)}px wide`);

/*
 * The identity actually reached the page.
 *
 * Three things, and each one has failed on its own before: the token layer
 * resolves (a stylesheet that does not load leaves every colour at its
 * @property initial value, which looks deliberate); the mark is inline and
 * takes `currentColor` (an <img> would be the one element that cannot cross a
 * theme change); and a theme choice actually reaches <html data-theme>, which
 * is the single attribute the whole stylesheet keys off.
 */
const brand = await page.evaluate(() => {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const read = (name) => style.getPropertyValue(name).trim();
  const mark = document.querySelector('.masthead .mark');
  return {
    ink: read('--ink'),
    surface: read('--surface'),
    bone: read('--eion-bone'),
    theme: root.dataset.theme ?? '',
    markIsInline: mark !== null && mark.tagName.toLowerCase() === 'svg',
    markTakesCurrentColor:
      mark !== null && mark.querySelector('path')?.getAttribute('fill') === 'currentColor',
    seal: document.querySelector('.eion-seal')?.textContent ?? '',
  };
});
check('brand tokens resolve on the root', brand.bone === '#f2f0eb',
  `--eion-bone ${brand.bone || 'unset'}`);
check('the theme layer paints from the identity',
  (brand.theme === 'dark' && brand.surface === 'rgb(11, 11, 12)') ||
    (brand.theme === 'light' && brand.surface === 'rgb(242, 240, 235)'),
  `${brand.theme} surface ${brand.surface}`);
check('the mark is inline and takes the page ink',
  brand.markIsInline && brand.markTakesCurrentColor,
  brand.markIsInline ? 'svg, currentColor' : 'not an inline svg');
check('the seal is set, never romanised', brand.seal === '永音', brand.seal);

// Cycling the control writes a literal theme, which is the only thing the
// stylesheet reads. `system` is a deferral and must survive as its own state
// rather than collapsing into whichever of the two it resolves to today.
const themeCycle = await page.evaluate(async () => {
  const button = document.querySelector('button.theme');
  if (button === null) return null;
  const seen = [];
  for (let i = 0; i < 4; i++) {
    seen.push(document.documentElement.dataset.themePref ?? '');
    button.click();
    await new Promise((r) => requestAnimationFrame(r));
  }
  return seen;
});
check('the theme control cycles all three states',
  themeCycle !== null &&
    themeCycle.length === 4 &&
    new Set(themeCycle).size === 3 &&
    themeCycle[0] === themeCycle[3],
  themeCycle === null ? 'no control' : themeCycle.join(' -> '));

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
    } else if (o.isMesh && o.name !== 'backdrop-shell') {
      // The room's shell is not an instrument, and the count below is about
      // instruments.
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
  // The room's own shell is excluded where this is gathered: this check is
  // about the instruments, and a count that quietly includes the backdrop stops
  // saying what its name says the moment the room gains anything.
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
 *
 * That premise depends on the ground being dark, and since the UI took on the
 * identity's palette the ground is Polymer Bone by default — itself near-white,
 * and near-white across the whole viewport, which swamps the keys and turns
 * both figures below into a measurement of the page rather than of the scene.
 * So the theme is pinned to dark for the reading. The scene's own colours do
 * not depend on it; only the paper behind them does.
 */
await page.evaluate(async () => {
  // `data-theme-ready` is what arms the 720 ms crossing. Removed first, so the
  // change lands on this frame instead of easing through mid-grey — a grey page
  // is above the `nonBackground` threshold, and sampling part-way through the
  // ease would measure the crossing rather than the scene.
  document.documentElement.removeAttribute('data-theme-ready');
  /*
   * Driven through the real control rather than by writing `data-theme`.
   *
   * The attribute is an *output* of brand/theme.ts, not an input: setting it by
   * hand repaints the CSS and leaves the store still believing it is light, so
   * anything reading the store — the galaxy's ink, the room's own surface —
   * carries on in the other theme entirely. That divergence made the full-VR
   * check below pass against a bone-white room in which a buried keyboard was
   * every bit as near-white as a drawn one.
   */
  const control = document.querySelector('button.theme');
  for (let i = 0; i < 5 && document.documentElement.dataset.theme !== 'dark'; i++) {
    control.click();
    await new Promise((r) => setTimeout(r, 30));
  }
});
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

/*
 * Spawn an emulated Launchpad and drive it.
 *
 * The bridge is not running here, so `addDevice` creates the local surface and
 * its request to open MIDI ports goes nowhere — which is exactly the split
 * being tested: the headset can render and play a device before, or without,
 * the desktop agreeing. LED colours are injected the way the bridge would
 * deliver them.
 */
const launchpad = await page.evaluate(async () => {
  const h = window.__vrmc;
  if (!h) return { ok: false, reason: 'no handle' };
  const engine = h.engine;

  const device = engine.addDevice('launchpad-x');
  if (!device) return { ok: false, reason: 'addDevice returned null' };

  // Light the bottom row red, as a DAW would: palette 5 is red, 6-bit 63,0,0.
  for (let col = 1; col <= 8; col++) device.applyLed(10 + col, 63, 0, 0, 0);
  // One pulsing pad and one flashing pad, to exercise the animation path.
  device.applyLed(21, 0, 63, 0, 2);
  device.applyLed(22, 63, 63, 0, 1);

  // Poke pad 44 through the real detector, in the device's own frame.
  const t = device.transform;
  const [qx, , , qw] = t.quaternion;
  const th = 2 * Math.atan2(qx, qw);
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const zoneIndex = device.layout.zoneForIndex(44);
  const zone = device.layout.zones[zoneIndex];
  const lx = zone.rect.x + zone.rect.width / 2;
  const ly = zone.rect.y + zone.rect.height / 2;
  const toWorld = (x, y, z) => [
    t.origin[0] + x,
    t.origin[1] + y * cos - z * sin,
    t.origin[2] + y * sin + z * cos,
  ];

  const sent = [];
  const realPush = engine.link.push.bind(engine.link);
  engine.link.push = (type, ch, d1, d2, v14, dev, flags, off) => {
    sent.push({ type, d1, d2, dev });
    return realPush(type, ch, d1, d2, v14, dev, flags, off);
  };

  const RADIUS = 0.008;
  const frame = engine.fingers;
  let clock = performance.now();
  for (let i = 0; i <= 6; i++) {
    const depth = 0.04 - (0.05 * i) / 6;
    const [wx, wy, wz] = toWorld(lx, ly, zone.raise + RADIUS + depth);
    clock += 1000 / 90;
    frame.beginFrame(clock, 1 / 90);
    frame.setFinger(6, wx, wy, wz, RADIUS);
    device.detector.update(frame, device);
  }
  // Hold, so the touch highlight is still on screen for the screenshot.
  for (let i = 0; i < 3; i++) {
    const [wx, wy, wz] = toWorld(lx, ly, zone.raise + RADIUS - 0.004);
    clock += 1000 / 90;
    frame.beginFrame(clock, 1 / 90);
    frame.setFinger(6, wx, wy, wz, RADIUS);
    device.detector.update(frame, device);
  }
  engine.link.push = realPush;

  return {
    ok: true,
    deviceCount: engine.launchpads.length,
    zones: device.layout.zones.length,
    model: device.spec.model,
    sent,
  };
});

check('emulated Launchpad spawned', launchpad.ok && launchpad.deviceCount === 1,
  launchpad.ok ? `${launchpad.model}, ${launchpad.zones} controls` : launchpad.reason);
if (launchpad.ok) {
  // 64 grid pads + 8 top + 8 scene = 80 pokeable controls; the logo is not one.
  check('Launchpad X exposes 80 pokeable controls', launchpad.zones === 80,
    `${launchpad.zones} zones`);
  const on = launchpad.sent.find((e) => e.type === 1);
  check('poking a pad sends its XY index, not a MIDI note', on !== undefined && on.d1 === 44,
    on ? `index ${on.d1} velocity ${on.d2}` : 'nothing sent');
  check('event is tagged with the device instance id', on !== undefined && on.dev >= 16,
    on ? `device ${on.dev}` : '');
}

// Let the blink animation and the touch highlight reach a rendered frame.
await page.waitForTimeout(200);

const lit = await page.evaluate(() => {
  const h = window.__vrmc;
  let lpMesh = null;
  h.scene.traverse((o) => {
    if (o.isInstancedMesh && o.count === 80 && o.instanceColor) lpMesh = o;
  });
  if (!lpMesh) return { ok: false };
  const device = h.engine.launchpads[0];
  const read = (xy) => {
    const z = device.layout.zoneForIndex(xy);
    const a = lpMesh.instanceColor.array;
    return [a[z * 3], a[z * 3 + 1], a[z * 3 + 2]].map((v) => +v.toFixed(3));
  };
  return { ok: true, red: read(11), dark: read(88), touched: read(44) };
});
check('DAW-driven LED colour reached the instance buffer',
  lit.ok && lit.red[0] > 0.8 && lit.red[1] < 0.2,
  lit.ok ? `pad 11 rgb=${JSON.stringify(lit.red)}` : 'no Launchpad mesh');
check('unlit pads stay visible rather than pure black',
  lit.ok && lit.dark[0] > 0.01 && lit.dark[0] < 0.2,
  lit.ok ? `pad 88 rgb=${JSON.stringify(lit.dark)}` : '');
check('touched pad flashes brighter than its resting colour',
  lit.ok && lit.touched[0] > 0.5,
  lit.ok ? `pad 44 rgb=${JSON.stringify(lit.touched)}` : '');

/*
 * The in-session pairing keypad.
 *
 * It only appears inside an XR session, which there is no way to enter here, so
 * the engine's dev seam forces it on. Everything after that is real: the panel
 * is built by the same component, laid out by the same transform, and poked
 * through the same detector as an instrument.
 */
const keypad = await page.evaluate(async () => {
  const h = window.__vrmc;
  if (!h?.engine.showKeypad) return { ok: false, reason: 'no keypad seam' };
  h.engine.showKeypad(true);
  await new Promise((r) => setTimeout(r, 200));

  const controller = h.engine.keypad;
  if (!controller) return { ok: false, reason: 'no keypad controller' };

  const layout = controller.layout;
  const t = (() => {
    let mesh = null;
    h.scene.traverse((o) => {
      if (o.isInstancedMesh && o.count === layout.zones.length) mesh = o;
    });
    return mesh;
  })();
  if (!t) return { ok: false, reason: 'keypad mesh not in the scene' };

  // Poke K, 7, M, 2, Q, X — a real code, one key at a time, through the
  // detector. Six presses should submit without any button being pressed.
  const alphabet = layout.zones.map((z) => z.label).join('');
  const wanted = 'K7M2QX';
  const frame = h.engine.fingers;
  const RIGHT_INDEX = 6;
  const RADIUS = 0.008;
  let clock = performance.now();

  const pose = h.engine.keypadTransform ?? null;
  void pose;

  // Surface-local -> world for a tilt-only orientation, as elsewhere.
  const zoneAt = (i) => layout.zones[i];
  const origin = t.parent.position;
  const q = t.parent.quaternion;
  const th = 2 * Math.atan2(q.x, q.w);
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const toWorld = (lx, ly, lz) => [
    origin.x + lx,
    origin.y + ly * cos - lz * sin,
    origin.z + ly * sin + lz * cos,
  ];

  for (const character of wanted) {
    const index = alphabet.indexOf(character);
    const zone = zoneAt(index);
    const lx = zone.rect.x + zone.rect.width / 2;
    const ly = zone.rect.y + zone.rect.height / 2;

    // Down through the key, then back out — the detector needs the release
    // before it will accept the next press on a different key.
    for (let i = 0; i <= 5; i++) {
      const depth = 0.035 - (0.045 * i) / 5;
      const [wx, wy, wz] = toWorld(lx, ly, zone.raise + RADIUS + depth);
      clock += 1000 / 90;
      frame.beginFrame(clock, 1 / 90);
      frame.setFinger(RIGHT_INDEX, wx, wy, wz, RADIUS);
      controller.update(frame, 1 / 90);
    }
    for (let i = 0; i < 3; i++) {
      const [wx, wy, wz] = toWorld(lx, ly, zone.raise + RADIUS + 0.03);
      clock += 1000 / 90;
      frame.beginFrame(clock, 1 / 90);
      frame.setFinger(RIGHT_INDEX, wx, wy, wz, RADIUS);
      controller.update(frame, 1 / 90);
    }
  }

  let instanced = 0;
  h.scene.traverse((o) => {
    if (o.isInstancedMesh) instanced++;
  });

  return {
    ok: true,
    keys: layout.zones.length,
    typed: controller.value,
    instanced,
  };
});

/*
 * The room, and the switch into it.
 *
 * The claim being tested is the one the whole feature rests on: going fully
 * immersive is a *render* decision inside the existing session, so the shell
 * and the clouds are already in the scene graph while the player is in
 * passthrough — invisible and costing nothing — and the toggle only changes
 * how opaque they are. If this ever starts building the galaxy on the toggle,
 * the switch stops being free and starts being a stall.
 */
const backdrop = await page.evaluate(async () => {
  const h = window.__vrmc;
  if (!h) return { ok: false, reason: 'no handle' };

  const survey = () => {
    let points = 0;
    let particles = 0;
    let visiblePoints = 0;
    let shellAlpha = null;
    h.scene.traverse((o) => {
      if (o.isPoints) {
        points++;
        particles += o.geometry.getAttribute('position')?.count ?? 0;
        if (o.visible) visiblePoints++;
      }
      if (o.name === 'backdrop-shell') shellAlpha = o.material?.uniforms?.uAlpha?.value ?? null;
    });
    return { points, particles, visiblePoints, shellAlpha };
  };

  /*
   * Wait for the fade to *settle*, not for a duration.
   *
   * The crossfade advances in frame time, and its per-frame step is clamped so
   * that a hitch cannot make the room jump. Under SwiftShader a frame can take
   * most of a second, so a fixed wall-clock wait lands wherever the software
   * renderer happened to get to — 0.994 on the first run of this, which is a
   * fact about the test host and not about the code. On a headset at 90 Hz the
   * same 720 ms is 65 frames and long finished.
   */
  const settle = async (want) => {
    for (let i = 0; i < 400; i++) {
      const state = survey();
      if (state.shellAlpha === want) return state;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return survey();
  };

  const before = survey();
  const button = [...document.querySelectorAll('.segmented button')].find(
    (b) => b.textContent.trim() === 'Full VR',
  );
  if (!button) return { ok: false, reason: 'no Full VR control' };
  button.click();
  const after = await settle(1);

  const back = [...document.querySelectorAll('.segmented button')].find(
    (b) => b.textContent.trim() === 'Your room',
  );
  back.click();
  const returned = await settle(0);

  return { ok: true, before, after, returned };
});

check('the galaxy is built before it is asked for', backdrop.ok && backdrop.before.points === 3,
  backdrop.ok ? `${backdrop.before.points} clouds, ${backdrop.before.particles} particles` : backdrop.reason);
if (backdrop.ok) {
  check('the room costs nothing while it is not showing',
    backdrop.before.visiblePoints === 0 && backdrop.before.shellAlpha === 0,
    `${backdrop.before.visiblePoints} visible clouds, shell alpha ${backdrop.before.shellAlpha}`);
  // Fully opaque, not merely nearly: at 0.999 the compositor is still blending
  // a thousandth of the real room in, which reads as a dirty lens.
  check('full VR reaches a completely opaque room',
    backdrop.after.shellAlpha === 1 && backdrop.after.visiblePoints === 3,
    `shell alpha ${backdrop.after.shellAlpha}, ${backdrop.after.visiblePoints} clouds drawn`);
  check('switching back leaves the buffer transparent again',
    backdrop.returned.shellAlpha === 0 && backdrop.returned.visiblePoints === 0,
    `shell alpha ${backdrop.returned.shellAlpha}, ${backdrop.returned.visiblePoints} clouds drawn`);
  check('no cloud was rebuilt by the switch',
    backdrop.after.particles === backdrop.before.particles &&
      backdrop.returned.particles === backdrop.before.particles,
    `${backdrop.before.particles} -> ${backdrop.after.particles} -> ${backdrop.returned.particles}`);
}

/*
 * The instruments survive the room.
 *
 * This is here because the room once ate them and every other check passed.
 * three draws all opaque geometry first and only then the transparent objects,
 * sorted among themselves — so a transparent shell with its depth test off is
 * drawn *after* the pads and straight over them. What that looked like was a
 * galaxy with the pad labels floating correctly in it (labels are transparent,
 * and sorted after the shell) and solid black where every pad and every white
 * key should have been. Counting the keys through the room is the cheapest
 * thing that would have caught it.
 */
const throughTheRoom = await page.evaluate(async () => {
  const button = [...document.querySelectorAll('.segmented button')].find(
    (b) => b.textContent.trim() === 'Full VR',
  );
  button.click();
  for (let i = 0; i < 600; i++) {
    let alpha = null;
    window.__vrmc.scene.traverse((o) => {
      if (o.name === 'backdrop-shell') alpha = o.material?.uniforms?.uAlpha?.value ?? null;
    });
    if (alpha === 1) return true;
    await new Promise((r) => requestAnimationFrame(r));
  }
  return false;
});
check('the room reached full opacity for the reading', throughTheRoom === true);

/*
 * Measured inside the keyboard's own projected box.
 *
 * This check exists because the room once ate the instruments and everything
 * else still passed, so it is worth saying what it took to make it actually
 * discriminate. A plain tally of near-white pixels does not: on the dark theme
 * the galaxy's ink is Absolute White, so a million particle pixels clear the
 * threshold whether or not the pads are buried underneath them. The longest
 * unbroken *run* does not either — the white keys are drawn as separate boxes
 * with a seam between them, so one key is about eighteen pixels wide and the
 * only long run in the frame belonged to the bone-white shell that was doing
 * the burying.
 *
 * What does discriminate is where the white is. The keys are projected to a
 * screen box and the near-white inside it is counted: thousands when the
 * keyboard is drawn, a scattering of stray particles when the room is over it.
 */
const keyBox = await page.evaluate(() => {
  const h = window.__vrmc;
  const keys = h?.engine?.instruments?.find((i) => i.id === 'keys');
  if (!keys) return null;
  const [ox, oy, oz] = keys.transform.origin;
  const [qx, , , qw] = keys.transform.quaternion;
  const th = 2 * Math.atan2(qx, qw);
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  let minX = 1;
  let maxX = -1;
  let minY = 1;
  let maxY = -1;
  // The four corners of the surface, in its own frame, projected out.
  for (const [lx, ly] of [
    [0, 0],
    [keys.locator.width, 0],
    [0, keys.locator.height],
    [keys.locator.width, keys.locator.height],
  ]) {
    const v = new h.THREE.Vector3(ox + lx, oy + ly * cos, oz + ly * sin).project(h.camera);
    minX = Math.min(minX, v.x);
    maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y);
    maxY = Math.max(maxY, v.y);
  }
  return { minX, maxX, minY, maxY };
});

const roomShot = (await page.screenshot()).toString('base64');
const inBox = await page.evaluate(
  async ({ b64, box }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const off = document.createElement('canvas');
    off.width = img.width;
    off.height = img.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const px = (ndc) => Math.round(((ndc + 1) / 2) * (img.width - 1));
    const py = (ndc) => Math.round(((1 - ndc) / 2) * (img.height - 1));
    const x0 = Math.max(0, px(box.minX));
    const x1 = Math.min(img.width - 1, px(box.maxX));
    const y0 = Math.max(0, py(box.maxY));
    const y1 = Math.min(img.height - 1, py(box.minY));
    if (x1 <= x0 || y1 <= y0) return { bright: 0, area: 0 };
    const { data } = ctx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    let bright = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) bright++;
    }
    return { bright, area: (x1 - x0 + 1) * (y1 - y0 + 1) };
  },
  { b64: roomShot, box: keyBox ?? { minX: 0, maxX: 0, minY: 0, maxY: 0 } },
);

check('the instruments are still drawn inside the full-VR room',
  keyBox !== null && inBox.bright > inBox.area * 0.25,
  `${inBox.bright} near-white px in the keyboard's ${inBox.area}px box`);

await page.evaluate(() => {
  [...document.querySelectorAll('.segmented button')]
    .find((b) => b.textContent.trim() === 'Your room')
    .click();
});

check('pairing keypad renders in the scene', keypad.ok,
  keypad.ok ? `${keypad.keys} keys` : keypad.reason);
if (keypad.ok) {
  // 24 characters in the pairing alphabet, plus backspace.
  check('keypad offers every code character plus backspace', keypad.keys === 25,
    `${keypad.keys} keys`);
  check('poking keys types the code', keypad.typed === 'K7M2QX',
    `typed "${keypad.typed}"`);
}

// Captured with the panel up, since the shot at the end is taken without it.
// This is the only look anyone gets at the panel without a headset.
await page.screenshot({ path: process.env.VRMC_PANEL_SHOT ?? 'connect-panel.png' });

// The panel must go away once it is not needed, or it floats in front of the
// instruments for the rest of the session.
const hidden = await page.evaluate(async () => {
  const h = window.__vrmc;
  if (!h?.engine.showKeypad) return { instanced: -1, cleared: null };
  h.engine.showKeypad(false);
  await new Promise((r) => setTimeout(r, 200));
  // Counted rather than matched on instance count: the 25-key keyboard has
  // exactly as many instances as the keypad, so looking for "a mesh with 25"
  // finds the keyboard and reports the panel as still on screen.
  let instanced = 0;
  h.scene.traverse((o) => {
    if (o.isInstancedMesh) instanced++;
  });
  return { instanced, cleared: h.engine.keypad?.value ?? null };
});
check('keypad leaves the scene when dismissed',
  keypad.ok && hidden.instanced === keypad.instanced - 1,
  `${keypad.instanced} instanced meshes with the panel, ${hidden.instanced} without`);
check('a half-typed code is not left waiting', hidden.cleared === '',
  `left "${hidden.cleared}"`);

await page.screenshot({ path: process.env.VRMC_SHOT ?? 'render-smoke.png' });

await browser.close();
server.close();

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
