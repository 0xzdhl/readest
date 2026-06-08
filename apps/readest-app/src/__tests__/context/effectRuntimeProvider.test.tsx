import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const bootSpy = vi.fn().mockResolvedValue({ platform: { appPlatform: 'web' }, settings: {} });

vi.mock('@/runtime/clientRuntime', () => ({
  getClientRuntime: () => ({ runPromise: (e: unknown) => bootSpy(e) }),
  getPlatformInfo: () => ({ appPlatform: 'web', isMobile: true }),
}));
vi.mock('@/application/usecases/boot/BootApp', () => ({ BootApp: { _tag: 'BootApp' } }));

import { EffectRuntimeProvider, usePlatformInfo } from '@/context/EffectRuntimeProvider';

function Probe() {
  const info = usePlatformInfo();
  return <div>mobile:{String(info.isMobile)}</div>;
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
    await waitFor(() => expect(bootSpy).toHaveBeenCalledTimes(1));
  });
});
