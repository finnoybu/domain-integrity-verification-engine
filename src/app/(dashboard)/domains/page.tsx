import type { Metadata } from "next";
import { DomainsList } from "./domains-list";

export const metadata: Metadata = { title: "Domains — DIVE" };

export default function DomainsPage() {
  return <DomainsList />;
}
