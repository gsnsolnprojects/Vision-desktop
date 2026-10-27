import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import log from "./log";
import type { RuntimeSetup } from "../shared/ipc";

/**
 * AI runtime for the packaged app (PyTorch + CUDA + TensorRT + engine dependencies).
 *
 * The installer ships a small private Python. On first launch we create a virtual environment in the
 * user's data folder and pip-install the exact versions in engine/requirements.lock (~4 GB download).
 * A marker file records what was installed; an app update with a changed lock file re-runs pip,
 * which only downloads what changed. Development mode never uses this (it runs engine/.venv).
 */

const MIN_FREE_BYTES = 12 * 1024 ** 3; // download + unpacked runtime + headroom

interface Marker {
  lockHash: string;
  pythonHome: string;
  completedAt: string;
}

export class RuntimeManager extends EventEmitter {
  private state: RuntimeSetup = { phase: "idle", message: "", detail: null, log: [], error: null, failedPhase: null, startedAt: null };
  private running: Promise<void> | null = null;

  readonly root = join(app.getPath("userData"), "runtime");
  readonly venv = join(this.root, "venv");
  readonly python = join(this.venv, "Scripts", "python.exe");
  private readonly marker = join(this.root, "state.json");
  private readonly logFile = join(this.root, "setup.log");

  get basePython(): string {
    return join(process.resourcesPath, "python", "python.exe");
  }

  get lockFile(): string {
    return join(process.resourcesPath, "engine", "requirements.lock");
  }

  get engineCodeDir(): string {
    return join(process.resourcesPath, "engine");
  }

  info(): RuntimeSetup {
    return { ...this.state, log: [...this.state.log] };
  }

  private lockHash(): string {
    return createHash("sha256").update(readFileSync(this.lockFile)).digest("hex").slice(0, 16);
  }

  private readMarker(): Marker | null {
    try {
      return JSON.parse(readFileSync(this.marker, "utf8")) as Marker;
    } catch {
      return null;
    }
  }

  /** True when the installed runtime matches this app version's lock file. */
  isReady(): boolean {
    const m = this.readMarker();
    return !!m && existsSync(this.python) && m.lockHash === this.lockHash() && m.pythonHome === join(process.resourcesPath, "python");
  }

  private update(patch: Partial<RuntimeSetup>): void {
    this.state = { ...this.state, ...patch };
    this.emit("change", this.info());
  }

  private appendLog(line: string): void {
    const log = [...this.state.log, line].slice(-60);
    this.update({ log });
  }

  /** Install or repair the runtime. Safe to call repeatedly; concurrent calls share one run. */
  ensure(): Promise<void> {
    if (this.isReady()) return Promise.resolve();
    if (!this.running) {
      this.running = this.install().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async install(): Promise<void> {
    mkdirSync(this.root, { recursive: true });
    const out = createWriteStream(this.logFile, { flags: "a" });
    const write = (l: string) => out.write(`${new Date().toISOString()} ${l}\n`);
    this.update({ phase: "checking", message: "Preparing AI runtime…", detail: null, error: null, failedPhase: null, log: [], startedAt: new Date().toISOString() });
    try {
      const free = statfsSync(this.root).bavail * statfsSync(this.root).bsize;
      if (free < MIN_FREE_BYTES) {
        throw new Error(`Not enough disk space: ${(free / 1024 ** 3).toFixed(1)} GB free, about 12 GB needed. Free up space and click Retry.`);
      }

      const m = this.readMarker();
      const homeChanged = !!m && m.pythonHome !== join(process.resourcesPath, "python");
      if (!existsSync(this.python) || homeChanged) {
        // A venv is tied to the Python it was created from; recreate it if the app moved.
        if (existsSync(this.venv)) rmSync(this.venv, { recursive: true, force: true });
        this.update({ phase: "creating", message: "Creating Python environment…" });
        await this.run(this.basePython, ["-m", "venv", this.venv], write);
      }

      // Factory networks drop out: pip retries each request, and the whole step is retried a few times.
      // Already-downloaded files are reused from pip's cache, so a retry only fetches what's missing.
      const ATTEMPTS = 4;
      for (let attempt = 1; ; attempt++) {
        this.update({
          phase: "downloading",
          message: attempt === 1 ? "Downloading AI components (about 4 GB, one time only)…" : `Connection problem — retrying (attempt ${attempt} of ${ATTEMPTS})…`,
        });
        try {
          await this.run(
            this.python,
            // --no-deps: the lock pins every package, so pip must not pull in anything newer.
            ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--progress-bar", "off", "--no-deps",
              "--retries", "10", "--timeout", "60", "-r", this.lockFile],
            write,
            (line) => this.onPipLine(line),
          );
          break;
        } catch (err) {
          if (attempt >= ATTEMPTS) throw err;
          write(`pip attempt ${attempt} failed; retrying in ${attempt * 15}s`);
          await new Promise((r) => setTimeout(r, attempt * 15_000));
        }
      }

      this.update({ phase: "verifying", message: "Checking the installation…", detail: null });
      await this.run(this.python, ["-m", "pip", "check", "--disable-pip-version-check"], write, (l) => this.appendLog(l));
      await this.run(this.python, ["-c", "import torch, ultralytics, cv2, fastapi, rfdetr, tensorrt, openpyxl, harvesters; print('cuda', torch.cuda.is_available())"], write, (l) =>
        this.appendLog(l),
      );

      const marker: Marker = { lockHash: this.lockHash(), pythonHome: join(process.resourcesPath, "python"), completedAt: new Date().toISOString() };
      writeFileSync(`${this.marker}.tmp`, JSON.stringify(marker, null, 2));
      renameSync(`${this.marker}.tmp`, this.marker);
      this.update({ phase: "done", message: "AI runtime ready", detail: null });
      log.info("AI runtime installed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      write(`FAILED: ${msg}`);
      log.error(`Runtime setup failed: ${msg}`);
      this.update({ phase: "failed", message: "AI runtime setup failed", error: msg, failedPhase: this.state.phase === "failed" ? this.state.failedPhase : this.state.phase });
      throw err;
    } finally {
      out.end();
    }
  }

  private onPipLine(line: string): void {
    const t = line.trim();
    if (!t) return;
    let m: RegExpMatchArray | null;
    if ((m = t.match(/^Downloading (\S+) \(([\d.]+ [kMG]B)\)/))) {
      // "Downloading https://.../torch-2.5.1%2Bcu121-cp310-...whl (2449.4 MB)" -> "torch (2449.4 MB)"
      const pkg = decodeURIComponent(m[1].split("/").pop() ?? m[1]).split("-")[0];
      this.update({ detail: `Downloading ${pkg} (${m[2]})` });
    } else if ((m = t.match(/^Collecting (\S+)/))) {
      this.update({ detail: `Checking ${m[1]}` });
    } else if (t.startsWith("Installing collected packages")) {
      this.update({ phase: "installing", message: "Installing AI components…", detail: "This can take a few minutes" });
    }
    this.appendLog(t.length > 200 ? `${t.slice(0, 200)}…` : t);
  }

  private run(cmd: string, args: string[], write: (l: string) => void, onLine?: (l: string) => void): Promise<void> {
    write(`$ ${cmd} ${args.join(" ")}`);
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, {
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PIP_NO_COLOR: "1" },
      });
      let buf = "";
      const handle = (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let i: number;
        while ((i = buf.search(/\r?\n/)) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + (buf[i] === "\r" ? 2 : 1));
          write(line);
          onLine?.(line);
        }
      };
      p.stdout.on("data", handle);
      p.stderr.on("data", handle);
      p.on("error", (e) => reject(new Error(`Could not start ${cmd}: ${e.message}`)));
      p.on("close", (code) => {
        if (buf) {
          write(buf);
          onLine?.(buf);
        }
        if (code === 0) resolve();
        else {
          const tail = this.state.log.slice(-3).join(" | ");
          reject(new Error(`Step failed (exit ${code}). ${/Could not|ConnectionError|Read timed out|NewConnectionError|getaddrinfo/i.test(tail) ? "Check the internet connection and click Retry." : tail}`));
        }
      });
    });
  }

  get logPath(): string {
    return this.logFile;
  }
}
