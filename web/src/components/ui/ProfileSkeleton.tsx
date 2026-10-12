/**
 * The Meet step before its profile is there (CharacterCard's code loading, or the profile being written): a tray shaped
 * and sized like the profile it becomes, so the voice card grows once to about its final height instead of shrinking
 * to its header and then shooting up (filmed: 464 → 132 → 664 px over 0.7 s). In the main bundle: it is shown while
 * the lazy CharacterCard loads.
 */
export function ProfileSkeleton({ label = "Writing their profile…" }: { label?: string }) {
  const bar = "animate-pulse rounded-full bg-surface-2";
  return (
    <div className="flex flex-col gap-3 rounded-tray bg-surface p-4" aria-hidden>
      <p className="text-meta text-ink-3">{label}</p>
      <div className="flex flex-col gap-2">
        <span className={`h-5 w-40 ${bar}`} />
        <span className={`h-3 w-52 ${bar}`} />
      </div>
      <div className="flex flex-col gap-2">
        {["w-full", "w-full", "w-11/12", "w-3/5"].map((w, i) => (
          <span key={i} className={`h-3.5 ${w} ${bar}`} />
        ))}
      </div>
      <div className="flex gap-1.5">
        {["w-16", "w-14", "w-20"].map((w, i) => (
          <span key={i} className={`h-5 ${w} ${bar}`} />
        ))}
      </div>
      <div className="flex flex-col gap-2">
        {["w-4/5", "w-2/3", "w-3/4", "w-1/2", "w-3/5", "w-4/5"].map((w, i) => (
          <span key={i} className={`h-3 ${w} ${bar}`} />
        ))}
      </div>
    </div>
  );
}
