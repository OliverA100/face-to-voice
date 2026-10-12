/**
 * Every reply starts with the character's mood: "[happy 2] Oh, now that's a story!" (the server's instructions ask for
 * it, web/src/lib/server/characterPrompt.ts). This pulls that tag off the front of the streamed reply, so it can drive
 * the voice (an ElevenLabs v4 audio tag) and the face (a participant attribute), and never be read out as words.
 *
 * Streaming: the reply arrives in small pieces, so the start is held back until the tag is complete, or until it is
 * clear there is none. Any other square brackets later in the reply are dropped too: to v4 they would be audio tags.
 */
export interface Mood {
  emotion: string; // one of the face's emotions, or "neutral"
  strength: 0 | 1 | 2 | 3; // 0 for neutral
}

/** The longest a tag can be ("[surprised 3]" is 13): past this without a "]" there is no tag. */
const MAX_TAG = 24;
const TAG_RE = /^\s*\[\s*([a-z]+)(?:\s*[: ]\s*([0-3]))?\s*\]\s*/i;

export class MoodTag {
  private head = "";
  private done = false;
  private inBracket = false; // a "[" seen and its "]" not yet (brackets can span pieces)
  private leading = true; // spaces before the first word are dropped (the tag's space may arrive in the next piece)
  /** The mood found at the start of this reply (null until found, or when there was none). */
  mood: Mood | null = null;

  private readonly known: ReadonlySet<string>;
  constructor(known: ReadonlySet<string>) {
    this.known = known;
  }

  /** Feed a piece of the reply; returns the text to pass on (possibly empty while the start is held back). */
  push(piece: string): string {
    if (this.done) return this.strip(piece);
    this.head += piece;
    const m = TAG_RE.exec(this.head);
    if (m) {
      this.done = true;
      const emotion = m[1].toLowerCase();
      if (this.known.has(emotion)) this.mood = { emotion, strength: emotion === "neutral" ? 0 : (Math.min(3, Number(m[2] ?? 2)) as 1 | 2 | 3) };
      return this.strip(this.head.slice(m[0].length));
    }
    const trimmed = this.head.trimStart();
    if (trimmed.length && (!trimmed.startsWith("[") || trimmed.length > MAX_TAG || trimmed.includes("]"))) {
      this.done = true; // no tag after all: pass the text on as it is
      return this.strip(this.head);
    }
    return "";
  }

  /** The end of the reply: whatever is still held back. */
  flush(): string {
    if (this.done) return "";
    this.done = true;
    return this.strip(this.head);
  }

  private strip(s: string): string {
    let out = "";
    for (const c of s) {
      if (c === "[") this.inBracket = true;
      else if (c === "]") this.inBracket = false;
      else if (!this.inBracket && !(this.leading && /\s/.test(c))) {
        out += c;
        this.leading = false;
      }
    }
    return out;
  }
}

/** "[happy, bright and bouncy] " for v4, from the server's table; "" for neutral or an unknown mood. */
export function audioTag(mood: Mood | null, tags: Record<string, [string, string, string]>): string {
  if (!mood || mood.strength === 0) return "";
  const t = tags[mood.emotion];
  return t ? `[${t[mood.strength - 1]}] ` : "";
}

/** The face's intensity for a mood strength (the browser blends to it): a hint, clear, full. */
export function moodIntensity(strength: Mood["strength"]): number {
  return [0, 0.5, 0.75, 1][strength];
}
