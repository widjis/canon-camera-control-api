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

## Platform Contract
- Production edge runtime target: Linux-first
- Control-plane services can remain platform-agnostic
- Windows should not be treated as the primary edge runtime for USB camera control
