import { KeyRound } from 'lucide-react';

/**
 * "Write this down" card for the invite code. Installing the app on iOS gives it
 * its own empty storage, so the code from this tab's link doesn't carry over and
 * the participant has to type it into the installed app. Renders nothing when
 * there is no code to show.
 */
export function InviteCodeNote({ code }: { code: string }) {
  if (!code) return null;
  return (
    <div className="w-full bg-surface-container dark:bg-surface-container-high rounded-xl p-3 text-left">
      <p className="flex items-start gap-2 text-xs text-on-surface-variant leading-relaxed">
        <KeyRound size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
        <span>Write this down — you&apos;ll type it into the app after installing it:</span>
      </p>
      <p
        className="mt-2 font-mono text-xl font-semibold tracking-wider text-on-surface break-all select-all"
        aria-label="Your invite code"
      >
        {code}
      </p>
    </div>
  );
}
