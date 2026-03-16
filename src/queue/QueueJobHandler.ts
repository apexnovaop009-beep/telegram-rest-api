import { QueueJob } from "../services/QueueJobService";

/**
 * Contract for a background queue-job handler.
 *
 * Each implementation handles exactly one {@link QueueJobType}.
 * The watchdog dispatches incoming jobs to the matching handler
 * based on the job's `type` field.
 */
export interface QueueJobHandler {
	handle(job: QueueJob): Promise<void>;
}
