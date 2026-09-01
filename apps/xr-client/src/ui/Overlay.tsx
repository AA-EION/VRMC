import { useState } from 'react';
import { DeviceModel } from '@vrmc/devices';
import { PAIRING_CODE_LENGTH, isPairingCode, normalisePairingCode } from '@vrmc/protocol';
import { DeviceStatus } from '@vrmc/protocol';
import type { LaunchpadInstance } from '../devices/LaunchpadInstance.js';
import type { LinkStatus } from '../net/BridgeLink.js';
import type { XrSupport } from '../xr/session.js';

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
  onPair: (code: string) => void;
  pairingBusy: boolean;
  pairingNote: string;
}

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
    onPair,
    pairingBusy,
    pairingNote,
  } = props;

  const connected = status.state === 'open';
  const canEnter = support?.hasPassthrough === true || support?.hasVR === true;

  return (
    <div className="overlay">
      <header>
        <h1>VRMC</h1>
        <p className="tagline">Mixed reality MIDI controller</p>
      </header>

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
            {location.protocol === 'https:' && bridgeUrl.startsWith('ws://') && (
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
          <p className="hint">
            {passthrough ? 'Passthrough active.' : 'Running without passthrough.'} Take the headset
            off or press the menu button to end the session.
          </p>
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
                <button type="button" onClick={() => onRemoveDevice(device.deviceId)}>
                  Remove
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
    </div>
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
