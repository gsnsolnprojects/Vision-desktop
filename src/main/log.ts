import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/** Minimal rotating file logger for the main process (engine has its own log). */
const MAX_BYTES = 5 * 1024 * 1024;

let logFile: string | null = null;

function file(): string {
  if (!logFile) {
    const dir = join(app.getPath("userData"), "station", "logs");
    mkdirSync(dir, { recursive: true });
    logFile = join(dir, "app.log");
  }
  return logFile;
}

function write(level: string, msg: string): void {
  const line = `${new Date().toISOString()} ${level} ${msg}\n`;
  if (!app.isPackaged) process.stdout.write(line);
  try {
    const f = file();
    try {
      if (statSync(f).size > MAX_BYTES) renameSync(f, `${f}.1`);
    } catch {
      /* file does not exist yet */
    }
    appendFileSync(f, line);
  } catch {
    /* never let logging crash the app */
  }
}

const log = {
  info: (m: string) => write("INFO", m),
  warn: (m: string) => write("WARN", m),
  error: (m: string) => write("ERROR", m),
};

export default log;
