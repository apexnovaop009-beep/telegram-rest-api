import { QueueJobHandler } from "../QueueJobHandler";
import { QueueJob } from "../../services/QueueJobService";
import { DatabaseClient } from "../../database/DatabaseClient";
import { TelegramClientService } from "../../telegram/TelegramClientService";

interface SessionRecord {
	session_id: string;
}

/**
 * Processes a `delete_tenant` queue job:
 *
 * 1. Loads all Telegram sessions belonging to the tenant.
 * 2. Invalidates each session sequentially (destroys connection, logs out,
 *    deletes DB record). FLOOD_WAIT errors are handled with a retry-after wait.
 * 3. Deletes the tenant record from the database.
 *
 * If a FLOOD_WAIT is encountered, the handler waits the required number of
 * seconds (+ 1 s buffer) and retries that specific session before continuing.
 */
export class DeleteTenantHandler implements QueueJobHandler {
	async handle(job: QueueJob): Promise<void> {
		const tenantId = job.payload.tenantId as number;
		if (!tenantId) {
			throw new Error("Missing tenantId in job payload");
		}

		const db = DatabaseClient.getInstance();

		const sessions = await db.execute<SessionRecord[]>((prisma) =>
			prisma.telegramSession.findMany({
				where: { tenant_id: tenantId },
				select: { session_id: true },
			}),
		);

		for (const session of sessions) {
			await this.invalidateWithFloodRetry(session.session_id);
		}

		// All sessions cleared — delete the tenant record
		await db.execute((prisma) =>
			(prisma as any).tenant.delete({ where: { id: tenantId } }),
		);
	}

	/**
	 * Wraps `TelegramClientService.invalidate` with automatic FLOOD_WAIT handling.
	 * Retries indefinitely on flood-waits; all other errors propagate immediately.
	 */
	private async invalidateWithFloodRetry(sessionId: string): Promise<void> {
		// eslint-disable-next-line no-constant-condition
		while (true) {
			try {
				await TelegramClientService.invalidate(sessionId);
				return;
			} catch (error: unknown) {
				const seconds = this.extractFloodWaitSeconds(error);

				if (seconds !== null) {
					console.warn(
						`[DeleteTenantHandler] Telegram rate limit exceeded on session "${sessionId}" — retrying in ${seconds + 1}s`,
					);
					await new Promise((resolve) =>
						setTimeout(resolve, (seconds + 1) * 1000),
					);
				} else {
					throw error;
				}
			}
		}
	}

	private extractFloodWaitSeconds(error: unknown): number | null {
		if (
			error instanceof Error &&
			"seconds" in error &&
			typeof (error as Error & { seconds: unknown }).seconds === "number"
		) {
			return (error as Error & { seconds: number }).seconds;
		}
		return null;
	}
}
