import { z } from 'zod';

export const readerSearchSchema = z.object({
  cfi: z.string().optional().catch(undefined),
});

export const legacyReaderSearchSchema = readerSearchSchema.extend({
  ids: z.string().optional().catch(undefined),
});

export type ReaderSearch = z.infer<typeof readerSearchSchema>;

export const buildReaderQueryParams = (search: ReaderSearch) => {
  const params = new URLSearchParams();
  if (search.cfi) {
    params.set('cfi', search.cfi);
  }
  return params.toString();
};
