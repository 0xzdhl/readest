import type { AvailablePlan, PlanType, UserPlan } from '@/types/quota';
import { getPlanDetails } from '../utils/plan';
import PlanCard from './PlanCard';

interface PlansComparisonProps {
  availablePlans: AvailablePlan[];
  userPlan: UserPlan;
  onSubscribe: (priceId?: string, planType?: PlanType) => void;
}

/**
 * Plans section. Every plan is rendered as a full-width card in a vertical
 * stack so the whole comparison is visible at once (the previous horizontal
 * carousel got clipped inside the account rail's content column). The user's
 * current plan is marked; upgradable plans show an accent CTA. All surfaces
 * are token-based so the section themes cleanly and survives e-ink.
 */
const PlansComparison: React.FC<PlansComparisonProps> = ({
  availablePlans,
  userPlan,
  onSubscribe,
}) => {
  const userPlans: UserPlan[] = ['free', 'plus', 'pro', 'purchase'];
  const userPlanIndex = Math.max(0, userPlans.indexOf(userPlan));
  const allPlans = userPlans.map((plan) => ({ ...getPlanDetails(plan, availablePlans) }));

  return (
    <div className='flex flex-col gap-4'>
      {allPlans.map((plan, index) => (
        <PlanCard
          key={`plan-${plan.plan}-${index}`}
          plan={plan}
          isUserPlan={plan.plan === userPlan}
          comingSoon={false}
          // Preserve the original upgrade gating exactly.
          upgradable={index > 0 && (index > userPlanIndex || userPlan === 'purchase')}
          onSubscribe={onSubscribe}
        />
      ))}
    </div>
  );
};

export default PlansComparison;
