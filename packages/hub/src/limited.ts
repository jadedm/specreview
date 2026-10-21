// Runs `fn` over `items` with at most `limit` calls in flight, and answers in
// the items' order (#176). The first rejection rejects the whole, as
// Promise.all does, and no call starts after it; calls already started are
// not waited for.
export const eachLimited = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    for (let i = next++; i < items.length && !failed; i = next++) {
      results[i] = await fn(items[i]).catch((err: unknown) => {
        failed = true;
        throw err;
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};
