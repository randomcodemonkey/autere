import { useState, useCallback, useEffect } from 'react';

const MOBILE_BREAKPOINT = 768;

function getIsMobile(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT;
}

export function useCardState(cardId: string, defaultCollapsed = false) {
  const [isMobile, setIsMobile] = useState(getIsMobile);

  useEffect(() => {
    const onResize = () => setIsMobile(getIsMobile());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Use separate localStorage keys for mobile vs desktop so user preferences
  // are preserved per layout mode. First visit uses defaultCollapsed.
  const storageKey = `autere-card-${cardId}-${isMobile ? 'mobile' : 'desktop'}`;

  const [collapsed, setCollapsed] = useState(() => {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) return stored === '1';
    // No stored preference: mobile defaults to collapsed (except chat),
    // desktop defaults to expanded
    if (isMobile && cardId !== 'chat') return true;
    if (!isMobile && cardId !== 'chat') return false;
    return defaultCollapsed;
  });

  // When switching between mobile/desktop, load the preference for that layout
  useEffect(() => {
    const key = `autere-card-${cardId}-${isMobile ? 'mobile' : 'desktop'}`;
    const stored = localStorage.getItem(key);
    if (stored !== null) {
      setCollapsed(stored === '1');
    } else {
      // First visit to this layout: mobile collapses non-chat cards, desktop expands all
      if (isMobile && cardId !== 'chat') setCollapsed(true);
      else if (!isMobile) setCollapsed(false);
      else setCollapsed(defaultCollapsed);
    }
  }, [isMobile, cardId, defaultCollapsed]);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      const key = `autere-card-${cardId}-${isMobile ? 'mobile' : 'desktop'}`;
      localStorage.setItem(key, next ? '1' : '0');
      return next;
    });
  }, [cardId, isMobile]);

  return { collapsed, toggle };
}
