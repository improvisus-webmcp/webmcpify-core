import assert from "node:assert/strict";
import { planRegistrationPruning } from "../dist/lib/registration-pruning.js";
import { retainedSelectionTasks, completeSelectionTasks } from "../dist/lib/review-selection.js";
import { extractTasksFromText, validateTasks, validateToolScaledTasks } from "../dist/lib/tasks.js";

const registration = `context.registerTool({name:'remove_item',execute:()=>{ordinaryHandler();return {};}});`;
const prefix = `function ordinaryHandler(){return 'original app action';}\nconst context=document.modelContext;\n`;
for (const [file, source] of [
  ["app.js", `${prefix}if(context){${registration}context.registerTool({name:'keep_item',execute:ordinaryHandler});}`],
  ["app.tsx", `interface Context { registerTool(value:unknown):void }; const discovered=navigator.modelContext as Context; const context=discovered; function ordinaryHandler(){return <span>Keep</span>}; if(context){${registration}}`],
  ["app.ts", `const context=(document.modelContext as {registerTool(value:unknown):void})!; function ordinaryHandler(){}; if(context){${registration}}`],
]) {
  const plan = await planRegistrationPruning([{ path: file, source }], ["remove_item"]);
  assert.ok(plan, `Straightforward JS/TS registration must prune: ${file}`);
  const result = plan.get(file);
  assert.ok(result.includes("ordinaryHandler"), "Original handlers must survive");
  assert.ok(!result.includes("name:'remove_item'"));
  assert.ok(result.length < source.length);
}

for (const source of [
  `${prefix}if(context)${registration}`, // bare if would lose its body/else
  `${prefix}const handle=context.registerTool({name:'remove_item'});`, // result in use
  `${prefix}context.registerTool({name:'remove_item',...options});`,
  `${prefix}context.registerTool({name:'remove_item',[key]:true});`,
  `${prefix}const name='remove_item';context.registerTool({name});`,
  `${prefix}context.registerTool({name:'remove_item'});context.unregisterTool('remove_item');`,
  `${prefix}function other(context){${registration}}`, // shadowed binding
  `function separate(){const context=document.modelContext;} ${registration}`, // alias outside lexical scope
  `const document={modelContext:other};const context=document.modelContext;${registration}`,
  `let context=document.modelContext;${registration}`,
  `${prefix}context.registerTool=another;${registration}`,
  `${prefix}context['registerTool']=another;${registration}`,
  `${prefix}delete context.registerTool;${registration}`,
  `const context=applicationRegistry;${registration}`,
  `${prefix}${registration}${registration}`, // duplicate conditional exposure
  `const context=document.modelContext;const definitions=[{name:'remove_item'}];definitions.forEach(tool=>context.registerTool(tool));`,
]) assert.equal(await planRegistrationPruning([{ path: "app.js", source }], ["remove_item"]), undefined, "Entangled/dynamic registrations must defer safely");
assert.equal(await planRegistrationPruning([{ path: "form.html", source: '<form toolname="remove_item"></form>' }], ["remove_item"]), undefined);

const selected = [{ name: "keep_item", behavior: { expectedFailures: [{ condition: "empty", error: "Nothing to keep" }] } }];
const rejected = [{ name: "remove_item" }];
const positive = { id: "keep-success", description: "Keep selected item", requiredTools: ["keep_item"], verify: "document.body.dataset.kept === 'yes'" };
const negative = { id: "keep-rejection", description: "Keep with empty selection", requiredTools: ["keep_item"], expectedOutcome: "rejection", expectedError: "Nothing to keep", setup: "Empty the selection without satisfying the keep guard", verify: "document.body.dataset.kept !== 'yes'" };
const removed = { ...positive, id: "removed", requiredTools: ["remove_item"] };
const mixed = { ...positive, id: "mixed", requiredTools: ["keep_item", "remove_item"], setup: "Prepare both tools" };
const availability = { ...positive, id: "availability", requiredTools: undefined, description: "Verify removed tool availability", verify: "document.modelContext.getTools().some(tool => tool.name === 'remove_item')" };
const retained = retainedSelectionTasks([positive, negative, removed, mixed, availability], selected, rejected);
assert.deepEqual(retained, [positive, negative], "Drop rejected-only, mixed, and availability tasks referencing removed tools");
assert.deepEqual(completeSelectionTasks(retained, [{ ...positive, verify: "true" }, removed], selected), retained, "Provider output must never overwrite an unaffected pass criterion or pad retained tests");
assert.deepEqual(validateToolScaledTasks(retained, selected), retained);
assert.deepEqual(validateTasks(retained, 1), retained);
const raw = `TASKS_JSON\n\`\`\`json\n${JSON.stringify(retained)}\n\`\`\``;
assert.deepEqual(extractTasksFromText(raw), retained);
assert.deepEqual(extractTasksFromText(raw, 1), retained);
assert.throws(() => completeSelectionTasks([], [], selected), /at least 1/);
const unsupportedSupplement = { ...positive, id: "unsupported-supplement", setup: "Run remove_item before keep_item" };
assert.throws(() => completeSelectionTasks([], retainedSelectionTasks([unsupportedSupplement], selected, rejected), selected), /at least 1/, "New coverage tests must not reintroduce rejected-tool setup through prose");
const extended = [...selected, { name: "other_item" }];
const added = { ...positive, id: "new-coverage", requiredTools: ["other_item"] };
assert.deepEqual(completeSelectionTasks(retained, [added], extended), [...retained, added]);
assert.throws(() => completeSelectionTasks(retained, [], extended), /missing task coverage/);
console.log("Selection pruning passed: JS/TS/JSX direct removal, conservative source fallback, immutable retained tests, dependent-task removal, and coverage-only supplementation");
