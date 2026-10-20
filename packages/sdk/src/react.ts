// React bindings. Requires react >= 18 as a peer dependency.
import { useEffect, useRef, useState } from "react";
import { Addr, type ResolveOptions, type ResolveResult } from "./index.ts";

export interface UseResolveState {
  data: ResolveResult | null;
  error: { code: string; message: string } | null;
  loading: boolean;
}

/** Resolves `name` (e.g. "heelo.addr") on `opts.network`. Re-fetches when inputs change; ignores stale responses. */
export function useAddrResolve(client: Addr, name: string | null | undefined, opts: ResolveOptions): UseResolveState {
  const [state, setState] = useState<UseResolveState>({ data: null, error: null, loading: false });
  const seq = useRef(0);
  const key = `${name}|${opts.network}|${opts.asset}|${opts.standard}`;
  useEffect(() => {
    if (!name || !/\.addr$/i.test(name.trim())) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      client.resolve(name.trim(), opts).then(
        (data) => id === seq.current && setState({ data, error: null, loading: false }),
        (e) => id === seq.current && setState({ data: null, error: { code: e.code ?? "error", message: e.message }, loading: false }),
      );
    }, 250); // debounce typing
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  return state;
}
