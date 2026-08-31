import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * WebXR only runs in a secure context, and "secure" for a headset on your LAN
 * means real HTTPS — the localhost exemption does not apply to the address the
 * Quest actually connects to. So the dev server speaks HTTPS with a self-signed
 * certificate, which the headset's browser will warn about once and then
 * remember.
 *
 * For production hosting see docs/WEB-DEPLOYMENT.md; a self-signed certificate
 * is a development convenience, not a deployment strategy.
 */
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: true, // bind all interfaces so the headset can reach it
    port: 5173,
  },
  build: {
    // Quest Browser is Chromium-based and well past ES2022; down-levelling
    // would only add transpilation weight to a bundle fetched over Wi-Fi.
    target: 'es2022',
    sourcemap: true,
    rolldownOptions: {
      output: {
        // three.js is the bulk of the bundle and changes only when the
        // dependency does. Splitting it out means shipping an app update
        // re-downloads a few kB rather than the whole engine.
        advancedChunks: {
          groups: [
            { name: 'three', test: /node_modules[\\/]three[\\/]/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
});
