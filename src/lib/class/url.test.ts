import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { pickClassroomUrls } from "./url";

const path = "/class/abc123def0";
describe("which classroom link is shared (and put in the QR code)", () => {
  it("on a real host the link is the public HTTPS origin — never a local IP", () => {
    const r = pickClassroomUrls({ origin: "https://vocabulary-quiz-show.vercel.app", hostname: "vocabulary-quiz-show.vercel.app", path, lanUrls: ["http://192.168.0.3:3200" + path] });
    expect(r).toEqual({ primary: "https://vocabulary-quiz-show.vercel.app/class/abc123def0", others: [] });
    expect(r.primary).not.toMatch(/192\.168|10\.\d|localhost|127\.0\.0\.1/);
  });
  it("on the teacher's laptop at localhost it is the Wi-Fi address, since phones can't reach localhost", () => {
    const r = pickClassroomUrls({ origin: "http://localhost:3200", hostname: "localhost", path, lanUrls: ["http://192.168.0.3:3200" + path, "http://10.0.0.5:3200" + path] });
    expect(r.primary).toBe("http://192.168.0.3:3200/class/abc123def0");
    expect(r.others).toEqual(["http://10.0.0.5:3200/class/abc123def0"]);
  });
  it("falls back to the page origin when no Wi-Fi address is known, and respects a LAN host the teacher opened directly", () => {
    expect(pickClassroomUrls({ origin: "http://localhost:3200", hostname: "localhost", path, lanUrls: [] }).primary).toBe("http://localhost:3200" + path);
    expect(pickClassroomUrls({ origin: "http://192.168.0.3:3200", hostname: "192.168.0.3", path, lanUrls: [] }).primary).toBe("http://192.168.0.3:3200" + path);
  });
});

describe("QR code", () => {
  it("the library produces a PNG image for the exact classroom URL", async () => {
    const url = "https://vocabulary-quiz-show.vercel.app/class/abc123def0";
    const dataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 2, width: 440 });
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(dataUrl.length).toBeGreaterThan(500);
    // the QR matrix encodes the URL: the same text always gives the same code, a different text a different one
    expect(await QRCode.toDataURL(url, { margin: 2, width: 440, errorCorrectionLevel: "M" })).toBe(dataUrl);
    expect(await QRCode.toDataURL(url + "x", { margin: 2, width: 440, errorCorrectionLevel: "M" })).not.toBe(dataUrl);
  });
  it("the teacher screen encodes the link it shows (not a separately built address) and never uses an outside service", () => {
    const host = readFileSync(new URL("../../components/class/HostClass.tsx", import.meta.url), "utf8");
    expect(host).toMatch(/pickClassroomUrls\(\{ origin: window\.location\.origin/);
    expect(host).toMatch(/<QrCode url=\{links\.primary\} \/>/);
    expect(host).toMatch(/\[links\.primary, \.\.\.links\.others\]\.map/); // the printed link is the same value
    const qr = readFileSync(new URL("../../components/QrCode.tsx", import.meta.url), "utf8");
    expect(qr).toMatch(/import\("qrcode"\)/);
    expect(qr).not.toMatch(/https?:\/\/(api\.qrserver|chart\.googleapis|quickchart)/);
  });
  it("the server never offers LAN addresses on Vercel", async () => {
    const { lanAddresses } = await import("./http");
    const old = process.env.VERCEL;
    process.env.VERCEL = "1";
    expect(lanAddresses()).toEqual([]);
    if (old === undefined) delete process.env.VERCEL; else process.env.VERCEL = old;
  });
});
