// Builds build/python: a private, minimal Python 3.10 (x64) shipped inside the installer.
// It only needs to create the runtime venv on first launch (python -m venv + ensurepip), so the
// standard library is copied without site-packages, tests, Tk/IDLE, docs or headers.
// Uses robocopy (built into Windows): far faster than file-by-file copies under antivirus scanning.
//
// Usage: node scripts/prepare-python.mjs [path-to-Python310]   (default: the python on PATH)
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const src =
  process.argv[2] ||
  execFileSync("python", ["-c", "import sys; print(sys.base_prefix)"], { encoding: "utf8" }).trim();
const version = execFileSync(join(src, "python.exe"), ["-c", "import sys, struct; print(sys.version_info[:2], struct.calcsize('P')*8)"], {
  encoding: "utf8",
}).trim();
if (version !== "(3, 10) 64") {
  throw new Error(`Need 64-bit Python 3.10 (the engine's tested version), got ${version} at ${src}`);
}

const out = join(process.cwd(), "build", "python");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

function robocopy(from, to, extraArgs) {
  // /E recurse, /NFL /NDL /NJH /NJS /NP quiet, /MT multi-threaded. Exit codes < 8 mean success.
  const r = spawnSync("robocopy", [from, to, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/MT:16", ...extraArgs], { stdio: "inherit" });
  if (r.status === null || r.status >= 8) throw new Error(`robocopy ${from} failed (exit ${r.status})`);
}

for (const f of ["python.exe", "pythonw.exe", "python3.dll", "python310.dll", "vcruntime140.dll", "vcruntime140_1.dll", "LICENSE.txt"]) {
  cpSync(join(src, f), join(out, f));
}
robocopy(join(src, "DLLs"), join(out, "DLLs"), ["/XF", "_tkinter.pyd", "tcl86t.dll", "tk86t.dll"]);
robocopy(join(src, "Lib"), join(out, "Lib"), ["/XD", "site-packages", "__pycache__", "test", "tests", "tkinter", "idlelib", "turtledemo", "lib2to3"]);
mkdirSync(join(out, "Lib", "site-packages"), { recursive: true });

if (!existsSync(join(out, "Lib", "ensurepip", "_bundled"))) throw new Error("ensurepip wheels missing: venv creation would fail");

const size = (d) => readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(join(d, e.name)) : statSync(join(d, e.name)).size), 0);
console.log(`build/python ready (${(size(out) / 2 ** 20).toFixed(0)} MB) from ${src}`);
