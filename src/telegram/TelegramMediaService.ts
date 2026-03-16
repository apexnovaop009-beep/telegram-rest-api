import * as fs from "fs";
import * as path from "path";
import bigInt from "big-integer";
import { Api, TelegramClient } from "telegram";

export type MediaType = "photo" | "video" | "audio" | "document";

export interface DownloadRequest {
	id: string;
	accessHash: string;
	fileReference: string; // hex-encoded
	type: MediaType;
}

export interface DownloadResult {
	fileName: string;
	date: string; // YYYY-MM-DD
}

export interface FileInfo {
	filePath: string;
	contentType: string;
	ext: string;
	size: number;
}

/** Manages downloaded Telegram media files and the daily cleanup schedule. */
export class TelegramMediaService {
	static readonly MEDIA_DIR = path.resolve(process.cwd(), "storage", "media");

	// ── Static: File Operations ───────────────────────────────────────

	/** Returns the full path of a cached file matching `id`, or null. */
	static findCachedFile(dir: string, id: string): string | null {
		if (!fs.existsSync(dir)) return null;
		const match = fs.readdirSync(dir).find((f) => path.parse(f).name === id);
		return match ? path.join(dir, match) : null;
	}

	/** Validates and resolves a stored media file path, or null if invalid/missing. */
	static resolveFile(date: string, filename: string): string | null {
		if (
			date.includes("..") ||
			filename.includes("..") ||
			filename.includes("/") ||
			filename.includes("\\")
		) {
			return null;
		}

		const filePath = path.join(TelegramMediaService.MEDIA_DIR, date, filename);
		return fs.existsSync(filePath) ? filePath : null;
	}

	/** Returns MIME type, extension, and size for a file on disk. */
	static async getFileInfo(filePath: string): Promise<FileInfo> {
		const { fileTypeFromFile } = await import("file-type");
		const detected = await fileTypeFromFile(filePath);
		const { size } = fs.statSync(filePath);

		return {
			filePath,
			contentType: detected?.mime ?? "application/octet-stream",
			ext: detected?.ext ?? "bin",
			size,
		};
	}

	/** Returns the expiration date based on MEDIA_RETENTION_DAYS. */
	static getExpirationDate(): Date {
		const retentionDays = TelegramMediaService.resolveRetentionDays();
		return new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
	}

	/** Returns today's date directory path under MEDIA_DIR. */
	static getTodayDir(): string {
		const today = new Date().toISOString().split("T")[0];
		return path.join(TelegramMediaService.MEDIA_DIR, today);
	}

	/** Reads MEDIA_RETENTION_DAYS from env (default: 7, minimum: 1). */
	static resolveRetentionDays(): number {
		return Math.max(1, parseInt(process.env.MEDIA_RETENTION_DAYS ?? "7", 10));
	}

	// ── Static: Telegram Download ─────────────────────────────────────

	/** Downloads a Telegram media file to storage/media/<date>/<id>.<ext>. */
	static async downloadFile(
		client: TelegramClient,
		request: DownloadRequest,
	): Promise<DownloadResult> {
		const { id, accessHash, fileReference, type } = request;
		const dateDir = TelegramMediaService.getTodayDir();
		const today = path.basename(dateDir);

		if (!fs.existsSync(dateDir)) {
			fs.mkdirSync(dateDir, { recursive: true });
		}

		const tmpPath = path.join(dateDir, `${id}.tmp`);

		try {
			const fileRefBuffer = Buffer.from(fileReference, "hex");

			// Photos use InputPhotoFileLocation; everything else is a document.
			const inputLocation: Api.TypeInputFileLocation =
				type === "photo"
					? new Api.InputPhotoFileLocation({
							id: bigInt(id),
							accessHash: bigInt(accessHash),
							fileReference: fileRefBuffer,
							thumbSize: "y",
						})
					: new Api.InputDocumentFileLocation({
							id: bigInt(id),
							accessHash: bigInt(accessHash),
							fileReference: fileRefBuffer,
							thumbSize: "",
						});

			const buffer = await client.downloadFile(inputLocation);

			if (!buffer || (buffer as Buffer).length === 0) {
				throw new Error("Telegram returned an empty file");
			}

			fs.writeFileSync(tmpPath, buffer as Buffer);
		} catch (error) {
			if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
			throw error;
		}

		const { ext } = await TelegramMediaService.getFileInfo(tmpPath);
		const fileName = `${id}.${ext}`;

		fs.renameSync(tmpPath, path.join(dateDir, fileName));

		return { fileName, date: today };
	}

	// ── Instance: Cleanup Scheduler ───────────────────────────────────

	private timer: ReturnType<typeof setTimeout> | null = null;

	/** Starts the daily cleanup scheduler. Safe to call multiple times. */
	start(): void {
		if (this.timer !== null) return;

		const targetHour = this.resolveTargetHour();
		const timezone = process.env.APP_TIMEZONE ?? "UTC";
		const retentionDays = TelegramMediaService.resolveRetentionDays();

		this.mediaCleanup().catch((error) => {
			console.error("[MediaService] Startup cleanup error:", error);
		});

		this.scheduleNextRun(targetHour, timezone);

		console.log(
			`[MediaService] Started — daily cleanup at ${String(targetHour).padStart(2, "0")}:00 ${timezone}, retention: ${retentionDays}d`,
		);
	}

	/** Stops the cleanup scheduler. */
	stop(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
			console.log("[MediaService] Stopped");
		}
	}

	/** Deletes date directories older than MEDIA_RETENTION_DAYS. */
	async mediaCleanup(): Promise<void> {
		const retentionDays = TelegramMediaService.resolveRetentionDays();

		if (!fs.existsSync(TelegramMediaService.MEDIA_DIR)) {
			return;
		}

		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - retentionDays);
		const cutoffDateStr = cutoff.toISOString().split("T")[0];

		const entries = fs.readdirSync(TelegramMediaService.MEDIA_DIR, {
			withFileTypes: true,
		});

		let deleted = 0;

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;

			if (entry.name < cutoffDateStr) {
				const dirPath = path.join(TelegramMediaService.MEDIA_DIR, entry.name);
				fs.rmSync(dirPath, { recursive: true, force: true });
				deleted++;
				console.log(
					`[MediaService] Deleted expired media directory: ${entry.name}`,
				);
			}
		}

		if (deleted > 0) {
			console.log(
				`[MediaService] Cleanup complete — ${deleted} director(ies) removed`,
			);
		}
	}

	// ── Private ────────────────────────────────────────────────────────────

	/** Schedules the next cleanup run, self-rescheduling after each execution. */
	private scheduleNextRun(targetHour: number, timezone: string): void {
		const msUntilNext = this.msUntilNextHour(targetHour, timezone);
		const nextRunAt = new Date(Date.now() + msUntilNext);

		this.timer = setTimeout(() => {
			this.timer = null;

			this.mediaCleanup().catch((error) => {
				console.error("[MediaService] Cleanup error:", error);
			});

			this.scheduleNextRun(targetHour, timezone);
		}, msUntilNext);

		console.log(
			`[MediaService] Next media cleanup scheduled at ${nextRunAt.toLocaleString(
				"en-US",
				{
					timeZone: timezone,
					hour12: false,
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit",
				},
			)} (${timezone})`,
		);
	}

	/** Returns ms until the next occurrence of targetHour:00 in the given timezone. */
	private msUntilNextHour(targetHour: number, timezone: string): number {
		const now = new Date();

		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		}).formatToParts(now);

		const get = (type: string): number =>
			parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);

		const secondsIntoDay = get("hour") * 3600 + get("minute") * 60 + get("second");
		let secondsUntil = targetHour * 3600 - secondsIntoDay;

		if (secondsUntil <= 0) secondsUntil += 24 * 3600;

		return secondsUntil * 1000;
	}

	/** Reads MEDIA_CLEANUP_HOUR from env (default: 2, range: 0–23). */
	private resolveTargetHour(): number {
		const raw = parseInt(process.env.MEDIA_CLEANUP_HOUR ?? "2", 10);
		return isNaN(raw) || raw < 0 || raw > 23 ? 2 : raw;
	}
}
