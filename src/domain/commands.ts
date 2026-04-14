export interface CreateProjectInput {
  title: string;
  summary?: string;
  goals?: string[];
  rootPath: string;
}

export interface CreateTaskInput {
  projectId: string;
  workstreamId?: string;
  title: string;
  description?: string;
  goal?: string;
  priority?: 'low' | 'medium' | 'high';
  acceptanceCriteria?: string[];
  actor?: string;
}

export interface CreateHandoffInput {
  projectId: string;
  taskId: string;
  fromActor: string;
  toActor: string;
  summary: string;
  nextAction: string;
  doneItems?: string[];
  remainingItems?: string[];
  requiredContextRefs?: string[];
  warnings?: string[];
  unresolvedQuestions?: string[];
  confidence?: 'low' | 'medium' | 'high';
}

export interface CreateCheckpointInput {
  projectId: string;
  sessionId: string;
  taskId?: string;
  summary: string;
  taskUpdates?: string[];
  projectUpdates?: string[];
  promotedDecisions?: string[];
  deferredItems?: string[];
  discardableItems?: string[];
}
