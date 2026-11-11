"""Drive a real X11 drag for the e2e test (Linux/xvfb only).

    python xdrag.py press X Y  # button 1 down at screen X,Y — the user grabs the element
    python xdrag.py release  # move + button up — drops on the root window, ends the drag

Electron's webContents.startDrag() runs a native XDND loop that only finishes when the X
pointer button is released, so the test holds the button via XTest like a real user.
"""
import sys
import time

from Xlib import X, display
from Xlib.ext import xtest

d = display.Display()
if sys.argv[1] == "press":
    x, y = (int(v) for v in sys.argv[2:4]) if len(sys.argv) >= 4 else (200, 200)
    xtest.fake_input(d, X.MotionNotify, x=x, y=y)
    d.sync()
    time.sleep(0.05)
    xtest.fake_input(d, X.ButtonPress, 1)
else:
    for x, y in [(40, 40), (30, 30), (20, 20)]:
        xtest.fake_input(d, X.MotionNotify, x=x, y=y)
        d.sync()
        time.sleep(0.05)
    xtest.fake_input(d, X.ButtonRelease, 1)
d.sync()
