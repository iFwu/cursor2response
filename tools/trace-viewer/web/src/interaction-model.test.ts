import { describe, expect, it } from "vitest";

import { groupInteractions } from "./interaction-model";

const projection = (overrides: Record<string, unknown>) => ({
  id: String(overrides.id),
  kind: "metadata",
  requestId: null,
  executionId: null,
  executionIds: [],
  status: null,
  ...overrides
});

describe("groupInteractions", () => {
  it("keeps steering and aborted inputs in their active Execution", () => {
    const groups = groupInteractions([
      projection({ id: "input-initial", kind: "user_input", requestId: "request-1", executionId: "execution-1", executionIds: ["execution-1"] }),
      projection({ id: "input-aborted", kind: "turn_aborted", requestId: "request-2", executionId: "execution-1", executionIds: ["execution-1"] }),
      projection({ id: "input-steer", kind: "user_input", requestId: "request-2", executionId: "execution-1", executionIds: ["execution-1"] }),
      projection({ id: "attached", requestId: "request-2", executionId: "execution-1" }),
      projection({ id: "terminal", requestId: "request-1", executionId: "execution-1", status: "finished" })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].inputs.map((item) => item.id)).toEqual(["input-initial", "input-aborted", "input-steer"]);
    expect(groups[0].steps.map((item) => item.id)).toEqual(["attached", "terminal"]);
    expect(groups[0].status).toBe("completed");
  });

  it("keeps separate Executions as separate interactions", () => {
    const groups = groupInteractions([
      projection({ id: "input-1", kind: "user_input", requestId: "request-1", executionId: "execution-1", executionIds: ["execution-1"] }),
      projection({ id: "terminal-1", executionId: "execution-1", status: "cancelled" }),
      projection({ id: "input-2", kind: "user_input", requestId: "request-2", executionId: "execution-2", executionIds: ["execution-2"] })
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.status)).toEqual(["cancelled", "running"]);
  });

  it("uses the latest Execution lifecycle when an interaction is retried", () => {
    const groups = groupInteractions([
      projection({
        id: "input-1", kind: "user_input", requestId: "request-1",
        executionId: "execution-1", executionIds: ["execution-1", "execution-2"]
      }),
      projection({ id: "terminal-1", executionId: "execution-1", status: "failed" }),
      projection({ id: "started-2", executionId: "execution-2", status: "running" })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].status).toBe("running");
  });
});
