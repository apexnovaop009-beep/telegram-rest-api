import { TelegramClient } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { Api } from "telegram";
import * as fs from "fs";
import * as path from "path";

interface MediaInfo {
	type: string;
	id?: string;
	accessHash?: string;
	fileReference?: string;
	fileSize?: number;
	mimeType?: string;
	fileName?: string;
	duration?: number;
	width?: number;
	height?: number;
}

interface AlbumItem {
	messageId: number;
	date: number;
	media?: MediaInfo;
	text: string;
	replyToMessageId?: number;
	forwardFromId?: string;
}

interface AlbumBuffer {
	chatId: string;
	senderId: string;
	isPrivate: boolean;
	isGroup: boolean;
	isChannel: boolean;
	items: AlbumItem[];
	timer: ReturnType<typeof setTimeout>;
}

interface MessageLogEntry {
	timestamp: string;
	messageId: number;
	groupedId?: string;
	chatId: string;
	senderId: string;
	isPrivate: boolean;
	isGroup: boolean;
	isChannel: boolean;
	text: string;
	date: number;
	replyToMessageId?: number;
	forwardFromId?: string;
	media?: MediaInfo;
	album?: MediaInfo[];
}

/**
 * Listens for incoming Telegram messages and appends each event as a JSON
 * line to storage/<telegramUserId>.log.
 *
 * No media is downloaded here. The log entry includes full MediaInfo
 * (id, accessHash, fileReference, mimeType, etc.) so callers can trigger
 * an on-demand download later via the /media/download route.
 *
 * Albums (multiple photos sent together) are buffered until all siblings
 * arrive, then written as a single entry with an `album: MediaInfo[]` array.
 */
export class IncomingMessageHandler {
	private static readonly STORAGE_DIR = path.resolve(process.cwd(), "storage");
	private static readonly GROUP_FLUSH_DELAY_MS = 500;
	private static readonly INIT_DELAY_MS = 5000;

	private readonly client: TelegramClient;
	private readonly telegramUserId: string;
	private handler: ((event: NewMessageEvent) => Promise<void>) | null = null;
	private readonly pendingAlbums = new Map<string, AlbumBuffer>();

	constructor(client: TelegramClient, telegramUserId: string) {
		this.client = client;
		this.telegramUserId = telegramUserId;
		if (!fs.existsSync(IncomingMessageHandler.STORAGE_DIR)) {
			fs.mkdirSync(IncomingMessageHandler.STORAGE_DIR, { recursive: true });
		}
	}

	// ── Parsing ─────────────────────────────────────────────────────────

	private static extractMedia(
		media: Api.TypeMessageMedia | null | undefined,
	): MediaInfo | undefined {
		if (!media) return undefined;

		if (
			media instanceof Api.MessageMediaPhoto &&
			media.photo instanceof Api.Photo
		) {
			return {
				type: "photo",
				id: media.photo.id.toString(),
				accessHash: media.photo.accessHash.toString(),
				fileReference: Buffer.from(media.photo.fileReference).toString("hex"),
				fileSize: media.photo.sizes?.length ?? 0,
			};
		}

		if (
			media instanceof Api.MessageMediaDocument &&
			media.document instanceof Api.Document
		) {
			const doc = media.document;
			const fileName = (
				doc.attributes?.find(
					(a) => a instanceof Api.DocumentAttributeFilename,
				) as Api.DocumentAttributeFilename | undefined
			)?.fileName;
			const video = doc.attributes?.find(
				(a) => a instanceof Api.DocumentAttributeVideo,
			) as Api.DocumentAttributeVideo | undefined;
			const audio = doc.attributes?.find(
				(a) => a instanceof Api.DocumentAttributeAudio,
			) as Api.DocumentAttributeAudio | undefined;

			return {
				type: video ? "video" : audio ? "audio" : "document",
				id: doc.id.toString(),
				accessHash: doc.accessHash.toString(),
				fileReference: Buffer.from(doc.fileReference).toString("hex"),
				fileSize: Number(doc.size),
				mimeType: doc.mimeType,
				fileName,
				duration: video?.duration ?? audio?.duration,
				width: video?.w,
				height: video?.h,
			};
		}

		if (
			media instanceof Api.MessageMediaGeo &&
			media.geo instanceof Api.GeoPoint
		) {
			return { type: "geo" };
		}

		if (media instanceof Api.MessageMediaContact) {
			return { type: "contact" };
		}

		return { type: media.className ?? "unknown" };
	}

	// ── Message Routing ─────────────────────────────────────────────────

	private handleSingleMessage(
		event: NewMessageEvent,
		chatId: string,
		media: MediaInfo | undefined,
	): void {
		const msg = event.message;
		this.writeLogEntry({
			timestamp: new Date().toISOString(),
			messageId: msg.id,
			chatId,
			senderId: msg.senderId?.toString() ?? "",
			isPrivate: event.isPrivate ?? false,
			isGroup: event.isGroup ?? false,
			isChannel: event.isChannel ?? false,
			text: msg.text ?? "",
			date: msg.date,
			replyToMessageId: msg.replyTo?.replyToMsgId,
			forwardFromId: msg.fwdFrom?.fromId?.toString(),
			media,
		});
	}

	private handleAlbumMessage(
		event: NewMessageEvent,
		chatId: string,
		groupedId: string,
		media: MediaInfo | undefined,
	): void {
		const msg = event.message;
		const item: AlbumItem = {
			messageId: msg.id,
			date: msg.date,
			media,
			text: msg.text ?? "",
			replyToMessageId: msg.replyTo?.replyToMsgId,
			forwardFromId: msg.fwdFrom?.fromId?.toString(),
		};

		const existing = this.pendingAlbums.get(groupedId);
		if (existing) {
			clearTimeout(existing.timer);
			existing.items.push(item);
			existing.timer = setTimeout(
				() => this.flushAlbum(groupedId),
				IncomingMessageHandler.GROUP_FLUSH_DELAY_MS,
			);
		} else {
			this.pendingAlbums.set(groupedId, {
				chatId,
				senderId: msg.senderId?.toString() ?? "",
				isPrivate: event.isPrivate ?? false,
				isGroup: event.isGroup ?? false,
				isChannel: event.isChannel ?? false,
				items: [item],
				timer: setTimeout(
					() => this.flushAlbum(groupedId),
					IncomingMessageHandler.GROUP_FLUSH_DELAY_MS,
				),
			});
		}
	}

	private flushAlbum(groupedId: string): void {
		const buffer = this.pendingAlbums.get(groupedId);
		if (!buffer) return;
		this.pendingAlbums.delete(groupedId);

		const sorted = [...buffer.items].sort((a, b) => a.messageId - b.messageId);
		const caption = sorted.find((i) => i.text !== "") ?? sorted[0];

		this.writeLogEntry({
			timestamp: new Date().toISOString(),
			messageId: sorted[0].messageId,
			groupedId,
			chatId: buffer.chatId,
			senderId: buffer.senderId,
			isPrivate: buffer.isPrivate,
			isGroup: buffer.isGroup,
			isChannel: buffer.isChannel,
			text: caption?.text ?? "",
			date: sorted[0].date,
			replyToMessageId: caption?.replyToMessageId,
			forwardFromId: caption?.forwardFromId,
			album: sorted.map((i) => i.media).filter(Boolean) as MediaInfo[],
		});
	}

	// ── Log ──────────────────────────────────────────────────────────────

	private writeLogEntry(entry: MessageLogEntry): void {
		const logPath = path.join(
			IncomingMessageHandler.STORAGE_DIR,
			`${this.telegramUserId}.log`,
		);
		fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
	}

	// ── Lifecycle ────────────────────────────────────────────────────────

	async start(): Promise<void> {
		this.handler = async (event: NewMessageEvent) => {
			try {
				const message = event.message;
				const chatId = message.chatId?.toString() ?? "";
				const media = IncomingMessageHandler.extractMedia(message.media);
				const groupedId = message.groupedId?.toString();

				if (groupedId) {
					this.handleAlbumMessage(event, chatId, groupedId, media);
				} else {
					this.handleSingleMessage(event, chatId, media);
				}
			} catch (error) {
				console.error(
					`[MessageHandler] Error for user ${this.telegramUserId}:`,
					error,
				);
			}
		};

		this.client.addEventHandler(
			this.handler,
			new NewMessage({ incoming: true }),
		);

		await this.delay(IncomingMessageHandler.INIT_DELAY_MS);

		try {
			await this.client.getDialogs({ limit: 100 });
		} catch {
			// Non-fatal — events still work if the session already has update state
		}

		console.log(`[MessageHandler] Started for user ${this.telegramUserId}`);
	}

	stop(): void {
		if (this.handler) {
			this.client.removeEventHandler(
				this.handler,
				new NewMessage({ incoming: true }),
			);
			this.handler = null;
		}

		for (const [groupedId, buffer] of [...this.pendingAlbums]) {
			clearTimeout(buffer.timer);
			this.flushAlbum(groupedId);
		}
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
