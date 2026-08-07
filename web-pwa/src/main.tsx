import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './index.css';

// Register the service worker (autoUpdate: a new build activates in the background —
// see skipWaiting/clientsClaim in sw.ts). Without the controllerchange listener below,
// an already-open session keeps running the OLD JS in memory until the participant
// fully closes and reopens the app, silently missing bug fixes (and schedule/gating
// changes) that have already been deployed. Reloading on controllerchange means an
// update applies on the participant's very next in-app navigation instead.
registerSW({ immediate: true });

if ('serviceWorker' in navigator) {
  // Reload ONLY when a new build replaces an existing controller (a real update).
  // On a first visit the page starts uncontrolled and sw.ts's clientsClaim() fires
  // a controllerchange ~0.4s in as the freshly-installed SW claims the page — that
  // is NOT an update, and reloading there is a spurious first-visit reload that
  // interrupts PWA installation: it discards the `beforeinstallprompt` event
  // InstallPrompt.tsx just captured (so the install button never appears) and
  // resets Chrome's install engagement. Guard on whether a controller already
  // existed at load so the first-install claim is ignored.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    window.location.reload();
  });
}

const root = createRoot(document.getElementById('root')!);

// Dev-only preview of the voice-memo recorder, decoupled from any study/backend:
//   http://localhost:5174/pwa/?recorder-preview=1
// Stripped from production builds (import.meta.env.DEV is false there).
if (import.meta.env.DEV && new URLSearchParams(location.search).has('recorder-preview')) {
  void (async () => {
    const { AudioRecorder } = await import('./components/AudioRecorder');
    root.render(
      <StrictMode>
        <div className="min-h-dvh bg-surface-container">
          <AudioRecorder
            question={{
              id: 'preview',
              type: 'audio',
              required: false,
              text: 'Talk about your day today.',
              max_recording_seconds: 300,
            }}
            reduceMotion={false}
            onCancel={() => console.log('[recorder-preview] cancelled')}
            onSave={(id, blob) =>
              console.log('[recorder-preview] saved', { id, bytes: blob.size, type: blob.type })}
          />
        </div>
      </StrictMode>,
    );
  })();
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
