import { useState, useEffect } from 'react';

/**
 * Hook that drives step-by-step progress indicators.
 *
 * @param {boolean} active      – whether the timer should be running
 * @param {number[]} thresholds – seconds at which to advance to the next step
 *                                e.g. [3, 8, 15] means step 0 for 0-2s, step 1 for 3-7s, step 2 for 8-14s, step 3 for 15s+
 * @returns {{ elapsedSec: number, stepIndex: number }}
 */
export function useStepTimer(active, thresholds = []) {
  const [elapsedSec, setElapsedSec] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (!active) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on deactivation
      setElapsedSec(0);
      setStepIndex(0);
      return undefined;
    }
    const started = Date.now();
    const tick = () => {
      const sec = Math.floor((Date.now() - started) / 1000);
      setElapsedSec(sec);
      let idx = 0;
      for (let i = 0; i < thresholds.length; i++) {
        if (sec >= thresholds[i]) idx = i + 1;
      }
      setStepIndex(idx);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [active, thresholds]);

  return { elapsedSec, stepIndex };
}
