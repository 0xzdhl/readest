export interface UpdaterPlatformInfo {
  url?: string;
}

export interface UpdaterManifest {
  version: string;
  pub_date?: string;
  notes?: string;
  platforms: Record<string, UpdaterPlatformInfo | undefined>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const isUpdaterManifest = (value: unknown): value is UpdaterManifest => {
  if (!isRecord(value) || typeof value['version'] !== 'string' || !isRecord(value['platforms'])) {
    return false;
  }

  return Object.values(value['platforms']).every((platform) => {
    if (platform === undefined) return true;
    return (
      isRecord(platform) && (platform['url'] === undefined || typeof platform['url'] === 'string')
    );
  });
};

export const getUpdaterManifest = async (response: Response): Promise<UpdaterManifest> => {
  const data: unknown = await response.json();
  if (!isUpdaterManifest(data)) {
    throw new Error('Invalid updater manifest');
  }
  return data;
};
