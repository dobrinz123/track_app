import { useEffect, useState } from 'react';
import type { FacadeState, SessionFacade } from '../../session/facade';

/** Subscribes a component to a `SessionFacade`'s live state for its lifetime. */
export function useFacadeState(facade: SessionFacade): FacadeState {
  const [state, setState] = useState<FacadeState>(() => {
    let snapshot: FacadeState | undefined;
    const unsubscribe = facade.subscribe((s) => {
      snapshot = s;
    });
    unsubscribe();
    // subscribe() always calls back synchronously with the current state.
    return snapshot as FacadeState;
  });

  useEffect(() => {
    return facade.subscribe(setState);
  }, [facade]);

  return state;
}
