# plugin/ — JUCE VST3/AU (placeholder)

Nothing here yet. The plugin is planned to reuse everything the desktop app uses:

* **Engine** — launch/reuse the same `ripper-engine` process and talk to `/api/v1`. Discovery,
  token and lifecycle rules: [`docs/formats.md` §10](../docs/formats.md#10-engine-discovery-desktop-app--plugin).
  One engine is shared by the desktop app and every plugin instance.
* **UI** — embed `ui/dist` in a `juce::WebBrowserComponent`. The UI picks the host at runtime;
  `ui/src/host/juceHost.js` is the stub to complete. Each method maps to a native function of the
  same name (`getEngine`, `prepareDrag`, `startDrag` → `performExternalDragDropOfFiles`,
  `pickFolder` → `juce::FileChooser`, `exportToFolder`, `download`, `showItemInFolder`,
  `getSetting`/`setSetting`, `onError`) plus pad playback on the audio thread.
* **Audio math** — any processing done natively (e.g. pad playback with fades/reverse/choke)
  must follow `docs/formats.md` exactly and pass the vectors in `docs/parity.json`.
