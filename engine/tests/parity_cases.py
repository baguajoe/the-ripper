"""Shared JS<->Python parity vectors: docs/parity.json is consumed by ui/tests/parity.test.js
and re-checked by engine/tests/test_parity.py, so the two implementations can't drift.

    python -m engine.tests.parity_cases > docs/parity.json
"""
import json

from engine.services import analyzer, chopper, exporter

GRID = [
    (120, 0.0, 12.0, 4), (120, 0.0043, 12.0, 4), (90, 0.6709, 12.0, 1), (128, 0.3, 30.0, 0.25),
    (174, 1.1, 20.5, 8), (60, 0.03, 9.99, 16), (97.5, 2.2, 15.0, 0.5),
]
SNAP = [(1.13, 120, 0, 1, 12), (1.3, 120, 0, 1, 12), (-1, 120, 0, 1, 12), (11.99, 120, 0.2, 4, 12), (5.55, 93, 0.41, 0.25, 30)]
TRANSIENT = [([0.0, 0.5, 0.52, 1.0, 1.5], 2.0), ([0.2, 0.9, 1.97], 2.0), ([], 3.0)]
NAMES = [("My Song (Remix)!", 120.0, "F#m", "slice03"), ("", 92.5, None, "drums"),
         ("a/b\\c:d", 128, "C", "kick 1"), ("Ünïcödé — beat", 87.25, "Bbm", "other"),
         ("x" * 80, 140, "Am", "slice12")]


def build() -> dict:
    return {
        "grid": [{"args": list(a), "slices": chopper.grid_slices(*a)} for a in GRID],
        "beats": [{"args": [a[0], a[1], a[2]], "beats": analyzer.grid_beats(a[0], a[1], a[2])} for a in GRID],
        "snap": [{"args": list(a), "t": round(chopper.snap(*a), 6)} for a in SNAP],
        "transient": [{"args": [o, d], "slices": chopper.transient_slices(o, d)} for o, d in TRANSIENT],
        "filenames": [{"args": list(a), "name": exporter.build_filename(*a)} for a in NAMES],
    }


if __name__ == "__main__":
    print(json.dumps(build(), indent=1))
