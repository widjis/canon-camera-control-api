# Integration Contracts

## Canon EOS R50 Verification Notes

The following behavior has been verified locally against a Canon EOS R50 using `gphoto2` on macOS during development.

### Preconditions
- Camera USB app: `Photo Import/Remote Control`
- Wi-Fi/Bluetooth: disabled
- Host-side competing macOS processes may need to be stopped before `gphoto2` access

### Verified Detection And Status
- `gphoto2 --auto-detect` detected `Canon EOS R50`
- `gphoto2 --summary` returned manufacturer, model, firmware, serial, battery, and storage info
- `gphoto2 --storage-info` returned SD card capacity and free-space data

### Verified Config Paths
- `captureEnabled` -> `/main/settings/capture`
- `captureTarget` -> `/main/settings/capturetarget`
- `iso` -> `/main/imgsettings/iso`
- `shutterSpeed` -> `/main/capturesettings/shutterspeed`
- `aperture` -> `/main/capturesettings/aperture`
- `whiteBalance` -> `/main/imgsettings/whitebalance`
- `focusMode` -> `/main/capturesettings/focusmode`
- `driveMode` -> `/main/capturesettings/drivemode`

### Verified Actions
- preview capture using `--capture-preview`
- still capture with direct download using `--capture-image-and-download`
- still capture to memory card using `capturetarget="Memory card"`
- keeping files on camera during download using `--keep`

### Verified Local Evidence
- Preview file created:
  - `thumb_r50-preview.jpg`
- Still capture files created:
  - `r50-capture-20260713-200527.jpg`
  - `r50-card-20260714-043908.jpg`

### Contract Implications
- Public API should expose normalized keys rather than raw `gphoto2` paths
- `keepOnCamera` must be modeled explicitly because `gphoto2 --capture-image-and-download` deletes camera files unless `--keep` is provided
- Live camera state must be queried from the device because the camera body can change settings outside the application

### Known Output Parsing Fix — `cameraPath` Suffix

- On the verified Canon EOS R50 setup, `gphoto2` always prints the capture location line as `New file is in location <path> on the camera`, for both `internalRam` and `memoryCard` capture targets.
- The original parser used a greedy `New file is in location (.+)$` pattern, which captured the trailing `" on the camera"` text as part of `cameraPath`. This corrupted value was persisted into the edge `media` table, synced into the control server `media_assets` table when `mediaSyncPolicy.syncMode` is `metadataOnly`, and returned from `POST /v1/captures` job results.
- A corrupted `cameraPath` breaks `POST /v1/storage/files/download` and `POST /v1/storage/files/delete` when a client reuses the value returned from capture, since the real on-camera filename never contains the suffix.
- Fixed by narrowing the pattern to `New file is in location (\S+)`, which stops at the first whitespace and excludes the suffix. Verified against both captured output variants (`/capt0000.jpg on the camera` and `/store_00020001/DCIM/100CANON/IMG_0255.JPG on the camera`) from this device.
- No API contract change: `cameraPath` remains `string | null` in `docs/openapi.yaml`; only the parsed value is now correct.

### Known Output Parsing Fix — `GET /v1/camera/preview` On Windows

- On this Windows development host, `gphoto2 --capture-preview` derives its `thumb_<name>` output filename by splitting only on `/`. A Windows-style backslash path (the default output of Node's `path.join` on `win32`) is never recognized as having a directory component, so `thumb_` gets prepended to the entire string instead of just the basename — producing a bogus nested path (e.g. `thumb_data\media\preview-<uuid>.jpg` interpreted by the OS as a new `thumb_data/media/...` directory) instead of the expected file next to the original.
- This made every `GET /v1/camera/preview` call fail with `500 PREVIEW_NOT_FOUND` on Windows, even though the underlying `gphoto2 --capture-preview` command itself succeeded.
- Fixed in `capturePreview()` (`src/gphoto2.ts`) by normalizing the generated path to forward slashes before passing it as gphoto2's `--filename` argument; the local `fs` lookups for the resulting file are unaffected since Node accepts both separator styles on Windows. `path.sep` is already `/` on Linux/macOS, so this is a no-op there.
- Verified live against the Canon EOS R50 on this device after the fix: 5 consecutive `GET /v1/camera/preview` calls all returned `200` with a valid ~200KB, 960x640 JPEG; average latency was **~1.0-1.2 seconds per call** (each call is a real `gphoto2 --capture-preview` USB round trip — there is no continuous/streamed preview, matching the "no high-frame-rate video streaming" scope decision in `docs/project-plan.md`).

## Platform Contract
- Production edge runtime target: Linux-first
- Control-plane services can remain platform-agnostic
- Windows should not be treated as the primary edge runtime for USB camera control
