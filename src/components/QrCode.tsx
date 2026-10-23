"use client";

import { useEffect, useState } from "react";

/** A QR code for `url`, generated in the browser (no outside service). Dark on white so phone cameras read it easily. */
export function QrCode({ url, size = 220, caption = "Scan to join" }: { url: string; size?: number; caption?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    import("qrcode")
      .then((m) => m.toDataURL(url, { errorCorrectionLevel: "M", margin: 2, width: size * 2, color: { dark: "#000000", light: "#ffffff" } }))
      .then((data) => !cancelled && setSrc(data))
      .catch(() => !cancelled && setSrc(null));
    return () => {
      cancelled = true;
    };
  }, [url, size]);
  return (
    <figure className="qr">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} width={size} height={size} alt={`QR code that opens ${url}`} />
      ) : (
        <div className="qr__wait" style={{ width: size, height: size }} aria-hidden="true" />
      )}
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
