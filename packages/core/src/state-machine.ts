import type {
  ApplicationOutcome,
  ApplicationStage,
  ExecutionState,
  FourAxisState,
} from '@jobhelper/contracts';

const ALLOWED_EXECUTION_TRANSITIONS: Record<ExecutionState, readonly ExecutionState[]> = {
  draft: ['queued', 'paused', 'closed'],
  queued: ['running', 'stopping', 'paused', 'interrupted', 'error', 'closed'],
  running: ['stopping', 'paused', 'waiting_user', 'interrupted', 'error', 'closed', 'draft'],
  stopping: ['paused', 'waiting_user', 'interrupted', 'error', 'closed'],
  paused: ['queued', 'waiting_user', 'closed'],
  waiting_user: ['queued', 'paused', 'stopping', 'closed'],
  interrupted: ['queued', 'paused', 'waiting_user', 'closed'],
  error: ['queued', 'paused', 'waiting_user', 'closed'],
  closed: [],
};

const STAGE_ORDER: Record<ApplicationStage, number> = {
  created: 0,
  opened: 1,
  inspecting: 2,
  filling: 3,
  filling_ready: 4,
  submit_attempted: 5,
  verifying: 6,
  done: 7,
};

export function isTerminalOutcome(outcome: ApplicationOutcome): boolean {
  return (
    outcome === 'submitted_verified' ||
    outcome === 'user_reported' ||
    outcome === 'job_unavailable' ||
    outcome === 'closed_without_submit'
  );
}

/**
 * Validates all 4-axis state transitions and global invariants (INV-01, INV-08).
 */
export function assertValidFourAxisTransition(
  current: FourAxisState,
  patch: Partial<FourAxisState>,
): FourAxisState {
  const next: FourAxisState = {
    executionState: patch.executionState ?? current.executionState,
    waitingReason: patch.waitingReason ?? current.waitingReason,
    applicationStage: patch.applicationStage ?? current.applicationStage,
    outcome: patch.outcome ?? current.outcome,
  };

  if (next.executionState !== current.executionState) {
    const allowed = ALLOWED_EXECUTION_TRANSITIONS[current.executionState];
    if (!allowed.includes(next.executionState)) {
      throw new Error(
        `非法运行状态转移: ${current.executionState} -> ${next.executionState}`,
      );
    }
  }

  // INV-08: Once a submission attempt occurred with unknown outcome, cannot regress to pre-submit filling.
  if (
    STAGE_ORDER[current.applicationStage] >= STAGE_ORDER.submit_attempted &&
    STAGE_ORDER[next.applicationStage] < STAGE_ORDER.submit_attempted
  ) {
    throw new Error(
      `已尝试提交后的任务禁止回退表单阶段: ${current.applicationStage} -> ${next.applicationStage}`,
    );
  }

  // INV-01: Filling ready must never silently become submitted_verified.
  if (
    next.applicationStage === 'filling_ready' &&
    (next.outcome === 'submitted_verified' || next.outcome === 'user_reported')
  ) {
    throw new Error('仅完成填写核对（filling_ready）不能直接标记为已投递');
  }

  // Terminal outcome protection: never overwrite verified/reported submission with closed_without_submit.
  if (
    (current.outcome === 'submitted_verified' || current.outcome === 'user_reported') &&
    next.outcome !== current.outcome
  ) {
    throw new Error(`已确认的投递结果不可覆盖: ${current.outcome} -> ${next.outcome}`);
  }

  // Waiting reason consistency
  if (next.executionState === 'running' || next.executionState === 'queued' || next.executionState === 'closed') {
    if (patch.waitingReason === undefined) {
      next.waitingReason = 'none';
    }
  }

  return next;
}
