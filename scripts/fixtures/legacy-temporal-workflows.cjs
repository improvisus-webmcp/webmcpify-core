// Historical repair command sequence, before workflow versioning. Replay this
// history against today's worker to catch accidental nondeterminism.
const { ActivityCancellationType, proxyActivities } = require('@temporalio/workflow');
const { testActivity } = proxyActivities({ startToCloseTimeout: '30 minutes', heartbeatTimeout: '30 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED, retry: { maximumAttempts: 1 } });
exports.repairWorkflow = async opts => {
  const result = await testActivity(opts.path, opts.url, opts.task, 0, opts.runId, opts.taskSetId, opts.provider);
  return { passed: result.passed, attempts: 0, task: opts.task };
};
