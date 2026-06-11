import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SystemSettings } from '@/domain/settings';

const settings = { foo: 'bar' } as unknown as SystemSettings;
const bootSpy = vi.fn().mockResolvedValue({ platform: { appPlatform: 'web' }, settings });

vi.mock('@/runtime/clientRuntime', () => ({
  getClientRuntime: () => ({ runPromise: (e: unknown) => bootSpy(e) }),
  getPlatformInfo: () => ({ appPlatform: 'web', isMobile: true }),
}));
vi.mock('@/application/usecases/boot/BootApp', () => ({ BootApp: { _tag: 'BootApp' } }));

import {
  EffectRuntimeProvider,
  useBootSettings,
  useBooted,
  usePlatformInfo,
} from '@/context/EffectRuntimeProvider';

function Probe() {
  const info = usePlatformInfo();
  return <div>mobile:{String(info.isMobile)}</div>;
}

function BootProbe() {
  const booted = useBooted();
  const bs = useBootSettings();
  return (
    <div data-testid='probe'>
      {booted ? `booted:${bs ? 'has-settings' : 'no-settings'}` : 'pending'}
    </div>
  );
}

describe('EffectRuntimeProvider', () => {
  it('exposes sync platform info and runs BootApp once on mount', async () => {
    render(
      <EffectRuntimeProvider>
        <Probe />
      </EffectRuntimeProvider>,
    );
    // jest-dom matchers are not globally registered in this suite, so assert presence directly.
    expect(screen.getByText('mobile:true')).toBeTruthy();
    await waitFor(() => expect(bootSpy).toHaveBeenCalled());
  });
});

describe('EffectRuntimeProvider boot', () => {
  it('flips booted=true and exposes bootSettings after BootApp resolves', async () => {
    const { container } = render(
      <EffectRuntimeProvider>
        <BootProbe />
      </EffectRuntimeProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-testid="probe"]')?.textContent).toBe(
        'booted:has-settings',
      ),
    );
  });

  it('useBooted falls back to false outside the provider', () => {
    const { container } = render(<BootProbe />);
    expect(container.querySelector('[data-testid="probe"]')?.textContent).toBe('pending');
  });
});
