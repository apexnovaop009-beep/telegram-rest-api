import { DatabaseClient } from "../database/DatabaseClient";

const FORWARDING_INTERVAL_MS = parseInt(
	process.env.FORWARDING_INTERVAL_MS ?? "1000",
	10,
);
const SERVER_NAME = process.env.SERVER_NAME ?? "";

/**
 * Forwards messages to each session's callback URL in strict FIFO order.
 *
 * Each session's queue is independent — a blocked session (e.g. waiting for
 * an attachment to finish downloading) does not delay any other session.
 *
 * FIFO guarantee: the next message for a session is only forwarded once the
 * preceding message reaches `downloaded` status.  A `pending` message
 * (attachment still in flight) stops the queue for that session until the
 * DownloadWorkerService marks it `downloaded`.
 */
export class TenantForwardingScheduler {
	private timer: NodeJS.Timeout | null = null;
	private processing = false;

	start(): void {
		if (this.timer) return;

		this.timer = setInterval(() => this.tick(), FORWARDING_INTERVAL_MS);
		console.log(
			`[ForwardingScheduler] Started (interval: ${FORWARDING_INTERVAL_MS}ms)`,
		);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private async tick(): Promise<void> {
		if (this.processing) return;
		this.processing = true;

		try {
			const db = DatabaseClient.getInstance();

			const rows = await db.execute(
				(prisma) =>
					prisma.message.findMany({
						where: {
							status: { not: "forwarded" },
							session: { server_name: SERVER_NAME },
						},
						select: { session_id: true },
						distinct: ["session_id"],
				}) as Promise<{ session_id: bigint }[]>,
		);

		await Promise.all(rows.map((r) => this.processSession(r.session_id)));
		} catch (error) {
			console.error("[ForwardingScheduler] Tick error:", error);
		} finally {
			this.processing = false;
		}
	}

	private async processSession(sessionId: bigint): Promise<void> {
		try {
			const db = DatabaseClient.getInstance();

			const session = await db.execute(
				(prisma) =>
					prisma.telegramSession.findUnique({
						where: { id: sessionId },
						select: { callback_url: true },
					}) as Promise<{ callback_url: string } | null>,
			);

			if (!session?.callback_url) {
				console.warn(
					`[ForwardingScheduler] No callback_url for session ${sessionId}`,
				);
				return;
			}

			const state = await db.execute(
				(prisma) =>
					prisma.tenantMessageState.upsert({
						where: { session_id: sessionId },
						update: {},
						create: {
							session_id: sessionId,
							last_forwarded_id: BigInt(0),
						},
					}) as Promise<{ last_forwarded_id: bigint }>,
			);

			let lastForwardedId = state.last_forwarded_id;
			let nextId: bigint | null;

			do {
				nextId = await this.forwardNext(
					sessionId,
					lastForwardedId,
					session.callback_url,
				);
				if (nextId !== null) {
					lastForwardedId = nextId;
				}
			} while (nextId !== null);
		} catch (error) {
			console.error(
				`[ForwardingScheduler] Error for session ${sessionId}:`,
				error,
			);
		}
	}

	/**
	 * Finds the next message after `lastForwardedId` for the session and
	 * attempts to forward it.
	 *
	 * Returns the forwarded message's `id` (the new cursor) on success,
	 * or `null` when:
	 *  - There are no more messages to forward
	 *  - The next message is still `pending` (download in flight) — blocks the queue
	 *  - The HTTP POST to the callback URL failed — will be retried next tick
	 */
	private async forwardNext(
		sessionId: bigint,
		lastForwardedId: bigint,
		callbackUrl: string,
	): Promise<bigint | null> {
		const db = DatabaseClient.getInstance();

		return db.execute(async (prisma) => {
			const nextMsg = await prisma.message.findFirst({
				where: {
					session_id: sessionId,
					id: { gt: lastForwardedId },
				},
				orderBy: { id: "asc" },
				select: { id: true, raw_payload: true, status: true },
			});

			if (!nextMsg) return null;

			// Already forwarded — advance the cursor and continue
			if (nextMsg.status === "forwarded") {
				await prisma.tenantMessageState.update({
					where: { session_id: sessionId },
					data: { last_forwarded_id: nextMsg.id },
				});
				return nextMsg.id;
			}

			// Attachment still downloading — stop the queue for this session
			if (nextMsg.status !== "downloaded") return null;

			const posted = await this.postToCallbackUrl(
				callbackUrl,
				nextMsg.raw_payload,
			);
			if (!posted) return null;

			await prisma.$transaction([
				prisma.message.update({
					where: { id: nextMsg.id },
					data: { status: "forwarded" },
				}),
				prisma.tenantMessageState.update({
					where: { session_id: sessionId },
					data: { last_forwarded_id: nextMsg.id },
				}),
			]);

			console.log(
				`[ForwardingScheduler] Forwarded message ${nextMsg.id} for session ${sessionId}`,
			);
			return nextMsg.id;
		});
	}

	private async postToCallbackUrl(
		callbackUrl: string,
		rawPayload: string | null,
	): Promise<boolean> {
		if (!rawPayload) {
			console.warn(
				`[ForwardingScheduler] Message has no raw_payload, skipping`,
			);
			return true;
		}

		try {
			const res = await fetch(callbackUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: rawPayload,
			});

			if (!res.ok) {
				throw new Error(`HTTP ${res.status} ${res.statusText}`);
			}

			return true;
		} catch (error) {
			console.error(
				`[ForwardingScheduler] POST to ${callbackUrl} failed, will retry on next tick:`,
				error instanceof Error ? error.message : error,
			);
			return false;
		}
	}
}
