import type { Handoff } from '../../domain/entities.js';

export interface HandoffRow {
  label: string;
  value: string;
}

const USER_TRUST_NOTICE =
  'user-authored intent — verify code/test state independently before trusting claims of "done"';

export function buildHandoffRows(handoff: Handoff): HandoffRow[] {
  const rows: HandoffRow[] = [
    { label: 'From', value: `${handoff.fromActor} → ${handoff.toActor}` },
  ];
  if (handoff.fromActor === 'user') {
    rows.push({ label: 'Trust note', value: USER_TRUST_NOTICE });
  }
  rows.push(
    { label: 'Summary', value: handoff.summary },
    { label: 'Next action', value: handoff.nextAction },
    { label: 'Confidence', value: handoff.confidence },
  );
  if (handoff.doneItems.length > 0) {
    rows.push({ label: 'Done', value: handoff.doneItems.join('; ') });
  }
  if (handoff.remainingItems.length > 0) {
    rows.push({ label: 'Remaining', value: handoff.remainingItems.join('; ') });
  }
  if (handoff.warnings.length > 0) {
    rows.push({ label: 'Warnings', value: handoff.warnings.join('; ') });
  }
  if (handoff.unresolvedQuestions.length > 0) {
    rows.push({
      label: 'Unresolved questions',
      value: handoff.unresolvedQuestions.join('; '),
    });
  }
  return rows;
}
