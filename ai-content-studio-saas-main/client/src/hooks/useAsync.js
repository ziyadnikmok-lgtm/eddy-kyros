import { useState, useCallback, useRef, useEffect } from 'react';
import { useApp } from '../context/AppContext';

const ERROR_CODE_MAP = {
  TIMEOUT: 'Request timed out — the server may be busy. Try again in a moment.',
  RATE_LIMITED: 'Rate limit reached — wait a moment and retry.',
  INVALID_API_KEY: 'Your API key is invalid. Check it on the API Keys page.',
  NO_ACTIVE_KEY: 'No active API key. Add one on the API Keys page.',
  SAFETY_BLOCKED: 'Prompt was blocked by safety filters. Try rephrasing.',
  GEMINI_TIMEOUT: 'Gemini took too long to respond. Try a simpler prompt or retry.',
  GEMINI_TRANSIENT: 'Temporary Gemini error — retries exhausted. Try again shortly.',
  TOO_MANY_JOBS: 'Too many batch jobs running. Wait for one to finish or cancel it.',
  PAYLOAD_TOO_LARGE: 'Upload is too large. Reduce the file size and try again.',
  FILE_TOO_LARGE: 'Image is too large. Use PNG, JPG, or WEBP under 10MB.',
  INVALID_FILE_TYPE: 'Unsupported image format. Use PNG, JPG, or WEBP. HEIC is not supported.',
  INVALID_FILE_CONTENT: 'That image file looks broken or mismatched. Re-export it as PNG, JPG, or WEBP and try again.',
  UPLOAD_PARSE_ERROR: 'Could not read that image. Re-export it as PNG, JPG, or WEBP and try again.',
  CORS_ERROR: 'Cross-origin request blocked.',
  INSTAGRAM_UNAVAILABLE: 'Instagram post is unavailable or private.',
};

const INFO_CODES = new Set(['TIMEOUT', 'RATE_LIMITED', 'GEMINI_TIMEOUT', 'GEMINI_TRANSIENT', 'TOO_MANY_JOBS']);

function formatError(err) {
  const code = err?.code || 'UNKNOWN';
  const friendly = ERROR_CODE_MAP[code];
  const message = friendly || err?.message || 'Something went wrong';
  const type = INFO_CODES.has(code) ? 'info' : 'error';
  return { message, type };
}

export function useAsync() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const { notify } = useApp();

  const mountedRef = useRef(true);
  const abortRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  const run = useCallback(async (fn, { silent = false } = {}) => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const result = await fn({ signal: controller.signal });
      if (!mountedRef.current) return undefined;
      return result;
    } catch (err) {
      if (!mountedRef.current) return undefined;
      if (err?.name === 'AbortError') return undefined;
      setError(err);
      if (!silent) {
        const { message, type } = formatError(err);
        notify(message, type);
      }
      return undefined;
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [notify]);

  return { loading, error, run };
}
