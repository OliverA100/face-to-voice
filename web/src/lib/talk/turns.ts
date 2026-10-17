/**
 * The chat card's conversation: the last few turns, the character's and the visitor's, in the order they were said.
 * A character turn is one reply (one transcript stream, growing as it is heard); a visitor turn is their line since
 * the character last spoke (lib/talk/heard.ts), growing live, and closed when the character starts its next reply.
 * Pure, so it can be tested without a room.
 */
export type Turn = { id: number; who: "character" | "you"; text: string };

/** Turns kept: the card shows the newest and fades the older ones. */
export const KEEP_TURNS = 6;

export class Turns {
  private list: Turn[] = [];
  private next = 0;
  private replies = new Map<string, number>(); // reply stream id → its turn
  private youOpen = false;

  /** The character's reply `reply` (its stream id) as heard so far. */
  character(reply: string, text: string): void {
    const id = this.replies.get(reply);
    const turn = id === undefined ? undefined : this.list.find((t) => t.id === id);
    if (turn) turn.text = text;
    else {
      this.replies.set(reply, this.next);
      this.push({ id: this.next++, who: "character", text });
    }
  }

  /** The visitor's current line: a new turn after the character has spoken, else the open one grows. */
  you(text: string): void {
    if (!text) return;
    const last = this.list.at(-1);
    if (this.youOpen && last?.who === "you") last.text = text;
    else {
      this.push({ id: this.next++, who: "you", text });
      this.youOpen = true;
    }
  }

  /** The character started speaking: the visitor's next words are a new turn. */
  closeYou(): void {
    this.youOpen = false;
  }

  /** A copy, for the snapshot. */
  get value(): Turn[] {
    return this.list.map((t) => ({ ...t }));
  }

  private push(turn: Turn) {
    this.list.push(turn);
    if (this.list.length > KEEP_TURNS) this.list.shift();
  }
}
