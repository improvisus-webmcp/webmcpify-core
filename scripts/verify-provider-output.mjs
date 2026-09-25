import assert from "node:assert/strict";
import { normalizeProviderOutput } from "../dist/lib/provider-output.js";
import { extractTasksFromText } from "../dist/lib/tasks.js";

const tasks = Array.from({ length: 5 }, (_, index) => ({
  id: `task-${index + 1}`,
  description: `Complete action ${index + 1}.`,
  requiredTools: ["run_action"],
  verify: `document.body.dataset.task${index + 1} === 'done'`,
}));
const proposal = `TASKS_JSON\n\`\`\`json\n${JSON.stringify(tasks)}\n\`\`\``;

const agy = JSON.stringify({ status: "SUCCESS", response: proposal });
const codexJsonl = `${JSON.stringify({ type: "item.completed", item: { type: "assistant_message", content: proposal } })}\n${JSON.stringify({ type: "turn.completed" })}`;
const claude = JSON.stringify({ result: { content: [{ type: "text", text: proposal }] } });
const futureEnvelope = JSON.stringify({ data: { choices: [{ assistant: { answer: proposal } }] } });

for (const raw of [agy, codexJsonl, claude, futureEnvelope]) {
  assert.equal(normalizeProviderOutput(raw), proposal);
  assert.equal(extractTasksFromText(raw)?.length, 5);
}
assert.equal(normalizeProviderOutput(proposal), proposal);
console.log("Provider output normalization verification passed");
