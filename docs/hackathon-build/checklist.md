# Autonomous build checklist

Mode: autonomous  
Verification: automated after items 4 and 7  
Git cadence: one final reviewed commit  
Wow moment: one developer request becomes a safe patch and independently verified browser outcome, with only the consequential decision interrupting the human.

- [x] **1. Add the isolated Strands package**
  Spec ref: `spec.md > Packaging`
  What to build: Add the Node 22 package, dependencies, scripts, and workspace wiring.
  Acceptance: Existing Core install requirements remain unchanged.
  Verify: Install dependencies and run package typecheck.

- [x] **2. Expose trusted human review over Core MCP**
  Spec ref: `spec.md > Core MCP additions`
  What to build: Add and document `review_webmcp` using Core's existing review implementation.
  Acceptance: Review returns approval/rejection and the exact patch identifier; apply still enforces approval.
  Verify: Run the MCP contract test.

- [x] **3. Implement the Strands agent CLI**
  Spec ref: `spec.md > Agent`
  What to build: Parse arguments, connect to Core over stdio MCP, construct the constrained Strands agent, and invoke the workflow.
  Acceptance: A single command can orchestrate the complete workflow.
  Verify: Run focused unit tests with mocked cloud dependencies.

- [x] **4. Verify the security boundary**
  Spec ref: `prd.md > Requirements`
  What to build: Test tool ordering, review stop, patch binding, and truthful failure reporting.
  Acceptance: No model-controlled path bypasses the existing human approval manifest.
  Verify: Run all focused tests and inspect the MCP tool contract.

- [x] **5. Document setup and demo flow**
  Spec ref: `scope.md`
  What to build: Add concise README and architecture instructions, including credential prerequisites and limitations.
  Acceptance: A judge can install and run the agent from the public repository.
  Verify: Follow the documented commands from a clean dependency install.

- [x] **6. Create submission assets**
  Spec ref: `scope.md`
  What to build: Export an architecture diagram and draft the Devpost description, testing instructions, screenshots, and video script.
  Acceptance: Every required Devpost field has content or a clearly identified user-supplied value.
  Verify: Compare against live submission requirements.

- [x] **7. Run the full project verification**
  Spec ref: `spec.md > Verification`
  What to build: Run typecheck, complete test suite, package dry-run, and secret/diff checks.
  Acceptance: All automated checks pass and the package contains expected files only.
  Verify: Preserve command results in build notes.

- [ ] **8. Prepare the Devpost handoff**
  Spec ref: `scope.md`
  What to build: Confirm repository visibility, license detection, pushed branch/main, public video, diagram upload, and form values.
  Acceptance: Submission is ready for explicit final confirmation.
  Verify: Run live Devpost preflight without submitting.
