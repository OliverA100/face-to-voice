"use client";

/**
 * The Meet step: the character behind the voice. Claude writes a profile from the casting (name, backstory, traits,
 * habits, quirks, interests, catchphrases, mood and first words), which the live conversation will play. The mood is
 * not shown (the face already shows the expression, and it changes as they talk), nor are the first words: they stay a
 * surprise until the conversation.
 *
 * The profile is written before the step opens (VoicePanel's Meet: one Claude call, then shared by everyone who meets
 * this voice). "Recast" writes a different one for the same voice, kept for this visitor only: the profile is a
 * skeleton while it is written, and the card scrolls back up to the new one.
 */
import { useRef, useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { BusyPill } from "@/components/ui/Spinner";
import { Status } from "@/components/ui/Status";
import { TalkPanel } from "@/components/ui/TalkPanel";
import type { ProfileResult } from "@/lib/character/profile";
import { isLimitError } from "@/lib/limits/open";
import { talkAvailable } from "@/lib/talk/invite";
import { ProfileSkeleton } from "@/components/ui/ProfileSkeleton";
import { scrollVoiceCardTop } from "@/components/ui/voiceCardScroll";
import { requestProfile, VoiceApiError, withCasting, type DesignResult } from "@/lib/voice/client";


export function CharacterCard({
  design,
  take,
  result,
  onResult,
  onRetired,
  onStale,
}: {
  design: Pick<DesignResult, "faceKey" | "descKey" | "sent">;
  take: number | null; // the voice in use: the one the character talks with
  result: ProfileResult;
  onResult: (r: ProfileResult, forDesign: Pick<DesignResult, "faceKey" | "descKey">) => void; // the voice it was asked for
  onRetired: (message: string) => void; // the voice was retired (a chat found out): back to the takes to choose it again
  onStale: () => void; // the character can't be recast (code "stale"): "New voices" may design for this face again
}) {
  const [busy, setBusy] = useState(false); // recasting
  const [error, setError] = useState<{ message: string; limits: boolean } | null>(null);
  const [said, setSaid] = useState("");
  const [recast, setRecast] = useState(false); // a recast profile fades in over the skeleton (the first comes in with its step)
  const root = useRef<HTMLDivElement>(null);

  const recastNow = async () => {
    setBusy(true);
    setError(null);
    try {
      onResult(await withCasting(design, () => requestProfile(design, true)), design);
      setSaid("They have been recast.");
      setRecast(true);
      // Recast is pressed below the profile: back up to the new one (after it renders)
      requestAnimationFrame(() => scrollVoiceCardTop(root.current?.closest('section[aria-label="Voice"]') ?? null));
    } catch (e) {
      if (!(e instanceof VoiceApiError)) console.error("[profile]", e);
      if (e instanceof VoiceApiError && e.code === "stale") onStale();
      setError({ message: e instanceof VoiceApiError ? e.message : "Something went wrong. Please try again.", limits: isLimitError(e) });
    } finally {
      setBusy(false);
    }
  };

  const { profile } = result;
  return (
    <div ref={root} className="flex flex-col gap-3">
      {busy ? (
        // the new character is being written: a tray shaped like the profile it becomes, in the old one's place
        <ProfileSkeleton label="Recasting the character…" />
      ) : (
        <section aria-label={`Character: ${profile.name}`} className={`${recast ? "enter " : ""}flex flex-col gap-3 rounded-tray bg-surface p-4`}>
          <div>
            <h2 className="display text-subtitle text-ink">{profile.name}</h2>
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
      )}
      {/* The step's main action (when talking is invite-only, for invited visitors: lib/talk/invite.ts). */}
      {talkAvailable() && <TalkPanel design={design} take={take} name={profile.name} onRetired={onRetired} onStale={onStale} />}
      {/* Its own row, like the download: what it does on the left, the action on the right. */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-label text-ink">Not who you had in mind?</p>
          <p className="text-meta text-ink-3">Keep the voice, meet a different character</p>
        </div>
        <BusyPill
          busy={busy}
          busyLabel="Recasting the character…"
          onClick={recastNow}
          data-step-focus={talkAvailable() ? undefined : ""} // else Chat is the step's first control
          className="pill-secondary h-8 px-3 text-label"
        >
          Recast
        </BusyPill>
      </div>
      {error && <Alert limits={error.limits}>{error.message}</Alert>}
      <Status message={busy ? "Recasting the character…" : said} />
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
