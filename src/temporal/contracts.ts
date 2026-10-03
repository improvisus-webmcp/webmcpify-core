/** Data-only contracts: importing these must never load an optional SDK. */
export interface CoreWorkflowOptions {
  path: string;
  url: string;
  provider: string;
  method: string;
  security: string;
  runId: string;
  reviewPort?: string;
  productContext?: string;
  baseline?: boolean;
  activityTimeoutMinutes?: number;
  reviewTimeoutHours?: number;
}

export interface DraftIdentity { runId: string; patchHash: string }
export interface SourceIdentity { sourceVersion?: string; workingTreeHash?: string }
export interface ReviewedDraft extends DraftIdentity {
  approved: boolean;
  taskSetId: string;
  taskIds: string[];
  toolCount: number;
}
export interface CoreProgress {
  path: string;
  url: string;
  phase: string;
  completedTasks: number;
  totalTasks: number;
  reviewUrl?: string;
}
export interface CoreWorkflowResult {
  status: "passed" | "failed" | "rejected";
  passed: number;
  total: number;
  evaluationPath?: string;
  baselinePath?: string;
}
