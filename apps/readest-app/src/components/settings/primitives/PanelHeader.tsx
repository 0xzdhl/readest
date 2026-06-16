import clsx from 'clsx';
import type React from 'react';

interface PanelHeaderProps {
  /** Panel name. Rendered as the surface's `<h2>`. */
  title: string;
  /**
   * One-line explanation of what this panel does. Required by DESIGN.md §2.9
   * for every top-level settings panel; skip only when the title already says
   * everything (rare).
   */
  description?: React.ReactNode;
  /** Optional trailing content aligned to the title row (e.g. a quick action). */
  rightSlot?: React.ReactNode;
  className?: string;
}

/**
 * Top-of-panel header for settings panels — the top-level counterpart to
 * `<SubPageHeader>` (which heads drilled-in sub-pages). Renders the canonical
 * title + one-line description opening that DESIGN.md §2.9 requires of every
 * panel, in the same `text-lg font-semibold tracking-tight` / `text-base-content/70`
 * typography so the wording stays visually anchored as the user moves between
 * the sidebar (desktop) or drills in/out (mobile).
 *
 * The description carries no explicit font-size so it inherits the
 * `.settings-content` 14px-desktop / 16px-mobile cascade.
 */
const PanelHeader: React.FC<PanelHeaderProps> = ({ title, description, rightSlot, className }) => {
  return (
    <div className={clsx(description ? 'mb-6' : 'mb-4', 'px-4', className)}>
      <div className='flex w-full items-center justify-between gap-2'>
        <h2 className='text-lg font-semibold tracking-tight'>{title}</h2>
        {rightSlot}
      </div>
      {description && <p className='text-base-content/70 mt-1.5 leading-relaxed'>{description}</p>}
    </div>
  );
};

export default PanelHeader;
