import type { Metadata } from "next";
import { ClassApp } from "@/components/class/ClassApp";

export const metadata: Metadata = { title: "Vocabulary Quiz Show — Join your group" };

export default async function ClassPage({ params }: { params: Promise<{ activityId: string }> }) {
  const { activityId } = await params;
  return <ClassApp activityId={activityId} />;
}
