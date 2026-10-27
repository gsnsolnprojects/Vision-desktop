import { ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { app } from "electron";
import log from "./log";
import { RuntimeManager } from "./runtime";
import type { EngineInfo } from "../shared/ipc";

const READY_TIMEOUT_MS = 60_000;
const MAX_FAST_RESTARTS = 5;

/**
 * Supervises the Python inference engine process.
 *
 * - Generates a per-launch secret token (passed via env, never on the command line).
 * - Waits for the `ENGINE_READY port=N` handshake.
 * - Restarts the engine with backoff if it crashes; gives up after repeated fast failures.
 * - Shuts it down gracefully on quit so runs are flushed to disk.
 */
export class EngineManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private token = randomBytes(32).toString("hex");
  private port: number | null = null;
  private state: EngineInfo["state"] = "stopped";
  private error: string | null = null;
  private restarts = 0;
  private recentCrashes: number[] = [];
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;

  readonly runtime = new RuntimeManager();

  constructor(private readonly dataDir: string) {
    super();
    mkdirSync(dataDir, { recursive: true });
    this.runtime.on("change", () => this.emit("change", this.info()));
  }

  info(): EngineInfo {
    const ready = this.state === "ready" && this.port !== null;
    return {
      state: this.state,
      baseUrl: ready ? `http://127.0.0.1:${this.port}` : null,
      wsUrl: ready ? `ws://127.0.0.1:${this.port}/ws` : null,
      token: ready ? this.token : null,
      error: this.error,
      restarts: this.restarts,
      setup: app.isPackaged && (this.state === "installing" || this.runtime.info().phase === "failed") ? this.runtime.info() : null,
    };
  }

  private setState(state: EngineInfo["state"], error: string | null = null): void {
    this.state = state;
    this.error = error;
    this.emit("change", this.info());
  }

  private command(): { cmd: string; args: string[]; cwd: string } {
    if (app.isPackaged) {
      // Runtime venv (installed on first launch) running the engine code shipped with the app.
      return { cmd: this.runtime.python, args: ["-m", "visionm_engine"], cwd: this.runtime.engineCodeDir };
    }
    const engineDir = join(app.getAppPath(), "engine");
    const venvPython = join(engineDir, ".venv", "Scripts", "python.exe");
    const python = process.env.VISIONM_PYTHON || (existsSync(venvPython) ? venvPython : "python");
    return { cmd: python, args: ["-m", "visionm_engine"], cwd: engineDir };
  }

  start(): void {
    if (this.proc) return;
    if (app.isPackaged && !this.runtime.isReady()) {
      // First launch (or an app update with new AI components): install the runtime, then start.
      this.setState("installing");
      this.runtime.ensure().then(
        () => this.start(),
        (err) => this.setState("failed", `AI runtime setup failed: ${err instanceof Error ? err.message : String(err)}`),
      );
      return;
    }
    this.stopping = false;
    this.port = null;
    this.setState(this.restarts > 0 ? "restarting" : "starting");

    const { cmd, args, cwd } = this.command();
    const fullArgs = [...args, "--port", "0", "--data-dir", this.dataDir, "--parent-pid", String(process.pid)];
    log.info(`Starting engine: ${cmd} ${fullArgs.join(" ")}`);

    let proc: ChildProcess;
    try {
      proc = spawn(cmd, fullArgs, {
        cwd,
        env: { ...process.env, VISIONM_ENGINE_TOKEN: this.token, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", ...(app.isPackaged ? { PYTHONPATH: this.runtime.engineCodeDir } : {}) },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.setState("failed", `Could not start engine: ${String(err)}`);
      return;
    }
    this.proc = proc;

    const readyTimer = setTimeout(() => {
      if (this.state !== "ready") {
        log.error("Engine did not become ready in time; killing it");
        proc.kill();
      }
    }, READY_TIMEOUT_MS);

    let stdoutBuf = "";
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        const m = /^ENGINE_READY port=(\d+)/.exec(line);
        if (m) {
          clearTimeout(readyTimer);
          this.port = Number(m[1]);
          log.info(`Engine ready on port ${this.port}`);
          this.setState("ready");
        } else if (line) {
          log.info(`[engine] ${line}`);
        }
      }
    });
    // Engine logs go to its own rotating file; mirror stderr for dev visibility only.
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      if (!app.isPackaged) process.stderr.write(chunk);
    });

    proc.on("error", (err) => {
      log.error(`Engine process error: ${err.message}`);
      this.error = err.message;
    });

    proc.on("exit", (code, signal) => {
      clearTimeout(readyTimer);
      this.proc = null;
      this.port = null;
      if (this.stopping) {
        this.setState("stopped");
        return;
      }
      log.error(`Engine exited unexpectedly (code=${code}, signal=${signal})`);
      this.scheduleRestart(`Engine exited (code ${code ?? signal})`);
    });
  }

  private scheduleRestart(reason: string): void {
    const now = Date.now();
    this.recentCrashes = this.recentCrashes.filter((t) => now - t < 120_000);
    this.recentCrashes.push(now);
    if (this.recentCrashes.length > MAX_FAST_RESTARTS) {
      this.setState("failed", `${reason}. The engine keeps crashing; check the logs.`);
      return;
    }
    this.restarts += 1;
    const delay = Math.min(1000 * 2 ** (this.recentCrashes.length - 1), 15_000);
    this.setState("restarting", reason);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
  }

  /** Manual restart from the UI (e.g. after a "failed" state). */
  async restart(): Promise<void> {
    this.recentCrashes = [];
    await this.stop();
    this.restarts += 1;
    this.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const proc = this.proc;
    if (!proc) {
      this.setState("stopped");
      return;
    }
    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    const port = this.port;
    if (port) {
      try {
        await fetch(`http://127.0.0.1:${port}/shutdown`, {
          method: "POST",
          headers: { "x-engine-token": this.token },
          signal: AbortSignal.timeout(2000),
        });
      } catch (err) {
        log.warn(`Graceful engine shutdown request failed: ${String(err)}`);
      }
    }
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000));
    if ((await Promise.race([exited, timeout])) === "timeout") {
      log.warn("Engine did not exit in time; killing it");
      proc.kill();
      await exited;
    }
  }

  /** Authenticated GET against the engine from the main process (e.g. report download). */
  async fetchEngine(path: string): Promise<Response> {
    if (!this.port) throw new Error("Engine is not running");
    return fetch(`http://127.0.0.1:${this.port}${path}`, { headers: { "x-engine-token": this.token } });
  }
}
