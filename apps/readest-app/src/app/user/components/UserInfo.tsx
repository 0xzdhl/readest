import { PiUserCircle } from 'react-icons/pi';
import { useTranslation } from '@/hooks/useTranslation';
import type { PlanDetails } from '../utils/plan';
import UserAvatar from '@/components/UserAvatar';

interface UserInfoProps {
  avatarUrl?: string;
  userFullName: string;
  userEmail: string;
  planDetails: PlanDetails;
}

const UserInfo: React.FC<UserInfoProps> = ({ avatarUrl, userFullName, userEmail, planDetails }) => {
  const _ = useTranslation();
  return (
    // Compact identity block for the account rail (sticky-left on desktop,
    // stacked on top on mobile). Avatar + name + email + plan badge in a
    // single row that reads cleanly at the rail's ~256px width.
    <div className='flex min-w-0 items-center gap-3'>
      {/* Lock the avatar box to a square via classes so it can't go oval.
          fillContainer drops UserAvatar's inline width/height so the child
          stretches to this wrapper instead of fighting it. */}
      <div className='aspect-square h-12 w-12 flex-shrink-0'>
        {avatarUrl ? (
          <UserAvatar
            url={avatarUrl}
            size={96}
            DefaultIcon={PiUserCircle}
            className='h-full w-full'
            borderClassName='border-base-100 border-2'
            fillContainer
          />
        ) : (
          <PiUserCircle className='text-base-content/80 h-full w-full' />
        )}
      </div>

      <div className='flex min-w-0 flex-grow flex-col gap-0.5'>
        <h2 className='text-base-content truncate font-semibold tracking-tight'>{userFullName}</h2>
        <p className='text-base-content/65 truncate text-[0.85em]'>{userEmail}</p>
        <span className='border-base-300 text-base-content/70 mt-1 inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[0.75em] font-medium'>
          {_(planDetails.name)}
        </span>
      </div>
    </div>
  );
};

export default UserInfo;
