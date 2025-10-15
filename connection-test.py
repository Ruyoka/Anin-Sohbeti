#!/usr/bin/env python3
"""Standalone script to verify Cloudflare R2 connectivity."""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Iterable


def load_env_file(path: Path) -> None:
    """Populate ``os.environ`` with variables defined in a ``.env`` file."""
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        if line.startswith("export "):
            line = line[len("export ") :].strip()

        if "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()

        if value and len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]

        if key and key not in os.environ:
            os.environ[key] = value


def ensure_dependencies() -> None:
    try:
        global boto3  # type: ignore
        import boto3  # noqa: F401
        from botocore.exceptions import BotoCoreError, ClientError  # noqa: F401
    except ImportError as exc:  # pragma: no cover - environment dependent
        print(f"❌ Connection failed: Missing dependency ({exc}). Install boto3 to continue.")
        sys.exit(1)


def required_env(keys: Iterable[str]) -> None:
    missing = [key for key in keys if not os.environ.get(key)]
    if missing:
        raise RuntimeError(
            "Missing required environment variables: " + ", ".join(sorted(missing))
        )


def main() -> None:
    project_root = Path(__file__).resolve().parent
    load_env_file(project_root / ".env")

    ensure_dependencies()
    from botocore.exceptions import BotoCoreError, ClientError

    required_env(("R2_ENDPOINT", "R2_ACCESS_KEY", "R2_SECRET_KEY", "R2_BUCKET"))

    session = boto3.session.Session()
    client = session.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY"],
        aws_secret_access_key=os.environ["R2_SECRET_KEY"],
        region_name=os.environ.get("R2_REGION", "auto"),
    )

    bucket_name = os.environ["R2_BUCKET"]

    try:
        response = client.list_objects_v2(Bucket=bucket_name, MaxKeys=1)
        object_count = response.get("KeyCount")
        suffix = ""
        if object_count is not None:
            suffix = f" (found {object_count} object{'s' if object_count != 1 else ''})"
        print(f"✅ Connection successful{suffix}")
    except (BotoCoreError, ClientError, Exception) as exc:
        print(f"❌ Connection failed: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"❌ Connection failed: {error}")
        sys.exit(1)
