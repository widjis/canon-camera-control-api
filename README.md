# Camera Control

Camera Control is a Canon camera automation platform built around an edge API that runs close to the camera and a control server that orchestrates it remotely.

## Source Of Truth
- Product and architecture docs live in `docs/`
- API contract lives in `docs/openapi.yaml`
- Agent workflow rules live in `AGENT.md`

## Current Status
- Canon EOS R50 has been verified locally with `gphoto2`
- The repository now includes both the TypeScript edge API and the first control server

## Development
1. Install dependencies:
   - `npm install`
2. Configure runtime environment:
   - copy values from `.env.example` into a local `.env`
3. Start the edge API:
   - `npm run dev:edge`
4. Start the control server:
   - `npm run dev:control`
5. Build for production:
   - `npm run build`
6. Run tests:
   - `npm test`
7. Or run both services with Docker:
   - local/dev (no camera passthrough): `docker compose up -d --build`
   - production Linux edge host (with camera passthrough): `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`
   - edge API: `http://localhost:30000`, control server: `http://localhost:40000`
   - see `docs/deployment-and-environment.md` for volumes, ports, health checks, and why USB passthrough is a separate override file

For deploying to a real Ubuntu edge host without Docker, follow "Ubuntu Edge Node Deployment" below.

## Ubuntu Edge Node Deployment (No Docker)

Step-by-step procedure for a **fresh Ubuntu machine that runs both services with the Canon camera attached over USB**, without Docker: TypeScript is compiled on the host and the two services run under `systemd`.

Running native is deliberate. `gphoto2` is invoked as a fresh process per command (`src/gphoto2.ts`), so no long-lived USB handle is held and replugging the camera is tolerated without restarting the service. Container `/dev/bus/usb` passthrough loses that property, and container capture has not yet been verified end-to-end on a native Linux Docker host.

> Status: this procedure is derived from the code and from verified `gphoto2` behaviour, but it has not yet been executed end-to-end on the target Ubuntu host. Record the outcome in `docs/operational-runbook.md` after the first real run.

### Step 1 — Decide whether the graphical session stays

Do this before anything else; it changes several later steps.

On a desktop-enabled Ubuntu, `gvfs-gphoto2-volume-monitor` automatically mounts any PTP camera so it appears in the file manager. While that mount is held, `gphoto2` cannot claim the device and camera commands fail with `Could not claim the USB device`. This is the Linux counterpart of the macOS `icdd` / `PTPCamera` problem, but `prepareHost` in `src/gphoto2.ts` only handles the macOS case, so it must be solved at the OS level.

**Option A — no GUI (recommended for a dedicated edge node):**

```bash
sudo systemctl set-default multi-user.target
sudo reboot
```

Nothing is uninstalled and it is reversible with `set-default graphical.target`. No graphical session means no gvfs, so nothing ever competes for the camera.

**Option B — keep the GUI.** Disable only the gphoto2 volume monitor rather than removing `gvfs-backends`, which would also break trash, SMB, and MTP in the file manager:

```bash
ls /usr/share/gvfs/remote-volume-monitors/          # path differs between Ubuntu releases
sudo mv /usr/share/gvfs/remote-volume-monitors/gphoto2.monitor \
        /usr/share/gvfs/remote-volume-monitors/gphoto2.monitor.disabled
```

Then, as the desktop user and not as root, stop GNOME from auto-opening removable media:

```bash
gsettings set org.gnome.desktop.media-handling automount false
gsettings set org.gnome.desktop.media-handling automount-open false
```

Two caveats for Option B: the monitor process is D-Bus activated, so `killall gvfs-gphoto2-volume-monitor` only helps until the camera is replugged, and `apt upgrade` can restore the renamed file, so re-check it after upgrades. Anyone who logs into the desktop and clicks the camera icon in Files will also take the camera away from the service.

### Step 2 — System packages

```bash
sudo apt update
sudo apt install -y git curl gphoto2
sudo apt install -y cifs-utils        # only if the network export endpoint is used against SMB
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v                               # expect v24.x
gphoto2 --version
```

Node 24 is the recommended runtime. `package.json` requires `>=22` because the code uses the built-in `node:sqlite` module (`src/stores.ts`) instead of a native SQLite package — which also means **no compiler toolchain is needed**, since `npm ci` installs no native modules. On older Node 22 builds `node:sqlite` still requires the `--experimental-sqlite` flag; Node 24 needs no flag.

### Step 3 — Service user and USB permissions

```bash
sudo useradd -r -m -d /var/lib/camera-control -s /usr/sbin/nologin camera
sudo usermod -aG plugdev camera
```

Check how the shipped udev rules grant camera access:

```bash
grep -rn "uaccess\|plugdev" /lib/udev/rules.d/*gphoto2* /usr/lib/udev/rules.d/*gphoto2*
```

If the rules use `TAG+="uaccess"`, which is typical on current Ubuntu, access is granted by ACL to whoever holds the **active graphical session** — something a system service user never has. Group membership alone is then not enough and an explicit rule is required:

```bash
sudo tee /etc/udev/rules.d/99-canon-camera.rules >/dev/null <<'RULE'
# 04a9 = Canon. Grant group access so the headless service user can claim the camera,
# not only the user holding the active graphical session.
SUBSYSTEM=="usb", ATTRS{idVendor}=="04a9", MODE="0660", GROUP="plugdev"
RULE
sudo udevadm control --reload
sudo udevadm trigger
```

Unplug and replug the camera so the new rule applies.

### Step 4 — Verify the camera before touching the application

Verify in this order, so a failure identifies which layer is at fault:

```bash
lsusb | grep -i canon                     # 1. does the OS see the camera at all?
sudo -u camera gphoto2 --auto-detect      # 2. can the SERVICE USER claim it?
sudo -u camera gphoto2 --summary          # 3. does PTP communication work?
```

Step 2 is the real test. If it succeeds as your own login user but fails as `camera`, the problem is permissions (Step 3), not systemd and not the camera.

Camera-side requirements: USB mode `Photo Import/Remote Control`, Wi-Fi and Bluetooth off, a data-capable USB cable, and mains power (AC adapter or dummy battery) for sustained capture.

### Step 5 — Clone and build

```bash
sudo git clone <repository-url> /opt/canon-camera-control-api
sudo chown -R camera:camera /opt/canon-camera-control-api
cd /opt/canon-camera-control-api
sudo -u camera npm ci
sudo -u camera npm run build
```

Use `npm ci` rather than `npm install`, since `package-lock.json` is committed. Do **not** use `--omit=dev`: TypeScript lives in `devDependencies`, so without it `npm run build` cannot run, and `dist/` is git-ignored and therefore never present after a clone.

### Step 6 — Configure `.env`

`.env` is git-ignored, so it must be created on the host:

```bash
sudo -u camera cp .env.example .env
sudo -u camera nano .env
sudo chmod 600 .env
```

Use absolute paths. The defaults in `src/config.ts` are relative to `process.cwd()`, which makes the data location depend on where the process was started:

```
HOST=0.0.0.0
PORT=3000
DEVICE_ID=edge-camera-01
DATA_DIR=/var/lib/camera-control/data
DATABASE_PATH=/var/lib/camera-control/data/edge.sqlite
MEDIA_DIR=/var/lib/camera-control/data/media
API_BEARER_TOKEN=<generate-a-token>

CONTROL_HOST=0.0.0.0
CONTROL_PORT=4000
CONTROL_DATA_DIR=/var/lib/camera-control/control-data
CONTROL_DATABASE_PATH=/var/lib/camera-control/control-data/control.sqlite
CONTROL_JOB_POLL_INTERVAL_MS=500
CONTROL_JOB_POLL_TIMEOUT_MS=60000
CONTROL_API_BEARER_TOKEN=<generate-a-token>
```

`PREPARE_DARWIN_PROCESSES` can be dropped; it is ignored on Linux. Bearer auth is enforced **only when a token is set** (`src/config.ts`), so with `HOST=0.0.0.0` and no token an API that can fire the shutter and write to a plant share is open to the whole network. Set both tokens.

```bash
sudo -u camera mkdir -p /var/lib/camera-control/data/media /var/lib/camera-control/control-data
```

### Step 7 — Smoke test by hand

```bash
cd /opt/canon-camera-control-api
sudo -u camera npm run start:edge
```

In a second shell:

```bash
curl -s http://127.0.0.1:3000/v1/health
curl -s -H "Authorization: Bearer <edge-token>" http://127.0.0.1:3000/v1/device
```

Stop it with Ctrl-C before continuing. Use `start:edge` / `start:control`, which run plain `node dist/*.js`, and never `dev:edge` / `dev:all` in production: `tsx watch` restarts the process on file changes, which can kill an in-flight `gphoto2` command and drop the serial command queue.

### Step 8 — systemd units

```bash
sudo tee /etc/systemd/system/camera-edge.service >/dev/null <<'UNIT'
[Unit]
Description=Canon camera edge API
After=network-online.target
Wants=network-online.target

[Service]
User=camera
SupplementaryGroups=plugdev
WorkingDirectory=/opt/canon-camera-control-api
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/camera-control.service >/dev/null <<'UNIT'
[Unit]
Description=Canon camera control server
After=network-online.target
Wants=network-online.target

[Service]
User=camera
WorkingDirectory=/opt/canon-camera-control-api
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node dist/control-index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now camera-edge camera-control
systemctl status camera-edge camera-control
journalctl -u camera-edge -f
```

Four details in these units matter:

- `Environment=PATH=` is required. The code calls the bare string `"gphoto2"` (`src/gphoto2.ts`), so it depends on `PATH`; systemd's default `PATH` is minimal and the resulting `ENOENT` looks exactly like "gphoto2 is not installed".
- `SupplementaryGroups=plugdev` is set explicitly on the edge unit, because systemd does not necessarily inherit the user's supplementary groups.
- No `EnvironmentFile=` is used. The entrypoints already run `import "dotenv/config"`, which loads `.env` from `WorkingDirectory`; systemd and dotenv parse quotes and comments differently, so loading `.env` through both parsers can yield different values.
- `ExecStart` runs `node` directly rather than `npm run start:edge`. `npm run` inserts npm and a shell between systemd and Node, and SIGTERM is often not forwarded cleanly, leaving an orphaned process holding port 3000 so the next start fails with `EADDRINUSE`.

Two services means two units on purpose: separate logs (`journalctl -u camera-edge`), independent restarts, and one crash does not take the other down.

### Step 9 — Register the edge node with the control server

`control-data/` is git-ignored, so a fresh host starts with an empty control database and no registered devices, including when migrating from an existing host. Register the local edge API:

```bash
curl -s -X POST http://127.0.0.1:4000/v1/control/devices \
  -H "Authorization: Bearer <control-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "edge-camera-01",
    "name": "Line 1 Canon EOS R50",
    "edgeBaseUrl": "http://127.0.0.1:3000",
    "edgeBearerToken": "<edge-token>"
  }'

curl -s -X POST http://127.0.0.1:4000/v1/control/devices/edge-camera-01/probe \
  -H "Authorization: Bearer <control-token>"
```

`deviceId`, `name`, and `edgeBaseUrl` are required. With both services on one host, `edgeBaseUrl` is `127.0.0.1` and port 4000 never has to be exposed off the machine.

When migrating from another host, note that the edge SQLite database, saved camera profiles, and downloaded media are **not** in Git. Copy `edge.sqlite`, `control.sqlite`, and the media directory across manually if that data is still needed.

### Step 10 — Network share for the export endpoint (optional)

`POST /v1/media/:assetId/export` requires an **absolute** `targetRoot` (`src/app.ts`). Linux has no UNC paths, so a Windows-style `\\server\share\...` is rejected and the share must be mounted first:

```bash
sudo mkdir -p /mnt/plant-share /etc/camera-control
sudo tee /etc/camera-control/smb.cred >/dev/null <<'CRED'
username=<user>
password=<password>
domain=<domain>
CRED
sudo chmod 600 /etc/camera-control/smb.cred
```

Add to `/etc/fstab` for SMB:

```
//fileserver/plant-share /mnt/plant-share cifs credentials=/etc/camera-control/smb.cred,uid=camera,gid=camera,file_mode=0644,dir_mode=0755,_netdev 0 0
```

or for NFS:

```
fileserver:/export/plant-share /mnt/plant-share nfs defaults,_netdev 0 0
```

Then run `sudo mount -a` and verify the service user can actually write:

```bash
sudo -u camera touch /mnt/plant-share/.write-test && sudo -u camera rm /mnt/plant-share/.write-test
```

Notes:

- `uid=camera` in the mount options must match the service user, otherwise `copyFile` fails and the API returns `502 NETWORK_SAVE_FAILED` — a mount permission problem that reads like an application error.
- `_netdev` keeps boot from hanging when the file server is unreachable.
- The caller, which is the app server and never the browser, owns `targetRoot` and sends it per request. Moving from Windows to Ubuntu therefore means changing that value to `/mnt/plant-share/...` on the caller side, with **no change to this codebase**.
- If the share is down, export fails with `502` and there is no automatic retry; the capture itself stays safe under `MEDIA_DIR`.

### Step 11 — Firewall

```bash
sudo ufw allow from <trusted-subnet> to any port 3000 proto tcp
sudo ufw enable
```

Keep port 4000 closed to the network when the control server runs on the same host as its only edge node.

### Updating

```bash
cd /opt/canon-camera-control-api
sudo -u camera git pull
sudo -u camera npm ci
sudo -u camera npm run build
sudo systemctl restart camera-edge camera-control
```

Forgetting `npm run build` is the classic mistake: the services keep running the previous `dist/` without any error, and the new code silently has no effect.

### Operational notes

- `MEDIA_DIR` grows without limit; there is no retention or cleanup in the code. On a full disk the first symptom is usually a confusing SQLite error, so plan a cleanup job or a separate partition.
- Never run `npm run dev:edge` while the unit is active. Two edge processes compete for the same camera and the resulting errors look like a hardware fault.
- `scripts/test-gphoto2-camera.sh` was written for macOS; its USB visibility step uses `system_profiler` and prints nothing on Linux. Use `lsusb` for that step — the other steps work as-is.

### Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Could not claim the USB device` | gvfs or a file manager holds the camera | Step 1; check `ps aux \| grep gvfs-gphoto2` and `gio mount -l \| grep -i gphoto` |
| Works as your login user, fails as `camera` | udev grants access via `uaccess` to the graphical session only | Step 3 udev rule, then replug |
| `ENOENT` / `gphoto2 execution failed` under systemd but fine in a shell | systemd's minimal `PATH` | Set `Environment=PATH=` in the unit |
| `EADDRINUSE` after restart | orphaned Node process from an `npm run` ExecStart | Run `node` directly; clear with `sudo fuser -k 3000/tcp` |
| `Cannot find module '/opt/.../dist/index.js'` | `dist/` is git-ignored and was never built | `npm ci && npm run build` |
| `502 NETWORK_SAVE_FAILED` | share not mounted, or mount uid does not match the service user | Step 10, then the `touch` write test |
| Camera detected but every command times out | Wi-Fi/Bluetooth on, wrong USB mode, or charge-only cable | Set `Photo Import/Remote Control`, disable wireless, swap the cable |

## Helper Scripts
- `scripts/test-gphoto2-camera.sh`: low-level `gphoto2` visibility and compatibility checks on the edge host
- `scripts/test_capture.py`: edge API capture helper that can:
  - create and release a camera session automatically
  - apply one or more camera config values with repeatable `--set key=value`
  - trigger still capture to `internalRam` or `memoryCard`
  - choose whether the image is downloaded to the edge and/or kept on the camera
  - optionally download the resulting image from the edge API to your local machine

Example:
- `python scripts/test_capture.py --edge-base-url http://10.60.20.196:3000 --set iso=100 --set aperture=6.3 --download-local-dir downloads`

## Runtime Split
- `src/index.ts` boots the edge API that owns camera USB access
- `src/control-index.ts` boots the control server that registers edge nodes, probes them, orchestrates captures, and records audit logs
- Runtime app config stays in environment variables or `.env`
- Saved camera presets/profiles stay in SQLite on the edge node
- Live camera config is queried from the camera when needed and is not treated as cached local truth

## Important Runtime Notes
- Canon EOS R50 should use `Photo Import/Remote Control`
- Wi-Fi/Bluetooth should be disabled for USB control
- On macOS, host processes such as `icdd`, `photolibraryd`, and `PTPCamera` may need to be stopped before `gphoto2` claims the camera
- On Linux with a desktop session, `gvfs-gphoto2-volume-monitor` claims the camera the same way — see "Ubuntu Edge Node Deployment" above
- On Windows, `gphoto2` isn't natively packaged — see `docs/windows-gphoto2-setup.md` for installing it via MSYS2/MinGW64 for local development
- For the first production path, prefer Linux for the edge node even though the control server remains cross-platform
