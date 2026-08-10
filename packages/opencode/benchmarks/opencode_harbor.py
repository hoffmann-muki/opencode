"""Harbor adapter for an exact locally built OpenCode revision."""

import asyncio
import hashlib
import json
import os
import re
import shlex
import subprocess
import tomllib
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, override

from harbor.agents.installed.base import NonZeroAgentExitCodeError, with_prompt_template
from harbor.agents.installed.opencode import OpenCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.task.id import PackageTaskId

from packages.opencode.benchmarks.tracing.agentsight_harbor import (
    HarborAgentSightProfiler,
)
from packages.opencode.benchmarks.harbor_secrets import (
    remove_secret_environment,
    source_secret_environment,
    stage_secret_environment,
)


FULL_GIT_SHA = re.compile(r"^[0-9a-f]{40}$")
FULL_SHA256 = re.compile(r"^[0-9a-f]{64}$")
REPO_ROOT = Path(__file__).resolve().parents[3]
TRACE_METADATA_FILENAME = "benchmark-trace.json"
TRACE_ALLOCATION_FILENAME = ".harbor-attempts.json"
TRACE_LOCK_FILENAME = ".harbor-attempts.lock"
PROVIDER_ENVIRONMENT = {
    "amazon-bedrock": (
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_REGION",
    ),
    "anthropic": ("ANTHROPIC_API_KEY",),
    "azure": ("AZURE_RESOURCE_NAME", "AZURE_API_KEY"),
    "deepseek": ("DEEPSEEK_API_KEY",),
    "github-copilot": ("GITHUB_TOKEN",),
    "google": (
        "GEMINI_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_API_KEY",
    ),
    "groq": ("GROQ_API_KEY",),
    "huggingface": ("HF_TOKEN",),
    "llama": ("LLAMA_API_KEY",),
    "mistral": ("MISTRAL_API_KEY",),
    "openai": ("OPENAI_API_KEY", "OPENAI_BASE_URL"),
    "opencode": ("OPENCODE_API_KEY",),
    "openrouter": ("OPENROUTER_API_KEY",),
    "xai": ("XAI_API_KEY",),
}
NON_SECRET_ENVIRONMENT = {
    "AWS_REGION",
    "AZURE_RESOURCE_NAME",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "OPENAI_BASE_URL",
}


class BenchmarkOpenCode(OpenCode):
    """Install the immutable benchmark binary while retaining Harbor's runner."""

    def __init__(
        self,
        *args,
        logs_dir: Path,
        binary_path: str,
        source_commit: str,
        binary_sha256: str,
        trace_root: str | None = None,
        trace_run_id: str | None = None,
        trace_created_at: str | None = None,
        trace_benchmark: str | None = None,
        evaluation_workers: int = 1,
        benchmark_retries: int = 0,
        harbor_version: str = "unknown",
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
        trace_values = (
            trace_root,
            trace_run_id,
            trace_created_at,
            trace_benchmark,
        )
        if any(value is not None for value in trace_values) and not all(
            value is not None for value in trace_values
        ):
            raise ValueError("OpenCode Harbor tracing requires complete metadata")
        if trace_benchmark is not None and not trace_benchmark.strip():
            raise ValueError("trace_benchmark cannot be empty")
        if evaluation_workers < 1 or benchmark_retries < 0:
            raise ValueError("OpenCode Harbor trace execution metadata is invalid")
        self._trace_root = Path(trace_root).resolve() if trace_root else None
        self._trace_run_id = trace_run_id
        self._trace_created_at = trace_created_at
        self._trace_benchmark = trace_benchmark
        self._evaluation_workers = evaluation_workers
        self._benchmark_retries = benchmark_retries
        self._harbor_version = harbor_version
        self._trace_instance_id: str | None = None
        self._trace_attempt: int | None = None
        self._trace_agent_timeout: float | None = None
        self._trace_image: str | None = None
        self._agentsight_profiler: HarborAgentSightProfiler | None = None
        super().__init__(*args, logs_dir=logs_dir, **kwargs)

    @override
    def build_cli_flags(self) -> str:
        flags = super().build_cli_flags()
        if self._trace_root is None:
            return flags
        return " ".join(value for value in (flags, "--benchmark-trace") if value)

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if self._trace_root is not None:
            trial = _trial_metadata(self.logs_dir)
            self._trace_instance_id = trial["instance_id"]
            self._trace_agent_timeout = trial["agent_timeout_seconds"]
            self._trace_image = trial["image"]
            self._trace_attempt = _allocate_attempt(
                self._trace_root,
                self._trace_instance_id,
            )
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

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        del context
        if self._trace_root is None:
            await self._run_agent(instruction, environment)
            return
        if (
            self._trace_instance_id is None
            or self._trace_attempt is None
            or self._trace_agent_timeout is None
            or self._trace_image is None
            or self._trace_run_id is None
            or self._trace_benchmark is None
            or self.session_id is None
        ):
            raise ValueError("Harbor did not initialize OpenCode trace identity")

        self._agentsight_profiler = await asyncio.to_thread(
            HarborAgentSightProfiler.start,
            logs_dir=self.logs_dir,
            trace_run_id=self._trace_run_id,
            benchmark=self._trace_benchmark,
            framework="opencode",
            instance_id=self._trace_instance_id,
            attempt=self._trace_attempt,
            docker_session_id=environment.session_id,
        )
        started_at = datetime.now(timezone.utc)
        metadata: dict[str, Any] = {
            "schemaVersion": 1,
            "runId": self._trace_run_id,
            "benchmark": self._trace_benchmark,
            "instanceId": self._trace_instance_id,
            "attempt": self._trace_attempt,
            "traceRoot": str(self._trace_root),
            "createdAt": self._trace_created_at,
            "frameworkRevision": self._source_commit,
            "model": self.model_name,
            "evaluationWorkers": self._evaluation_workers,
            "inferenceTimeoutSeconds": self._trace_agent_timeout,
            "benchmarkRetries": self._benchmark_retries,
            "harborVersion": self._harbor_version,
            "image": self._trace_image,
            "sessionId": self.session_id,
            "agentSightProfileId": self._agentsight_profiler.profile_id,
            "agentSightStrict": self._agentsight_profiler.strict,
            "startedAt": started_at.isoformat(),
            "status": "running",
        }
        try:
            _atomic_write_json(self.logs_dir / TRACE_METADATA_FILENAME, metadata)
            await self._run_agent(instruction, environment)
        except BaseException as error:
            _atomic_write_json(
                self.logs_dir / TRACE_METADATA_FILENAME,
                {
                    **metadata,
                    "finishedAt": datetime.now(timezone.utc).isoformat(),
                    "status": (
                        "timeout"
                        if isinstance(error, asyncio.CancelledError)
                        else "failed"
                    ),
                    "error": type(error).__name__,
                },
            )
            raise
        else:
            _atomic_write_json(
                self.logs_dir / TRACE_METADATA_FILENAME,
                {
                    **metadata,
                    "finishedAt": datetime.now(timezone.utc).isoformat(),
                    "status": "completed",
                },
            )
        finally:
            await asyncio.to_thread(self._agentsight_profiler.finish)

    async def _run_agent(
        self,
        instruction: str,
        environment: BaseEnvironment,
    ) -> None:
        self._instruction = instruction
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")
        provider = self.model_name.split("/", 1)[0]
        values = {
            key: os.environ[key]
            for key in PROVIDER_ENVIRONMENT.get(provider, ())
            if os.environ.get(key)
        }
        env = {
            key: value for key, value in values.items() if key in NON_SECRET_ENVIRONMENT
        }
        env.update(
            {
                "OPENCODE_FAKE_VCS": "git",
                "XDG_DATA_HOME": "/logs/agent/opencode/xdg-data",
                "XDG_STATE_HOME": "/logs/agent/opencode/xdg-state",
            }
        )

        if skills_command := self._build_register_skills_command():
            await self.exec_as_agent(environment, command=skills_command, env=env)
        if mcp_command := self._build_register_config_command():
            await self.exec_as_agent(environment, command=mcp_command, env=env)

        secrets = {key: value for key, value in values.items() if key not in env}
        secret_path = (
            await stage_secret_environment(environment, self.logs_dir, secrets)
            if secrets
            else None
        )
        cli_flags = self.build_cli_flags()
        command = (
            source_secret_environment(secret_path) if secret_path is not None else ""
        ) + (
            ". ~/.nvm/nvm.sh; "
            f"opencode --model={shlex.quote(self.model_name)} run --format=json "
            f"{'--continue ' if self._resume else ''}"
            f"{cli_flags + ' ' if cli_flags else ''}--thinking "
            "--dangerously-skip-permissions -- "
            f"{shlex.quote(instruction)} "
            "2>&1 </dev/null | stdbuf -oL tee /logs/agent/opencode.txt"
        )
        try:
            await self.exec_as_agent(environment, command=command, env=env)
        finally:
            if secret_path is not None:
                await remove_secret_environment(environment, secret_path)
        if messages := self._error_messages():
            raise NonZeroAgentExitCodeError(
                "OpenCode emitted error event(s): " + "; ".join(messages[:3])
            )


def _trial_metadata(logs_dir: Path) -> dict[str, Any]:
    config = json.loads((logs_dir.parent / "config.json").read_text())
    task = config.get("task")
    if not isinstance(task, dict):
        raise ValueError("Harbor trial config has no task object")
    name = task.get("name")
    reference = task.get("ref")
    if (
        not isinstance(name, str)
        or "/" not in name
        or not isinstance(reference, str)
        or not reference.startswith("sha256:")
    ):
        raise ValueError("Harbor package task is not pinned to a digest")
    organization, task_name = name.split("/", 1)
    task_path = PackageTaskId(
        org=organization,
        name=task_name,
        ref=reference,
    ).get_local_path()
    with (task_path / "task.toml").open("rb") as file:
        document = tomllib.load(file)
    task_agent = document.get("agent")
    environment = document.get("environment")
    timeout = task_agent.get("timeout_sec") if isinstance(task_agent, dict) else None
    image = environment.get("docker_image") if isinstance(environment, dict) else None
    if not isinstance(timeout, int | float) or timeout <= 0:
        raise ValueError("Harbor task has no positive agent timeout")
    if not isinstance(image, str) or not image:
        raise ValueError("Harbor task has no Docker image")
    multiplier = config.get("agent_timeout_multiplier")
    if multiplier is None:
        multiplier = config.get("timeout_multiplier", 1)
    if not isinstance(multiplier, int | float) or multiplier <= 0:
        raise ValueError("Harbor trial timeout multiplier must be positive")
    return {
        "instance_id": task_name,
        "agent_timeout_seconds": float(timeout) * float(multiplier),
        "image": image,
    }


def _allocate_attempt(root: Path, instance_id: str) -> int:
    if not root.is_dir() or root.is_symlink():
        raise ValueError(f"Harbor trace root must be a real directory: {root}")
    with _allocation_lock(root):
        path = root / TRACE_ALLOCATION_FILENAME
        allocations = (
            json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        )
        if not isinstance(allocations, dict) or not all(
            isinstance(key, str) and isinstance(value, int) and value >= 0
            for key, value in allocations.items()
        ):
            raise ValueError("Harbor trace attempt allocation state is invalid")
        attempt = allocations.get(instance_id, 0) + 1
        allocations[instance_id] = attempt
        _atomic_write_json(path, allocations)
        return attempt


@contextmanager
def _allocation_lock(root: Path) -> Iterator[None]:
    import fcntl

    with (root / TRACE_LOCK_FILENAME).open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.chmod(0o600)
    temporary.replace(path)
