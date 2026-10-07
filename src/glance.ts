// Glance card helpers. VoiceOS silently drops any block whose strings exceed
// the documented limits, so every value is clipped to its field's max here.

export type Block = Record<string, unknown> & { type: string };
type Tone = "neutral" | "good" | "bad";

export const fit = (s: string | number | undefined, max: number, fallback = "-"): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim() || fallback;
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
};

/** Keep the end of a path (the filename) when clipping, since that's the useful part. */
export const fitPath = (p: string, max: number): string =>
  p.length <= max ? p : "…" + p.slice(p.length - (max - 1));

export const header = (title: string, trailing?: string): Block => ({
  type: "header",
  icon: "file",
  title: fit(title, 60),
  ...(trailing ? { trailing: fit(trailing, 40) } : {}),
});

export const keyValue = (pairs: [string, string][]): Block => ({
  type: "keyValue",
  pairs: pairs.slice(0, 5).map(([k, v]) => [fit(k, 32), fit(v, 64)]),
});

export const list = (
  rows: { title: string; subtitle?: string; trailing?: string; icon?: string }[],
  heading?: string,
): Block => ({
  type: "list",
  ...(heading ? { header: fit(heading, 60) } : {}),
  rows: rows.slice(0, 6).map((r) => ({
    icon: r.icon ?? "file",
    title: fitPath(r.title, 60),
    ...(r.subtitle ? { subtitle: fit(r.subtitle, 72) } : {}),
    ...(r.trailing ? { trailing: fit(r.trailing, 24) } : {}),
  })),
});

export const stats = (items: { label: string; value: string | number; tone?: Tone }[]): Block => ({
  type: "stats",
  items: items.slice(0, 3).map((i) => ({
    label: fit(i.label, 48),
    value: fit(i.value, 20),
    ...(i.tone ? { tone: i.tone } : {}),
  })),
});

export const badges = (items: { text: string; tone?: Tone }[]): Block => ({
  type: "badges",
  items: items.slice(0, 3).map((i) => ({ text: fit(i.text, 24), ...(i.tone ? { tone: i.tone } : {}) })),
});

export function glanceResult(blocks: Block[]) {
  if (blocks.length === 0 || blocks.length > 3) throw new Error("glanceResult: pass 1-3 blocks");
  return { _voiceos_glance: { blocks } };
}

export const jsonResult = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload) }],
});
