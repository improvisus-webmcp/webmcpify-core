import assert from "node:assert/strict";
import { GENERATION_OUTPUT_SCHEMA, generationOutputSchema, normalizeProviderOutput } from "../dist/lib/provider-output.js";
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
const structured = JSON.stringify({ tool_proposals_json: JSON.stringify({tools: []}), tasks_json: JSON.stringify(tasks), capability_coverage_json: JSON.stringify({candidates: []}) });
assert.equal(GENERATION_OUTPUT_SCHEMA.additionalProperties, false);
assert.equal(GENERATION_OUTPUT_SCHEMA.properties.capability_coverage_json.type, 'object', 'Coverage JSON framing must be enforced by the native schema');
assert.deepEqual(generationOutputSchema(['known-id','known-id']).properties.capability_coverage_json.properties.candidates.items.properties.candidateId.enum,['known-id'],'Native coverage may only copy known resolved candidate IDs');
assert.equal(generationOutputSchema([]).properties.capability_coverage_json.properties.candidates.maxItems,0);
assert.equal(GENERATION_OUTPUT_SCHEMA.properties.capability_coverage_json.properties.candidates.items.properties.candidateId.enum,undefined,'Project constraints must not mutate the shared schema');
const objectCoverage = JSON.stringify({ tool_proposals_json: JSON.stringify({tools: []}), tasks_json: JSON.stringify(tasks), capability_coverage_json: {candidates: []} });
for (const raw of [structured, objectCoverage, JSON.stringify(objectCoverage), JSON.stringify(structured), JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: objectCoverage } }) + '\n' + JSON.stringify({type:'turn.completed'})]) {
  assert.match(normalizeProviderOutput(raw), /TOOL_PROPOSALS_JSON/);
  assert.match(normalizeProviderOutput(raw), /CAPABILITY_COVERAGE_JSON/);
  assert.deepEqual(extractTasksFromText(raw), tasks);
}
assert.equal(extractTasksFromText(JSON.stringify({tool_proposals_json:'{}', tasks_json:'not JSON', capability_coverage_json:'{}'})), undefined, "Structured formatting must not bypass task validation");
console.log("Provider output normalization verification passed");
