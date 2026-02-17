// ---------------------------------------------------------------------------
// Oasis TUI — Centralized Theme
// ---------------------------------------------------------------------------

/** Midnight Neon palette — all hex colors for 256-color terminal support */
export const colors = {
    primary: "#c084fc",   // Magenta / purple — brand, prompt caret
    accent: "#60a5fa",   // Electric blue — AI messages
    user: "#fbbf24",   // Amber — user messages
    success: "#34d399",   // Emerald — fast lane, heartbeat on
    warning: "#fb923c",   // Orange — slow lane, thinking
    error: "#f87171",   // Red — errors
    muted: "#6b7280",   // Gray-500 — dividers, timestamps
    dim: "#4b5563",   // Gray-600 — secondary info
    text: "#e5e7eb",   // Gray-200 — primary readable text
    white: "#f9fafb",   // Near-white — AI reply body
} as const;

/** Box-drawing horizontal divider */
export const DIVIDER = "─".repeat(78);

/**
 * ASCII avatar — palm-tree / oasis motif.
 * Compact 6-line art that fits in the header.
 */
export const AVATAR = [
    "    ⠀⣠⠤⣄⠀    ",
    "  ⢀⣾⣿⣿⣿⣷⡀  ",
    "  ⣿⣿⣿⣿⣿⣿⣿  ",
    "  ⠈⠻⢿⣿⡿⠟⠁  ",
    "      ⢸⣿⡇      ",
    "  ⣀⣤⣴⣿⣿⣦⣤⣀  ",
].join("\n");

/** Compact single-line avatar for inline use */
export const AVATAR_INLINE = "🌴";

export type ColorKey = keyof typeof colors;
