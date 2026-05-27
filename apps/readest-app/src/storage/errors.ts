export class StorageConfigError extends Error {
  readonly _tag = 'StorageConfigError' as const;
  constructor(message?: string) {
    super(message);
    this.name = 'StorageConfigError';
  }
}

export class StorageSignError extends Error {
  readonly _tag = 'StorageSignError' as const;
  constructor(message?: string) {
    super(message);
    this.name = 'StorageSignError';
  }
}

export class StorageRequestError extends Error {
  readonly _tag = 'StorageRequestError' as const;
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'StorageRequestError';
  }
}

export class StorageNotFoundError extends Error {
  readonly _tag = 'StorageNotFoundError' as const;
  constructor(message?: string) {
    super(message);
    this.name = 'StorageNotFoundError';
  }
}
