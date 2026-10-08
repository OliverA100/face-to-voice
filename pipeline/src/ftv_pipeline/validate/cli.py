"""`uv run validate`: the shape validation commands (see validate/__init__.py).

    uv run validate --sweep [--only sem_nose_width …]   each slider alone: where it first breaks (sweep.py)
    uv run validate --vlimits [--passes 4] [--rays 3000 --ray-passes 6]
                                                         the web limiter (web/src/data/limits.json): grown until every
                                                         pair of Shape sliders, pushed to where it stops them, passes
                                                         the exact checks, then until a fresh set of random
                                                         multi-slider faces does (--rays 0 skips them) (vlimits.py)
    uv run validate --ends                               pull slider ends in to where the limiter stops them alone
    uv run validate --fights                             which Shape sliders take room from each other (fights.py)
    uv run validate --fx-reach                           how far each fine-tune control may go on each emotion
                                                         (web/src/data/fxReach.json, fx_reach.py)
    uv run validate --stress [--quick] [--vision] [--fresh]
                                                         the stress test, measure-only (stress.py): needs the app
                                                         running on :3000 for its own states (scripts/stress-states.mjs)
    uv run python -m ftv_pipeline.validate.grow faces.json   grow the limiter from faces made elsewhere (web random faces)
"""
from __future__ import annotations

import argparse


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description="Validate face shapes: break sweep, web limiter, slider fights, fine-tune reach, stress test.")
    p.add_argument("--sweep", action="store_true", help="push each slider alone to its ends and find where it breaks")
    p.add_argument("--only", nargs="*", help="limit the sweep to these morph targets (--stress: these families)")
    p.add_argument("--vlimits", action="store_true", help="build the vertex limiter (web/src/data/limits.json)")
    p.add_argument("--passes", type=int, default=4)
    p.add_argument("--rays", type=int, default=3000, help="random multi-slider faces per --vlimits pass (0: none)")
    p.add_argument("--ray-passes", type=int, default=6, help="at most this many multi-slider passes (fresh seed each)")
    p.add_argument("--ends", action="store_true", help="pull slider ends in to where the limiter stops them alone")
    p.add_argument("--fights", action="store_true", help="report sliders that take room from each other")
    p.add_argument("--fx-reach", action="store_true", help="how far each fine-tune control may go on each emotion")
    p.add_argument("--stress", action="store_true", help="the stress test: every family, exact-checked, report + sheets")
    p.add_argument("--quick", action="store_true", help="--stress: the ~10 minute subset")
    p.add_argument("--vision", action="store_true", help="--stress: also ask Claude to review the sheets")
    p.add_argument("--fresh", action="store_true", help="--stress: re-make the extreme identities and the app's states")
    p.add_argument("--workers", type=int, default=8)
    args = p.parse_args(argv)
    if args.sweep:
        from .sweep import run

        run(args.only, args.workers)
    if args.vlimits:
        from .vlimits import run as vrun

        vrun(args.passes, args.workers, args.rays, args.ray_passes)
    if args.ends:
        from .vlimits import limiter_ends

        limiter_ends(args.workers)
    if args.fights:
        from .fights import run as fights

        fights(args.workers)
    if args.fx_reach:
        from .fx_reach import run as fx_reach

        fx_reach(args.workers)
    if args.stress:
        from .stress import run as stress

        stress(args.quick, args.vision, args.workers, args.fresh, args.only)
    if not (args.sweep or args.vlimits or args.ends or args.fights or args.fx_reach or args.stress):
        p.print_help()
