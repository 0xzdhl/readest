import { usePlatformInfo } from '@/context/EffectRuntimeProvider';
import { useTranslation } from '@/hooks/useTranslation';
import { getWebsiteUrl } from '@/services/environment';
import Link from './Link';

const LegalLinks = () => {
  const _ = useTranslation();
  const platformInfo = usePlatformInfo();

  const termsUrl =
    platformInfo.isIOSApp || platformInfo.isMacOSApp
      ? 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/'
      : `${getWebsiteUrl()}/terms-of-service`;

  return (
    <div className='my-2 flex flex-wrap justify-center gap-4 text-sm sm:text-xs'>
      <Link href={termsUrl} className='text-blue-500 underline hover:text-blue-600'>
        {_('Terms of Service')}
      </Link>
      <Link
        href={`${getWebsiteUrl()}/privacy-policy`}
        className='text-blue-500 underline hover:text-blue-600'
      >
        {_('Privacy Policy')}
      </Link>
    </div>
  );
};

export default LegalLinks;
