import clsx from 'clsx';
import { useState } from 'react';
import {
  MdOutlineCreditCard,
  MdOutlineRestore,
  MdOutlineLockReset,
  MdOutlineMailOutline,
} from 'react-icons/md';
import { usePlatformInfo } from '@/context/EffectRuntimeProvider';
import { useTranslation } from '@/hooks/useTranslation';
import { BoxedList, NavigationRow } from '@/components/settings/primitives';
import type { UserPlan } from '@/types/quota';

interface DeleteConfirmationModalProps {
  show: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const DeleteConfirmationModal: React.FC<DeleteConfirmationModalProps> = ({
  show,
  onCancel,
  onConfirm,
}) => {
  const _ = useTranslation();
  if (!show) return null;

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4'>
      <div className='eink-bordered bg-base-100 w-full max-w-md rounded-2xl p-6 shadow-xl'>
        <h3 className='text-base-content mb-3 text-lg font-semibold tracking-tight'>
          {_('Delete Your Account?')}
        </h3>
        <p className='text-base-content/70 mb-6 text-[0.9em] leading-relaxed'>
          {_(
            'This action cannot be undone. All your data in the cloud will be permanently deleted.',
          )}
        </p>
        <div className='flex flex-col gap-3 sm:flex-row'>
          <button onClick={onCancel} className='btn btn-ghost flex-1'>
            {_('Cancel')}
          </button>
          <button onClick={onConfirm} className='btn btn-error flex-1'>
            {_('Delete Permanently')}
          </button>
        </div>
      </div>
    </div>
  );
};

interface AccountActionsProps {
  userPlan: UserPlan;
  iapAvailable: boolean;
  onLogout: () => void;
  onResetPassword: () => void;
  onUpdateEmail: () => void;
  onConfirmDelete: () => void;
  onRestorePurchase?: () => void;
  onManageSubscription?: () => void;
}

const AccountActions: React.FC<AccountActionsProps> = ({
  userPlan,
  iapAvailable,
  onLogout,
  onResetPassword,
  onUpdateEmail,
  onConfirmDelete,
  onRestorePurchase,
  onManageSubscription,
}) => {
  const _ = useTranslation();
  const platformInfo = usePlatformInfo();
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);

  const handleDeleteRequest = () => {
    setShowConfirmDelete(true);
  };

  const handleCancelDelete = () => {
    setShowConfirmDelete(false);
  };

  const showRestore = platformInfo.hasIAP && iapAvailable;
  const showSubscription = !showRestore && userPlan !== 'free';
  const hasSubscriptionGroup = showRestore || showSubscription;

  return (
    <>
      <DeleteConfirmationModal
        show={showConfirmDelete}
        onCancel={handleCancelDelete}
        onConfirm={async () => {
          await onConfirmDelete();
          setShowConfirmDelete(false);
        }}
      />
      <div className='flex flex-col gap-6'>
        {hasSubscriptionGroup && (
          <BoxedList title={_('Subscription')}>
            {showSubscription && (
              <NavigationRow
                icon={MdOutlineCreditCard}
                title={_('Manage Subscription')}
                onClick={() => onManageSubscription?.()}
              />
            )}
            {showRestore && (
              <NavigationRow
                icon={MdOutlineRestore}
                title={_('Restore Purchase')}
                onClick={() => onRestorePurchase?.()}
              />
            )}
          </BoxedList>
        )}

        <BoxedList title={_('Account')}>
          <NavigationRow
            icon={MdOutlineLockReset}
            title={_('Reset Password')}
            onClick={onResetPassword}
          />
          <NavigationRow
            icon={MdOutlineMailOutline}
            title={_('Update Email')}
            onClick={onUpdateEmail}
          />
        </BoxedList>

        <div className='flex flex-col gap-3'>
          <button
            type='button'
            onClick={onLogout}
            className={clsx(
              'eink-bordered border-base-200 bg-base-100 flex h-11 items-center justify-center rounded-lg border px-4',
              'text-base-content font-medium',
              'transition-colors duration-150',
              'hover:border-base-300 hover:bg-base-200/60 active:bg-base-200/80',
              'focus-visible:ring-base-content/15 focus-visible:outline-none focus-visible:ring-2',
            )}
          >
            {_('Sign Out')}
          </button>
          <button
            type='button'
            onClick={handleDeleteRequest}
            className={clsx(
              'eink-bordered border-base-200 bg-base-100 flex h-11 items-center justify-center rounded-lg border px-4',
              'text-error font-medium',
              'transition-colors duration-150',
              'hover:border-error/40 hover:bg-error/5 active:bg-error/10',
              'focus-visible:ring-error/30 focus-visible:outline-none focus-visible:ring-2',
            )}
          >
            {_('Delete Account')}
          </button>
        </div>
      </div>
    </>
  );
};

export default AccountActions;
