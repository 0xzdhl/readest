import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';

import ModalPortal from '@/components/ModalPortal';
import PinInput, { type PinInputHandle } from '@/components/PinInput';
import { useTranslation } from '@/hooks/useTranslation';
import { saveSysSettings } from '@/helpers/settings';
import { PIN_LENGTH, generatePinSalt, hashPin, isValidPin, verifyPin } from '@/libs/crypto/applock';
import { useAppLockStore } from '@/store/appLockStore';
import { useSettingsStore } from '@/store/settingsStore';

const fieldLabelClass = 'text-base-content/70 text-[0.85em] font-medium tracking-wide';

/**
 * Always mounted (at Providers level). Reads `dialogMode` from
 * `useAppLockStore`; renders nothing when null. Dialog state lives in
 * the store rather than the SettingsMenu component because that
 * component unmounts the moment its dropdown closes — local state
 * would never make it to a render.
 */
export default function AppLockDialog() {
  const _ = useTranslation();
  const { settings } = useSettingsStore();
  const {
    pinHash,
    pinSalt,
    setPin: setStorePin,
    clearPin,
    dialogMode,
    closeDialog,
  } = useAppLockStore();
  const mode = dialogMode;

  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const currentPinRef = useRef<PinInputHandle | null>(null);
  const newPinRef = useRef<PinInputHandle | null>(null);
  const confirmPinRef = useRef<PinInputHandle | null>(null);

  // Reset every field on open so a previous attempt's digits never
  // leak into the next session.
  useEffect(() => {
    if (!mode) return;
    setCurrentPin('');
    setNewPin('');
    setConfirmPin('');
    setError('');
  }, [mode]);

  // Auto-advance: as soon as a field reaches PIN_LENGTH, move focus
  // to the next field. Saves the user from tabbing.
  const advanceFromCurrent = (next: string) => {
    setCurrentPin(next);
    if (error) setError('');
    if (next.length === PIN_LENGTH && (mode === 'change' || mode === 'set')) {
      newPinRef.current?.focus();
    }
  };
  const advanceFromNew = (next: string) => {
    setNewPin(next);
    if (error) setError('');
    if (next.length === PIN_LENGTH) confirmPinRef.current?.focus();
  };
  const onConfirmChange = (next: string) => {
    setConfirmPin(next);
    if (error) setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !mode) return;
    setError('');

    if (mode === 'set') {
      if (!isValidPin(newPin)) {
        setError(_('PIN must be {{length}} digits', { length: PIN_LENGTH }));
        return;
      }
      if (newPin !== confirmPin) {
        setError(_('PINs do not match'));
        return;
      }
      setBusy(true);
      try {
        const salt = generatePinSalt();
        const hash = await hashPin(newPin, salt);
        await saveSysSettings('pinCodeSalt', salt);
        await saveSysSettings('pinCodeHash', hash);
        await saveSysSettings('pinCodeEnabled', true);
        setStorePin(hash, salt);
        closeDialog();
      } finally {
        setBusy(false);
      }
      return;
    }

    if (mode === 'change') {
      if (!pinHash || !pinSalt) {
        closeDialog();
        return;
      }
      if (!isValidPin(currentPin)) {
        setError(_('PIN must be {{length}} digits', { length: PIN_LENGTH }));
        return;
      }
      setBusy(true);
      try {
        const ok = await verifyPin(currentPin, pinSalt, pinHash);
        if (!ok) {
          setError(_('Incorrect PIN'));
          setCurrentPin('');
          currentPinRef.current?.focus();
          return;
        }
        if (!isValidPin(newPin)) {
          setError(_('PIN must be {{length}} digits', { length: PIN_LENGTH }));
          return;
        }
        if (newPin !== confirmPin) {
          setError(_('PINs do not match'));
          return;
        }
        const salt = generatePinSalt();
        const hash = await hashPin(newPin, salt);
        await saveSysSettings('pinCodeSalt', salt);
        await saveSysSettings('pinCodeHash', hash);
        setStorePin(hash, salt);
        closeDialog();
      } finally {
        setBusy(false);
      }
      return;
    }

    // mode === 'disable'
    if (!pinHash || !pinSalt) {
      closeDialog();
      return;
    }
    if (!isValidPin(currentPin)) {
      setError(_('PIN must be {{length}} digits', { length: PIN_LENGTH }));
      return;
    }
    setBusy(true);
    try {
      const ok = await verifyPin(currentPin, pinSalt, pinHash);
      if (!ok) {
        setError(_('Incorrect PIN'));
        setCurrentPin('');
        currentPinRef.current?.focus();
        return;
      }
      await saveSysSettings('pinCodeEnabled', false);
      await saveSysSettings('pinCodeHash', undefined);
      await saveSysSettings('pinCodeSalt', undefined);
      clearPin();
      closeDialog();
    } finally {
      setBusy(false);
    }
  };

  if (!mode) return null;
  // Defensive: if `pinCodeEnabled` is somehow stale relative to the
  // mode the caller asked for, close rather than crash.
  if (mode !== 'set' && !settings.pinCodeEnabled) {
    closeDialog();
    return null;
  }

  const title =
    mode === 'set' ? _('Set PIN') : mode === 'change' ? _('Change PIN') : _('Disable PIN');

  const description =
    mode === 'set'
      ? _(
          'Pick a 4-digit PIN. You will need to enter it every time you open Readest. There is no way to recover a forgotten PIN. Clearing the app data is the only way to reset it.',
        )
      : mode === 'change'
        ? _('Enter your current PIN, then choose a new 4-digit PIN.')
        : _('Enter your current PIN to disable the app lock.');

  // Multi-step surfaces label the step sequence so the progression reads calm
  // and obvious. `set` is a single step; `change` is two; `disable` is one.
  const steps =
    mode === 'change'
      ? [_('Verify'), _('Choose new PIN')]
      : mode === 'disable'
        ? [_('Verify')]
        : [];

  const confirmLabel =
    mode === 'set' ? _('Set PIN') : mode === 'change' ? _('Change PIN') : _('Disable');

  return (
    <ModalPortal>
      <dialog className='modal modal-open' aria-label={title}>
        <div
          className={clsx(
            'modal-box eink-bordered bg-base-100 border-base-200 flex w-full max-w-md flex-col',
            'border p-0',
          )}
        >
          {/* Header bar: mode-appropriate title + one-line description (§2.9, §6). */}
          <div className='border-base-200 flex flex-col gap-1.5 border-b px-6 pb-4 pt-6'>
            <h3 className='text-lg font-semibold tracking-tight'>{title}</h3>
            <p className='text-base-content/70 text-[0.85em] leading-relaxed'>{description}</p>
          </div>

          <form onSubmit={handleSubmit} className='flex flex-col gap-6 px-6 py-6'>
            {(mode === 'change' || mode === 'disable') && (
              <div className='flex flex-col items-center gap-3'>
                {steps.length > 1 && (
                  <span className='text-base-content/55 text-[0.78em] font-medium uppercase tracking-wider'>
                    {_('Step {{current}} of {{total}}', { current: 1, total: steps.length })}
                  </span>
                )}
                <span className={fieldLabelClass}>{_('Current PIN')}</span>
                <PinInput
                  ref={currentPinRef}
                  value={currentPin}
                  onChange={advanceFromCurrent}
                  ariaLabel={_('Current PIN')}
                  autoFocus
                  autoComplete='current-password'
                  disabled={busy}
                />
              </div>
            )}
            {(mode === 'set' || mode === 'change') && (
              <>
                <div className='flex flex-col items-center gap-3'>
                  {steps.length > 1 && (
                    <span className='text-base-content/55 text-[0.78em] font-medium uppercase tracking-wider'>
                      {_('Step {{current}} of {{total}}', { current: 2, total: steps.length })}
                    </span>
                  )}
                  <span className={fieldLabelClass}>{_('New PIN')}</span>
                  <PinInput
                    ref={newPinRef}
                    value={newPin}
                    onChange={advanceFromNew}
                    ariaLabel={_('New PIN')}
                    autoFocus={mode === 'set'}
                    autoComplete='new-password'
                    disabled={busy}
                  />
                </div>
                <div className='flex flex-col items-center gap-3'>
                  <span className={fieldLabelClass}>{_('Confirm new PIN')}</span>
                  <PinInput
                    ref={confirmPinRef}
                    value={confirmPin}
                    onChange={onConfirmChange}
                    ariaLabel={_('Confirm new PIN')}
                    autoComplete='new-password'
                    disabled={busy}
                  />
                </div>
              </>
            )}
            {/* Error slot: token error color, reserves its line so the layout
                stays still as messages appear/clear (reduced-motion-safe: opacity
                only, no transform). */}
            <p
              className={clsx(
                'text-error min-h-[1rem] text-center text-[0.85em] leading-4 transition-opacity duration-150',
                error ? 'opacity-100' : 'opacity-0',
              )}
              aria-live='polite'
            >
              {error || ' '}
            </p>
            <div className='flex justify-end gap-3'>
              <button
                type='button'
                onClick={closeDialog}
                disabled={busy}
                className={clsx(
                  'btn btn-ghost',
                  'h-10 min-h-10 rounded-lg px-4 text-sm font-medium',
                  'focus-visible:ring-base-content/15 focus-visible:outline-none focus-visible:ring-2',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                )}
              >
                {_('Cancel')}
              </button>
              <button
                type='submit'
                disabled={busy}
                className={clsx(
                  'btn btn-primary',
                  'h-10 min-h-10 rounded-lg border-0 px-5 text-sm font-medium',
                  'focus-visible:ring-primary/40 focus-visible:outline-none focus-visible:ring-2',
                  busy && 'opacity-60',
                )}
              >
                {busy && (
                  <span
                    aria-hidden='true'
                    className='loading loading-spinner loading-xs me-2 align-[-0.125em]'
                  />
                )}
                {confirmLabel}
              </button>
            </div>
          </form>
        </div>
      </dialog>
    </ModalPortal>
  );
}
