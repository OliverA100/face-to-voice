"use client";

/**
 * /dev/hair-review — decide which hair styles stay. Lists every style in the picker (hair/index.json) and the HairCS
 * candidates under review (hair/review/review.json, gitignored, made by `uv run haircs-review build`), each with
 * front / ¾ / profile shots taken with the app's real renderer (hair/review/shots/<id>__<view>.webp; the picker
 * thumbnail stands in for a missing shot). Keep / cut per style, kept in this browser (localStorage); "Export" downloads
 * decisions.json for `uv run haircs-review apply decisions.json`, which updates the picker.
 */
import { useEffect, useMemo, useState } from "react";

type Style = { id: string; label: string; thumb: string; bytes: number; review?: { class: string; variant?: string } };
type Item = Style & { source: string; cls: string; variant: string; inPicker: boolean };
type Decision = "keep" | "cut";

const BASE = "/models/";
const STORE = "ftv-hair-review";
const VIEWS = ["front", "threeQuarter", "profile"] as const;

/** Where a style comes from, by its id's prefix; procedural styles have none. */
function sourceOf(s: Style, inPicker: boolean): string {
  if (!inPicker) return "HairCS (new)";
  if (s.id.startsWith("haircs-")) return "HairCS";
  if (s.id.startsWith("bystedt-")) return "Bystedt";
  return "Ours";
}

function load(): Record<string, Decision> {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "{}");
  } catch {
    return {};
  }
}

export default function HairReview() {
  const [items, setItems] = useState<Item[]>([]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [source, setSource] = useState("all");
  const [cls, setCls] = useState("all");
  const [variant, setVariant] = useState("all");
  const [show, setShow] = useState<"all" | "undecided" | Decision>("all");
  const [big, setBig] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch(BASE + "hair/index.json").then((r) => r.json()),
      fetch(BASE + "hair/review/review.json").then((r) => (r.ok ? r.json() : { styles: [] })).catch(() => ({ styles: [] })),
    ]).then(([index, review]: [{ styles: Style[] }, { styles: Style[] }]) => {
      const shipped = index.styles.map((s) => ({ ...s, inPicker: true }));
      const fresh = review.styles.filter((s) => !index.styles.some((x) => x.id === s.id)).map((s) => ({ ...s, inPicker: false }));
      setItems([...shipped, ...fresh].map((s) => ({ ...s, source: sourceOf(s, s.inPicker), cls: s.review?.class ?? "—", variant: s.review?.variant ?? "—" })));
      setDecisions(load()); // after the fetch, so the server render and hydration agree
    });
  }, []);

  const decide = (ids: string[], d: Decision | null) => {
    setDecisions((prev) => {
      const next = { ...prev };
      for (const id of ids) {
        if (d === null || next[id] === d) delete next[id];
        else next[id] = d;
      }
      try {
        localStorage.setItem(STORE, JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  };

  const sources = useMemo(() => ["all", ...new Set(items.map((i) => i.source))], [items]);
  const classes = useMemo(() => ["all", ...new Set(items.map((i) => i.cls).filter((c) => c !== "—"))], [items]);
  const variants = useMemo(() => ["all", ...new Set(items.map((i) => i.variant).filter((c) => c !== "—"))], [items]);
  const visible = items.filter(
    (i) =>
      (source === "all" || i.source === source) &&
      (cls === "all" || i.cls === cls) &&
      (variant === "all" || i.variant === variant) &&
      (show === "all" || (show === "undecided" ? !decisions[i.id] : decisions[i.id] === show)),
  );
  const count = (d: Decision) => Object.values(decisions).filter((x) => x === d).length;

  const exportDecisions = () => {
    const keep = Object.entries(decisions).filter(([, d]) => d === "keep").map(([id]) => id);
    const cut = Object.entries(decisions).filter(([, d]) => d === "cut").map(([id]) => id);
    const blob = new Blob([JSON.stringify({ keep, cut }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "decisions.json";
    a.click();
  };

  const chip = (on: boolean) => `rounded-full px-3 py-1 text-label ${on ? "bg-ink text-page" : "bg-surface text-ink shadow-hairline"}`;

  return (
    <main className="min-h-dvh bg-page p-5 text-ink">
      <header className="sticky top-0 z-10 -mx-5 mb-4 flex flex-wrap items-center gap-3 bg-page/95 px-5 py-3 backdrop-blur">
        <h1 className="text-title font-normal">Hair review</h1>
        <span className="text-label text-ink-3">
          {items.length} styles · {count("keep")} keep · {count("cut")} cut · {items.length - count("keep") - count("cut")} undecided · {visible.length} shown
        </span>
        <div className="ml-auto flex gap-2">
          <button className={chip(false)} onClick={() => decide(visible.map((v) => v.id), "keep")}>Keep shown</button>
          <button className={chip(false)} onClick={() => decide(visible.map((v) => v.id), "cut")}>Cut shown</button>
          <button className={chip(false)} onClick={() => decide(visible.map((v) => v.id), null)}>Clear shown</button>
          <button className="pill-primary h-9 px-4" onClick={exportDecisions}>Export decisions.json</button>
        </div>
        <div className="flex w-full flex-wrap gap-2">
          {sources.map((s) => (
            <button key={s} className={chip(source === s)} onClick={() => setSource(s)}>{s}</button>
          ))}
          <span className="w-3" />
          {classes.map((c) => (
            <button key={c} className={chip(cls === c)} onClick={() => setCls(c)}>{c}</button>
          ))}
          <span className="w-3" />
          {variants.length > 1 && variants.map((v) => (
            <button key={"v" + v} className={chip(variant === v)} onClick={() => setVariant(v)}>{v === "all" ? "any variant" : v}</button>
          ))}
          <span className="w-3" />
          {(["all", "undecided", "keep", "cut"] as const).map((d) => (
            <button key={d} className={chip(show === d)} onClick={() => setShow(d)}>{d}</button>
          ))}
        </div>
      </header>

      <ul className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-3">
        {visible.map((i) => {
          const d = decisions[i.id];
          return (
            <li key={i.id} className={`rounded-card bg-surface p-2 shadow-hairline ${d === "keep" ? "ring-2 ring-green-600" : d === "cut" ? "opacity-40 ring-2 ring-red-500" : ""}`}>
              <button className="grid w-full grid-cols-3 gap-1" onClick={() => setBig(i.id)} aria-label={`Enlarge ${i.label}`}>
                {VIEWS.map((v) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={v} loading="lazy" alt="" className="aspect-square w-full rounded-row bg-page object-cover"
                    src={`${BASE}hair/review/shots/${i.id}__${v}.webp`} onError={(e) => ((e.currentTarget as HTMLImageElement).src = BASE + i.thumb)} />
                ))}
              </button>
              <div className="mt-2 flex items-center gap-2 px-1">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body">{i.label}</div>
                  <div className="truncate text-meta text-ink-3">{i.source} · {i.cls}{i.variant !== "—" && i.variant !== "base" ? ` · ${i.variant}` : ""} · {Math.round(i.bytes / 1000)} KB · {i.id}</div>
                </div>
                <button className={chip(d === "keep")} onClick={() => decide([i.id], "keep")}>Keep</button>
                <button className={chip(d === "cut")} onClick={() => decide([i.id], "cut")}>Cut</button>
              </div>
            </li>
          );
        })}
      </ul>

      {big && (
        <div className="fixed inset-0 z-20 grid place-items-center bg-black/70 p-6" onClick={() => setBig(null)}>
          <div className="grid max-w-[1400px] grid-cols-3 gap-2">
            {VIEWS.map((v) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={v} alt="" className="w-full rounded-card bg-page" src={`${BASE}hair/review/shots/${big}__${v}.webp`} />
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
