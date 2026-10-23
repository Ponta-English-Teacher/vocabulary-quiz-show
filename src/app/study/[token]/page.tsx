import type { Metadata } from "next";
import { StudyApp } from "@/components/study/StudyApp";

export const metadata: Metadata = {
  title: "Vocabulary Quiz Show — Study page",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function StudyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <StudyApp token={token} />;
}
