import { useSyncExternalStore } from 'react';

/** Phones in portrait (< 768 px wide) and in landscape (short and touch-driven) get the mobile shell. */
export const MOBILE_QUERY = '(max-width: 767px), (max-height: 500px) and (pointer: coarse)';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = matchMedia(query);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}

export const useIsMobile = () => useMediaQuery(MOBILE_QUERY);
