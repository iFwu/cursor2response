import { expect, it } from "vitest";
import { sha256Hex } from "./crypto.ts";

it("computes SHA-256 UTF-8 fingerprints", async () => {
  await expect(sha256Hex("abc")).resolves.toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
