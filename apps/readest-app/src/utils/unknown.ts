export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const getStringProperty = (value: unknown, property: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const propertyValue = value[property];
  return typeof propertyValue === 'string' ? propertyValue : undefined;
};

export const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const getJsonErrorMessage = (value: unknown): string | undefined =>
  getStringProperty(value, 'error');
