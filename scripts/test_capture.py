#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any
from urllib import error, request


class ApiError(RuntimeError):
    def __init__(self, method: str, url: str, status_code: int, payload: Any):
        self.method = method
        self.url = url
        self.status_code = status_code
        self.payload = payload
        message = self._build_message()
        super().__init__(message)

    def _build_message(self) -> str:
        if isinstance(self.payload, dict):
            code = self.payload.get("code")
            message = self.payload.get("message")
            if code and message:
                return f"{self.method} {self.url} failed with {self.status_code} {code}: {message}"
            if message:
                return f"{self.method} {self.url} failed with {self.status_code}: {message}"
        return f"{self.method} {self.url} failed with {self.status_code}: {self.payload}"


class EdgeApiClient:
    def __init__(self, base_url: str, bearer_token: str | None = None, timeout_seconds: int = 60):
        self.base_url = base_url.rstrip("/")
        self.bearer_token = bearer_token
        self.timeout_seconds = timeout_seconds

    def get_json(self, path: str, headers: dict[str, str] | None = None) -> Any:
        return self._request("GET", path, headers=headers)

    def post_json(self, path: str, payload: dict[str, Any], headers: dict[str, str] | None = None) -> Any:
        return self._request("POST", path, payload=payload, headers=headers)

    def patch_json(self, path: str, payload: dict[str, Any], headers: dict[str, str] | None = None) -> Any:
        return self._request("PATCH", path, payload=payload, headers=headers)

    def delete(self, path: str, headers: dict[str, str] | None = None) -> Any:
        return self._request("DELETE", path, headers=headers)

    def download_bytes(self, path: str, headers: dict[str, str] | None = None) -> tuple[bytes, dict[str, str]]:
        return self._request("GET", path, headers=headers, expect_binary=True)

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        expect_binary: bool = False
    ) -> Any:
        url = f"{self.base_url}{path}"
        request_headers = {
            "Accept": "application/json"
        }
        if self.bearer_token:
            request_headers["Authorization"] = f"Bearer {self.bearer_token}"
        if headers:
            request_headers.update(headers)

        body: bytes | None = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            request_headers["Content-Type"] = "application/json"

        req = request.Request(url, data=body, headers=request_headers, method=method)

        try:
            with request.urlopen(req, timeout=self.timeout_seconds) as response:
                response_bytes = response.read()
                response_headers = {key: value for key, value in response.headers.items()}
                if expect_binary:
                    return response_bytes, response_headers
                if not response_bytes:
                    return None
                return json.loads(response_bytes.decode("utf-8"))
        except error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                payload = raw
            raise ApiError(method, url, exc.code, payload) from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Set camera config values through the edge API, trigger a capture, and optionally download the resulting image locally.",
        epilog=(
            "Examples:\n"
            "  python scripts/test_capture.py --edge-base-url http://10.60.20.196:3000 --set iso=100 --set aperture=6.3\n"
            "  python scripts/test_capture.py --set iso=400 --capture-target memoryCard --download-local-dir downloads\n"
            "  python scripts/test_capture.py --set whiteBalance=Daylight --set driveMode=Single --no-download-to-edge\n"
        ),
        formatter_class=argparse.RawTextHelpFormatter
    )

    parser.add_argument("--edge-base-url", default=os.environ.get("EDGE_BASE_URL", "http://127.0.0.1:3000"))
    parser.add_argument("--bearer-token", default=os.environ.get("API_BEARER_TOKEN"))
    parser.add_argument("--timeout-seconds", type=int, default=60)

    parser.add_argument("--owner-type", default="operator", choices=["operator", "controlServer", "automation"])
    parser.add_argument("--owner-id", default="test_capture.py")
    parser.add_argument("--lease-seconds", type=int, default=300)

    parser.add_argument(
        "--set",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="Apply a camera config before capture. Repeatable. Example: --set iso=100 --set aperture=6.3"
    )

    parser.add_argument("--capture-target", default="memoryCard", choices=["internalRam", "memoryCard"])
    parser.add_argument("--filename-template", default=None)
    parser.add_argument("--poll-interval-seconds", type=float, default=1.0)
    parser.add_argument("--poll-timeout-seconds", type=int, default=60)

    parser.add_argument("--download-to-edge", dest="download_to_edge", action="store_true", default=True)
    parser.add_argument("--no-download-to-edge", dest="download_to_edge", action="store_false")
    parser.add_argument("--keep-on-camera", dest="keep_on_camera", action="store_true", default=True)
    parser.add_argument("--delete-from-camera-after-download", dest="keep_on_camera", action="store_false")

    parser.add_argument(
        "--download-local-dir",
        default=None,
        help="If provided, download the captured asset from the edge API to this local directory after the job succeeds."
    )
    parser.add_argument("--show-status", action="store_true", help="Print current camera status before and after capture.")
    parser.add_argument("--list-configs", action="store_true", help="Print current writable camera configs before capture.")

    return parser.parse_args()


def parse_key_value(item: str) -> tuple[str, Any]:
    if "=" not in item:
        raise ValueError(f"Expected KEY=VALUE, got: {item}")
    key, raw_value = item.split("=", 1)
    key = key.strip()
    if not key:
        raise ValueError(f"Config key cannot be empty: {item}")
    return key, parse_scalar(raw_value.strip())


def parse_scalar(raw_value: str) -> Any:
    lowered = raw_value.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if lowered == "null":
        return None

    try:
        if raw_value.startswith("0") and raw_value not in {"0", "0.0"} and not raw_value.startswith("0."):
            raise ValueError
        return int(raw_value)
    except ValueError:
        pass

    try:
        return float(raw_value)
    except ValueError:
        return raw_value


def session_headers(session_token: str) -> dict[str, str]:
    return {"X-Session-Token": session_token}


def wait_for_job(client: EdgeApiClient, job_id: str, poll_interval_seconds: float, poll_timeout_seconds: int) -> dict[str, Any]:
    deadline = time.time() + poll_timeout_seconds
    while True:
        job = client.get_json(f"/v1/jobs/{job_id}")
        status = job.get("status")
        if status in {"succeeded", "failed", "cancelled"}:
            return job
        if time.time() >= deadline:
            raise TimeoutError(f"Timed out waiting for job {job_id} after {poll_timeout_seconds} seconds.")
        time.sleep(poll_interval_seconds)


def choose_local_filename(asset: dict[str, Any]) -> str:
    filename = str(asset.get("filename") or "").strip()
    camera_path = str(asset.get("cameraPath") or "").strip()
    camera_name = Path(camera_path).name if camera_path else ""

    if filename and Path(filename).suffix:
        return filename
    if filename and camera_name and Path(camera_name).suffix:
        return f"{filename}{Path(camera_name).suffix}"
    if camera_name:
        return camera_name
    if filename:
        return filename
    return f"{asset.get('assetId', 'capture')}.bin"


def print_json(title: str, payload: Any) -> None:
    print(f"\n== {title} ==")
    print(json.dumps(payload, indent=2))


def main() -> int:
    args = parse_args()
    client = EdgeApiClient(
        base_url=args.edge_base_url,
        bearer_token=args.bearer_token,
        timeout_seconds=args.timeout_seconds
    )

    session_id: str | None = None
    session_token: str | None = None

    try:
        health = client.get_json("/v1/health")
        device = client.get_json("/v1/device")
        print_json("Health", health)
        print_json("Device", device)

        session = client.post_json("/v1/sessions", {
            "ownerType": args.owner_type,
            "ownerId": args.owner_id,
            "leaseSeconds": args.lease_seconds
        })
        session_id = str(session["sessionId"])
        session_token = str(session["leaseToken"])
        print_json("Session", session)

        if args.show_status:
            print_json("Camera Status (before)", client.get_json("/v1/camera/status"))

        if args.list_configs:
            print_json("Camera Configs", client.get_json("/v1/camera/configs"))

        for item in args.set:
            key, value = parse_key_value(item)
            updated = client.patch_json(
                f"/v1/camera/configs/{key}",
                {"value": value},
                headers=session_headers(session_token)
            )
            print_json(f"Config Updated: {key}", updated)

        capture_payload: dict[str, Any] = {
            "captureTarget": args.capture_target,
            "downloadToEdge": args.download_to_edge,
            "keepOnCamera": args.keep_on_camera
        }
        if args.filename_template:
            capture_payload["filenameTemplate"] = args.filename_template

        accepted = client.post_json(
            "/v1/captures",
            capture_payload,
            headers=session_headers(session_token)
        )
        print_json("Capture Accepted", accepted)

        job = wait_for_job(
            client,
            job_id=str(accepted["jobId"]),
            poll_interval_seconds=args.poll_interval_seconds,
            poll_timeout_seconds=args.poll_timeout_seconds
        )
        print_json("Capture Job", job)

        if job.get("status") != "succeeded":
            error_payload = job.get("error") or {"message": "Capture job did not succeed."}
            raise RuntimeError(json.dumps(error_payload, indent=2))

        result = job.get("result") or {}
        asset = result.get("asset")
        if args.download_local_dir:
            if not asset:
                print("\nNo local edge asset was created. Use --download-to-edge if you want to download the captured file back through the API.")
            else:
                local_dir = Path(args.download_local_dir)
                local_dir.mkdir(parents=True, exist_ok=True)
                download_name = choose_local_filename(asset)
                download_path = local_dir / download_name
                content, _headers = client.download_bytes(f"/v1/media/{asset['assetId']}/content")
                download_path.write_bytes(content)
                print(f"\nDownloaded captured file to: {download_path.resolve()}")

        if args.show_status:
            print_json("Camera Status (after)", client.get_json("/v1/camera/status"))

        return 0
    except (ApiError, TimeoutError, ValueError, RuntimeError) as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        return 1
    finally:
        if session_id and session_token:
            try:
                client.delete(f"/v1/sessions/{session_id}", headers=session_headers(session_token))
                print(f"\nReleased session: {session_id}")
            except ApiError as exc:
                print(f"\nWarning: failed to release session {session_id}: {exc}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
