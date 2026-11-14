import numpy as np, soundfile as sf, sys, time
sys.path.insert(0, __import__('os').getcwd())
from engine.tests.fixtures import _kick, SR
def make_song(bpm=124.0, duration=240.0, sr=SR):
    n=int(duration*sr); t=np.arange(n)/sr
    # D minor: Dm Gm Bb A(?)  -> use Dm Gm Dm C  natural minor diatonic
    midi = lambda m: 440*2**((m-69)/12)
    chords=[[62,65,69],[67,70,74],[62,65,69],[60,64,67]]  # Dm Gm Dm C
    bar=4*60/bpm
    out=np.zeros(n,np.float32)
    idx=(t//(bar*2)).astype(int)%4
    for ci,ch in enumerate(chords):
        m=idx==ci
        for note in ch:
            out[m]+=0.05*np.sin(2*np.pi*midi(note)*t[m])
    roots=np.array([38,43,38,36]); bf=440*2**((roots[idx]-69)/12)
    out+= (0.12*np.sin(2*np.pi*np.cumsum(bf)/sr)).astype(np.float32)
    kick=_kick(sr)*0.8; period=60/bpm; k=0
    while k*period<duration:
        s=int(round(k*period*sr)); e=min(n,s+len(kick)); out[s:e]+=kick[:e-s]; k+=1
    out/=max(1.0,float(np.abs(out).max())/0.9)
    return np.stack([out,out*0.98])
y=make_song(); sf.write(sys.argv[1], y.T, SR, subtype='PCM_16')
