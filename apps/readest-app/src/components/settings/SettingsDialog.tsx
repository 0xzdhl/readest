import clsx from 'clsx';
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import type React from 'react';
import { Suspense, useEffect, useRef, useState } from 'react';
import 'overlayscrollbars/overlayscrollbars.css';
import { FiSearch } from 'react-icons/fi';
import { IoAccessibilityOutline } from 'react-icons/io5';
import { LiaHandPointerSolid } from 'react-icons/lia';
import { MdArrowBackIosNew, MdArrowForwardIos, MdClose } from 'react-icons/md';
import { PiDotsThreeVerticalBold, PiRobot, PiSpeakerHigh } from 'react-icons/pi';
import { RiDashboardLine, RiFontSize, RiShareLine, RiTranslate } from 'react-icons/ri';
import { VscSymbolColor } from 'react-icons/vsc';
import { useCommandPalette } from '@/components/command-palette';
import Dialog from '@/components/Dialog';
import Dropdown from '@/components/Dropdown';
import { clientEnv } from '@/clientEnv';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import { useTranslation } from '@/hooks/useTranslation';
import { getCommandPaletteShortcut } from '@/services/environment';
import { useSettingsStore } from '@/store/settingsStore';
import { getDirFromUILanguage } from '@/utils/rtl';
import DialogMenu from './DialogMenu';
import AIPanel from './AIPanel';
import ColorPanel from './ColorPanel';
import ControlPanel from './ControlPanel';
import FontPanel from './FontPanel';
import IntegrationsPanel from './IntegrationsPanel';
import LangPanel from './LangPanel';
import LayoutPanel from './LayoutPanel';
import MiscPanel from './MiscPanel';
import TTSPanel from './TTSPanel';
import { BoxedList, NavigationRow, PanelHeader } from './primitives';

export type SettingsPanelType =
  | 'Font'
  | 'Layout'
  | 'Color'
  | 'Control'
  | 'TTS'
  | 'Language'
  | 'AI'
  | 'Integrations'
  | 'Custom';
export type SettingsPanelPanelProp = {
  bookKey: string;
  onRegisterReset: (resetFn: () => void) => void;
};

type NavItemConfig = {
  tab: SettingsPanelType;
  icon: React.ElementType;
  label: string;
  disabled?: boolean;
};

// Panels that render their own `<PanelHeader>` (title + description) inside
// the panel body. Every other panel gets the dialog-owned header below, so a
// single description map keeps the §2.9 title+description opening uniform
// without editing nine panel files.
const PANELS_WITH_OWN_HEADER = new Set<SettingsPanelType>(['Integrations']);

const SettingsDialog: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const closeIconSize = useResponsiveSize(16);
  const [isRtl] = useState(() => getDirFromUILanguage() === 'rtl');
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Drives the structural fork: ≥640px shows the sidebar + content two-pane;
  // narrower shows the mobile list ↔ panel drill-in. Tracked in state (not a
  // CSS-only switch) because the two layouts have different DOM and header
  // shapes, and a desktop browser narrowed past 640px must flip too.
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia('(min-width: 640px)').matches,
  );
  const {
    setFontPanelView,
    setSettingsDialogOpen,
    activeSettingsItemId,
    setActiveSettingsItemId,
    requestedPanel,
    setRequestedPanel,
  } = useSettingsStore();
  const { open: openCommandPalette } = useCommandPalette();

  const handleOpenCommandPalette = () => {
    openCommandPalette();
    setSettingsDialogOpen(false);
  };

  const navItems = [
    { tab: 'Font', icon: RiFontSize, label: _('Font') },
    { tab: 'Layout', icon: RiDashboardLine, label: _('Layout') },
    { tab: 'Color', icon: VscSymbolColor, label: _('Color') },
    { tab: 'Control', icon: LiaHandPointerSolid, label: _('Behavior') },
    { tab: 'Language', icon: RiTranslate, label: _('Language') },
    { tab: 'TTS', icon: PiSpeakerHigh, label: _('TTS') },
    {
      tab: 'AI',
      icon: PiRobot,
      label: _('AI Assistant'),
      disabled: clientEnv.NODE_ENV === 'production',
    },
    { tab: 'Integrations', icon: RiShareLine, label: _('Integrations') },
    { tab: 'Custom', icon: IoAccessibilityOutline, label: _('Custom') },
  ] as NavItemConfig[];
  const visibleNavItems = navItems.filter((item) => !item.disabled);

  // One-line panel descriptions (DESIGN.md §2.9). Integrations owns its own
  // header so it is intentionally absent here.
  const panelDescriptions: Partial<Record<SettingsPanelType, string>> = {
    Font: _('Choose typefaces and adjust text size for comfortable reading.'),
    Layout: _('Control margins, spacing, columns, and the header and footer.'),
    Color: _('Pick a theme and customize colors, highlights, and backgrounds.'),
    Control: _('Configure scrolling, gestures, page turning, and device behavior.'),
    Language: _('Set the interface language, translation, and dictionaries.'),
    TTS: _('Style how spoken text is highlighted as it is read aloud.'),
    AI: _('Choose the AI model used for in-reader assistance.'),
    Custom: _('Apply your own CSS to the book and to the app interface.'),
  };

  const isValidPanel = (panel: string | null): panel is SettingsPanelType =>
    !!panel && visibleNavItems.some((item) => item.tab === panel);

  // `null` is the mobile list view (no panel drilled into). Desktop never
  // sits at null — there is always a panel selected next to the sidebar.
  const [activePanel, setActivePanel] = useState<SettingsPanelType | null>(() => {
    // Deep-link: a caller asked for a specific panel before opening. The
    // store-clear lives in a useEffect below so we never call a zustand setter
    // during render.
    if (isValidPanel(requestedPanel)) return requestedPanel;
    const startDesktop =
      typeof window === 'undefined' ? true : window.matchMedia('(min-width: 640px)').matches;
    if (!startDesktop) return null;
    const lastPanel = localStorage.getItem('lastConfigPanel');
    if (isValidPanel(lastPanel)) return lastPanel;
    return 'Font';
  });

  // Track the viewport class. On crossing into desktop with no panel selected
  // (e.g. resized up from the mobile list), pick the remembered/default panel.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)');
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (isDesktop && activePanel === null) {
      const lastPanel = localStorage.getItem('lastConfigPanel');
      // eslint-disable-next-line react-hooks/set-state-in-effect -- responding to viewport change
      setActivePanel(isValidPanel(lastPanel) ? lastPanel : 'Font');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop]);

  // Clear the deep-link request after the initial render consumed it.
  useEffect(() => {
    if (requestedPanel) setRequestedPanel(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectPanel = (tab: SettingsPanelType) => {
    setActivePanel(tab);
    setFontPanelView('main-fonts');
    localStorage.setItem('lastConfigPanel', tab);
  };

  const handleBackToList = () => {
    setActivePanel(null);
  };

  // Sync localStorage and fontPanelView when the active panel changes.
  const activePanelRef = useRef(activePanel);
  useEffect(() => {
    if (activePanel && activePanelRef.current !== activePanel) {
      activePanelRef.current = activePanel;
      setFontPanelView('main-fonts');
      localStorage.setItem('lastConfigPanel', activePanel);
    }
  }, [activePanel, setFontPanelView]);

  const [resetFunctions, setResetFunctions] = useState<
    Record<SettingsPanelType, (() => void) | null>
  >({
    Font: null,
    Layout: null,
    Color: null,
    Control: null,
    TTS: null,
    Language: null,
    AI: null,
    Integrations: null,
    Custom: null,
  });

  const registerResetFunction = (panel: SettingsPanelType, resetFn: () => void) => {
    setResetFunctions((prev) => ({ ...prev, [panel]: resetFn }));
  };

  const handleResetCurrentPanel = () => {
    if (!activePanel) return;
    const resetFn = resetFunctions[activePanel];
    if (resetFn) resetFn();
  };

  const handleClose = () => {
    setSettingsDialogOpen(false);
  };

  // handle activeSettingsItemId: switch to the correct panel and scroll to item
  useEffect(() => {
    if (!activeSettingsItemId) return;

    // parse panel from item id (format: settings.panel.itemName)
    const parts = activeSettingsItemId.split('.');
    if (parts.length >= 2) {
      const panelMap: Record<string, SettingsPanelType> = {
        font: 'Font',
        layout: 'Layout',
        color: 'Color',
        control: 'Control',
        tts: 'TTS',
        language: 'Language',
        ai: 'AI',
        integrations: 'Integrations',
        custom: 'Custom',
      };
      const panelKey = parts[1]?.toLowerCase();
      const targetPanel = panelMap[panelKey || ''];
      if (targetPanel && targetPanel !== activePanel) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- panel switch based on external navigation is intended
        setActivePanel(targetPanel);
      }
    }

    // scroll to item after panel renders
    const timeoutId = setTimeout(() => {
      const element = panelRef.current?.querySelector(
        `[data-setting-id="${activeSettingsItemId}"]`,
      );
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.classList.add('settings-highlight');
        setTimeout(() => element.classList.remove('settings-highlight'), 2000);
      }
      setActiveSettingsItemId(null);
    }, 100);

    return () => clearTimeout(timeoutId);
  }, [activeSettingsItemId, activePanel, setActiveSettingsItemId]);

  const activeNav = activePanel
    ? visibleNavItems.find((item) => item.tab === activePanel)
    : undefined;

  const renderWindowControls = (opts: { withMenu: boolean; withClose: boolean }) => (
    <div className='flex h-full items-center justify-end gap-x-2'>
      <button
        onClick={handleOpenCommandPalette}
        aria-label={_('Search Settings')}
        title={`${_('Search Settings')} (${getCommandPaletteShortcut()})`}
        className='btn btn-ghost flex h-8 min-h-8 w-8 items-center justify-center p-0'
      >
        <FiSearch />
      </button>
      {opts.withMenu && activePanel && (
        <Dropdown
          label={_('Settings Menu')}
          className='dropdown-bottom dropdown-end'
          buttonClassName='btn btn-ghost h-8 min-h-8 w-8 p-0 flex items-center justify-center'
          toggleButton={<PiDotsThreeVerticalBold />}
        >
          <DialogMenu
            bookKey={bookKey}
            activePanel={activePanel}
            onReset={handleResetCurrentPanel}
            resetLabel={
              activeNav ? _('Reset {{settings}}', { settings: activeNav.label }) : undefined
            }
          />
        </Dropdown>
      )}
      {opts.withClose && (
        <button
          onClick={handleClose}
          aria-label={_('Close')}
          className='bg-base-300/65 btn btn-ghost btn-circle flex h-6 min-h-6 w-6 p-0'
        >
          <MdClose size={closeIconSize} />
        </button>
      )}
    </div>
  );

  const renderSidebarItem = ({ tab, icon: Icon, label }: NavItemConfig) => {
    const active = activePanel === tab;
    return (
      <button
        key={tab}
        type='button'
        data-tab={tab}
        title={label}
        aria-current={active ? 'page' : undefined}
        onClick={() => handleSelectPanel(tab)}
        className={clsx(
          'group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-start',
          'transition-colors duration-150',
          'focus-visible:ring-base-content/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
          // Two-step depth for selection (DESIGN.md §2.2, §2.3): settings has
          // no brand color, so the active panel reads via base-300 fill, not
          // primary. E-ink keeps the bordered surface visible.
          active
            ? 'bg-base-300/80 text-base-content eink:eink-bordered eink:border'
            : 'text-base-content/80 hover:bg-base-200',
        )}
      >
        <Icon className='h-[1.15em] w-[1.15em] shrink-0' aria-hidden='true' />
        <span className='truncate'>{label}</span>
      </button>
    );
  };

  const scrollerOptions = {
    scrollbars: { autoHide: 'scroll', clickScroll: true },
    showNativeOverlaidScrollbars: false,
  } as const;

  const panelContent = (
    <OverlayScrollbarsComponent
      className='text-base-content h-full px-6 sm:px-8'
      options={scrollerOptions}
      defer
    >
      <div
        ref={panelRef}
        role='group'
        aria-label={`${activeNav?.label ?? _('Settings')} - ${_('Settings')}`}
        className='pb-6 pt-4'
      >
        {activePanel && !PANELS_WITH_OWN_HEADER.has(activePanel) && (
          <PanelHeader
            title={activeNav?.label ?? ''}
            description={panelDescriptions[activePanel]}
          />
        )}
        <Suspense
          fallback={
            <div className='flex min-h-[40vh] items-center justify-center' role='status'>
              <span className='loading loading-lg not-eink:loading-dots eink:loading-spinner' />
              <span className='sr-only'>{_('Loading...')}</span>
            </div>
          }
        >
          {activePanel === 'Font' && (
            <FontPanel
              bookKey={bookKey}
              onRegisterReset={(fn) => registerResetFunction('Font', fn)}
            />
          )}
          {activePanel === 'Layout' && (
            <LayoutPanel
              bookKey={bookKey}
              onRegisterReset={(fn) => registerResetFunction('Layout', fn)}
            />
          )}
          {activePanel === 'Color' && (
            <ColorPanel
              bookKey={bookKey}
              onRegisterReset={(fn) => registerResetFunction('Color', fn)}
            />
          )}
          {activePanel === 'Control' && (
            <ControlPanel
              bookKey={bookKey}
              onRegisterReset={(fn) => registerResetFunction('Control', fn)}
            />
          )}
          {activePanel === 'TTS' && (
            <TTSPanel
              bookKey={bookKey}
              onRegisterReset={(fn) => registerResetFunction('TTS', fn)}
            />
          )}
          {activePanel === 'Language' && (
            <LangPanel
              bookKey={bookKey}
              onRegisterReset={(fn) => registerResetFunction('Language', fn)}
            />
          )}
          {activePanel === 'AI' && <AIPanel />}
          {activePanel === 'Integrations' && <IntegrationsPanel />}
          {activePanel === 'Custom' && (
            <MiscPanel
              bookKey={bookKey}
              onRegisterReset={(fn) => registerResetFunction('Custom', fn)}
            />
          )}
        </Suspense>
      </div>
    </OverlayScrollbarsComponent>
  );

  const mobileList = (
    <OverlayScrollbarsComponent
      className='text-base-content h-full px-6'
      options={scrollerOptions}
      defer
    >
      <div className='py-4'>
        <BoxedList>
          {visibleNavItems.map(({ tab, icon, label }) => (
            <NavigationRow
              key={tab}
              icon={icon}
              title={label}
              onClick={() => handleSelectPanel(tab)}
              data-setting-id={`settings.nav.${tab.toLowerCase()}`}
            />
          ))}
        </BoxedList>
      </div>
    </OverlayScrollbarsComponent>
  );

  return (
    <Dialog
      isOpen={true}
      onClose={handleClose}
      className='modal-open'
      bgClassName={bookKey ? 'sm:!bg-black/20' : 'sm:!bg-black/50'}
      boxClassName={clsx(
        'overflow-hidden not-eink:bg-base-200',
        'sm:!h-[78vh] sm:!max-h-[680px] sm:!min-w-[680px] sm:!w-[min(880px,92vw)] sm:!max-w-[880px]',
      )}
      // Body owns no scroll/padding — the sidebar stays fixed while each pane
      // scrolls independently via its own OverlayScrollbars. Mobile is
      // full-height (no snap sheet) so the list ↔ panel drill-in reads as a
      // full-screen flow rather than a partial sheet.
      contentClassName='!my-0 !overflow-hidden !px-0 sm:!px-0 flex min-h-0'
      header={
        <div className='flex w-full flex-col'>
          {/* Mobile header: list view shows a centered title; panel view shows
              a back chevron (returns to the list) + window controls. */}
          <div className='relative flex h-11 w-full items-center justify-between sm:hidden'>
            {activePanel ? (
              <button
                aria-label={_('Back')}
                onClick={handleBackToList}
                className='btn btn-ghost btn-circle flex h-8 min-h-8 w-8 hover:bg-transparent focus:outline-none'
              >
                {isRtl ? <MdArrowForwardIos /> : <MdArrowBackIosNew />}
              </button>
            ) : (
              <span className='h-8 w-8' aria-hidden='true' />
            )}
            {!activePanel && (
              <div className='pointer-events-none absolute inset-x-0 flex justify-center'>
                <span className='text-base font-semibold'>{_('Settings')}</span>
              </div>
            )}
            {renderWindowControls({ withMenu: !!activePanel, withClose: true })}
          </div>
          {/* Desktop header: sits above the sidebar + content two-pane. */}
          <div className='hidden h-11 w-full items-center justify-between sm:flex'>
            <span className='ps-1 text-base font-semibold'>{_('Settings')}</span>
            {renderWindowControls({ withMenu: true, withClose: true })}
          </div>
        </div>
      }
    >
      <div className='flex h-full min-h-0 w-full'>
        {isDesktop && (
          <nav
            aria-label={_('Settings Panels')}
            className='border-base-200 eink:border-base-content flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-e p-3'
          >
            {visibleNavItems.map(renderSidebarItem)}
          </nav>
        )}
        <div className='flex min-h-0 min-w-0 flex-1 flex-col'>
          {isDesktop || activePanel ? panelContent : mobileList}
        </div>
      </div>
    </Dialog>
  );
};

export default SettingsDialog;
