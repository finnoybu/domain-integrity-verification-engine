import type { Metadata } from "next";
import { SettingsManager } from "./settings-manager";

export const metadata: Metadata = { title: "Settings — DIVE" };

export default function SettingsPage() {
  return <SettingsManager />;
}
