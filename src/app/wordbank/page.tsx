import type { Metadata } from "next";
import { WordBankManager } from "@/components/wordbank/WordBankManager";

export const metadata: Metadata = { title: "Word Bank — Vocabulary Quiz Show", robots: { index: false } };

export default function Page() {
  return (
    <main className="wb__page">
      <WordBankManager />
    </main>
  );
}
