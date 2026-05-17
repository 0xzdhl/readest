import { describe, test, expect, beforeEach, vi } from 'vitest';

// ── Module mocks ─────────────────────────────────────────────────────
vi.mock('@tanstack/react-router', () => ({
  redirect: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn().mockReturnValue({ label: 'main', close: vi.fn() }),
}));

vi.mock('@tauri-apps/api/webviewWindow', () => {
  const mockOnce = vi.fn();
  const ctor = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this['once'] = mockOnce;
  }) as unknown as { getByLabel: ReturnType<typeof vi.fn> };
  ctor.getByLabel = vi.fn();
  return { WebviewWindow: ctor };
});

vi.mock('@/services/environment', () => ({
  isPWA: vi.fn().mockReturnValue(false),
  isWebAppPlatform: vi.fn().mockReturnValue(false),
  isTauriAppPlatform: vi.fn().mockReturnValue(false),
}));

vi.mock('@/services/constants', () => ({
  BOOK_IDS_SEPARATOR: '+',
}));

import { redirect } from '@tanstack/react-router';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isTauriAppPlatform } from '@/services/environment';
import {
  navigateToReader,
  navigateToLogin,
  navigateToProfile,
  navigateToLibrary,
  navigateToResetPassword,
  navigateToUpdatePassword,
  redirectToLibrary,
  showReaderWindow,
  showLibraryWindow,
  ensureMainLibraryWindow,
  closeReaderWindowOrGoToLibrary,
} from '@/utils/nav';

const WebviewWindowCtor = WebviewWindow as unknown as { getByLabel: ReturnType<typeof vi.fn> };

// ── Helpers ──────────────────────────────────────────────────────────
function mockRouter() {
  return {
    navigate: vi.fn(),
  };
}

function makeAppService(isMacOS = false) {
  return { isMacOSApp: isMacOS } as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();

  // Reset default environment mock returns
  vi.mocked(isTauriAppPlatform).mockReturnValue(false);

  // Reset getCurrentWindow default
  vi.mocked(getCurrentWindow).mockReturnValue({
    label: 'main',
    close: vi.fn(),
  } as unknown as ReturnType<typeof getCurrentWindow>);

  // Reset window.location
  Object.defineProperty(window, 'location', {
    value: { pathname: '/library', search: '?q=test' },
    writable: true,
  });

  // Reset sessionStorage
  sessionStorage.clear();
});

// ── Tests ────────────────────────────────────────────────────────────
describe('navigateToReader', () => {
  test('navigates to /reader/:ids', () => {
    const router = mockRouter();
    navigateToReader(router, ['book1', 'book2']);

    expect(router.navigate).toHaveBeenCalledTimes(1);
    const callArg = router.navigate.mock.calls[0]![0] as { to: string };
    expect(callArg.to).toBe('/reader/book1+book2');
  });

  test('joins multiple book IDs with + separator', () => {
    const router = mockRouter();
    navigateToReader(router, ['a', 'b', 'c']);

    const callArg = router.navigate.mock.calls[0]![0] as { to: string };
    expect(callArg.to).toBe('/reader/a+b+c');
  });

  test('appends additional query params', () => {
    const router = mockRouter();
    navigateToReader(router, ['book1'], 'view=scroll');

    const callArg = router.navigate.mock.calls[0]![0] as { to: string };
    expect(callArg.to).toBe('/reader/book1?view=scroll');
  });

  test('passes navOptions through', () => {
    const router = mockRouter();
    navigateToReader(router, ['book1'], undefined, { scroll: false });

    expect(router.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: expect.stringContaining('/reader'), scroll: false }),
    );
  });
});

describe('navigateToLogin', () => {
  test('navigates to /auth with redirect from current path', () => {
    Object.defineProperty(window, 'location', {
      value: { pathname: '/library', search: '?q=test' },
      writable: true,
    });

    const router = mockRouter();
    navigateToLogin(router);

    const callArg = router.navigate.mock.calls[0]![0] as {
      to: string;
      search: { redirect: string };
    };
    expect(callArg.to).toBe('/auth');
    expect(callArg.search.redirect).toBe('/library?q=test');
  });

  test('uses / as redirect when already on /auth', () => {
    Object.defineProperty(window, 'location', {
      value: { pathname: '/auth', search: '' },
      writable: true,
    });

    const router = mockRouter();
    navigateToLogin(router);

    const callArg = router.navigate.mock.calls[0]![0] as {
      to: string;
      search: { redirect: string };
    };
    expect(callArg.to).toBe('/auth');
    expect(callArg.search.redirect).toBe('/');
  });
});

describe('navigateToProfile', () => {
  test('navigates to /user', () => {
    const router = mockRouter();
    navigateToProfile(router);

    expect(router.navigate).toHaveBeenCalledWith({ to: '/user', search: { section: '' } });
  });
});

describe('navigateToLibrary', () => {
  test('replaces to /library without params by default', () => {
    const router = mockRouter();
    navigateToLibrary(router);

    expect(router.navigate).toHaveBeenCalledWith({ to: '/library', replace: true });
  });

  test('replaces to /library with query params', () => {
    const router = mockRouter();
    navigateToLibrary(router, 'sort=title');

    expect(router.navigate).toHaveBeenCalledWith({ to: '/library?sort=title', replace: true });
  });

  test('passes navOptions through', () => {
    const router = mockRouter();
    navigateToLibrary(router, undefined, { scroll: false });

    expect(router.navigate).toHaveBeenCalledWith({ to: '/library', replace: true, scroll: false });
  });

  test('uses lastLibraryParams from sessionStorage when navBack=true', () => {
    sessionStorage.setItem('lastLibraryParams', 'sort=author&view=list');

    const router = mockRouter();
    navigateToLibrary(router, undefined, undefined, true);

    expect(router.navigate).toHaveBeenCalledWith({
      to: '/library?sort=author&view=list',
      replace: true,
    });
  });

  test('ignores lastLibraryParams when navBack=false', () => {
    sessionStorage.setItem('lastLibraryParams', 'sort=author');

    const router = mockRouter();
    navigateToLibrary(router, 'sort=title', undefined, false);

    expect(router.navigate).toHaveBeenCalledWith({ to: '/library?sort=title', replace: true });
  });

  test('falls back when lastLibraryParams is null and navBack=true', () => {
    const router = mockRouter();
    navigateToLibrary(router, 'sort=date', undefined, true);

    // Should still use the provided queryParams since sessionStorage has nothing
    expect(router.navigate).toHaveBeenCalledWith({ to: '/library?sort=date', replace: true });
  });
});

describe('redirectToLibrary', () => {
  test('throws redirect to /library', () => {
    expect(() => redirectToLibrary()).toThrow();
    expect(redirect).toHaveBeenCalledWith({ to: '/library' });
  });
});

describe('navigateToResetPassword', () => {
  test('navigates to /auth/recovery with redirect', () => {
    Object.defineProperty(window, 'location', {
      value: { pathname: '/settings', search: '' },
      writable: true,
    });

    const router = mockRouter();
    navigateToResetPassword(router);

    const callArg = router.navigate.mock.calls[0]![0] as {
      to: string;
      search: { redirect: string };
    };
    expect(callArg.to).toBe('/auth/recovery');
    expect(callArg.search.redirect).toBe('/settings');
  });

  test('uses / as redirect when on /auth', () => {
    Object.defineProperty(window, 'location', {
      value: { pathname: '/auth', search: '' },
      writable: true,
    });

    const router = mockRouter();
    navigateToResetPassword(router);

    const callArg = router.navigate.mock.calls[0]![0] as {
      to: string;
      search: { redirect: string };
    };
    expect(callArg.to).toBe('/auth/recovery');
    expect(callArg.search.redirect).toBe('/');
  });
});

describe('navigateToUpdatePassword', () => {
  test('navigates to /auth/update with redirect', () => {
    Object.defineProperty(window, 'location', {
      value: { pathname: '/user', search: '?tab=security' },
      writable: true,
    });

    const router = mockRouter();
    navigateToUpdatePassword(router);

    const callArg = router.navigate.mock.calls[0]![0] as {
      to: string;
      search: { redirect: string };
    };
    expect(callArg.to).toBe('/auth/update');
    expect(callArg.search.redirect).toBe('/user?tab=security');
  });

  test('uses / as redirect when on /auth', () => {
    Object.defineProperty(window, 'location', {
      value: { pathname: '/auth', search: '' },
      writable: true,
    });

    const router = mockRouter();
    navigateToUpdatePassword(router);

    const callArg = router.navigate.mock.calls[0]![0] as {
      to: string;
      search: { redirect: string };
    };
    expect(callArg.to).toBe('/auth/update');
    expect(callArg.search.redirect).toBe('/');
  });
});

describe('showReaderWindow', () => {
  test('creates a new WebviewWindow with correct URL', () => {
    const appService = makeAppService();
    showReaderWindow(appService as never, ['book1', 'book2']);

    expect(WebviewWindow).toHaveBeenCalled();
    const constructorCall = vi.mocked(WebviewWindow).mock.calls[0]!;
    const url = constructorCall[1]!.url as string;
    expect(url).toBe('/reader/book1+book2');
  });

  test('uses macOS-specific window options', () => {
    const appService = makeAppService(true);
    showReaderWindow(appService as never, ['book1']);

    const constructorCall = vi.mocked(WebviewWindow).mock.calls[0]!;
    const options = constructorCall[1]!;
    expect(options.title).toBe('');
    expect(options.decorations).toBe(true);
    expect(options.titleBarStyle).toBe('overlay');
  });

  test('uses non-macOS window options', () => {
    const appService = makeAppService(false);
    showReaderWindow(appService as never, ['book1']);

    const constructorCall = vi.mocked(WebviewWindow).mock.calls[0]!;
    const options = constructorCall[1]!;
    expect(options.title).toBe('Readest');
    expect(options.decorations).toBe(false);
    expect(options.transparent).toBe(true);
    expect(options.shadow).toBe(true);
  });
});

describe('showLibraryWindow', () => {
  test('creates a new WebviewWindow with file params', () => {
    const appService = makeAppService();
    showLibraryWindow(appService as never, ['file1.epub', 'file2.epub']);

    expect(WebviewWindow).toHaveBeenCalled();
    const constructorCall = vi.mocked(WebviewWindow).mock.calls[0]!;
    const url = constructorCall[1]!.url as string;
    expect(url).toContain('/library?');
    expect(url).toContain('file=file1.epub');
    expect(url).toContain('file=file2.epub');
  });
});

describe('ensureMainLibraryWindow', () => {
  test('shows and focuses the existing main window when present', async () => {
    const main = {
      show: vi.fn().mockResolvedValue(undefined),
      unminimize: vi.fn().mockResolvedValue(undefined),
      setFocus: vi.fn().mockResolvedValue(undefined),
    };
    WebviewWindowCtor.getByLabel.mockResolvedValue(main);

    await ensureMainLibraryWindow(makeAppService() as never);

    expect(WebviewWindowCtor.getByLabel).toHaveBeenCalledWith('main');
    expect(main.show).toHaveBeenCalled();
    expect(main.unminimize).toHaveBeenCalled();
    expect(main.setFocus).toHaveBeenCalled();
    expect(WebviewWindow).not.toHaveBeenCalled();
  });

  test('creates a new main-labelled window pointing at /library when missing', async () => {
    WebviewWindowCtor.getByLabel.mockResolvedValue(null);

    await ensureMainLibraryWindow(makeAppService() as never);

    expect(WebviewWindow).toHaveBeenCalledTimes(1);
    const [label, options] = vi.mocked(WebviewWindow).mock.calls[0]!;
    expect(label).toBe('main');
    expect((options as { url: string }).url).toBe('/library');
  });
});

describe('closeReaderWindowOrGoToLibrary', () => {
  function makeAppServiceWithWindow(hasWindow = true) {
    return { isMacOSApp: false, hasWindow } as Record<string, unknown>;
  }

  test('on web platform, navigates current view to /library', async () => {
    vi.mocked(isTauriAppPlatform).mockReturnValue(false);

    const router = mockRouter();
    await closeReaderWindowOrGoToLibrary(makeAppServiceWithWindow() as never, router);

    expect(router.navigate).toHaveBeenCalledWith({ to: '/library', replace: true });
    expect(WebviewWindowCtor.getByLabel).not.toHaveBeenCalled();
  });

  test('in Tauri main window, navigates the same window to /library', async () => {
    vi.mocked(isTauriAppPlatform).mockReturnValue(true);
    const close = vi.fn();
    vi.mocked(getCurrentWindow).mockReturnValue({
      label: 'main',
      close,
    } as unknown as ReturnType<typeof getCurrentWindow>);

    const router = mockRouter();
    await closeReaderWindowOrGoToLibrary(makeAppServiceWithWindow() as never, router);

    expect(close).not.toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith({ to: '/library', replace: true });
  });

  test('in dedicated reader window, ensures main library window and closes self', async () => {
    vi.mocked(isTauriAppPlatform).mockReturnValue(true);
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getCurrentWindow).mockReturnValue({
      label: 'reader-0',
      close,
    } as unknown as ReturnType<typeof getCurrentWindow>);
    const main = {
      show: vi.fn().mockResolvedValue(undefined),
      unminimize: vi.fn().mockResolvedValue(undefined),
      setFocus: vi.fn().mockResolvedValue(undefined),
    };
    WebviewWindowCtor.getByLabel.mockResolvedValue(main);

    const router = mockRouter();
    await closeReaderWindowOrGoToLibrary(makeAppServiceWithWindow() as never, router);

    expect(WebviewWindowCtor.getByLabel).toHaveBeenCalledWith('main');
    expect(main.show).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  test('uses lastLibraryParams from sessionStorage when navigating', async () => {
    vi.mocked(isTauriAppPlatform).mockReturnValue(false);
    sessionStorage.setItem('lastLibraryParams', 'sort=author');

    const router = mockRouter();
    await closeReaderWindowOrGoToLibrary(makeAppServiceWithWindow() as never, router);

    expect(router.navigate).toHaveBeenCalledWith({
      to: '/library?sort=author',
      replace: true,
    });
  });

  test('falls back to navigation when appService is null', async () => {
    vi.mocked(isTauriAppPlatform).mockReturnValue(true);

    const router = mockRouter();
    await closeReaderWindowOrGoToLibrary(null, router);

    expect(router.navigate).toHaveBeenCalledWith({ to: '/library', replace: true });
  });
});
