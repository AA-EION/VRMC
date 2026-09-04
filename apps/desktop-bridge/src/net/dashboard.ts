// SPDX-License-Identifier: GPL-3.0-only

/**
 * The bridge's local dashboard.
 *
 * The bridge is a background process with no window, so without this there is
 * no way to see whether it started, what address to type into the headset, or
 * whether the headset ever connected. On macOS that was worse than a gap: the
 * app bundle is deliberately window-less, so a failure produced no visible sign
 * at all.
 *
 * It is served from the HTTP server the WebSocket already needs, so it costs no
 * new port, no new dependency and no bundled browser — the one the user already
 * has renders it.
 */

export interface DeviceSummary {
  deviceId: number;
  model: string;
  status: number;
  detail: string;
}

export interface DashboardStatus {
  version: string;
  /** Addresses the headset can reach this bridge on. */
  addresses: string[];
  wsPort: number;
  udpPort: number;
  secure: boolean;
  /** How many headsets are connected. */
  clients: number;
  devices: DeviceSummary[];
  /** ms since a packet last arrived, or null if none ever has. */
  lastPacketAgoMs: number | null;
  packetsIn: number;
  packetsOut: number;
  eventsIn: number;
  ledsOut: number;
  jitterMs: number;
  peakJitterMs: number;
  lossRatio: number;
  malformed: number;
  midiAvailable: boolean;
  /** Pairing code as displayed, or empty when publishing is off. */
  pairingCode: string;
  /** Whether the pairing service has the current registration. */
  pairingRegistered: boolean;
  pairingError: string;
  /** Where to open the client in the headset. */
  siteUrl: string;
  /** Headsets connected over a WebRTC data channel. */
  rtcPeers: number;
  /** Why the bridge is not listening for pairing offers, if it is not. */
  rtcError: string;
}

/** Result of one self-test leg. */
export interface SelfTestResult {
  ok: boolean;
  detail: string;
}

const ACCENT = '#63e0ff';

/**
 * The dashboard page.
 *
 * Inlined rather than served from files: the bridge ships as a single packaged
 * executable, and a handful of loose assets beside it would be one more thing
 * for an installer to place correctly and for a user to break.
 */
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>VRMC Bridge</title>
<!--
  Inline, so the browser never asks for /favicon.ico. The bridge has no
  business serving static files, and the 404 it would answer with shows up as
  a red line in the console — the first thing anyone looking for a real
  problem here would find, and a dead end.
-->
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='3.6' fill='%230a0c12'/><g fill='%2363e0ff'><rect x='3' y='3' width='4' height='4' rx='1'/><rect x='9' y='3' width='4' height='4' rx='1'/><rect x='3' y='9' width='4' height='4' rx='1'/><rect x='9' y='9' width='4' height='4' rx='1'/></g></svg>" />
<style>
  /*
   * Both appearances, chosen by the system rather than by this file.
   *
   * It was "color-scheme: dark" and a single set of near-black values, which
   * is one theme wearing the name of a design: on a Mac set to Light it was a
   * dark rectangle in a light window, and the accent — a pale cyan picked to
   * glow on near-black — had almost no contrast against a white card.
   *
   * "light-dark()" keeps both values on one line each, so a colour and its
   * counterpart cannot drift apart the way two blocks of hex eventually do.
   * The light values are not the dark ones lightened: the accent, the warning
   * and the status colours are all darkened instead, because a colour legible
   * on black is generally not legible on white.
   */
  :root {
    color-scheme: light dark;
    --bg: light-dark(#f5f6fa, #0a0c12);
    --panel: light-dark(#ffffff, #151926);
    --border: light-dark(#d7dbe7, #262c40);
    --text: light-dark(#12151f, #e8ecf6);
    --muted: light-dark(#585f73, #9aa4bf);
    --accent: light-dark(#0a6f8f, ${ACCENT});
    --ok: light-dark(#0d7a44, #6ee7a8);
    --bad: light-dark(#b3182d, #ff8189);
    --warn: light-dark(#7a4d00, #ffc86b);
    /* Sunken and raised surfaces, so nothing below has to hard-code a hex. */
    --inset: light-dark(#eef0f6, #0a0c12);
    --raised: light-dark(#e6e9f2, #2a3145);
    --raised-hover: light-dark(#dadeeb, #38415c);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--text);
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 46rem; margin: 0 auto; display: grid; gap: 1rem; }
  header { display: flex; align-items: center; gap: .8rem; margin-bottom: .4rem; }
  header h1 { margin: 0; font-size: 1.3rem; letter-spacing: .1em; }
  .dot { width: .6rem; height: .6rem; border-radius: 50%; background: var(--bad); flex: none; }
  .dot.on { background: var(--ok); box-shadow: 0 0 .5rem var(--ok); }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: .8rem; padding: 1rem 1.1rem; }
  .card h2 { margin: 0 0 .8rem; font-size: .74rem; text-transform: uppercase; letter-spacing: .12em; color: var(--muted); }
  dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: .7rem; margin: 0; }
  dt { font-size: .68rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
  dd { margin: .15rem 0 0; font-family: ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums; }
  .addr { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin-bottom: .5rem; }
  .addr code {
    background: var(--inset); border: 1px solid var(--border); border-radius: .4rem;
    padding: .45rem .6rem; font-size: .95rem; color: var(--accent);
  }
  button {
    font: inherit; font-size: .85rem; font-weight: 600; padding: .5rem .9rem;
    border-radius: .5rem; border: 1px solid var(--border); background: var(--raised);
    color: var(--text); cursor: pointer;
  }
  button:hover:not(:disabled) { background: var(--raised-hover); }
  button:disabled { opacity: .5; cursor: default; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; }
  table { width: 100%; border-collapse: collapse; font-size: .86rem; }
  th { text-align: left; font-size: .68rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); padding-bottom: .4rem; font-weight: 600; }
  th, td { padding-right: 1.1rem; }
  th:last-child, td:last-child { padding-right: 0; }
  td { padding-top: .4rem; padding-bottom: .4rem; border-top: 1px solid var(--border); font-family: ui-monospace, Menlo, monospace; }
  td:first-child { color: var(--muted); }
  .ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); }
  .muted { color: var(--muted); }
  .results { margin: .8rem 0 0; display: grid; gap: .4rem; font-size: .85rem; }
  .results div { display: flex; gap: .5rem; }
  .hint { color: var(--muted); font-size: .85rem; margin: 0 0 .8rem; }
  /* The one thing on this page a user has to read across a room and retype. */
  .code {
    font-family: ui-monospace, Menlo, monospace; font-size: 2.6rem; font-weight: 700;
    letter-spacing: .18em; color: var(--accent); text-align: center;
    padding: .7rem 0 .5rem; user-select: all;
  }
  details { margin-top: .6rem; }
  summary { cursor: pointer; color: var(--muted); font-size: .82rem; }
  details[open] summary { margin-bottom: .7rem; }
</style>
</head>
<body>
<main>
  <header>
    <span class="dot" id="live"></span>
    <h1>VRMC BRIDGE</h1>
    <span class="muted" id="version"></span>
  </header>

  <section class="card" id="pairCard">
    <h2>Connect the headset</h2>
    <p class="hint">
      Open <strong id="siteUrl">the VRMC site</strong> in the headset and enter this code.
    </p>
    <div class="code" id="pairCode">------</div>
    <p class="hint" id="pairState"></p>
    <details>
      <summary>Enter an address instead</summary>
      <div id="addresses"></div>
      <p class="hint" id="tlsNote"></p>
    </details>
  </section>

  <section class="card">
    <h2>Headset</h2>
    <dl>
      <div><dt>Status</dt><dd id="clients">—</dd></div>
      <div><dt>Last packet</dt><dd id="lastPacket">—</dd></div>
      <div><dt>Jitter</dt><dd id="jitter">—</dd></div>
      <div><dt>Loss</dt><dd id="loss">—</dd></div>
      <div><dt>In</dt><dd id="pin">—</dd></div>
      <div><dt>Out</dt><dd id="pout">—</dd></div>
    </dl>
  </section>

  <section class="card">
    <h2>Audit</h2>
    <p class="hint">
      Checks each leg separately, so a failure points at one thing rather than
      "it does not work".
    </p>
    <div class="row">
      <button id="btn-headset">Headset round trip</button>
      <button id="btn-leds">Send LEDs to headset</button>
      <button id="btn-midi">Send a note to the DAW</button>
    </div>
    <div class="results" id="results"></div>
  </section>

  <section class="card">
    <h2>Devices</h2>
    <table>
      <thead><tr><th>ID</th><th>Model</th><th>MIDI ports</th></tr></thead>
      <tbody id="devices"></tbody>
    </table>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id);
const STATUS = { 0: 'opening', 1: 'ready', 2: 'failed' };

/*
 * The site as a user would say it aloud: "vrmc.eionstudios.com".
 *
 * URL rather than a regex, and not only because it is clearer. This whole
 * script is written inside a template literal, where a backslash is an escape
 * belonging to the literal and never reaches the browser — so a regex that
 * escaped the slashes of a scheme arrived with them bare, which is a syntax
 * error, which discarded every line below it. The page rendered its shell and
 * then sat there empty while the server answered perfectly. Nothing in this
 * script may contain a backslash; a test enforces it.
 */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function ago(ms) {
  if (ms === null) return 'never';
  if (ms < 1500) return 'just now';
  if (ms < 60000) return Math.round(ms / 1000) + 's ago';
  return Math.round(ms / 60000) + 'm ago';
}

async function refresh() {
  let s;
  try {
    s = await (await fetch('/api/status')).json();
  } catch {
    $('live').classList.remove('on');
    return;
  }
  $('version').textContent = 'v' + s.version;

  const connected = s.clients > 0;
  $('live').classList.toggle('on', connected);
  $('clients').textContent = connected ? s.clients + ' connected' : 'waiting';
  $('clients').className = connected ? 'ok' : 'muted';
  $('lastPacket').textContent = ago(s.lastPacketAgoMs);
  $('jitter').textContent = s.jitterMs.toFixed(2) + ' ms';
  $('jitter').className = s.jitterMs > 5 ? 'warn' : '';
  $('loss').textContent = (s.lossRatio * 100).toFixed(2) + '%';
  $('loss').className = s.lossRatio > 0.01 ? 'warn' : '';
  $('pin').textContent = s.packetsIn + ' pkt / ' + s.eventsIn + ' ev';
  $('pout').textContent = s.packetsOut + ' pkt / ' + s.ledsOut + ' led';

  const site = hostOf(s.siteUrl || '');
  $('siteUrl').textContent = site || 'the VRMC site';
  $('pairCode').textContent = s.pairingCode || 'off';
  $('pairState').textContent = !s.pairingCode
    ? 'Pairing is disabled; use an address below.'
    : s.pairingRegistered
      ? 'Ready — the code is live.'
      : 'Not reachable: ' + (s.pairingError || 'contacting the pairing service…');
  $('pairState').className = s.pairingRegistered ? 'hint ok' : 'hint warn';

  const scheme = s.secure ? 'wss' : 'ws';
  $('addresses').innerHTML = s.addresses
    .map((a) => '<div class="addr"><code>' + scheme + '://' + a + ':' + s.wsPort + '</code></div>')
    .join('') || '<p class="hint">No LAN address found.</p>';
  $('tlsNote').textContent = s.rtcError
    ? 'Pairing is not listening: ' + s.rtcError
    : s.rtcPeers
      ? s.rtcPeers + ' headset(s) connected directly over WebRTC.'
      : 'You should not need these — the pairing code above connects the headset ' +
        'directly. They are here for a client running on this computer.';

  $('devices').innerHTML = s.devices.length
    ? s.devices.map((d) =>
        '<tr><td>' + d.deviceId + '</td><td>' + d.model +
        '</td><td class="' + (d.status === 1 ? 'ok' : d.status === 2 ? 'bad' : 'muted') + '">' +
        (d.detail || STATUS[d.status]) + '</td></tr>').join('')
    : '<tr><td colspan="3" class="muted">None. Devices are created from the headset.</td></tr>';
}

function show(name, result) {
  const line = document.createElement('div');
  line.innerHTML = '<span class="' + (result.ok ? 'ok' : 'bad') + '">' +
    (result.ok ? '✓' : '✗') + '</span><span>' + name + ' — ' + result.detail + '</span>';
  $('results').prepend(line);
}

async function selfTest(what, name, button) {
  button.disabled = true;
  try {
    const r = await fetch('/api/selftest?what=' + what, { method: 'POST' });
    show(name, await r.json());
  } catch (e) {
    show(name, { ok: false, detail: String(e) });
  } finally {
    button.disabled = false;
    refresh();
  }
}

$('btn-headset').onclick = (e) => selfTest('headset', 'Headset round trip', e.target);
$('btn-leds').onclick = (e) => selfTest('leds', 'LEDs to headset', e.target);
$('btn-midi').onclick = (e) => selfTest('midi', 'Note to DAW', e.target);

refresh();
setInterval(refresh, 1000);
</script>
</body>
</html>
`;
}
