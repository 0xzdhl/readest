export type UploadMethod = 'POST' | 'PUT';

export const enum UploadFileError {
  Unauthorized = 'Unauthorized access',
  DownloadFailed = 'File download failed',
}

export interface ProgressPayload {
  progress: number;
  total: number;
  transferSpeed: number;
}

export type ProgressHandler = (progress: ProgressPayload) => void;
