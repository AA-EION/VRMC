import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

/*
 * Deliberately not wrapped in StrictMode.
 *
 * StrictMode's development double-mount exists to surface effects that are not
 * idempotent, which is a good trade in most apps. Here the mount effect opens a
 * WebSocket, an AudioContext and a WebGL context, and tearing those down and
 * rebuilding them on every mount produces spurious reconnects and a suspended
 * audio context that then needs another user gesture to revive. The bugs it
 * would catch are cheaper to find than the ones it creates.
 */
createRoot(container).render(<App />);
