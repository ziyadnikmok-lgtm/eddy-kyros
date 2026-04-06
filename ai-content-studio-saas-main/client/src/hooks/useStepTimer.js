import { useState, useEffect, useRef } from 'react';

export function useStepTimer(active, thresholds = []) {
  const [elapsedSec, setElapsedSec] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  // Stabilize thresholds reference to prevent timer reset on re-render
  const thresholdsRef = useRef(thresholds);
  thresholdsRef.current = thresholds;

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
      const t = thresholdsRef.current;
      let idx = 0;
      for (let i = 0; i < t.length; i++) {
        if (sec >= t[i]) idx = i + 1;
      }
      setStepIndex(idx);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [active]);

  return { elapsedSec, stepIndex };
}
