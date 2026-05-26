"""Delegate Python invocations to the packaged Node.js CLI."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    node = os.environ.get("NODE", "node")
    cli = root / "bin" / "agent-archive.js"
    result = subprocess.run([node, str(cli), *sys.argv[1:]], check=False)
    return int(result.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
