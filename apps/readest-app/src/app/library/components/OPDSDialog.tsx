import { clsx } from 'clsx';
import { usePlatformInfo } from '@/context/EffectRuntimeProvider';
import { CatalogManager } from '@/app/opds/components/CatalogManager';
import { useTranslation } from '@/hooks/useTranslation';
import Dialog from '@/components/Dialog';

interface CatalogDialogProps {
  onClose: () => void;
}

export function CatalogDialog({ onClose }: CatalogDialogProps) {
  const _ = useTranslation();
  const platformInfo = usePlatformInfo();
  return (
    <Dialog
      isOpen={true}
      title={platformInfo.isOnlineCatalogsAccessible ? _('Online Library') : _('OPDS Catalogs')}
      onClose={onClose}
      bgClassName={'sm:!bg-black/75'}
      boxClassName='sm:min-w-[520px] sm:w-3/4 sm:h-[85%] sm:!max-w-screen-sm'
    >
      <div className={clsx('bg-base-100 relative flex flex-col overflow-y-auto pb-4')}>
        <CatalogManager />
      </div>
    </Dialog>
  );
}
