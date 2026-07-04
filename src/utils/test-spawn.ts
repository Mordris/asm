import {
  spawnSync as nodeSpawnSync,
  spawn as nodeSpawn,
} from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import type {
  SpawnSyncOptions,
  SpawnOptions,
  SpawnSyncReturns,
  ChildProcess,
} from "node:child_process";

const require = createRequire(import.meta.url);

/**
 * tsx's CLI entry. Tests launch it via the current Node binary
 * (`process.execPath <tsx-cli> …`) rather than the `npx`/`tsx` shim: on Windows
 * those shims are `.cmd` files that child_process cannot spawn without a shell
 * (a bare name throws ENOENT; a `.cmd` throws EINVAL under Node's
 * CVE-2024-27980 hardening), so any `npx tsx …` invocation fails. Resolving via
 * `package.json` sidesteps tsx's restricted subpath exports.
 */
const TSX_CLI = join(
  dirname(require.resolve("tsx/package.json")),
  "dist",
  "cli.mjs",
);

/**
 * Rewrite a leading `npx tsx …` argv into `[node, <tsx-cli>, …]` so the same
 * test argv runs on every platform (see TSX_CLI). Any other argv is returned
 * unchanged.
 */
function normalizeArgv(argv: readonly string[]): readonly string[] {
  if (argv[0] === "npx" && argv[1] === "tsx") {
    return [process.execPath, TSX_CLI, ...argv.slice(2)];
  }
  return argv;
}

/**
 * Thin argv-first wrapper around `child_process.spawnSync` for tests. Takes an
 * argv array (`[cmd, ...args]`) and returns the Node-shaped result directly.
 */
export function spawnSyncArgv(
  argv: readonly string[],
  opts: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  const [cmd, ...args] = normalizeArgv(argv);
  return nodeSpawnSync(cmd, args, opts);
}

/**
 * Argv-first wrapper around `child_process.spawn`. Takes an argv array and
 * returns a Node `ChildProcess` whose `proc.stdout` / `proc.stderr` are read
 * as Node streams.
 */
export function spawnArgv(
  argv: readonly string[],
  opts: SpawnOptions = {},
): ChildProcess {
  const [cmd, ...args] = normalizeArgv(argv);
  return nodeSpawn(cmd, args, opts);
}

/**
 * Collect stdout/stderr and wait for exit, resolving to a
 * `{ exitCode, stdout, stderr }` shape that call sites assert against.
 */
export function spawnCollect(
  argv: readonly string[],
  opts: SpawnOptions & { stdin?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { stdin, ...spawnOpts } = opts;
  const stdio: ("pipe" | "ignore")[] =
    stdin !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"];
  return new Promise((resolve, reject) => {
    const child = spawnArgv(argv, { stdio, ...spawnOpts });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    if (stdin !== undefined && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      // Mirror runCommand in src/utils/spawn.ts: a missing binary surfaces
      // as exitCode 127, not a rejection, so callers can guard on exitCode
      // without a try/catch.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        resolve({ exitCode: 127, stdout, stderr: err.message });
        return;
      }
      reject(err);
    });
    const onDisconnect = () => child.kill("SIGKILL");
    process.on("disconnect", onDisconnect);
    child.on("close", (code) => {
      process.off("disconnect", onDisconnect);
      if (settled) return;
      settled = true;
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Run an inline TS snippet under `tsx`.
 * Writes the snippet inside `opts.cwd` (or process.cwd()) so that relative
 * imports like `./src/registry` resolve against the project tree, then runs
 * it via `npx tsx` and cleans up.
 */
export async function runInlineTs(
  script: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const base = opts.cwd ?? process.cwd();
  // Write the snippet directly at the base (project root) so relative imports
  // like `./src/registry` resolve against the project tree.
  const file = join(
    base,
    `.asm-inline-ts-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`,
  );
  writeFileSync(file, script);
  try {
    return await spawnCollect(["npx", "tsx", file], opts);
  } finally {
    rmSync(file, { force: true });
  }
}
