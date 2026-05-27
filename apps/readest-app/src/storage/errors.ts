export class StorageConfigError extends Error {
  readonly _tag = 'StorageConfigError' as const;
}

export class StorageSignError extends Error {
  readonly _tag = 'StorageSignError' as const;
}

export class StorageRequestError extends Error {
  readonly _tag = 'StorageRequestError' as const;
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class StorageNotFoundError extends Error {
  readonly _tag = 'StorageNotFoundError' as const;
}
