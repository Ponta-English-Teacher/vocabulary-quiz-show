import type { ReactNode } from "react";

/** The theatrical backdrop: spotlights, haze, vignette and a glossy stage floor. */
export function Stage({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "gold" | "calm" | "studio" }) {
  return (
    <div className={`stage stage--${tone}`}>
      <div className="stage__beams" aria-hidden="true">
        <i className="beam beam--a" />
        <i className="beam beam--b" />
        <i className="beam beam--c" />
      </div>
      <div className="stage__floor" aria-hidden="true" />
      <div className="stage__vignette" aria-hidden="true" />
      {children}
    </div>
  );
}

/** A row of marquee "bulbs" used as a decorative divider. */
export function Bulbs({ count = 14 }: { count?: number }) {
  return (
    <div className="bulbs" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <i key={i} style={{ animationDelay: `${(i % 2) * 0.6}s` }} />
      ))}
    </div>
  );
}
