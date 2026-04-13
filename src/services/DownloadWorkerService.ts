import { Api } from "telegram";
import * as fs from "fs";
import * as path from "path";
import bigInt from "big-integer";
import { Prisma, PrismaClient } from "@prisma/client";
import { DatabaseClient } from "../database/DatabaseClient";
import { TelegramClientService } from "../telegram/TelegramClientService";
import { SessionStatus } from "../database/constants/SessionStatus";
import {
	RawInput,
	RawInputPhoto,
	RawInputDocument,
	RawInputChatPhoto,
	DownloadTaskRow,
} from "./interface/DownloadTask";

/**
 * Thrown for failures where retrying will never succeed (e.g. deleted message,
 * lost peer access). Bypasses the normal retry counter and goes straight to
 * a permanent "failed" status.
 */
class PermanentDownloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PermanentDownloadError";
	}
}

const MAX_CONCURRENT = parseInt(
	process.env.MAX_CONCURRENT_DOWNLOADS ?? "5",
	10,
);
const MAX_RETRIES = parseInt(process.env.MAX_DOWNLOAD_RETRIES ?? "3", 10);
const DOWNLOAD_TIMEOUT_S = parseInt(
	process.env.DOWNLOAD_TIMEOUT_SECONDS ?? "600",
	10,
);
const SERVER_NAME = process.env.SERVER_NAME ?? "";
const STORAGE_BASE_URL = process.env.STORAGE_BASE_URL ?? "";
const WORKER_ID = `${SERVER_NAME}:${process.pid}`;
const POLL_INTERVAL_MS = 500;
const STALE_CHECK_INTERVAL_MS = 60_000;
const FILES_DIR = path.resolve(process.cwd(), "storage", "files");

export class DownloadWorkerService {
	private active = 0;
	private running = false;

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;

		if (!fs.existsSync(FILES_DIR)) {
			fs.mkdirSync(FILES_DIR, { recursive: true });
		}

		// Reset any tasks left in 'processing' by a previous run of this server.
		// Scoped to SERVER_NAME so tasks owned by other servers are untouched.
		await this.resetOrphanedTasks();

		this.pollLoop();
		setInterval(() => this.resetStaleTasks(), STALE_CHECK_INTERVAL_MS);
		console.log(`[DownloadWorker] Started (max concurrent: ${MAX_CONCURRENT})`);
	}

	stop(): void {
		this.running = false;
	}

	private async pollLoop(): Promise<void> {
		while (this.running) {
			try {
				if (this.active < MAX_CONCURRENT) {
					const task = await this.claimNextTask();
					if (task) {
						this.active++;
						this.processTask(task).finally(() => {
							this.active--;
						});
					}
				}
			} catch (error) {
				console.error("[DownloadWorker] Poll error:", error);
			}
			await this.sleep(POLL_INTERVAL_MS);
		}
	}

	private async claimNextTask(): Promise<DownloadTaskRow | null> {
		const db = DatabaseClient.getInstance();
		const rows = await db.execute<DownloadTaskRow[]>(
			(prisma) =>
				prisma.$queryRaw`
				UPDATE download_tasks
				SET status = 'processing',
				    started_at = NOW(),
				    worker_id = ${WORKER_ID}
				WHERE id = (
					SELECT id FROM download_tasks
					WHERE status = 'pending'
					AND (
						server_name = ${SERVER_NAME}
						OR (
							server_name IS NULL
							AND from_accounts && COALESCE(
								(
									SELECT ARRAY_AGG(ts.id)::BIGINT[]
									FROM telegram_sessions ts
									WHERE ts.server_name = ${SERVER_NAME}
									AND ts.status = ${SessionStatus.ACTIVE}
								),
								ARRAY[]::INTEGER[]
							)
						)
					)
					ORDER BY created_at ASC
					LIMIT 1
					FOR UPDATE SKIP LOCKED
				)
				RETURNING id, file_unique_id, raw_input_json, from_accounts,
				          file_type, owner_session_id
			`,
		);
		return rows.length > 0 ? rows[0] : null;
	}

	private async processTask(task: DownloadTaskRow): Promise<void> {
		try {
			if (!task.raw_input_json) {
				throw new Error(`No raw_input_json for task ${task.id}`);
			}

			const rawInput: RawInput = JSON.parse(task.raw_input_json);
			const client = await this.pickClient(
				task.owner_session_id,
				task.from_accounts,
			);
			if (!client) {
				throw new Error(`No available Telegram client for task ${task.id}`);
			}

			const buffer = await this.downloadFile(client, rawInput);
			if (!buffer || buffer.length === 0) {
				throw new Error(`Empty download result for task ${task.id}`);
			}

			// Skip if the task was reclaimed by another worker
			if (!(await this.stillOwnsTask(task.id))) {
				return;
			}

			const ext = this.inferExtension(rawInput);
			const fileName = `${task.file_unique_id}.${ext}`;
			const filePath = path.join(FILES_DIR, fileName);
			fs.writeFileSync(filePath, buffer);

			const relativePath = `storage/files/${fileName}`;
			const fileUrl = STORAGE_BASE_URL
				? `${STORAGE_BASE_URL.replace(/\/+$/, "")}/${relativePath}`
				: relativePath;

			await this.markCompleted(task, filePath, fileUrl);

			console.log(`[DownloadWorker] Completed task ${task.id} → ${fileName}`);
		} catch (error) {
			const isPermanent = error instanceof PermanentDownloadError;
			console.error(
				`[DownloadWorker] Failed task ${task.id}${isPermanent ? " (permanent)" : ""}:`,
				error instanceof Error ? error.message : error,
			);
			await this.markFailed(task, isPermanent);
		}
	}

	/**
	 * Verifies this worker still holds the lease on a task. Returns false
	 * if another server's stale-reset reclaimed the task while the
	 * download was in flight.
	 */
	private async stillOwnsTask(taskId: bigint): Promise<boolean> {
		const db = DatabaseClient.getInstance();
		const task = await db.execute(
			(prisma) =>
				prisma.downloadTask.findUnique({
					where: { id: taskId },
					select: { worker_id: true, status: true },
				}) as Promise<{
					worker_id: string | null;
					status: string;
				} | null>,
		);
		return (
			task !== null &&
			task.status === "processing" &&
			task.worker_id === WORKER_ID
		);
	}

	private async pickClient(
		ownerSessionId: bigint | null,
		fromAccounts: bigint[],
	): Promise<TelegramClientService | undefined> {
		const db = DatabaseClient.getInstance();

		// raw_input_json contains account-specific data (fileReference, accessHash,
		// messageId) — only the owning account can use it. Fall back to the full
		// list only for legacy tasks created before owner_session_id was stored.
		const accountIds = ownerSessionId ? [ownerSessionId] : fromAccounts;

		const sessions = await db.execute(
			(prisma) =>
				prisma.telegramSession.findMany({
					where: {
						id: { in: accountIds },
						status: SessionStatus.ACTIVE,
					},
					select: { session_id: true },
				}) as Promise<{ session_id: string }[]>,
		);

		for (const { session_id } of sessions) {
			const svc = TelegramClientService.getFromPool(session_id);
			if (svc) return svc;
		}
		return undefined;
	}

	private async downloadFile(
		clientService: TelegramClientService,
		rawInput: RawInput,
	): Promise<Buffer> {
		try {
			return await this.attemptDownload(clientService, rawInput);
		} catch (err) {
			if (
				this.isFileReferenceExpired(err) &&
				rawInput.type !== "chat_photo"
			) {
				console.log(
					`[DownloadWorker] File reference expired — re-fetching message ${rawInput.messageId}`,
				);
				const refreshed = await this.refreshFileReference(
					clientService,
					rawInput,
				);
				return await this.attemptDownload(clientService, refreshed);
			}
			throw err;
		}
	}

	private async attemptDownload(
		clientService: TelegramClientService,
		rawInput: RawInput,
	): Promise<Buffer> {
		const client = clientService.getClient();

		if (rawInput.type === "chat_photo") {
			const location = new Api.InputPeerPhotoFileLocation({
				peer: await this.resolveInputPeer(clientService, rawInput),
				photoId: bigInt(rawInput.photoId),
				big: true,
			});
			const result = await client.downloadFile(location, {
				dcId: rawInput.dcId,
			});
			return this.toBuffer(result);
		}

		if (rawInput.type === "photo") {
			const location = new Api.InputPhotoFileLocation({
				id: bigInt(rawInput.id),
				accessHash: bigInt(rawInput.accessHash),
				fileReference: Buffer.from(rawInput.fileReference, "base64"),
				thumbSize: rawInput.thumbSize || "x",
			});
			const result = await client.downloadFile(location, {
				dcId: rawInput.dcId,
			});
			return this.toBuffer(result);
		}

		const location = new Api.InputDocumentFileLocation({
			id: bigInt(rawInput.id),
			accessHash: bigInt(rawInput.accessHash),
			fileReference: Buffer.from(rawInput.fileReference, "base64"),
			thumbSize: rawInput.thumbSize || "",
		});
		const result = await client.downloadFile(location, {
			dcId: rawInput.dcId,
		});
		return this.toBuffer(result);
	}

	private isFileReferenceExpired(err: unknown): boolean {
		return (
			err instanceof Error &&
			err.message.includes("FILE_REFERENCE_EXPIRED")
		);
	}

	private async refreshFileReference(
		clientService: TelegramClientService,
		rawInput: RawInputPhoto | RawInputDocument,
	): Promise<RawInputPhoto | RawInputDocument> {
		const client = clientService.getClient();

		let peer: Api.TypeInputPeer;
		if (rawInput.peerType === "chat") {
			peer = new Api.InputPeerChat({ chatId: bigInt(rawInput.peerId) });
		} else {
			const apiPeer =
				rawInput.peerType === "channel"
					? new Api.PeerChannel({ channelId: bigInt(rawInput.peerId) })
					: new Api.PeerUser({ userId: bigInt(rawInput.peerId) });
			peer = (await client.getInputEntity(apiPeer)) as Api.TypeInputPeer;
		}

		const messages = await client.getMessages(peer, {
			ids: [rawInput.messageId],
		});
		const msg = messages[0];
		if (!msg || !(msg instanceof Api.Message)) {
			throw new PermanentDownloadError(
				`Message ${rawInput.messageId} not found while refreshing file reference — likely deleted`,
			);
		}

		if (
			rawInput.type === "photo" &&
			msg.media instanceof Api.MessageMediaPhoto &&
			msg.media.photo instanceof Api.Photo
		) {
			return {
				...rawInput,
				fileReference: Buffer.from(
					msg.media.photo.fileReference,
				).toString("base64"),
			};
		}

		if (
			rawInput.type === "document" &&
			msg.media instanceof Api.MessageMediaDocument &&
			msg.media.document instanceof Api.Document
		) {
			return {
				...rawInput,
				fileReference: Buffer.from(
					msg.media.document.fileReference,
				).toString("base64"),
			};
		}

		throw new PermanentDownloadError(
			`Could not extract fresh file reference from message ${rawInput.messageId} — media type mismatch or media removed`,
		);
	}

	/**
	 * Resolves an InputPeer for a chat photo download.
	 * Regular groups (chat) need only the chatId.
	 * Channels/supergroups need the accessHash, resolved from the client's
	 * entity cache (always present since we received a message from the peer).
	 */
	private async resolveInputPeer(
		clientService: TelegramClientService,
		rawInput: RawInputChatPhoto,
	): Promise<Api.TypeInputPeer> {
		if (rawInput.peerType === "chat") {
			return new Api.InputPeerChat({ chatId: bigInt(rawInput.peerId) });
		}

		const client = clientService.getClient();
		const peer =
			rawInput.peerType === "channel"
				? new Api.PeerChannel({ channelId: bigInt(rawInput.peerId) })
				: new Api.PeerUser({ userId: bigInt(rawInput.peerId) });

		return (await client.getInputEntity(peer)) as Api.TypeInputPeer;
	}

	private async markCompleted(
		task: { id: bigint; file_unique_id: string },
		filePath: string,
		fileUrl: string,
	): Promise<void> {
		const db = DatabaseClient.getInstance();
		await db.execute(async (prisma) => {
			return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
				await tx.downloadTask.update({
					where: { id: task.id },
					data: {
						status: "completed",
						file_path: filePath,
						file_url: fileUrl,
					},
				});

				const attachments: Array<{ id: bigint; message_id: bigint }> =
					await tx.attachment.findMany({
						where: { file_unique_id: task.file_unique_id },
						select: { id: true, message_id: true },
					});

				if (attachments.length === 0) return;

				await tx.attachment.updateMany({
					where: { file_unique_id: task.file_unique_id },
					data: { file_url: fileUrl },
				});

				const messageIds = [...new Set(attachments.map((a) => a.message_id))];

				for (const msgId of messageIds) {
					const allAttachments = await tx.attachment.findMany({
						where: { message_id: msgId },
						select: {
							file_unique_id: true,
							file_type: true,
							file_url: true,
						},
					});

					const pendingCount = allAttachments.filter(
						(a) => a.file_url === null,
					).length;

					// Patch the raw_payload attachments array with the latest URLs
					const msgRow = await tx.message.findUnique({
						where: { id: msgId },
						select: { raw_payload: true },
					});

				let updatedPayload: string | null = msgRow?.raw_payload ?? null;
				if (msgRow?.raw_payload) {
					try {
						const parsed = JSON.parse(msgRow.raw_payload);

						const chatPhoto = allAttachments.find(
							(a) => a.file_type === "chat_photo",
						);
						const regular = allAttachments.filter(
							(a) => a.file_type !== "chat_photo",
						);

					if (chatPhoto?.file_url) {
						parsed.image_link = chatPhoto.file_url;
					}
					if (regular.length > 0) {
						parsed.attachments = regular.map((a) => ({
							file_unique_id: a.file_unique_id,
							file_type: a.file_type,
							url: a.file_url,
						}));
					}

					if (pendingCount === 0) {
						parsed.download_failed = false;
					}

					updatedPayload = JSON.stringify(parsed);
					} catch {
						// Leave raw_payload unchanged if parsing fails
					}
				}

					await tx.message.update({
						where: { id: msgId },
						data: {
							...(pendingCount === 0 ? { status: "downloaded" } : {}),
							raw_payload: updatedPayload,
						},
					});
				}
			});
		});
	}

	private async markFailed(
		task: DownloadTaskRow,
		permanent = false,
	): Promise<void> {
		const db = DatabaseClient.getInstance();
		await db.execute(async (prisma) => {
			const current = await prisma.downloadTask.findUnique({
				where: { id: task.id },
				select: { retry_count: true },
			});

			const retryCount = (current?.retry_count ?? 0) + 1;
			const isPermanentFail = permanent || retryCount >= MAX_RETRIES;
			const newStatus = isPermanentFail ? "failed" : "pending";

			await prisma.downloadTask.update({
				where: { id: task.id },
				data: {
					status: newStatus,
					retry_count: retryCount,
					started_at: null,
					worker_id: null,
				},
			});

			if (isPermanentFail) {
				await this.resolveBlockedMessages(prisma, task.file_unique_id);
			}
		});
	}

	/**
	 * When a download is permanently failed, find every message that was
	 * waiting on that file. If all of the message's other attachments are
	 * also resolved (completed or failed), there is nothing left to wait for
	 * — mark the message `downloaded` with `download_failed: true` in its
	 * payload so the forwarding scheduler unblocks and the callback
	 * receives the event with the failure flag set.
	 */
	private async resolveBlockedMessages(
		prisma: PrismaClient,
		fileUniqueId: string,
	): Promise<void> {
		const affected = await prisma.attachment.findMany({
			where: { file_unique_id: fileUniqueId },
			select: { message_id: true },
		});

		const messageIds = [...new Set(affected.map((a) => a.message_id))];
		if (messageIds.length === 0) return;

		for (const msgId of messageIds) {
			const msg = await prisma.message.findUnique({
				where: { id: msgId },
				select: { status: true, raw_payload: true },
			});

			if (!msg || msg.status !== "pending") continue;

			const siblings = await prisma.attachment.findMany({
				where: { message_id: msgId },
				select: { file_unique_id: true },
			});

			const siblingTasks = await prisma.downloadTask.findMany({
				where: {
					file_unique_id: { in: siblings.map((s) => s.file_unique_id) },
				},
				select: { status: true },
			});

			const allResolved = siblingTasks.every(
				(t) => t.status === "completed" || t.status === "failed",
			);

			if (!allResolved) continue;

			let updatedPayload: string | null = msg.raw_payload ?? null;
			if (msg.raw_payload) {
				try {
					const parsed = JSON.parse(msg.raw_payload);
					parsed.download_failed = true;
					updatedPayload = JSON.stringify(parsed);
				} catch {
					// Leave raw_payload unchanged if parsing fails
				}
			}

			await prisma.message.update({
				where: { id: msgId },
				data: { status: "downloaded", raw_payload: updatedPayload },
			});

			console.warn(
				`[DownloadWorker] Message ${msgId} finalised with download_failed=true — ${fileUniqueId} exhausted all retries`,
			);
		}
	}

	/**
	 * On startup, resets all tasks left in 'processing' by any previous
	 * process on this server (any PID).  Safe to scope by SERVER_NAME prefix
	 * because other servers use a different SERVER_NAME.
	 */
	private async resetOrphanedTasks(): Promise<void> {
		const db = DatabaseClient.getInstance();
		const { count } = await db.execute((prisma) =>
			prisma.downloadTask.updateMany({
				where: {
					status: "processing",
					worker_id: { startsWith: `${SERVER_NAME}:` },
				},
				data: {
					status: "pending",
					started_at: null,
					worker_id: null,
				},
			}),
		);
		if (count > 0) {
			console.log(
				`[DownloadWorker] Reset ${count} orphaned task(s) from previous run`,
			);
		}
	}

	/**
	 * Resets stale tasks that were claimed by THIS server but exceeded the
	 * download timeout. Scoped by worker_id prefix so that one server
	 * cannot accidentally re-queue a task still being processed by another.
	 */
	private async resetStaleTasks(): Promise<void> {
		const db = DatabaseClient.getInstance();
		const cutoff = new Date(Date.now() - DOWNLOAD_TIMEOUT_S * 1000);

		await db.execute((prisma) =>
			prisma.downloadTask.updateMany({
				where: {
					status: "processing",
					started_at: { lt: cutoff },
					worker_id: { startsWith: `${SERVER_NAME}:` },
				},
				data: {
					status: "pending",
					started_at: null,
					worker_id: null,
				},
			}),
		);
	}

	private inferExtension(rawInput: RawInput): string {
		if (rawInput.type === "photo" || rawInput.type === "chat_photo") return "jpg";
		const mime = rawInput.mimeType ?? "";
		if (rawInput.fileName) {
			const parts = rawInput.fileName.split(".");
			if (parts.length > 1) return parts[parts.length - 1];
		}
		const mimeMap: Record<string, string> = {
			"video/mp4": "mp4",
			"video/webm": "webm",
			"audio/ogg": "ogg",
			"audio/mpeg": "mp3",
			"application/pdf": "pdf",
			"image/png": "png",
			"image/jpeg": "jpg",
			"image/webp": "webp",
		};
		return mimeMap[mime] ?? "bin";
	}

	private toBuffer(result: string | Buffer | undefined): Buffer {
		if (Buffer.isBuffer(result)) return result;
		if (typeof result === "string") return Buffer.from(result, "binary");
		if (result === undefined) return Buffer.alloc(0);
		return Buffer.from(result as unknown as ArrayBuffer);
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
