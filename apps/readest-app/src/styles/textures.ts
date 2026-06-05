import { getFilename } from '@/utils/path';
import { md5Fingerprint } from '@/utils/md5';

export type { BackgroundTexture, CustomTexture, CustomTextureInfo } from '@/domain/textures';
import type { BackgroundTexture, CustomTexture } from '@/domain/textures';

export const PREDEFINED_TEXTURES: BackgroundTexture[] = [
  { id: 'none', name: 'None', url: '', loaded: true },
  { id: 'concrete', name: 'Concrete', url: '/images/concrete-texture.png', loaded: true },
  { id: 'paper', name: 'Paper', url: '/images/paper-texture.png', loaded: true },
  { id: 'sand', name: 'Sand', url: '/images/sand-texture.jpg', loaded: true },
  { id: 'parchment', name: 'Parchment', url: '/images/parchment-paper.jpg', loaded: true },
  { id: 'scrapbook', name: 'Scrapbook', url: '/images/scrapbook-texture.jpg', loaded: true },
  { id: 'leaves', name: 'Leaves', url: '/images/leaves-pattern.jpg', loaded: true },
  { id: 'moon', name: 'Moon Sky', url: '/images/moon-sky.jpg', loaded: true },
  { id: 'night-sky', name: 'Night Sky', url: '/images/night-sky.jpg', loaded: true },
];

export function getTextureName(path: string): string {
  const fileName = getFilename(path);
  return fileName.replace(/\.(jpg|jpeg|png|gif|bmp|webp|mp4)$/i, '');
}

export function getTextureId(name: string): string {
  return md5Fingerprint(name);
}

export function createCustomTexture(
  path: string,
  options?: Partial<Omit<CustomTexture, 'id' | 'path'>>,
): CustomTexture {
  const name = options?.name || getTextureName(path);
  // Spread options first so replica-sync fields (contentId, bundleDir,
  // byteSize) flow through from the import path. Mirrors the
  // createCustomFont fix — without the spread, addTexture silently
  // drops those fields and publishFontUpsert / replica binary upload
  // both no-op on missing contentId.
  return {
    ...options,
    id: getTextureId(name),
    name,
    path,
  };
}

const createTextureCSS = (texture: BackgroundTexture) => {
  const css = `
    .sidebar-container, .notebook-container, .foliate-viewer {
      position: relative;
    }

    body::before, .sidebar-container::before, .notebook-container::before,
    .foliate-viewer::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
      z-index: 0;
      background-image: url("${texture.blobUrl || texture.url}");
      background-repeat: repeat;
      background-size: var(--bg-texture-size, cover);
      mix-blend-mode: var(--bg-texture-blend-mode, multiply);
      opacity: var(--bg-texture-opacity, 0.6);
    }
    body::before {
      height: 100vh;
    }
    `;

  return css;
};

const textureStyleId = 'background-texture';
export const mountBackgroundTexture = (document: Document, texture: BackgroundTexture) => {
  const styleElement = document.getElementById(textureStyleId) || document.createElement('style');
  styleElement.id = textureStyleId;
  styleElement.textContent = createTextureCSS(texture);

  if (!styleElement.parentNode) {
    document.head.appendChild(styleElement);
  }
};

export const unmountBackgroundTexture = (document: Document) => {
  const styleElement = document.getElementById(textureStyleId);
  if (styleElement && styleElement.parentNode) {
    styleElement.parentNode.removeChild(styleElement);
  }
};
