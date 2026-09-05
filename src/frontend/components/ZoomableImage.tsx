import React, { useRef, useState } from 'react';

interface ZoomableImageProps {
  src: string;
  alt?: string;
  /** Called when the image receives a plain tap/click while un-zoomed. */
  onTap?: () => void;
}

interface PointerState {
  x: number;
  y: number;
}

const MIN_SCALE = 1;
const MAX_SCALE = 8;

/**
 * Fullscreen lightbox image with pinch-to-zoom and pan support.
 * Uses pointer events so it works with touch (pinch / drag / double-tap)
 * and mouse (wheel / drag / double-click) alike.
 * Clicking the image when fully zoomed out signals close via onZoomClick.
 */
export const ZoomableImage = ({ src, alt, onTap }: ZoomableImageProps) => {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<PointerState>({ x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement>(null);

  // Live gesture bookkeeping (not state: no re-renders per move event)
  const pointers = useRef(new Map<number, PointerState>());
  // Double-tap detection for tap-to-close vs double-click-to-zoom
  const DBL_TAP_MS = 280;
  const lastTapRef = useRef(0);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gesture = useRef({
    // pinch
    startDist: 0,
    startScale: 1,
    startMid: { x: 0, y: 0 },
    // pan
    startOffset: { x: 0, y: 0 },
    dragStart: { x: 0, y: 0 },
    // click suppression after drag/pinch
    moved: false,
  });

  const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

  // Keep the image visually inside the viewport after zooming out or panning
  const clampOffset = (o: PointerState, s: number): PointerState => {
    if (s <= 1 || !imgRef.current) return { x: 0, y: 0 };
    const rect = imgRef.current.getBoundingClientRect();
    const maxX = Math.max(0, (rect.width * (s - 1)) / 2);
    const maxY = Math.max(0, (rect.height * (s - 1)) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, o.x)),
      y: Math.min(maxY, Math.max(-maxY, o.y)),
    };
  };

  const dist = (a: PointerState, b: PointerState) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a: PointerState, b: PointerState): PointerState => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length === 2) {
      gesture.current.startDist = dist(pts[0], pts[1]);
      gesture.current.startScale = scale;
      gesture.current.startMid = mid(pts[0], pts[1]);
    } else if (pts.length === 1) {
      gesture.current.dragStart = { x: e.clientX, y: e.clientY };
      gesture.current.startOffset = offset;
    }
    gesture.current.moved = false;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length >= 2) {
      // Pinch: scale around the gesture midpoint
      const d = dist(pts[0], pts[1]);
      if (gesture.current.startDist > 0) {
        const s = clampScale(gesture.current.startScale * (d / gesture.current.startDist));
        const m = mid(pts[0], pts[1]);
        setScale(s);
        setOffset((prev) =>
          clampOffset(
            {
              x: prev.x + (m.x - gesture.current.startMid.x),
              y: prev.y + (m.y - gesture.current.startMid.y),
            },
            s,
          ),
        );
        gesture.current.startMid = m;
        gesture.current.moved = true;
      }
    } else if (scale > 1) {
      // Pan while zoomed
      setOffset(
        clampOffset(
          {
            x: gesture.current.startOffset.x + (e.clientX - gesture.current.dragStart.x),
            y: gesture.current.startOffset.y + (e.clientY - gesture.current.dragStart.y),
          },
          scale,
        ),
      );
      if (Math.hypot(e.clientX - gesture.current.dragStart.x, e.clientY - gesture.current.dragStart.y) > 5) {
        gesture.current.moved = true;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current.startDist = 0;
    if (pointers.current.size === 1) {
      const remaining = [...pointers.current.values()][0];
      gesture.current.dragStart = { x: remaining.x, y: remaining.y };
      gesture.current.startOffset = offset;
    }
    if (scale <= 1.001) setOffset({ x: 0, y: 0 });
  };

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (gesture.current.moved || scale > 1.001) return;
    // Debounce tap-to-close so a double-click (zoom toggle) doesn't close the
    // lightbox via the first click's tap event.
    const now = Date.now();
    if (now - lastTapRef.current < DBL_TAP_MS) {
      lastTapRef.current = 0;
      if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
      setScale(2.5);
    } else {
      lastTapRef.current = now;
      tapTimerRef.current = setTimeout(() => {
        tapTimerRef.current = null;
        onTap?.();
      }, DBL_TAP_MS);
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Click handler already zoomed in on the second tap; only handle zoom-out
    if (scale > 1) {
      setScale(1);
      setOffset({ x: 0, y: 0 });
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    setScale((prev) => {
      const s = clampScale(prev * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      if (s <= 1.001) setOffset({ x: 0, y: 0 });
      return s;
    });
  };

  return (
    <img
      ref={imgRef}
      src={src}
      alt={alt}
      className="zoomable-image"
      style={{
        transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
        touchAction: 'none',
        cursor: scale > 1 ? 'grab' : 'zoom-in',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onWheel={onWheel}
      draggable={false}
    />
  );
};
