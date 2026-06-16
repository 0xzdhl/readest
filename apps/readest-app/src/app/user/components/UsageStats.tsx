import Quota from '@/components/Quota';
import { useTranslation } from '@/hooks/useTranslation';
import { SectionTitle } from '@/components/settings/primitives';
import type { QuotaType } from '@/types/quota';

interface UsageStatsProps {
  quotas: QuotaType[];
}

const UsageStats: React.FC<UsageStatsProps> = ({ quotas }) => {
  const _ = useTranslation();
  return (
    <div className='w-full'>
      <SectionTitle className='mb-2'>{_('Usage')}</SectionTitle>
      <div className='card eink-bordered border-base-200 bg-base-100 border p-4'>
        {quotas && quotas.length > 0 ? (
          <Quota quotas={quotas} showProgress className='space-y-4' labelClassName='px-3' />
        ) : (
          <div className='bg-base-200 h-10 animate-pulse rounded-md'></div>
        )}
      </div>
    </div>
  );
};

export default UsageStats;
