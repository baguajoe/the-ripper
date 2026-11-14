"""Chopping a selection (v1.1.3): the cases from manual testing, against the engine's math.
The UI's copy (ui/src/lib/grid.js) is held to the same numbers by docs/parity.json."""
import pytest

from engine.services import chopper

BAR_128 = 240 / 128


def lengths(slices):
    return [s["end"] - s["start"] for s in slices]


def test_four_bars_at_128_even_16_is_sixteen_equal_slices():
    start = 0.2
    sl = chopper.even_slices(start, start + 4 * BAR_128, 16)
    assert len(sl) == 16
    assert sl[0]["start"] == pytest.approx(start) and sl[-1]["end"] == pytest.approx(start + 4 * BAR_128)
    for n in lengths(sl):
        assert n == pytest.approx(4 * BAR_128 / 16, abs=2e-6)
    assert [s["name"] for s in sl] == [f"slice{i:02d}" for i in range(1, 17)]
    for a, b in zip(sl, sl[1:]):
        assert a["end"] == b["start"]  # contiguous, no gaps


@pytest.mark.parametrize("count", [8, 16, 32])
def test_even_counts(count):
    assert len(chopper.even_slices(1.0, 1.0 + 4 * BAR_128, count)) == count


def test_grid_inside_a_selection_only_chops_the_selection():
    sel = (0.2 + 4 * BAR_128, 0.2 + 8 * BAR_128)  # bars 5-8 at 128 BPM, downbeat 0.2
    sl = chopper.selection_grid_slices(128, 0.2, *sel, 1)
    assert len(sl) == 16
    assert sl[0]["start"] == pytest.approx(sel[0]) and sl[-1]["end"] == pytest.approx(sel[1])
    assert chopper.selection_grid_slices(128, 0.2, *sel, 4).__len__() == 4
    assert len(chopper.selection_grid_slices(128, 0.2, *sel, 0.25)) == 64


def test_transients_inside_a_selection_are_capped_strongest_first():
    onsets = [i * 0.1 for i in range(1, 60)]
    strengths = [(i * 37) % 11 for i in range(1, 60)]
    sl = chopper.selection_transient_slices(onsets, strengths, 0.0, 6.0, cap=16)
    assert len(sl) == 16
    assert sl[0]["start"] == 0.0 and sl[-1]["end"] == 6.0
    # only onsets inside the selection are used
    inner = chopper.selection_transient_slices([0.5, 1.5, 2.5, 3.5], [1, 1, 1, 1], 1.0, 3.0)
    assert [s["start"] for s in inner] == [1.0, 1.5, 2.5]
    # strongest kept
    top = chopper.selection_transient_slices([1, 2, 3, 4], [0.1, 0.9, 0.2, 0.8], 0, 5, cap=3)
    assert [s["start"] for s in top] == [0, 2, 4]


def test_a_short_fragment_before_the_first_downbeat_is_merged():
    # the manual-test bug: downbeat at 0.1 s gave a 0.1 s slice01
    whole = chopper.grid_slices(120, 0.1, 12.0, 4)
    assert whole[0] == {"start": 0.0, "end": 2.1, "name": "slice01"}
    assert min(lengths(whole)) >= 0.25  # nothing shorter than half a beat
    sel = chopper.selection_grid_slices(120, 0.1, 0.0, 4.1, 1)
    assert sel[0]["end"] == pytest.approx(0.6) and len(sel) == 8
    # a long pickup (>= half a beat) is a slice of its own
    assert chopper.grid_slices(120, 0.3, 4.3, 4)[0] == {"start": 0.0, "end": 0.3, "name": "slice01"}
    # a short first slice that is NOT before the first downbeat is kept (>= 50 ms)
    mid = chopper.selection_grid_slices(120, 0.0, 3.3, 5.0, 1)
    assert mid[0]["start"] == pytest.approx(3.3) and mid[0]["end"] == pytest.approx(3.5)


def test_no_slice_is_shorter_than_50ms():
    assert len(chopper.even_slices(0, 0.3, 32)) == 6
    for s in chopper.even_slices(0, 0.3, 32):
        assert s["end"] - s["start"] >= chopper.MIN_SLICE - 1e-9
    sl = chopper.selection_transient_slices([0.5, 0.52, 0.53, 0.98], None, 0.0, 1.0)
    assert min(lengths(sl)) >= chopper.MIN_SLICE - 1e-9
    assert [s["start"] for s in sl] == [0.0, 0.5]  # 0.98: tail shorter than 50 ms merged
    g = chopper.selection_grid_slices(120, 0.0, 0.0, 2.03, 1)
    assert g[-1]["end"] == 2.03 and min(lengths(g)) >= chopper.MIN_SLICE


def test_slices_api_selection(ready_track):
    client, tid = ready_track
    base = f"/api/v1/tracks/{tid}/slices"
    r = client.get(f"{base}?mode=even&count=16&start=0&end=8").get_json()["slices"]
    assert len(r) == 16 and r[-1]["end"] == 8.0
    r = client.get(f"{base}?mode=grid&division=1&start=2&end=6").get_json()["slices"]
    assert len(r) == 8 and r[0]["start"] == 2.0
    r = client.get(f"{base}?mode=transient&start=0&end=8&cap=4").get_json()["slices"]
    assert 1 <= len(r) <= 4 and r[-1]["end"] == 8.0
    assert client.get(f"{base}?mode=even&count=12&start=0&end=8").status_code == 400
    assert client.get(f"{base}?mode=even&start=5&end=5").status_code == 400
    o = client.get(f"/api/v1/tracks/{tid}/onsets").get_json()
    assert len(o["onsets"]) == len(o["strengths"]) and all(0 <= s <= 1 for s in o["strengths"])
