"""Container-scoped AgentSight profiling for Harbor benchmark attempts.

This module intentionally depends only on the Python standard library because
Harbor imports the OpenCode agent adapter in its isolated tool environment.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PROFILE_SCHEMA = "benchmark-agentsight-profile/v1"
HEALTH_SCHEMA = "benchmark-agentsight-health/v1"
DEFAULT_IMAGE = "agentsight:play"
DEFAULT_READY_TIMEOUT_SECONDS = 30.0
DEFAULT_STOP_TIMEOUT_SECONDS = 15
STAGING_DIRECTORY = ".agentsight-profile"


@dataclass(frozen=True, slots=True)
class _DockerCollector:
    sidecar: str
    source_dir: Path


class HarborAgentSightProfiler:
    """Own one AgentSight PID-namespace sidecar for a Harbor task container."""

    def __init__(
        self,
        *,
        logs_dir: Path,
        profile_id: str,
        container_id: str,
        correlation: dict[str, Any],
        env: dict[str, str],
    ) -> None:
        self.profile_id = profile_id
        self.container_id = container_id
        self.correlation = correlation
        self.env = env
        self.attempt_dir = logs_dir / STAGING_DIRECTORY
        self.directory = self.attempt_dir / "profiles" / "agentsight"
        self.sources_dir = self.directory / "sources"
        self.image = env.get("AGENTSIGHT_IMAGE", "").strip() or DEFAULT_IMAGE
        self.strict = env.get("BENCHMARK_AGENTSIGHT_STRICT") == "1"
        legacy_ready_ms = _positive_float(
            env.get("AGENTSIGHT_READY_TIMEOUT_MS"),
            DEFAULT_READY_TIMEOUT_SECONDS * 1_000,
        )
        self.ready_timeout = _positive_float(
            env.get("AGENTSIGHT_READY_TIMEOUT_SECONDS"),
            legacy_ready_ms / 1_000,
        )
        self.stop_timeout = int(
            _positive_float(
                env.get("AGENTSIGHT_STOP_TIMEOUT_SECONDS"),
                DEFAULT_STOP_TIMEOUT_SECONDS,
            )
        )
        self.started_at = time.time()
        self.image_id: str | None = None
        self._collector: _DockerCollector | None = None
        self._finished = False

    @classmethod
    def start(
        cls,
        *,
        logs_dir: Path,
        trace_run_id: str,
        benchmark: str,
        framework: str,
        instance_id: str,
        attempt: int,
        docker_session_id: str,
        env: dict[str, str] | None = None,
    ) -> HarborAgentSightProfiler:
        effective_env = dict(os.environ if env is None else env)
        profile_id = harbor_agentsight_profile_id(
            run_id=trace_run_id,
            framework=framework,
            instance_id=instance_id,
            attempt=attempt,
        )
        correlation = {
            "runId": trace_run_id,
            "benchmark": benchmark,
            "framework": framework,
            "instanceId": instance_id,
            "attempt": attempt,
        }
        if _disabled(effective_env):
            profiler = cls(
                logs_dir=logs_dir,
                profile_id=profile_id,
                container_id="disabled",
                correlation=correlation,
                env=effective_env,
            )
            profiler._mark_unavailable("disabled")
            profiler._finished = True
            return profiler
        try:
            container_id = resolve_docker_compose_main_container(
                docker_session_id,
                effective_env,
            )
        except (OSError, RuntimeError, ValueError) as error:
            profiler = cls(
                logs_dir=logs_dir,
                profile_id=profile_id,
                container_id="unresolved",
                correlation=correlation,
                env=effective_env,
            )
            profiler._mark_unavailable(
                f"task-container resolution failed: {type(error).__name__}"
            )
            profiler._finished = True
            if profiler.strict:
                raise RuntimeError(
                    "AgentSight task-container resolution failed"
                ) from error
            return profiler

        profiler = cls(
            logs_dir=logs_dir,
            profile_id=profile_id,
            container_id=container_id,
            correlation=correlation,
            env=effective_env,
        )
        try:
            profiler._start()
        except Exception as error:
            profiler._stop_collector()
            if profiler.strict:
                profiler._finished = True
                raise
            profiler._mark_unavailable(
                f"profiler initialization failed: {type(error).__name__}"
            )
            profiler._finished = True
        return profiler

    def finish(self) -> None:
        if self._finished:
            return
        self._finished = True
        try:
            stopped = self._stop_collector()
        except Exception as error:
            self._mark_unavailable(
                f"collector finalization failed: {type(error).__name__}"
            )
            if self.strict:
                raise
            return
        source_health = _read_object(
            self.sources_dir / "task-container" / "health.json"
        )
        complete = stopped is not None and stopped.returncode == 0
        complete = complete and source_health is not None
        complete = complete and source_health.get("complete") is True
        status = "completed" if complete else "degraded"
        self._write_profile(status)
        _write_json_atomic(
            self.directory / "health.json",
            {
                "schema": HEALTH_SCHEMA,
                "profileId": self.profile_id,
                "status": status,
                "complete": complete,
                "sources": {
                    "task-container": source_health
                    or {"status": "missing", "complete": False}
                },
                "sidecarExitCode": stopped.returncode if stopped is not None else None,
            },
        )
        _write_json_atomic(
            self.directory / "summary.json",
            {
                "status": status,
                "complete": complete,
                "sources": {
                    "task-container": _summarize_health(source_health),
                },
            },
        )
        if self.strict and not complete:
            raise RuntimeError(
                f"AgentSight profile {self.profile_id} finished as {status}"
            )

    def _start(self) -> None:
        source_dir = self.sources_dir / "task-container"
        source_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        image = _run(
            ["docker", "image", "inspect", "--format", "{{.Id}}", self.image],
            self.env,
        )
        if image.returncode != 0:
            reason = (
                f"image unavailable: {self.image}; build the AgentSight play "
                "image or set AGENTSIGHT_IMAGE"
            )
            self._mark_unavailable(reason)
            self._finished = True
            if self.strict:
                raise RuntimeError(f"AgentSight {reason}")
            return
        self.image_id = image.stdout.strip()
        inspected = _run(
            [
                "docker",
                "inspect",
                "--format",
                "{{.State.Pid}}",
                self.container_id,
            ],
            self.env,
        )
        try:
            init_pid = int(inspected.stdout.strip())
        except ValueError:
            init_pid = 0
        if inspected.returncode != 0 or init_pid <= 0:
            reason = (
                "could not resolve task-container init PID: "
                f"{inspected.stderr.strip() or inspected.stdout.strip()}"
            )
            self._mark_unavailable(reason)
            self._finished = True
            if self.strict:
                raise RuntimeError(f"AgentSight {reason}")
            return

        sidecar = _sidecar_name(self.profile_id)
        _run(["docker", "rm", "--force", sidecar], self.env)
        launched = _run(
            build_docker_sidecar_args(
                image=self.image,
                sidecar=sidecar,
                source_dir=source_dir,
                profile_id=self.profile_id,
                init_pid=init_pid,
                stop_timeout=self.stop_timeout,
                binary_path="/opt/opencode-benchmark/opencode",
            ),
            self.env,
        )
        if launched.returncode != 0:
            reason = (
                "task-container collector launch failed: "
                f"{launched.stderr.strip() or launched.stdout.strip()}"
            )
            self._mark_unavailable(reason)
            self._finished = True
            if self.strict:
                raise RuntimeError(f"AgentSight {reason}")
            return
        if not _wait_for_ready(
            source_dir / "ready.json",
            self.ready_timeout,
            profile_id=self.profile_id,
        ):
            _run(
                ["docker", "stop", "--time", str(self.stop_timeout), sidecar],
                self.env,
            )
            logs = _run(["docker", "logs", sidecar], self.env)
            _write_text_atomic(
                source_dir / "collector.log",
                f"{logs.stdout}{logs.stderr}",
            )
            _run(["docker", "rm", "--force", sidecar], self.env)
            reason = (
                "task-container collector did not become ready within "
                f"{self.ready_timeout:g} seconds"
            )
            self._mark_unavailable(reason)
            self._finished = True
            if self.strict:
                raise RuntimeError(f"AgentSight {reason}")
            return
        self._collector = _DockerCollector(sidecar=sidecar, source_dir=source_dir)
        self._write_profile("capturing")

    def _stop_collector(self) -> subprocess.CompletedProcess[str] | None:
        if self._collector is None:
            return None
        collector = self._collector
        self._collector = None
        stopped = _run(
            [
                "docker",
                "stop",
                "--time",
                str(self.stop_timeout),
                collector.sidecar,
            ],
            self.env,
        )
        logs = _run(["docker", "logs", collector.sidecar], self.env)
        try:
            _write_text_atomic(
                collector.source_dir / "collector.log",
                f"{logs.stdout}{logs.stderr}",
            )
        finally:
            _run(["docker", "rm", "--force", collector.sidecar], self.env)
        return stopped

    def _mark_unavailable(self, reason: str) -> None:
        self._write_profile("unavailable", reason=reason)
        source = {
            "status": "unavailable",
            "complete": False,
            "reason": reason,
        }
        _write_json_atomic(
            self.directory / "health.json",
            {
                "schema": HEALTH_SCHEMA,
                "profileId": self.profile_id,
                "status": "unavailable",
                "complete": False,
                "reason": reason,
                "sources": {"task-container": source},
            },
        )
        _write_json_atomic(
            self.directory / "summary.json",
            {
                "status": "unavailable",
                "complete": False,
                "reason": reason,
                "sources": {"task-container": _summarize_health(source)},
            },
        )

    def _write_profile(self, status: str, *, reason: str | None = None) -> None:
        payload: dict[str, Any] = {
            "schema": PROFILE_SCHEMA,
            "profileId": self.profile_id,
            "status": status,
            "topology": "docker-pid-host-sidecar",
            "sourceScopes": (
                ["task-container"] if status in {"capturing", "completed"} else []
            ),
            "startedAt": _iso(self.started_at),
            "updatedAt": _iso(time.time()),
            "targetContainer": self.container_id,
            "image": self.image,
            "imageId": self.image_id,
            "captureTls": True,
            "correlation": self.correlation,
        }
        if reason is not None:
            payload["reason"] = reason
        _write_json_atomic(self.directory / "profile.json", payload)


def harbor_agentsight_profile_id(
    *,
    run_id: str,
    framework: str,
    instance_id: str,
    attempt: int,
) -> str:
    if not run_id or not framework or not instance_id or attempt < 1:
        raise ValueError("Harbor AgentSight profile identity is invalid")
    digest = hashlib.sha256(
        "\0".join((run_id, framework, instance_id, str(attempt))).encode()
    ).hexdigest()
    return f"agentsight-{digest[:32]}"


def resolve_docker_compose_main_container(
    session_id: str,
    env: dict[str, str],
) -> str:
    if not session_id:
        raise ValueError("Docker Compose session ID cannot be empty")
    project = docker_compose_project_name(session_id)
    result = _run(
        [
            "docker",
            "ps",
            "--filter",
            f"label=com.docker.compose.project={project}",
            "--filter",
            "label=com.docker.compose.service=main",
            "--format",
            "{{.ID}}",
        ],
        env,
    )
    containers = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if result.returncode != 0 or len(containers) != 1:
        detail = (
            result.stderr.strip() or result.stdout.strip() or "no matching container"
        )
        raise RuntimeError(
            f"could not resolve Harbor main container for {project}: {detail}"
        )
    return containers[0]


def docker_compose_project_name(value: str) -> str:
    normalized = value.lower()
    allowed_initial = "abcdefghijklmnopqrstuvwxyz0123456789"
    allowed = f"{allowed_initial}_-"
    if not normalized or normalized[0] not in allowed_initial:
        normalized = f"0{normalized}"
    return "".join(char if char in allowed else "-" for char in normalized)


def build_docker_sidecar_args(
    *,
    image: str,
    sidecar: str,
    source_dir: Path,
    profile_id: str,
    init_pid: int,
    stop_timeout: int,
    binary_path: str,
) -> list[str]:
    return [
        "docker",
        "run",
        "--detach",
        "--name",
        sidecar,
        "--privileged",
        "--pid",
        "host",
        "--network",
        "none",
        "--stop-timeout",
        str(stop_timeout),
        "--volume",
        "/sys:/sys:ro",
        "--volume",
        f"{source_dir.resolve()}:/output",
        image,
        "record",
        "--pidns-filter",
        f"/proc/{init_pid}/ns/pid",
        "--capture-level",
        "research",
        "--profile-dir",
        "/output",
        "--profile-id",
        profile_id,
        "--scope-id",
        "task-container",
        "--ready-file",
        "/output/ready.json",
        "--no-server",
        "--no-stdio",
        "--binary-path",
        f"/proc/{init_pid}/root/{binary_path.lstrip('/')}",
        "--tls-binary-only",
    ]


def _wait_for_ready(path: Path, timeout: float, *, profile_id: str) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready = _read_object(path)
        if (
            ready
            and ready.get("schema") == "agentsight-capture-ready/v1"
            and ready.get("profile_id") == profile_id
            and ready.get("scope_id") == "task-container"
        ):
            return True
        time.sleep(0.1)
    return False


def _run(
    command: list[str],
    env: dict[str, str],
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
            env=env,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return subprocess.CompletedProcess(command, 127, "", str(error))


def _disabled(env: dict[str, str]) -> bool:
    return env.get("BENCHMARK_AGENTSIGHT", "").strip().lower() in {
        "0",
        "false",
        "off",
        "disabled",
    }


def _positive_float(value: str | None, fallback: float) -> float:
    try:
        parsed = float(value or "")
    except ValueError:
        return fallback
    return parsed if parsed > 0 else fallback


def _sidecar_name(profile_id: str) -> str:
    value = "".join(
        char if char.isalnum() or char in "_.-" else "-"
        for char in f"agentsight-{profile_id}-task-container".lower()
    )
    return value[:120].rstrip("-_.") or "agentsight-profile"


def _summarize_health(health: dict[str, Any] | None) -> dict[str, Any]:
    health = health or {}
    evidence = health.get("evidence")
    evidence = evidence if isinstance(evidence, dict) else {}
    return {
        "status": health.get("status", "missing"),
        "complete": health.get("complete") is True,
        "events": evidence.get("events_written", 0),
        "writeErrors": evidence.get("write_errors", 0),
        "eventsBySource": evidence.get("events_by_source", {}),
        "diagnosticsByType": evidence.get("diagnostics_by_type", {}),
    }


def _read_object(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    _write_text_atomic(path, json.dumps(value, indent=2, sort_keys=True) + "\n")


def _write_text_atomic(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    temporary.write_text(value, encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def _iso(timestamp: float) -> str:
    from datetime import UTC, datetime

    return datetime.fromtimestamp(timestamp, tz=UTC).isoformat()
