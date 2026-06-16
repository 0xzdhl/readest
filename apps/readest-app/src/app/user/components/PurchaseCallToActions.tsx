import clsx from 'clsx';
import { useTranslation } from '@/hooks/useTranslation';
import type { PlanType } from '@/types/quota';
import { getLocale } from '@/utils/misc';
import type { PlanDetails } from '../utils/plan';

interface PurchaseCallToActionsProps {
  plan: PlanDetails;
  onSubscribe: (priceId?: string, planType?: PlanType) => void;
}

const PurchaseCallToActions: React.FC<PurchaseCallToActionsProps> = ({ plan, onSubscribe }) => {
  const _ = useTranslation();

  if (!plan.products || plan.products.length === 0) {
    return null;
  }

  const formatProductPrice = (price: number, currency: string) => {
    return new Intl.NumberFormat(getLocale(), {
      style: 'currency',
      currency: currency,
    }).format(price / 100);
  };

  // Render EVERY purchasable one-time product as a buy tile. The previous code
  // only surfaced products tagged `storage` / `customization` and dropped the
  // rest (the `getProductFeature` fallback is `generic`), so lifetime products
  // without those tags showed no buy button at all. Token-based, eink-bordered,
  // two-step-depth hover so it themes cleanly and reads on monochrome.
  const tileClass =
    'eink-bordered border-base-200 bg-base-100 flex w-full flex-col items-center justify-center gap-0.5 rounded-lg border p-3 transition-colors duration-150 hover:border-base-300 hover:bg-base-200/60 focus-visible:ring-base-content/15 focus-visible:outline-none focus-visible:ring-2';

  return (
    <div className={clsx('grid gap-2', plan.products.length === 1 ? 'grid-cols-1' : 'grid-cols-2')}>
      {plan.products.map((product) => (
        <button
          key={product.id}
          type='button'
          onClick={() => onSubscribe(product.id, 'purchase')}
          className={tileClass}
        >
          <span className='text-base-content font-semibold'>{_(product.name)}</span>
          <span className='text-primary text-[0.85em] font-bold'>
            {formatProductPrice(product.price, product.currency)}
          </span>
        </button>
      ))}
    </div>
  );
};

export default PurchaseCallToActions;
