import { useState, useEffect } from 'react';

export function useStepTimer(active, thresholds = []) {
  const [elapsedSec, setElapsedSec] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (!active) {
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
