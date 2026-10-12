"use client";

/**
 * The Meet step: the character behind the voice. Claude writes a profile from the casting (name, backstory, traits,
 * habits, quirks, interests, catchphrases, mood and first words), which the live conversation will play. The mood is
 * not shown (the face already shows the expression, and it changes as they talk), nor are the first words: they stay a
 * surprise until the conversation.
 *
 * Opening the step writes the profile the first time (one Claude call, then shared by everyone who meets this voice);
 * after that it is free. "Reimagine" writes a different one for the same voice, kept for this visitor only.
 */
import { useEffect, useRef, useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { BusySwap } from "@/components/ui/Spinner";
import { Status } from "@/components/ui/Status";
import { TalkPanel } from "@/components/ui/TalkPanel";
import type { ProfileResult } from "@/lib/character/profile";
import { talkAvailable } from "@/lib/talk/invite";
import { ProfileSkeleton } from "@/components/ui/ProfileSkeleton";
import { requestProfile, VoiceApiError, type DesignResult } from "@/lib/voice/client";

type Busy = null | "write" | "rewrite";

export function CharacterCard({
  design,
  take,
  result,
  onResult,
}: {
  design: Pick<DesignResult, "faceKey" | "descKey">;
  take: number | null; // the voice in use: the one the character talks with
  result: ProfileResult | null;
  onResult: (r: ProfileResult, forDesign: Pick<DesignResult, "faceKey" | "descKey">) => void; // the voice it was asked for
}) {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState("");

  const write = async (kind: Exclude<Busy, null>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      onResult(await requestProfile(design, kind === "rewrite"), design);
      setSaid(kind === "rewrite" ? "They have been reimagined." : "The character's profile is ready.");
    } catch (e) {
      if (!(e instanceof VoiceApiError)) console.error("[profile]", e);
      setError(e instanceof VoiceApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  // Opening the step is the request: write (or fetch) the profile once, on the first visit.
  const asked = useRef(false);
  useEffect(() => {
    if (result || asked.current) return;
    asked.current = true;
    void write("write");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, []);

  if (!result) {
    return (
      <div className="flex flex-col gap-3">
        {busy === "write" || !error ? (
          // A tray shaped and sized like the profile it is about to become (ProfileSkeleton)
          <ProfileSkeleton />
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 text-label text-ink">Their profile didn’t arrive.</p>
            <button type="button" onClick={() => write("write")} data-step-focus className="pill-secondary h-8 px-3 text-label">
              Try again
            </button>
          </div>
        )}
        {error && <Alert>{error}</Alert>}
        <Status message={busy === "write" ? "Writing their profile…" : said} />
      </div>
    );
  }

  const { profile } = result;
  return (
    <div className="enter flex flex-col gap-3">
      <section aria-label={`Character: ${profile.name}`} className="flex flex-col gap-3 rounded-tray bg-surface p-4">
        <div>
          <h3 className="display text-[20px] text-ink">{profile.name}</h3>
          {profile.title && <p className="text-meta text-ink-3 first-letter:uppercase">{profile.title}</p>}
        </div>
        <p className="text-body text-ink-2">{profile.backstory}</p>
        {/* Chips wrap onto new lines; the card never scrolls sideways. */}
        <ul aria-label="Traits" className="flex flex-wrap gap-1.5">
          {profile.traits.map((t) => (
            <li key={t} className="rounded-full bg-card px-2.5 py-0.5 text-meta text-ink-2 shadow-hairline">
              {t}
            </li>
          ))}
        </ul>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-meta">
          <Row label="Habits" items={profile.habits} />
          <Row label="Quirks" items={profile.quirks} />
          <Row label="Loves" items={profile.interests} />
          {profile.dislikes?.length > 0 && <Row label="Hates" items={profile.dislikes} />}
          <Row label="Catchphrase" items={profile.catchphrases.map((c) => `“${c}”`)} />
          {profile.want && <Row label="Wants" items={[profile.want]} />}
        </dl>
      </section>
      {/* The step's main action (when talking is invite-only, for invited visitors: lib/talk/invite.ts). */}
      {talkAvailable() && <TalkPanel design={design} take={take} name={profile.name} />}
      {/* Its own row, like the download: what it does on the left, the action on the right. */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-label text-ink">Someone else?</p>
          <p className="text-meta text-ink-3">Keep the voice, meet a different character</p>
        </div>
        <button
          type="button"
          onClick={() => write("rewrite")}
          aria-disabled={!!busy}
          aria-busy={busy === "rewrite"}
          aria-label={busy === "rewrite" ? "Reimagining the character…" : undefined}
          data-step-focus={talkAvailable() ? undefined : ""} // else Chat is the step's first control
          className="pill-secondary grid h-8 px-3 text-label"
        >
          <BusySwap busy={busy === "rewrite"}>Reimagine</BusySwap>
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      <Status message={busy === "rewrite" ? "Reimagining the character…" : said} />
    </div>
  );
}

function Row({ label, items }: { label: string; items: string[] }) {
  return (
    <>
      <dt className="text-ink-3">{label}</dt>
      <dd className="text-ink-2">{items.join(" · ")}</dd>
    </>
  );
}
