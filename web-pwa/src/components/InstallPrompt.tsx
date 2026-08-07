/**
 * "Install app" affordance with browser-aware, tailored instructions.
 *
 * PWA install works differently in every browser, so we detect the environment
 * and show the right guidance:
 *   - `native`       — Chromium (Android/desktop Chrome, Edge, Samsung…) fires
 *                      `beforeinstallprompt`; we capture it and drive a real
 *                      "Install app" button.
 *   - `ios`          — iOS/iPadOS never fires that event; installing means
 *                      Share → "Add to Home Screen" (and only Safari produces a
 *                      real standalone app).
 *   - `macos-safari` — desktop Safari installs via File → "Add to Dock".
 *   - `android`      — Android browser without a captured prompt (e.g. Firefox);
 *                      install lives in the browser menu.
 *   - `unsupported`  — desktop Firefox and others with no PWA install; the only
 *                      way forward is to open the page in Chrome or Safari.
 *
 * Renders nothing once the app is installed / launched standalone.
 *
 * Two layouts: `compact` (a header pill that reveals the guidance in a popover)
 * and `card` (full-width, always-visible guidance for the invite-code screen).
 */
import { useEffect, useState } from 'react';
import { Download, Share, X, MoreVertical, Copy, Check, ExternalLink } from 'lucide-react';
import { cn } from '../lib/utils';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type Platform = 'native' | 'ios' | 'macos-safari' | 'android' | 'unsupported';

function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS Safari exposes this non-standard flag when launched from the home screen.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIOS(): boolean {
  const ua = navigator.userAgent;
  return (
    /iphone|ipad|ipod/i.test(ua) ||
    // iPadOS 13+ reports as a Mac; disambiguate via touch support.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/** iOS browser that isn't Safari (Chrome/Firefox/Edge on iOS are all WebKit but
 *  only Safari's "Add to Home Screen" yields a true standalone PWA). */
function isIOSNonSafari(): boolean {
  return /crios|fxios|edgios|opt\//i.test(navigator.userAgent);
}

function isMacSafari(): boolean {
  const ua = navigator.userAgent;
  return (
    /Macintosh/.test(ua) &&
    /Safari/.test(ua) &&
    !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR/.test(ua)
  );
}

function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent);
}

/** Classify the current environment. A captured `beforeinstallprompt` always
 *  wins — it means the browser can install directly. */
function classify(deferred: BeforeInstallPromptEvent | null): Platform {
  if (deferred) return 'native';
  if (isIOS()) return 'ios';
  if (isMacSafari()) return 'macos-safari';
  if (isAndroid()) return 'android';
  return 'unsupported';
}

export function InstallPrompt({
  variant = 'compact',
  className,
}: {
  variant?: 'compact' | 'card';
  className?: string;
}) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone());
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault(); // stop Chrome's mini-infobar; we drive the prompt ourselves
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed) return null;

  const platform = classify(deferred);

  const runNativePrompt = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  };

  // ── Card: full-width guidance for the invite-code / onboarding screens ──
  if (variant === 'card') {
    if (platform === 'native') {
      return (
        <div className={cn('w-full flex flex-col gap-2', className)}>
          <button
            onClick={runNativePrompt}
            className="w-full inline-flex items-center justify-center gap-2 bg-secondary-container text-on-secondary-container font-semibold py-3 rounded-full active:scale-95 hover:brightness-95 transition-all"
          >
            <Download size={18} aria-hidden="true" />
            Install app
          </button>
        </div>
      );
    }
    return <InstallInstructions platform={platform} className={className} />;
  }

  // ── Compact: a small header pill. Nothing actionable → render nothing. ──
  if (platform === 'unsupported') return null;

  return (
    <div className={cn('relative shrink-0', className)}>
      <button
        onClick={platform === 'native' ? runNativePrompt : () => setShowHint((v) => !v)}
        aria-label="Install app"
        aria-expanded={platform === 'native' ? undefined : showHint}
        className="inline-flex items-center gap-1.5 bg-white/20 hover:bg-white/30 text-white font-semibold text-xs px-3 py-1.5 rounded-full active:scale-95 transition-all"
      >
        {platform === 'native' ? <Download size={14} aria-hidden="true" /> : <Share size={14} aria-hidden="true" />}
        <span>Install</span>
      </button>
      {platform !== 'native' && showHint && (
        <div className="absolute right-0 top-full mt-2 w-72 z-50 text-on-surface">
          <InstallInstructions platform={platform} onClose={() => setShowHint(false)} />
        </div>
      )}
    </div>
  );
}

/** Tailored, browser-specific "how to install" panel. */
function InstallInstructions({
  platform,
  className,
  onClose,
}: {
  platform: Exclude<Platform, 'native'>;
  className?: string;
  onClose?: () => void;
}) {
  const content = INSTRUCTIONS[platform];
  const Icon = content.icon;
  return (
    <div
      className={cn(
        'bg-white dark:bg-surface-container-lowest border border-slate-200 dark:border-outline-variant/30 rounded-xl shadow-lg p-4 text-sm text-on-surface',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span className="p-1.5 rounded-full bg-secondary-container text-on-secondary-container shrink-0">
          <Icon size={16} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-snug">{content.title}</p>
          <ol className="mt-1.5 flex flex-col gap-1.5 text-on-surface-variant leading-relaxed">
            {content.steps.map((step, i) => (
              <li key={i} className="flex gap-2">
                {content.steps.length > 1 && (
                  <span className="font-semibold text-on-surface shrink-0">{i + 1}.</span>
                )}
                <span>{step}</span>
              </li>
            ))}
          </ol>
          {platform === 'unsupported' && <CopyLink />}
        </div>
        {onClose && (
          <button onClick={onClose} aria-label="Dismiss" className="shrink-0 text-on-surface-variant">
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

/** "Copy link" row for browsers that can't install — so participants can paste
 *  the URL into Chrome or Safari. */
function CopyLink() {
  const [copied, setCopied] = useState(false);
  const url = window.location.href;
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the URL is shown below regardless */
    }
  };
  return (
    <button
      onClick={onCopy}
      className="mt-2.5 w-full inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-container-high dark:bg-surface-container-highest text-on-surface font-medium text-xs active:scale-95 transition-all"
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      <span className="truncate">{copied ? 'Link copied' : url}</span>
    </button>
  );
}

const INSTRUCTIONS: Record<
  Exclude<Platform, 'native'>,
  { icon: typeof Share; title: string; steps: string[] }
> = {
  ios: {
    icon: Share,
    title: 'Add this app to your Home Screen',
    steps: [
      'Tap the Share button (a square with an upward arrow) in the browser toolbar.',
      "Scroll down and choose “Add to Home Screen”.",
      'Open the app from your Home Screen, then enter your invite code.',
      ...(isIOSNonSafari() ? ['If you don’t see this option, open this page in Safari first.'] : []),
    ],
  },
  'macos-safari': {
    icon: Download,
    title: 'Add this app to your Dock',
    steps: [
      'In Safari’s menu bar, choose File → “Add to Dock” (or the Share button → “Add to Dock”).',
      'Open the app from your Dock, then enter your invite code.',
    ],
  },
  android: {
    icon: MoreVertical,
    title: 'Install this app',
    steps: [
      'Open your browser’s menu (⋮).',
      'Tap “Install app” or “Add to Home screen”.',
      'Open the app from your Home Screen, then enter your invite code.',
    ],
  },
  unsupported: {
    icon: ExternalLink,
    title: 'This browser can’t install the app',
    steps: ['Open this page in Chrome or Safari to install the app and continue.'],
  },
};
