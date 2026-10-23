import type { Metadata } from "next";
import { ClassStudy } from "@/components/study/ClassStudy";

export const metadata: Metadata = { title: "Vocabulary Quiz Show — Study Vocabulary", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function ClassStudyPage({ params }: { params: Promise<{ activityId: string }> }) {
  const { activityId } = await params;
  return <ClassStudy activityId={activityId} />;
}
