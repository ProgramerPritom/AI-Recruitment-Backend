export type CandidateStatus =
  | 'sourced'
  | 'accepted'
  | 'rejected'
  | 'contacted'
  | 'replied'
  | 'interested'
  | 'not_interested'
  | 'meeting_booked'
  | 'interviewed'
  | 'shortlisted'
  | 'hired'
  | 'unsubscribed';

export const VALID_CANDIDATE_STATUSES: CandidateStatus[] = [
  'sourced',
  'accepted',
  'rejected',
  'contacted',
  'replied',
  'interested',
  'not_interested',
  'meeting_booked',
  'interviewed',
  'shortlisted',
  'hired',
  'unsubscribed',
];

/**
 * Permitted transitions mapping:
 * Key: current status -> Value: array of allowed target statuses
 */
const STATUS_TRANSITIONS: Record<CandidateStatus, CandidateStatus[]> = {
  sourced: ['accepted', 'rejected'],
  accepted: ['contacted', 'rejected'],
  contacted: ['replied', 'unsubscribed'],
  replied: ['interested', 'not_interested', 'unsubscribed'],
  interested: ['meeting_booked', 'rejected', 'unsubscribed'],
  not_interested: ['unsubscribed'],
  meeting_booked: ['interviewed', 'rejected', 'unsubscribed'],
  interviewed: ['shortlisted', 'rejected', 'unsubscribed'],
  shortlisted: ['hired', 'rejected', 'unsubscribed'],
  hired: [], // Terminal status
  rejected: ['accepted', 'sourced'], // Allow recruiter reconsideration or restoring
  unsubscribed: [], // Terminal blacklist status - no further outreach
};

export class CandidateStateMachine {
  /**
   * Check if transitioning from currentStatus to targetStatus is valid
   */
  public static canTransition(currentStatus: CandidateStatus, targetStatus: CandidateStatus): boolean {
    if (currentStatus === targetStatus) {
      return true;
    }

    // Unsubscribed can happen at any point after contacted
    const contactedOrLater: CandidateStatus[] = [
      'contacted',
      'replied',
      'interested',
      'not_interested',
      'meeting_booked',
      'interviewed',
      'shortlisted',
      'rejected',
    ];
    if (targetStatus === 'unsubscribed' && contactedOrLater.includes(currentStatus)) {
      return true;
    }

    const allowed = STATUS_TRANSITIONS[currentStatus];
    return allowed ? allowed.includes(targetStatus) : false;
  }

  /**
   * Validate transition or throw an informative error
   */
  public static validateTransition(currentStatus: CandidateStatus, targetStatus: CandidateStatus): void {
    if (!VALID_CANDIDATE_STATUSES.includes(targetStatus)) {
      throw new Error(`Invalid status: "${targetStatus}". Must be one of ${VALID_CANDIDATE_STATUSES.join(', ')}`);
    }

    if (!this.canTransition(currentStatus, targetStatus)) {
      throw new Error(
        `Illegal status transition: Cannot move candidate from "${currentStatus}" to "${targetStatus}".`
      );
    }
  }

  /**
   * Check if candidate is eligible to receive outreach campaigns
   */
  public static isEligibleForOutreach(status: CandidateStatus, email?: string): boolean {
    if (!email || email.trim().length === 0) {
      return false;
    }
    return status === 'accepted';
  }

  /**
   * Check if candidate should be suppressed from any further email follow-ups
   */
  public static shouldSuppressOutreach(status: CandidateStatus): boolean {
    const suppressedStatuses: CandidateStatus[] = [
      'unsubscribed',
      'replied',
      'interested',
      'not_interested',
      'meeting_booked',
      'interviewed',
      'shortlisted',
      'hired',
      'rejected',
    ];
    return suppressedStatuses.includes(status);
  }
}

