/**
 * Which classroom link should the teacher share (and put in the QR code)?
 *  - On a real host (Vercel or any non-local address): the page's own origin — the public HTTPS URL.
 *  - On the teacher's laptop at localhost: the laptop's Wi-Fi address, because phones can't reach "localhost".
 * A LAN address is never chosen when the app is served from a real host.
 */
export function pickClassroomUrls(args: { origin: string; hostname: string; path: string; lanUrls: string[] }): { primary: string; others: string[] } {
  const local = args.hostname === "localhost" || args.hostname === "127.0.0.1" || args.hostname === "[::1]" || args.hostname === "::1";
  if (!local) return { primary: `${args.origin}${args.path}`, others: [] };
  if (args.lanUrls.length) return { primary: args.lanUrls[0], others: args.lanUrls.slice(1) };
  return { primary: `${args.origin}${args.path}`, others: [] };
}
