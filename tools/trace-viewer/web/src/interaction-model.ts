export type InteractionStatus = "observed" | "running" | "completed" | "failed" | "cancelled";

export type InteractionProjection = {
  id: string;
  kind: string;
  requestId: string | null;
  executionId: string | null;
  executionIds?: string[];
  status: string | null;
};

export type InteractionGroup<T extends InteractionProjection> = {
  id: string;
  index: number;
  inputs: T[];
  steps: T[];
  finals: T[];
  status: InteractionStatus;
};

const executionStatuses = new Set([
  "running", "finished", "completed", "succeeded", "failed", "error", "send_failed", "cancelled", "superseded"
]);

function interactionStatus<T extends InteractionProjection>(group: InteractionGroup<T>): InteractionStatus {
  let terminal: string | null = null;
  for (let index = group.steps.length - 1; index >= 0; index -= 1) {
    const status = group.steps[index].status;
    if (!status || !executionStatuses.has(status)) continue;
    terminal = status;
    break;
  }
  if (terminal === "running") return "running";
  if (terminal === "failed" || terminal === "error" || terminal === "send_failed") return "failed";
  if (terminal === "cancelled" || terminal === "superseded") return "cancelled";
  if (terminal || group.finals.some((item) => item.status === "published")) return "completed";
  return group.inputs.length > 0 ? "running" : "observed";
}

export function groupInteractions<T extends InteractionProjection>(projections: T[]): InteractionGroup<T>[] {
  const groups: InteractionGroup<T>[] = [];
  const executionGroup = new Map<string, InteractionGroup<T>>();
  const requestGroup = new Map<string, InteractionGroup<T>>();
  const inputKinds = new Set(["user_input", "turn_aborted"]);

  for (const item of projections) {
    if (!inputKinds.has(item.kind)) continue;
    const executionIds = item.executionIds ?? (item.executionId ? [item.executionId] : []);
    let group = executionIds.map((executionId) => executionGroup.get(executionId)).find(Boolean)
      ?? (item.requestId ? requestGroup.get(item.requestId) : undefined);
    if (!group) {
      group = {
        id: `interaction-${executionIds[0] ?? item.id}`,
        index: groups.length + 1,
        inputs: [],
        steps: [],
        finals: [],
        status: "running"
      };
      groups.push(group);
    }
    group.inputs.push(item);
    for (const executionId of executionIds) executionGroup.set(executionId, group);
    if (item.requestId) requestGroup.set(item.requestId, group);
  }

  let preamble: InteractionGroup<T> | null = null;
  let current: InteractionGroup<T> | null = null;
  const fallback = () => {
    if (current) return current;
    if (!preamble) {
      preamble = { id: "interaction-preamble", index: 0, inputs: [], steps: [], finals: [], status: "observed" };
      groups.unshift(preamble);
    }
    return preamble;
  };

  for (const item of projections) {
    if (inputKinds.has(item.kind)) {
      current = (item.executionId ? executionGroup.get(item.executionId) : undefined)
        ?? (item.requestId ? requestGroup.get(item.requestId) : undefined)
        ?? current;
      continue;
    }
    const matched = (item.executionId ? executionGroup.get(item.executionId) : undefined)
      ?? (item.requestId ? requestGroup.get(item.requestId) : undefined);
    if (item.kind === "final_output") (matched ?? fallback()).finals.push(item);
    else (matched ?? fallback()).steps.push(item);
  }

  for (const group of groups) group.status = interactionStatus(group);
  return groups;
}
