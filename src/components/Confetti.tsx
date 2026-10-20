"use client";

import { useMemo } from "react";

const COLORS = ["#ffc94a", "#ff3d8b", "#38e1ff", "#a98bff", "#ffffff", "#5dffb0"];

/** Decorative confetti burst. Hidden for reduced-motion users via CSS. */
export function Confetti({ count = 70 }: { count?: number }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        delay: Math.random() * 0.6,
        duration: 2.2 + Math.random() * 1.8,
        drift: (Math.random() - 0.5) * 160,
        spin: 360 + Math.random() * 720,
        color: COLORS[i % COLORS.length],
        w: 6 + Math.random() * 6,
        h: 10 + Math.random() * 10,
      })),
    [count],
  );

  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((p) => (
        <span
          key={p.id}
          style={{
            left: `${p.left}%`,
            width: p.w,
            height: p.h,
            background: p.color,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
            ["--drift" as string]: `${p.drift}px`,
            ["--spin" as string]: `${p.spin}deg`,
          }}
        />
      ))}
    </div>
  );
}
