import { useTranslation } from '@/hooks/useTranslation';
import type { PlanDetails } from '../utils/plan';

interface PlanActionButtonProps {
  plan: PlanDetails;
  isUserPlan: boolean;
  comingSoon?: boolean;
  upgradable?: boolean;
  onSubscribe: (priceId?: string) => void;
}

const PlanActionButton: React.FC<PlanActionButtonProps> = ({
  plan,
  isUserPlan,
  comingSoon,
  upgradable,
  onSubscribe,
}) => {
  const _ = useTranslation();

  if (isUserPlan) {
    // Current plan (free or paid): a calm, non-interactive marker, not a CTA.
    return (
      <div className='border-base-200 text-base-content/70 flex w-full items-center justify-center rounded-lg border px-6 py-3 text-[0.9em] font-medium'>
        {_('Current Plan')}
      </div>
    );
  }

  if (upgradable && plan.plan !== 'free') {
    if (comingSoon) {
      return (
        <button type='button' disabled className='btn w-full' aria-disabled='true'>
          {_('Coming Soon')}
        </button>
      );
    }
    return (
      <button
        type='button'
        onClick={() => onSubscribe(plan.productId)}
        className='btn btn-primary w-full'
      >
        {_('Upgrade to {{plan}}', { plan: _(plan.name) })}
      </button>
    );
  }

  return null;
};

export default PlanActionButton;
