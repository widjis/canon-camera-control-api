# Windows Dev Setup — gphoto2 via MSYS2

This project targets Linux for the production edge node (see `docs/deployment-and-environment.md`), but `gphoto2` can run locally on Windows for development through MSYS2/MinGW64. This is how the working setup on this machine was put together, reconstructed from the actual installed state (`C:\msys64`, `mingw-w64-x86_64-gphoto2`).

## Why MSYS2

`gphoto2` has no official standalone Windows installer. The practical way to get a working Windows binary is MSYS2's MinGW64 package repository, which builds `gphoto2`/`libgphoto2` against MinGW-w64 + libusb. This is dev/test tooling only — do not treat it as a production path; the edge node target stays Linux (`apt install gphoto2` in `Dockerfile`).

## Steps

### 1. Install MSYS2
1. Download the installer from [msys2.org](https://www.msys2.org/) (`msys2-x86_64-<date>.exe`).
2. Run it, keep the default install path `C:\msys64`, finish the installer.
3. The installer opens an MSYS2 terminal automatically. Update the base packages:
   ```
   pacman -Syu
   ```
   This may close the terminal partway through (normal — it's restarting core packages). Reopen **MSYS2** from the Start menu and run it again to finish:
   ```
   pacman -Syu
   ```
   Repeat until it reports nothing left to do.

### 2. Install gphoto2 (MinGW64 environment)
Open **MSYS2 MinGW x64** specifically from the Start menu — not the plain "MSYS2" (MSYS runtime) shell, and not UCRT64/CLANG64. The package below targets the `mingw64` environment, matching what's actually installed on this machine (`C:\msys64\mingw64\bin\gphoto2.exe`):
```
pacman -S mingw-w64-x86_64-gphoto2
```

### 3. Add gphoto2 to your Windows PATH
`gphoto2` needs to be callable from a normal terminal (PowerShell, Git Bash, or whatever runs `npm run dev:edge`), not just from inside the MSYS2 shell.
1. Open **Environment Variables** (search Windows Start menu for "environment variables", or `System Properties` → `Advanced` → `Environment Variables`).
2. Under **User variables**, edit `Path`, add a new entry:
   ```
   C:\msys64\mingw64\bin
   ```
   (This is a user-level PATH entry on this machine, not system-level — either works, user-level doesn't need admin rights.)
3. Close and reopen any terminal for the change to take effect.

### 4. Verify
In a fresh PowerShell or terminal window:
```
gphoto2 --version
```
Should print the gphoto2 version and copyright banner.

### 5. Connect the camera and verify detection
1. Set the camera's USB connection mode to **Photo Import / Remote Control**.
2. Turn off Wi-Fi/Bluetooth on the camera (USB and wireless control conflict).
3. Plug in via USB, then:
   ```
   gphoto2 --auto-detect
   ```
   Should list the camera model and a `usb:x,y` port.

**If the camera doesn't show up here** even though `gphoto2 --version` works: Windows may have bound its default PTP/MTP driver to the camera instead of a libusb-compatible one. Use [Zadig](https://zadig.akeo.ie/) to replace the driver for the camera's USB interface with **WinUSB** or **libusbK**, then unplug/replug the camera and retry `--auto-detect`. Only do this for the camera's interface — don't touch unrelated USB devices in Zadig's device list.

## Project-specific notes
- `src/gphoto2.ts` shells out to `gphoto2` via `execFile`, so it just needs `gphoto2` resolvable on `PATH` for whatever process runs `npm run dev:edge` — no MSYS2-specific code exists in this repo.
- A Windows-only path-separator bug in preview capture (`gphoto2` only recognizes `/` when deriving its `thumb_` filename, not the `\` that Node's `path.join` produces on `win32`) was already found and fixed here — see `docs/integration-contracts.md`. Nothing further needed on the MSYS2 side for that.
- This MSYS2/Windows setup is for local development and hands-on hardware testing only. Follow `docs/deployment-and-environment.md` and the `Dockerfile` for the actual Linux production path.
