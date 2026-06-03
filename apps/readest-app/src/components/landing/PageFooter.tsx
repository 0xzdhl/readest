import type React from 'react';
import { getBrandName, getWebsiteUrl } from '@/services/environment';

interface PageFooterProps {
  tagline: string;
}

export const PageFooter: React.FC<PageFooterProps> = ({ tagline }) => (
  <p className='text-base-content/50 mt-6 text-center text-xs'>
    <a
      href={getWebsiteUrl()}
      className='hover:text-base-content/80 font-medium transition-colors'
      target='_blank'
      rel='noopener'
    >
      {getBrandName()}
    </a>
    <span className='mx-1.5'>·</span>
    <span>{tagline}</span>
  </p>
);
