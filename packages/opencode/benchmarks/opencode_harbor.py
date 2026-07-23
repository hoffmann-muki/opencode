"""Harbor adapter for an exact locally built OpenCode revision."""

import hashlib
import re
import subprocess
from pathlib import Path

from harbor.agents.installed.opencode import OpenCode
from harbor.environments.base import BaseEnvironment


FULL_GIT_SHA = re.compile(r"^[0-9a-f]{40}$")
FULL_SHA256 = re.compile(r"^[0-9a-f]{64}$")
REPO_ROOT = Path(__file__).resolve().parents[3]


class BenchmarkOpenCode(OpenCode):
    """Install the immutable benchmark binary while retaining Harbor's runner."""

    def __init__(
        self,
        *args,
        binary_path: str,
        source_commit: str,
        binary_sha256: str,
        **kwargs,
    ) -> None:
        path = Path(binary_path)
        if not path.is_absolute() or not path.is_file():
            raise ValueError("binary_path must be an existing absolute file")
        if not FULL_GIT_SHA.fullmatch(source_commit):
            raise ValueError("source_commit must be a full Git SHA")
        if not FULL_SHA256.fullmatch(binary_sha256):
            raise ValueError("binary_sha256 must be a SHA-256 digest")
        with path.open("rb") as binary:
            digest = hashlib.file_digest(binary, "sha256").hexdigest()
        if digest != binary_sha256:
            raise ValueError("binary_path does not match binary_sha256")

        commit = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        status = subprocess.run(
            [
                "git",
                "-C",
                str(REPO_ROOT),
                "status",
                "--porcelain",
                "--untracked-files=no",
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        if commit != source_commit or status:
            raise ValueError(
                "source_commit must identify the current clean OpenCode checkout"
            )

        self._benchmark_binary = path
        self._source_commit = source_commit
        super().__init__(*args, **kwargs)

    async def install(self, environment: BaseEnvironment) -> None:
        await environment.upload_file(
            source_path=self._benchmark_binary,
            target_path="/installed-agent/opencode-benchmark",
        )
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                "install -d /opt/opencode-benchmark; "
                "install -m 0755 /installed-agent/opencode-benchmark "
                "/opt/opencode-benchmark/opencode; "
                "printf '%s\\n' '#!/bin/sh' "
                "'export OPENCODE_DISABLE_PROVIDER_RETRIES=1' "
                "'exec /opt/opencode-benchmark/opencode \"$@\"' "
                "> /usr/local/bin/opencode; "
                "chmod 0755 /usr/local/bin/opencode"
            ),
        )
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "mkdir -p ~/.nvm; "
                ": > ~/.nvm/nvm.sh; "
                "opencode --version"
            ),
        )
