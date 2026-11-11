import math

import pytest

from engine.services import analyzer, chopper


def _bpm_ok(result: dict, truth: float) -> bool:
    bpm = result["bpm"]
    if abs(bpm - truth) <= 2:
        return True
    # half/double only acceptable when the analyzer flagged it
    if abs(bpm * 2 - truth) <= 2 and result["bpm_flag"] == "maybe_double":
        return True
    if abs(bpm / 2 - truth) <= 2 and result["bpm_flag"] == "maybe_half":
        return True
    return False


@pytest.mark.parametrize("key,truth", [("wav120", 120), ("wav90", 90)])
def test_bpm(converted, key, truth):
    a = analyzer.analyze(converted[key])
    assert _bpm_ok(a, truth), (a["bpm"], a["bpm_raw"], a["bpm_flag"])


def test_key_a_minor(converted):
    a = analyzer.analyze(converted["wav120"])
    assert a["key"] in {"Am", "C"}, a["key"]


def test_mp3_matches_wav(converted):
    w = analyzer.analyze(converted["wav120"])
    m = analyzer.analyze(converted["mp3"])
    assert abs(w["bpm"] - m["bpm"]) <= 1
    assert w["key"] == m["key"]
    assert abs(w["downbeat"] - m["downbeat"]) < 0.03
    assert abs(len(w["beats"]) - len(m["beats"])) <= 1


def test_grid_aligned_to_kicks(converted):
    a = analyzer.analyze(converted["wav120"])
    # kicks are at exact multiples of 0.5 s; the grid must sit within 15 ms of them
    for b in a["beats"]:
        assert abs(b - round(b * 2) / 2) < 0.015, b
    assert a["downbeat"] < 0.05


def test_grid_slicing_1_bar(converted):
    a = analyzer.analyze(converted["wav120"])
    sl = chopper.grid_slices(a["bpm"], a["downbeat"], a["duration"], chopper.GRID_DIVISIONS["1bar"])
    assert len(sl) == math.ceil(len(a["beats"]) / 4)
    assert sl[0]["start"] == 0.0 and sl[-1]["end"] == pytest.approx(a["duration"])
    for x, y in zip(sl, sl[1:]):
        assert x["end"] == y["start"]


@pytest.mark.parametrize("div,beats", [("1/4", 0.25), ("1/2", 0.5), ("1", 1), ("2bar", 8), ("4bar", 16)])
def test_grid_divisions(div, beats):
    sl = chopper.grid_slices(120, 0.0, 12.0, chopper.GRID_DIVISIONS[div])
    assert len(sl) == math.ceil(24 / beats)


def test_grid_lead_in_slice():
    # downbeat at 0.3 s -> a 0.3 s pickup slice, then bars
    sl = chopper.grid_slices(120, 0.3, 4.3, 4.0)
    assert [round(s["start"], 3) for s in sl] == [0.0, 0.3, 2.3]


def test_transient_slicing(converted):
    y = analyzer.load_mono(converted["wav120"])
    onsets = analyzer.detect_onsets(y, 0.5)
    sl = chopper.transient_slices(onsets, len(y) / analyzer.ANALYSIS_SR)
    assert len(sl) >= 18


def test_snap():
    assert chopper.snap(1.13, 120, 0.0, 1.0, 12) == pytest.approx(1.0)
    assert chopper.snap(1.30, 120, 0.0, 1.0, 12) == pytest.approx(1.5)
    assert chopper.snap(-1, 120, 0.0, 1.0, 12) == 0.0


def test_grid_beats_negative_k():
    beats = analyzer.grid_beats(120, 1.25, 3.0)
    assert beats[0] == pytest.approx(0.25)
    assert len(beats) == 6


def test_key_labels():
    assert analyzer.key_label(9, "minor") == "Am"
    assert analyzer.key_label(6, "major") == "F#"
