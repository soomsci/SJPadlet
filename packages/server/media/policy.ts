import { setting } from '@server/common/runtime';
export function uploadPolicy() {
  const free = setting('FREE_TIER_MODE') === 'true';
  return {
    imagesOnly: free,
    maxBytes: free ? 1024 ** 2 : 20 * 1024 ** 2,
    boardBytes: free ? 100 * 1024 ** 2 : 1024 ** 3,
    teacherBytes: free ? 200 * 1024 ** 2 : 10 * 1024 ** 3,
    schoolBytes: free ? 800 * 1024 ** 2 : null,
  };
}
