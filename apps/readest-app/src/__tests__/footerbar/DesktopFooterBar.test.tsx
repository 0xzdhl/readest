import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DesktopFooterBar from '@/app/reader/components/footerbar/DesktopFooterBar';
import type { FooterBarChildProps } from '@/app/reader/components/footerbar/types';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

const mockGetView = vi.fn(() => ({
  history: { canGoBack: true, canGoForward: true },
}));
const mockGetViewState = vi.fn(() => ({ ttsEnabled: false }));
const mockGetProgress = vi.fn(() => ({
  section: { current: 1, total: 10 },
  pageinfo: { current: 1, total: 10 },
}));
const mockGetViewSettings = vi.fn(() => ({
  progressStyle: 'percentage',
  showPaginationButtons: false,
  rtl: false,
}));

vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    hoveredBookKey: 'book-1',
    getView: mockGetView,
    getViewState: mockGetViewState,
    getProgress: mockGetProgress,
    getViewSettings: mockGetViewSettings,
  }),
}));

vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getBookData: () => ({ isFixedLayout: false }),
  }),
}));

const renderFooterBar = (overrides: Partial<FooterBarChildProps> = {}) => {
  const onProgressChange = vi.fn();
  const props: FooterBarChildProps = {
    bookKey: 'book-1',
    navigationHandlers: {
      onPrevPage: vi.fn(),
      onNextPage: vi.fn(),
      onPrevSection: vi.fn(),
      onNextSection: vi.fn(),
      onGoBack: vi.fn(),
      onGoForward: vi.fn(),
      onProgressChange,
    },
    progressFraction: 0.45,
    progressValid: true,
    gridInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    actionTab: '',
    forceMobileLayout: false,
    onSetActionTab: vi.fn(),
    onSpeakText: vi.fn(),
    ...overrides,
  };
  const result = render(<DesktopFooterBar {...props} />);
  return { ...result, onProgressChange };
};

describe('DesktopFooterBar progress slider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the reading progress with the shared Slider component', () => {
    const { container } = renderFooterBar();

    // The polished Slider renders a percentage bubble.
    expect(within(container).getByText('45%')).toBeTruthy();

    // The progress control is the shared Slider's range input, not a bare native one.
    const rangeInput = container.querySelector('input[type="range"]') as HTMLInputElement | null;
    expect(rangeInput).not.toBeNull();
    expect(rangeInput!.className).toContain('slider-input');
  });

  it('forwards slider changes to navigationHandlers.onProgressChange', () => {
    const { container, onProgressChange } = renderFooterBar();

    const rangeInput = container.querySelector('input[type="range"]') as HTMLInputElement;
    fireEvent.change(rangeInput, { target: { value: '70' } });

    expect(onProgressChange).toHaveBeenCalledWith(70);
  });
});
