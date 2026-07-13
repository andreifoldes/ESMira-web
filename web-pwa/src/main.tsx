import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './index.css';

// Register the service worker (autoUpdate: a new build silently activates on the
// next load). This is what makes the app installable + offline-capable.
registerSW({ immediate: true });

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
