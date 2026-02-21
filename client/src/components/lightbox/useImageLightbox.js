import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import ImageLightbox from './ImageLightbox';

const CLOSE_ANIMATION_MS = 220;

export function useImageLightbox() {
  const [isOpen, setIsOpen] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [imageUrls, setImageUrls] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const closeTimerRef = useRef(null);

  const openLightbox = useCallback((urls, startIndex = 0) => {
    if (!Array.isArray(urls) || urls.length === 0) return;

    const clampedIndex = Math.max(0, Math.min(startIndex, urls.length - 1));
    setImageUrls(urls);
    setCurrentIndex(clampedIndex);
    setIsVisible(true);
    setIsOpen(true);
  }, []);

  const closeLightbox = useCallback(() => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }

    setIsOpen(false);
    closeTimerRef.current = window.setTimeout(() => {
      setIsVisible(false);
      setImageUrls([]);
      setCurrentIndex(0);
      closeTimerRef.current = null;
    }, CLOSE_ANIMATION_MS);
  }, []);

  useEffect(() => () => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
    }
  }, []);

  const handleIndexChange = useCallback((index) => {
    setCurrentIndex(index);
  }, []);

  const LightboxComponent = useCallback(() => {
    if (!isVisible) return null;

    return createElement(ImageLightbox, {
      isOpen,
      imageUrls,
      currentIndex,
      onClose: closeLightbox,
      onIndexChange: handleIndexChange,
    });
  }, [closeLightbox, currentIndex, handleIndexChange, imageUrls, isOpen, isVisible]);

  return { openLightbox, LightboxComponent };
}

export default useImageLightbox;
