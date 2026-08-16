import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api.js';

/**
 * Minimal data hook.
 *
 * Deliberately not a caching library: the control plane shows live operational
 * state, so an explicit reload is the honest default and one less dependency
 * to keep the image small.
 */

export interface QueryState<T> {
  data: T | null;
  loading: boolean;
  error: { message: string; detail?: string } | null;
  reload: () => void;
}

export function useQuery<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: unknown[] = []): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<QueryState<T>['error']>(null);
  const [nonce, setNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(null);

    fetcherRef
      .current(controller.signal)
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(
          cause instanceof ApiError
            ? { message: cause.message, detail: `${cause.status} ${cause.code}` }
            : { message: cause instanceof Error ? cause.message : 'Unexpected error.' },
        );
        setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, loading, error, reload };
}
