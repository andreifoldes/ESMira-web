/**
 * "Install app" affordance.
 *
 * On Android/Chromium we capture the browser's `beforeinstallprompt` event and
 * surface our own button (browsers fire it but don't always show UI). On iOS
 * Safari — which never fires that event — we show a short "Add to Home Screen"
 * instruction instead. Renders nothing once the app is installed / launched
 * standalone, or where installation isn't available.
 *
 * Two layouts: `compact` (a pill for the header) and `card` (full-width, for the
 * invite-code screen).
 */
import { useEffect, useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { cn } from '../lib/utils';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

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

export function InstallPrompt({
  variant = 'compact',
  className,
}: {
  variant?: 'compact' | 'card';
  className?: string;
}) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone());
  const [showIosHint, setShowIosHint] = useState(false);

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

  const iosNeedsHint = isIOS() && !deferred;
  // Nothing to offer: not iOS and no install event captured (e.g. desktop where
  // the browser handles install via its own omnibox affordance, or unsupported).
  if (!deferred && !iosNeedsHint) return null;

  const onInstallClick = async () => {
    if (deferred) {
      await deferred.prompt();
      await deferred.userChoice;
      setDeferred(null);
    } else {
      setShowIosHint((v) => !v);
    }
  };

  const label = 'Install app';

  if (variant === 'card') {
    return (
      <div className={cn('w-full flex flex-col gap-2', className)}>
        <button
          onClick={onInstallClick}
          className="w-full inline-flex items-center justify-center gap-2 bg-secondary-container text-on-secondary-container font-semibold py-3 rounded-full active:scale-95 hover:brightness-95 transition-all"
        >
          {iosNeedsHint ? <Share size={18} aria-hidden="true" /> : <Download size={18} aria-hidden="true" />}
          {label}
        </button>
        {iosNeedsHint && showIosHint && <IosHint onClose={() => setShowIosHint(false)} />}
      </div>
    );
  }

  return (
    <div className={cn('relative shrink-0', className)}>
      <button
        onClick={onInstallClick}
        aria-label={label}
        className="inline-flex items-center gap-1.5 bg-white/20 hover:bg-white/30 text-white font-semibold text-xs px-3 py-1.5 rounded-full active:scale-95 transition-all"
      >
        {iosNeedsHint ? <Share size={14} aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
        <span>Install</span>
      </button>
      {iosNeedsHint && showIosHint && (
        <div className="absolute right-0 top-full mt-2 w-64 z-50 text-on-surface">
          <IosHint onClose={() => setShowIosHint(false)} />
        </div>
      )}
    </div>
  );
}

function IosHint({ onClose }: { onClose: () => void }) {
  return (
    <div className="bg-white dark:bg-surface-container-lowest border border-slate-200 dark:border-outline-variant/30 rounded-xl shadow-lg p-3 text-sm font-medium text-on-surface">
      <div className="flex items-start gap-2">
        <p className="leading-relaxed">
          To install: tap the <Share size={14} className="inline align-text-bottom" aria-label="Share" /> Share
          button in Safari, then choose <strong>Add to Home Screen</strong>.
        </p>
        <button onClick={onClose} aria-label="Dismiss" className="shrink-0 text-on-surface-variant">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
