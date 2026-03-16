import { DatabaseClient } from "../database/DatabaseClient";

export enum QueueJobStatus {
	PENDING = "pending",
	PROCESSING = "processing",
	COMPLETED = "completed",
	FAILED = "failed",
}

export enum QueueJobType {
	DELETE_TENANT = "delete_tenant",
}

export interface QueueJob {
	id: number;
	type: string;
	payload: Record<string, unknown>;
	status: string;
	attempts: number;
	max_attempts: number;
	last_error: string | null;
	created_at: Date;
	updated_at: Date;
}

/**
 * Generic service for managing background queue jobs.
 *
 * Jobs are stored in the `queue_jobs` table and processed by the
 * `QueueJobWatchdog`. New job types are added by extending {@link QueueJobType}
 * and registering a handler in the watchdog.
 */
export class QueueJobService {
	/**
	 * Enqueues a new job for background processing.
	 */
	static async enqueue(
		type: QueueJobType,
		payload: Record<string, unknown>,
		maxAttempts = 3,
	): Promise<QueueJob> {
		return DatabaseClient.getInstance().execute<QueueJob>((prisma) =>
			(prisma as any).queueJob.create({
				data: {
					type,
					payload,
					status: QueueJobStatus.PENDING,
					max_attempts: maxAttempts,
				},
			}),
		);
	}

	/**
	 * Fetches the next batch of pending jobs ordered by creation time.
	 */
	static async fetchPending(limit = 10): Promise<QueueJob[]> {
		return DatabaseClient.getInstance().execute<QueueJob[]>((prisma) =>
			(prisma as any).queueJob.findMany({
				where: { status: QueueJobStatus.PENDING },
				orderBy: { created_at: "asc" },
				take: limit,
			}),
		);
	}

	/**
	 * Marks a job as currently being processed and increments the attempt counter.
	 */
	static async markProcessing(id: number): Promise<void> {
		await DatabaseClient.getInstance().execute((prisma) =>
			(prisma as any).queueJob.update({
				where: { id },
				data: {
					status: QueueJobStatus.PROCESSING,
					attempts: { increment: 1 },
				},
			}),
		);
	}

	/**
	 * Marks a job as completed and removes it from the table.
	 */
	static async markCompleted(id: number): Promise<void> {
		await DatabaseClient.getInstance().execute((prisma) =>
			(prisma as any).queueJob.delete({ where: { id } }),
		);
	}

	/**
	 * Marks a job as failed with an error message.
	 * If the job has exceeded its `max_attempts`, status is set to "failed";
	 * otherwise it goes back to "pending" for a retry on the next tick.
	 */
	static async markFailed(job: QueueJob, errorMessage: string): Promise<void> {
		const exceeded = job.attempts + 1 >= job.max_attempts;
		await DatabaseClient.getInstance().execute((prisma) =>
			(prisma as any).queueJob.update({
				where: { id: job.id },
				data: {
					status: exceeded ? QueueJobStatus.FAILED : QueueJobStatus.PENDING,
					last_error: errorMessage,
				},
			}),
		);
	}
}
