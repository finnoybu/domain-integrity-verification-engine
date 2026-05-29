import type { Metadata } from "next";
import { DomainDetail } from "./domain-detail";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ domain: string }>;
}): Promise<Metadata> {
  const { domain } = await params;
  return { title: `${domain} — DIVE` };
}

export default async function DomainDetailPage({
  params,
}: {
  params: Promise<{ domain: string }>;
}) {
  const { domain } = await params;
  return <DomainDetail domain={domain} />;
}
