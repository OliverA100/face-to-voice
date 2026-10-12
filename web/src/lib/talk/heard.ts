/**
 * The "You:" line of a chat: what the visitor has said since the character last spoke, from the agent's transcripts.
 *
 * Each pause starts a new transcript segment, sent as drafts and then final. The speech-to-text (LiveKit Inference,
 * AssemblyAI) also sends each turn final twice, formatted and plain ("Yeah, I am." then "yeah i am"), under different
 * segment ids. So the line is the final segments so far, a version that only repeats words already shown adds
 * nothing, a fuller one replaces what it repeats, and the draft being spoken now goes at the end. Words are compared
 * whole ("no" is not part of "I know"). Pure, so it can be tested without a room.
 */

/** Text reduced to its words, to tell two versions of one transcript apart from new words. */
const words = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, "").replace(/\s+/g, " ").trim()} `;

export class HeardLine {
  private parts = new Map<string, string>();
  private draft = "";

  /** A transcript stream for the visitor: its segment id, its text, and whether it is final. */
  add(id: string, text: string, final: boolean): void {
    const t = text.trim();
    if (!t) return;
    if (!final) {
      this.draft = t;
      return;
    }
    this.draft = "";
    const w = words(t);
    if ([...this.parts.values()].some((p) => words(p).includes(w))) return; // already shown
    for (const [k, p] of this.parts) if (w.includes(words(p))) this.parts.delete(k); // a fuller version replaces it
    this.parts.set(id, t);
  }

  /** The character started speaking: the visitor's next words start a new line. */
  clear(): void {
    this.parts.clear();
    this.draft = "";
  }

  /** The line as shown, starting with a capital. */
  get text(): string {
    const line = [...this.parts.values(), this.draft].filter(Boolean).join(" ");
    return line.charAt(0).toUpperCase() + line.slice(1);
  }
}
