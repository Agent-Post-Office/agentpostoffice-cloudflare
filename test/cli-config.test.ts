import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readTokenFromStdin } from "../packages/cli/src/config.js";

describe("CLI credential input", () => {
  it("reads one bounded token from stdin without accepting surrounding output", async () => {
    const token = `apo_abcdef1234567890_${"A".repeat(43)}`;
    await expect(readTokenFromStdin(Readable.from([`${token}\n`]))).resolves.toBe(token);
    await expect(readTokenFromStdin(Readable.from(["\n"]))).rejects.toThrow(/token/i);
    await expect(readTokenFromStdin(Readable.from([`apo_${"x".repeat(5000)}\n`]))).rejects.toThrow(/token/i);
    await expect(readTokenFromStdin(Readable.from(["apo_one\napo_two\n"]))).rejects.toThrow(/token/i);
  });
});
