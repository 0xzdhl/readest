import { useEffect, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { cryptoSession } from '@/libs/crypto/session';
import { ensurePassphraseUnlocked } from '@/services/sync/passphraseGate';
import { replicaSyncClient } from '@/libs/replicaSyncClient';
import { isSyncError } from '@/libs/errors';
import { useSettingsStore } from '@/store/settingsStore';

type SyncPassphraseStatus = 'loading' | 'unset' | 'set' | 'error';

const isAuthError = (err: unknown): boolean => isSyncError(err) && err.code === 'AUTH';

export function SyncPassphraseSection() {
  const _ = useTranslation();
  // Tied to the 'credentials' Manage Sync toggle. When credentials sync
  // is off (the default), the passphrase machinery has no purpose — the
  // user has explicitly opted out of sending sensitive fields, so set/
  // forget controls just confuse. Subscribing means the panel pops in /
  // out reactively when the toggle flips.
  const credentialsSync = useSettingsStore(
    (state) => state.settings?.syncCategories?.credentials === true,
  );
  const [status, setStatus] = useState<SyncPassphraseStatus>('loading');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refreshStatus = async () => {
    try {
      const rows = await replicaSyncClient.listReplicaKeys();
      setStatus(rows.length === 0 ? 'unset' : 'set');
      setMessage(null);
    } catch (err) {
      if (isAuthError(err)) {
        // Not signed in — hide the panel by leaving status as 'loading'
        // until the auth context re-renders.
        return;
      }
      setStatus('error');
    }
  };

  useEffect(() => {
    if (!credentialsSync) return;
    void refreshStatus();
  }, [credentialsSync]);

  // Credentials sync off → no passphrase UI at all (set / forget /
  // status indicator are all hidden).
  if (!credentialsSync) return null;
  if (status === 'loading') return null;

  // First-time setup: when the user has no replica_keys row yet, the
  // gate's `kind === 'setup'` branch creates a fresh salt + key. Once
  // a passphrase exists the unlock prompt fires automatically on the
  // first encrypted-field push or pull, so there's no manual unlock
  // affordance — the only button left is "Forgot passphrase".
  const handleSetOrUnlock = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await ensurePassphraseUnlocked();
      await refreshStatus();
      setMessage(_('Sync passphrase ready'));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleForget = async () => {
    if (
      !confirm(
        _(
          'This permanently deletes the encrypted credentials we sync (e.g., OPDS catalog passwords) on every device. Local copies are preserved. You will need to re-enter the sync passphrase or set a new one. Continue?',
        ),
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await cryptoSession.forget();
      await refreshStatus();
      setMessage(_('Sync passphrase forgotten — all encrypted fields cleared'));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1.5'>
        <h3 className='text-base-content text-lg font-semibold tracking-tight'>
          {_('Sync passphrase')}
        </h3>
        <p className='text-base-content/70 text-[0.85em] leading-relaxed'>
          {status === 'unset'
            ? _(
                'Sensitive synced fields are encrypted before upload. Set a passphrase now or later when encryption is needed.',
              )
            : _('Saved to this account. You will be prompted for it when decrypting credentials.')}
        </p>
      </div>
      <div className='card eink-bordered border-base-200 bg-base-100 flex flex-col gap-3 border p-4'>
        <div className='flex items-center justify-between gap-3'>
          <span className='font-medium'>
            {status === 'unset' ? _('No passphrase set') : _('Passphrase active')}
          </span>
          <span
            className={
              status === 'unset' ? 'badge badge-ghost' : 'badge badge-success badge-outline'
            }
          >
            {status === 'unset' ? _('Not set') : _('Set')}
          </span>
        </div>
        {message && <p className='text-base-content/70 text-[0.85em] leading-relaxed'>{message}</p>}
        <div className='flex flex-wrap gap-2'>
          {status === 'unset' ? (
            <button className='btn btn-primary btn-sm' disabled={busy} onClick={handleSetOrUnlock}>
              {_('Set passphrase')}
            </button>
          ) : (
            <button
              className='btn btn-ghost btn-sm text-error'
              disabled={busy}
              onClick={handleForget}
            >
              {_('Forgot passphrase')}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
