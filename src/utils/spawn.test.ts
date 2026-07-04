import { describe, expect, it } from "vitest";
import { mkdtemp, rm, realpath } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runCommand } from "./spawn";

describe("runCommand", () => {
  it("captures stdout from a successful command", async () => {
    const { stdout, exitCode } = await runCommand(["echo", "hello"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("hello");
  });

  it("returns non-zero exit code on failure", async () => {
    // `false` is a POSIX command that always exits with code 1
    const { exitCode } = await runCommand(["false"]);
    expect(exitCode).not.toBe(0);
  });

  it("captures stderr separately from stdout", async () => {
    const { stdout, stderr, exitCode } = await runCommand([
      "sh",
      "-c",
      "echo out; echo err >&2",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("out");
    expect(stderr.trim()).toBe("err");
  });

  it("respects the cwd option", async () => {
    // Use node to print the working directory — portable across OSes, unlike
    // `pwd` + a hardcoded /tmp (which Git Bash rewrites to /c/tmp on Windows).
    const dir = await mkdtemp(join(tmpdir(), "spawn-cwd-"));
    try {
      const { stdout, exitCode } = await runCommand(
        [process.execPath, "-e", "process.stdout.write(process.cwd())"],
        { cwd: dir },
      );
      expect(exitCode).toBe(0);
      expect(await realpath(stdout.trim())).toBe(await realpath(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects when argv is empty", async () => {
    await expect(runCommand([])).rejects.toThrow(/non-empty argv/);
  });

  it("surfaces missing binary (ENOENT) as exit code 127", async () => {
    // checkGhCli() and similar graceful-fallback callers rely on an exitCode
    // guard — they must not see a rejected promise when the binary is absent.
    const { exitCode } = await runCommand([
      "asm-nonexistent-binary-for-test-xyz-42",
      "--version",
    ]);
    expect(exitCode).toBe(127);
  });
});
