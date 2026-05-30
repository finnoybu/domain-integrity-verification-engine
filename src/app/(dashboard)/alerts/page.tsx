import type { Metadata } from "next";
import { AlertsManager } from "./alerts-manager";

export const metadata: Metadata = { title: "Alerts — DIVE" };

export default function AlertsPage() {
  return <AlertsManager />;
}
