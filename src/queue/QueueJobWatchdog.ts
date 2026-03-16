import {
	QueueJobService,
	QueueJobType,
	QueueJob,
} from "../services/QueueJobService";
import { QueueJobHandler } from "./QueueJobHandler";
import { DeleteTenantHandler } from "./jobs/DeleteTenantHandler";

/**
 * Background worker that polls the `queue_jobs` table at a fixed interval,
 * dispatches each pending job to the appropriate handler, and cleans up
 * completed jobs.
 *
 * Adding support for a new job type requires:
 * 1. A new entry in {@link QueueJobType}.
 * 2. A class implementing {@link QueueJobHandler}.
 * 3. Registering it in `handlers` below.
 *
 * The poll interval is controlled by `QUEUE_JOB_INTERVAL_SECONDS` in the
 * environment file (default: 30 seconds).
 */
export class QueueJobWatchdog {
	private timer: ReturnType<typeof setInterval> | null = null;
	private busy = false;

	private readonly handlers: Record<string, QueueJobHandler> = {
		[QueueJobType.DELETE_TENANT]: new DeleteTenantHandler(),
	};

	start(): void {
		if (this.timer) return;

		const intervalSec = Math.max(
			1,
			parseInt(process.env.QUEUE_JOB_INTERVAL_SECONDS ?? "30", 10),
		);

		this.timer = setInterval(() => {
			this.tick().catch((error) => {
				console.error("[QueueJobWatchdog] Unhandled error during tick:", error);
			});
		}, intervalSec * 1000);

		console.log(`[QueueJobWatchdog] Started — interval: ${intervalSec}s`);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
			console.log("[QueueJobWatchdog] Stopped");
		}
	}

	// ── Private ──────────────────────────────────────────────────────────

	private async tick(): Promise<void> {
		if (this.busy) return;

		this.busy = true;
		try {
			const jobs = await QueueJobService.fetchPending();
			for (const job of jobs) {
				await this.process(job);
			}
		} finally {
			this.busy = false;
		}
	}

	private async process(job: QueueJob): Promise<void> {
		const handler = this.handlers[job.type];
		if (!handler) {
			console.error(
				`[QueueJobWatchdog] No handler registered for job type "${job.type}" (job id=${job.id})`,
			);
			await QueueJobService.markFailed(
				job,
				`No handler for type "${job.type}"`,
			);
			return;
		}

		try {
			await QueueJobService.markProcessing(job.id);
			console.log(
				`[QueueJobWatchdog] Processing job id=${job.id} type="${job.type}" (attempt ${job.attempts + 1}/${job.max_attempts})`,
			);
			await handler.handle(job);
			await QueueJobService.markCompleted(job.id);
			console.log(`[QueueJobWatchdog] Job id=${job.id} completed`);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Unknown error";
			console.error(`[QueueJobWatchdog] Job id=${job.id} failed: ${message}`);
			await QueueJobService.markFailed(job, message);
		}
	}
}
