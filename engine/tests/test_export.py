import io
import struct
import zipfile

import mido
import numpy as np
import pytest
import soundfile as sf

from engine.services import exporter
from engine.services.exporter import ExportOptions, Slice


def _slices(client, tid, division="1bar"):
    r = client.get(f"/api/v1/tracks/{tid}/slices?mode=grid&division={division}")
    assert r.status_code == 200
    return r.get_json()["slices"]


def _check_wav(raw: bytes, sr: int, bpm: float, loop: bool):
    data, file_sr = sf.read(io.BytesIO(raw), always_2d=True)
    info = sf.info(io.BytesIO(raw))
    assert file_sr == sr
    assert info.subtype == "PCM_24"
    assert data.shape[1] == 2
    assert np.isfinite(data).all()
    assert b"acid" in raw
    assert struct.unpack_from("<I", raw, 4)[0] == len(raw) - 8   # RIFF size fixed
    acid = exporter.read_acid(raw)
    assert acid is not None
    assert acid["bpm"] == pytest.approx(bpm)
    assert acid["root_note"] == 60 and acid["meter_num"] == 4 and acid["meter_den"] == 4
    assert acid["loop"] is loop
    return data, acid


@pytest.mark.parametrize("sr,mode", [(44100, "oneshot"), (48000, "loop")])
def test_export_kit_zip(ready_track, sr, mode):
    client, tid = ready_track
    track = client.get(f"/api/v1/tracks/{tid}").get_json()
    bpm, key = track["analysis"]["bpm"], track["analysis"]["key"]
    slices = _slices(client, tid)
    r = client.post(f"/api/v1/tracks/{tid}/export", json={
        "slices": slices, "mode": mode, "sr": sr, "normalize": True,
        "include_stems": True, "include_midi": True})
    assert r.status_code == 200, r.get_json()
    assert r.mimetype == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.data))
    names = z.namelist()
    stems = client.get(f"/api/v1/tracks/{tid}/stems").get_json()["stems"]["names"]
    assert len(names) == len(slices) + len(stems) + 1
    base = exporter.base_name(track["title"], bpm, key)
    assert base == f"beat-120_120bpm_{key}"  # "_" is the field separator
    for i in range(len(slices)):
        assert f"Slices/{base}_slice{i + 1:02d}.wav" in names
    for s in stems:
        assert f"Stems/{base}_{s}.wav" in names
    assert f"MIDI/{base}_slices.mid" in names

    for n in names:
        if n.endswith(".wav"):
            data, acid = _check_wav(z.read(n), sr, bpm, loop=(mode == "loop" or n.startswith("Stems/")))
            if n.startswith("Slices/") and mode == "loop":
                assert acid["num_beats"] == 4
                assert data.shape[0] == round(4 * 60 / bpm * sr)

    mid = mido.MidiFile(file=io.BytesIO(z.read(f"MIDI/{base}_slices.mid")))
    assert mid.ticks_per_beat == 480
    tempos = [m.tempo for t in mid.tracks for m in t if m.type == "set_tempo"]
    assert tempos == [mido.bpm2tempo(bpm)]
    ons = [m for t in mid.tracks for m in t if m.type == "note_on" and m.velocity > 0]
    assert len(ons) == len(slices)
    assert [m.note for m in ons] == list(range(36, 36 + len(slices)))
    # original timing: one bar (1920 ticks) between notes
    abs_t, t, starts = 0, mid.tracks[1], []
    for m in t:
        abs_t += m.time
        if m.type == "note_on" and m.velocity > 0:
            starts.append(abs_t)
    assert starts == [i * 1920 for i in range(len(slices))], starts


def test_single_slice_wav(ready_track):
    client, tid = ready_track
    sl = _slices(client, tid)[0]
    r = client.post(f"/api/v1/tracks/{tid}/export", json={
        "slices": [{**sl, "reverse": True, "gain": -6, "fade_in": 0.01, "fade_out": 0.05}],
        "format": "wav"})
    assert r.status_code == 200 and r.mimetype == "audio/wav"
    assert r.headers["X-Ripper-Filename"].endswith("_slice01.wav")
    _check_wav(r.data, 44100, 120, loop=False)


def test_acid_chunk_layout():
    c = exporter.acid_chunk(120.0, 4, loop=True)
    assert c[:4] == b"acid" and struct.unpack("<I", c[4:8])[0] == 24 and len(c) == 32
    flags, root, u1, u2, beats, den, num, bpm = struct.unpack("<IHHfIHHf", c[8:])
    assert (flags, root, u1, u2, beats, den, num, bpm) == (0x06, 60, 0x8000, 0.0, 4, 4, 4, 120.0)
    assert struct.unpack("<I", exporter.acid_chunk(90, 1, loop=False)[8:12])[0] == 0x03


def test_render_processing():
    sr = 1000
    audio = np.ones((2, 2000), dtype=np.float32) * 0.5
    sl = Slice(start=0.5, end=1.0, gain=6.0206, fade_in=0.1, fade_out=0.1, reverse=True)
    out, beats, out_sr = exporter.render_slice(audio, sr, sl, ExportOptions(sr=sr), 120)
    assert out.shape == (2, 500) and out_sr == sr and beats == 1
    assert out[0, 0] == 0.0 and out[0, -1] == 0.0
    assert out[0, 250] == pytest.approx(1.0, abs=1e-3)
    norm, _, _ = exporter.render_slice(audio * 0.1, sr, Slice(0, 1), ExportOptions(sr=sr, normalize=True), 120)
    assert np.max(np.abs(norm)) == pytest.approx(exporter.NORMALIZE_PEAK, abs=1e-4)


def test_trim_silence():
    sr = 44100
    audio = np.zeros((2, sr), dtype=np.float32)
    audio[:, sr // 2: sr // 2 + 4410] = 0.5
    out, _, _ = exporter.render_slice(audio, sr, Slice(0, 1), ExportOptions(trim_silence=True), 120)
    assert out.shape[1] < sr // 4


def test_filenames():
    assert exporter.build_filename("My Song (Remix)!", 120.0, "F#m", "slice03") == "My-Song-Remix_120bpm_F#m_slice03.wav"
    assert exporter.build_filename("", 92.5, None, "drums") == "track_92.5bpm_drums.wav"
    assert exporter.build_filename("a/b\\c:d", 128, "C", "kick 1") == "a-b-c-d_128bpm_C_kick-1.wav"


def test_midi_many_slices_capped():
    sl = [Slice(i * 0.1, i * 0.1 + 0.1) for i in range(100)]
    mid = mido.MidiFile(file=io.BytesIO(exporter.build_midi(sl, 100)))
    ons = [m for m in mid.tracks[1] if m.type == "note_on"]
    assert len(ons) == exporter.MAX_MIDI_SLICES and ons[-1].note == 127
