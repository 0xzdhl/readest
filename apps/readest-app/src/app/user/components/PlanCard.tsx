import clsx from 'clsx';
import { IoCheckmark } from 'react-icons/io5';
import { useTranslation } from '@/hooks/useTranslation';
import { getLocale } from '@/utils/misc';
import type { PlanDetails } from '../utils/plan';
import type { PlanType } from '@/types/quota';
import PlanActionButton from './PlanActionButton';
import PurchaseCallToActions from './PurchaseCallToActions';

interface PlanCardProps {
  plan: PlanDetails;
  isUserPlan: boolean;
  comingSoon?: boolean;
  upgradable?: boolean;
  onSubscribe: (priceId?: string, planType?: PlanType) => void;
}

const PlanCard: React.FC<PlanCardProps> = ({
  plan,
  isUserPlan,
  comingSoon,
  upgradable,
  onSubscribe,
}) => {
  const _ = useTranslation();
  const { price, currency } = plan;
  const formattedPrice = new Intl.NumberFormat(getLocale(), {
    style: 'currency',
    currency,
  }).format(price / 100);

  return (
    <div
      className={clsx(
        'eink-bordered bg-base-100 rounded-xl border p-5 transition-colors duration-150',
        // The current plan is highlighted with the brand accent (this surface
        // has a real primary action, so the accent is earned per DESIGN.md §2.2).
        isUserPlan ? 'border-primary' : 'border-base-200',
      )}
    >
      <div className='flex items-baseline justify-between gap-3'>
        <div className='flex items-center gap-2'>
          <h4 className='text-base-content text-lg font-semibold tracking-tight'>{_(plan.name)}</h4>
          {isUserPlan && (
            <span className='border-primary text-primary rounded-full border px-2 py-0.5 text-[0.7em] font-medium'>
              {_('Current')}
            </span>
          )}
        </div>
        <div className='text-base-content shrink-0 text-end'>
          {plan.plan !== 'purchase' ? (
            <span className='text-xl font-bold'>
              {formattedPrice}
              <span className='text-base-content/60 text-[0.7em] font-normal'>
                /{_(plan.interval)}
              </span>
            </span>
          ) : (
            <span className='text-base-content/70 text-[0.85em] font-normal'>
              {_('On-Demand Purchase')}
            </span>
          )}
        </div>
      </div>

      <div className='mt-5 space-y-3'>
        {plan.features.map((feature, featureIndex) => (
          <div key={featureIndex} className='flex flex-col'>
            <div className='flex items-center gap-2'>
              <IoCheckmark className='text-primary h-5 w-5 flex-shrink-0' aria-hidden='true' />
              <span className='text-base-content'>{_(feature.label)}</span>
            </div>
            {feature.description && (
              <div className='text-base-content/65 ms-7 text-[0.85em] leading-relaxed'>
                {_(feature.description)}
              </div>
            )}
          </div>
        ))}
      </div>

      {plan.limits && Object.keys(plan.limits).length > 0 && (
        <div className='bg-base-200 mt-5 rounded-lg p-4'>
          <h5 className='text-base-content mb-3 font-semibold'>{_('Plan Limits')}</h5>
          <div className='space-y-2'>
            {Object.entries(plan.limits).map(([key, value]) => (
              <div key={key} className='flex justify-between text-[0.9em]'>
                <span className='text-base-content/70'>{_(key)}</span>
                <span className='text-base-content font-medium'>{value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className='mt-5'>
        {plan.plan === 'purchase' ? (
          <PurchaseCallToActions plan={plan} onSubscribe={onSubscribe} />
        ) : (
          <PlanActionButton
            plan={plan}
            comingSoon={comingSoon}
            upgradable={upgradable}
            isUserPlan={isUserPlan}
            onSubscribe={onSubscribe}
          />
        )}
      </div>
    </div>
  );
};

export default PlanCard;
