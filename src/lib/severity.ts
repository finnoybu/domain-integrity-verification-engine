// Stability-severity accent colors. Per docs/dashboard-design.md (Decisions),
// the shadcn neutral palette governs the general chrome; these semantic colors
// are reserved for stability-state indicators only (status banners, signal
// rows). Kept as explicit hex — they are deliberately NOT design tokens, so
// they don't bleed into the rest of the UI. Values carried over verbatim from
// the original dashboard.
export const SEVERITY_COLORS = {
  stable: "#16A34A",
  drift: "#D97706",
  risk: "#DC2626",
  critical: "#7F1D1D",
  baseline: "#0EA5E9",
  invalid: "#9CA3AF",
} as const;

export type SeverityKey = keyof typeof SEVERITY_COLORS;
