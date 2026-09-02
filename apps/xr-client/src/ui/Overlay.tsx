import { useState } from 'react';
import { DeviceModel } from '@vrmc/devices';
import { PAIRING_CODE_LENGTH, isPairingCode, normalisePairingCode } from '@vrmc/protocol';
import { DeviceStatus, type LayoutState } from '@vrmc/protocol';
import type { LaunchpadInstance } from '../devices/LaunchpadInstance.js';
import type { LinkStatus } from '../net/BridgeLink.js';
import type { XrMode, XrSupport } from '../xr/session.js';
import type { DepthSensingState } from '../xr/Occlusion.js';
import { Logo } from '../brand/Logo.js';
import { SEAL } from '../brand/tokens.js';
import { useTheme, type ThemePref } from '../brand/theme.js';

export interface OverlayProps {
  support: XrSupport | null;
  status: LinkStatus;
  sessionActive: boolean;
  passthrough: boolean;
  bridgeUrl: string;
  error: string;
  onBridgeUrlChange: (url: string) => void;
  onConnect: () => void;
  onEnterXR: () => void;
  onPanic: () => void;
  devices: readonly LaunchpadInstance[];
  onAddDevice: (model: string) => void;
  onRemoveDevice: (deviceId: number) => void;
  onPinDevice: (deviceId: number, pinned: boolean) => void;
  onDropDevice: (deviceId: number) => void;
  layouts: LayoutState;
  onSaveLayout: (name: string) => void;
  onApplyLayout: (name: string) => void;
  onDeleteLayout: (name: string) => void;
  onPair: (code: string) => void;
  pairingBusy: boolean;
  pairingNote: string;
  mode: XrMode;
  onModeChange: (mode: XrMode) => void;
  depthOcclusion: boolean;
  onDepthOcclusionChange: (on: boolean) => void;
  depthState: DepthSensingState;
}

/** The three theme states, named the way the identity names them. */
const THEME_LABEL: Record<ThemePref, string> = {
  system: 'Auto',
  light: 'Light',
  dark: 'Dark',
};

/**
 * What to say about depth sensing, given what it actually did.
 *
 * Reported rather than promised. The feature is requested as optional, may not
 * be granted, and is best-effort even where it is — so the interface says which
 * of those happened instead of showing a checkbox that claims to have worked.
 */
const DEPTH_NOTE: Record<DepthSensingState, string> = {
  off: 'Uses the headset’s depth sensing, which is approximate: edges are soft and can shimmer.',
  unsupported: 'This headset did not offer depth sensing, so nothing changed.',
  waiting: 'Waiting for the headset’s first depth frame…',
  active: 'Active. Edges are approximate and can shimmer — that is the sensor, not the app.',
};

const STATE_LABEL: Record<LinkStatus['state'], string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  open: 'Connected',
  reconnecting: 'Reconnecting…',
  failed: 'Connection failed',
};

/**
 * The flat-screen panel, shown before entering XR and on the desktop.
 *
 * Everything here changes at human speed, so it is ordinary React state. The
 * one number that moves quickly — round-trip time — is sampled a couple of
 * times a second rather than per frame; a latency readout that updates 90 times
 * a second is unreadable anyway.
 */
export function Overlay(props: OverlayProps): React.ReactElement {
  const {
    support,
    status,
    sessionActive,
    passthrough,
    bridgeUrl,
    error,
    onBridgeUrlChange,
    onConnect,
    onEnterXR,
    onPanic,
    devices,
    onAddDevice,
    onRemoveDevice,
    onPinDevice,
    onDropDevice,
    layouts,
    onSaveLayout,
    onApplyLayout,
    onDeleteLayout,
    onPair,
    pairingBusy,
    pairingNote,
    mode,
    onModeChange,
    depthOcclusion,
    onDepthOcclusionChange,
    depthState,
  } = props;

  const connected = status.state === 'open';
  const canEnter = support?.hasPassthrough === true || support?.hasVR === true;

  return (
    <div className="overlay">
      <Masthead />

      <section className="card">
        <h2>1 · Connect</h2>
        <p className="hint">
          Open the VRMC app on the computer with your DAW and type the code it shows.
        </p>
        <PairingEntry onPair={onPair} busy={pairingBusy} />
        {pairingNote !== '' && <p className="hint spaced">{pairingNote}</p>}

        <details className="advanced">
          <summary>Enter an address instead</summary>
        <div className="row">
          <input
            type="text"
            value={bridgeUrl}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => onBridgeUrlChange(e.target.value)}
            aria-label="Bridge WebSocket URL"
          />
          <button type="button" onClick={onConnect}>
            {connected ? 'Reconnect' : 'Connect'}
          </button>
        </div>
        </details>

        <dl className="stats">
          <div>
            <dt>Link</dt>
            <dd className={connected ? 'ok' : status.state === 'failed' ? 'bad' : ''}>
              {STATE_LABEL[status.state]}
            </dd>
          </div>
          <div>
            <dt>Round trip</dt>
            <dd>{status.rttMs >= 0 ? `${status.rttMs.toFixed(1)} ms` : '—'}</dd>
          </div>
          <div>
            <dt>Best</dt>
            <dd>{status.bestRttMs >= 0 ? `${status.bestRttMs.toFixed(1)} ms` : '—'}</dd>
          </div>
          <div>
            <dt>Sent</dt>
            <dd>
              {status.eventsSent} ev
              {status.eventsDropped > 0 ? ` · ${status.eventsDropped} dropped` : ''}
            </dd>
          </div>
        </dl>
        {status.lastError !== '' && !connected && (
          <p className="warn">
            {status.lastError}
            {location.protocol === 'https:' && status.url.startsWith('ws://') && (
              <>
                {' '}
                This page is served over HTTPS, which cannot open a plain <code>ws://</code> socket.
                Use <code>wss://</code> — see docs/WEB-DEPLOYMENT.md.
              </>
            )}
          </p>
        )}
      </section>

      <section className="card">
        <h2>2 · Headset</h2>
        {support === null ? (
          <p className="hint">Checking for WebXR…</p>
        ) : canEnter ? (
          <>
            <p className="hint">
              {support.hasPassthrough
                ? 'Passthrough is available: the instruments will appear in your room.'
                : support.reason}
            </p>
            <button type="button" className="primary" onClick={onEnterXR} disabled={sessionActive}>
              {sessionActive ? 'Session running' : 'Enter mixed reality'}
            </button>
          </>
        ) : (
          <p className="warn">{support.reason}</p>
        )}
        {sessionActive && (
          <p className="hint spaced">
            {passthrough ? 'Passthrough active.' : 'Running without passthrough.'} Take the headset
            off or press the menu button to end the session.
          </p>
        )}

        {/*
          The room, and it is a choice rather than a fallback.
          `startSession` still drops to immersive-vr on a headset that cannot
          do passthrough, but that is a different thing entirely from someone
          deciding they would rather work in the dark. This switch is live in
          both directions at any moment, in or out of a session, and it does
          not touch the session at all — see xr/Backdrop.tsx.
        */}
        <div className="segmented" role="group" aria-label="Room">
          <button
            type="button"
            className={mode === 'passthrough' ? 'on' : ''}
            aria-pressed={mode === 'passthrough'}
            onClick={() => onModeChange('passthrough')}
          >
            Your room
          </button>
          <button
            type="button"
            className={mode === 'immersive' ? 'on' : ''}
            aria-pressed={mode === 'immersive'}
            onClick={() => onModeChange('immersive')}
          >
            Full VR
          </button>
        </div>
        <p className="hint spaced">
          {mode === 'immersive'
            ? 'The instruments sit in the EION Studios galaxy. Switching back is instant and does not interrupt the MIDI connection.'
            : 'The instruments sit in the room around you. Switch to full VR at any time, mid-session, without dropping the connection.'}
        </p>

        {/*
          Environment occlusion, said plainly.

          Hand occlusion is not offered here because it is not a choice: the
          hands are drawn as depth in passthrough and that is simply how the
          room is supposed to look. This is the *room's* depth, which is
          best-effort on every runtime that has it, so it is opt-in and the
          copy says what it actually does rather than promising occlusion.
        */}
        {mode === 'passthrough' && (
          <>
            <label className="toggle">
              <input
                type="checkbox"
                checked={depthOcclusion}
                onChange={(e) => onDepthOcclusionChange(e.target.checked)}
              />
              <span>Let real objects hide the instruments</span>
            </label>
            <p className="hint spaced">
              {DEPTH_NOTE[depthState]} Your hands already pass in front of the instruments
              correctly; this is about the desk and everything else in the room.
            </p>
          </>
        )}
      </section>

      <section className="card">
        <h2>3 · Devices</h2>
        <p className="hint">
          Adding a device makes a MIDI port appear on the computer, named as the real hardware is,
          so your DAW discovers it the way it would a controller being plugged in. Removing it
          closes the port again.
        </p>
        <div className="row wrap">
          <button type="button" onClick={() => onAddDevice(DeviceModel.LAUNCHPAD_X)}>
            + Launchpad X
          </button>
          <button type="button" onClick={() => onAddDevice(DeviceModel.LAUNCHPAD_PRO_MK3)}>
            + Launchpad Pro MK3
          </button>
        </div>

        {devices.length === 0 ? (
          <p className="hint spaced">No emulated devices yet.</p>
        ) : (
          <ul className="devices">
            {devices.map((device) => (
              <li key={device.deviceId}>
                <span className="device-name">{device.spec.displayName}</span>
                <span
                  className={
                    device.status === DeviceStatus.READY
                      ? 'ok'
                      : device.status === DeviceStatus.FAILED
                        ? 'bad'
                        : ''
                  }
                >
                  {device.status === DeviceStatus.READY
                    ? device.detail
                    : device.status === DeviceStatus.FAILED
                      ? device.detail
                      : 'opening ports…'}
                </span>
                <button
                  type="button"
                  onClick={() => onDropDevice(device.deviceId)}
                  disabled={!sessionActive}
                  title={
                    sessionActive
                      ? 'Rest it on whatever is really underneath it.'
                      : 'Only in the headset — it needs to see your room.'
                  }
                >
                  {device.anchored ? 'On a surface' : 'To surface'}
                </button>
                <button
                  type="button"
                  aria-pressed={device.pinned}
                  className={device.pinned ? 'on' : ''}
                  onClick={() => onPinDevice(device.deviceId, !device.pinned)}
                  title={
                    device.pinned
                      ? 'Pinned: your hands cannot move it while you play.'
                      : 'Loose: pinch it to move it.'
                  }
                >
                  {device.pinned ? 'Pinned' : 'Pin'}
                </button>
                <button type="button" onClick={() => onRemoveDevice(device.deviceId)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>4 · Layouts</h2>
        <p className="hint">
          A named arrangement remembers where every device is, how it is turned, and whether it
          is pinned. It is stored on the computer rather than in this browser, so it comes back
          the moment the headset reconnects — including after a restart.
        </p>
        <LayoutEntry onSave={onSaveLayout} disabled={!connected} />
        {!connected && <p className="hint spaced">Connect first — layouts live on the computer.</p>}

        {layouts.layouts.length === 0 ? (
          connected && <p className="hint spaced">No saved layouts yet.</p>
        ) : (
          <ul className="devices">
            {layouts.layouts.map((layout) => (
              <li key={layout.name}>
                <span className="device-name">{layout.name}</span>
                <span>
                  {layout.entries.length === 1 ? '1 device' : `${layout.entries.length} devices`}
                </span>
                <button
                  type="button"
                  className={layouts.current === layout.name ? 'on' : ''}
                  aria-pressed={layouts.current === layout.name}
                  onClick={() => onApplyLayout(layout.name)}
                >
                  {layouts.current === layout.name ? 'In use' : 'Use'}
                </button>
                <button type="button" onClick={() => onDeleteLayout(layout.name)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Playing</h2>
        <ul className="hint list">
          <li>Poke the keys and pads with your fingertips. Harder and faster plays louder.</li>
          <li>Slide a pressed finger sideways across the keys for a glissando.</li>
          <li>Pinch and drag vertically on a knob to send its CC.</li>
          <li>Keys send on channel 1; pads send on channel 10, the drum channel.</li>
        </ul>
        <button type="button" className="danger" onClick={onPanic}>
          Panic — silence all notes
        </button>
      </section>

      {error !== '' && <p className="warn banner">{error}</p>}

      <footer className="colophon">
        <span className="eion-seal">{SEAL}</span>
        <span>EION Studios</span>
      </footer>
    </div>
  );
}

/**
 * The head of the page: the mark, the name, one line, and the theme.
 *
 * The theme control lives here rather than in a settings section because it is
 * a property of the page rather than of anything on it — and because a person
 * who wants it wants it before they have read anything else.
 */
function Masthead(): React.ReactElement {
  const { pref, cycle } = useTheme();
  return (
    <header className="masthead">
      <Logo className="mark" />
      <div>
        <h1>VRMC</h1>
        <p className="tagline">Mixed reality MIDI controller</p>
      </div>
      <button
        type="button"
        className="theme"
        onClick={cycle}
        aria-label={`Theme: ${THEME_LABEL[pref]}. Click to change.`}
      >
        {THEME_LABEL[pref]}
      </button>
    </header>
  );
}


/**
 * Naming an arrangement.
 *
 * A plain field and a button rather than a prompt: this is typed on a floating
 * keyboard in a headset as often as on a real one, and a modal you have to
 * dismiss is one more thing to aim at.
 */
function LayoutEntry({
  onSave,
  disabled,
}: {
  onSave: (name: string) => void;
  disabled: boolean;
}): React.ReactElement {
  const [name, setName] = useState('');
  const ready = name.trim() !== '';
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || disabled) return;
        onSave(name);
        setName('');
      }}
    >
      <input
        type="text"
        value={name}
        placeholder="Studio"
        maxLength={48}
        spellCheck={false}
        aria-label="Layout name"
        disabled={disabled}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" disabled={!ready || disabled}>
        Save this arrangement
      </button>
    </form>
  );
}

/**
 * Pairing code entry.
 *
 * Deliberately one field with generous type sizing: this is typed on a floating
 * keyboard by someone in a headset, where per-character boxes mean a lot of
 * precise pokes and no way to fix a mistake in the middle. Case and dashes are
 * normalised as the user types, so the code can be entered however it reads.
 */
function PairingEntry({
  onPair,
  busy,
}: {
  onPair: (code: string) => void;
  busy: boolean;
}): React.ReactElement {
  const [code, setCode] = useState('');
  const normalised = normalisePairingCode(code);
  const ready = isPairingCode(normalised);

  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) onPair(normalised);
      }}
    >
      <input
        type="text"
        className="code-input"
        value={code}
        placeholder="K7M-2QX"
        maxLength={PAIRING_CODE_LENGTH + 2}
        spellCheck={false}
        autoCapitalize="characters"
        autoCorrect="off"
        aria-label="Pairing code"
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        disabled={busy}
      />
      <button type="submit" className="primary" disabled={!ready || busy}>
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </form>
  );
}
