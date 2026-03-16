import { TelegramClient } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { Api } from "telegram";
import * as fs from "fs";
import * as path from "path";

interface MediaInfo {
	type: string;
	id?: string;
	accessHash?: string;
	fileSize?: number;
	mimeType?: string;
	fileName?: string;
	duration?: number;
	width?: number;
	height?: number;
}

interface MessageLogEntry {
	timestamp: string;
	messageId: number;
	chatId: string;
	senderId: string;
	senderUsername?: string;
	isPrivate: boolean;
	isGroup: boolean;
	isChannel: boolean;
	text: string;
	date: number;
	replyToMessageId?: number;
	forwardFromId?: string;
	media?: MediaInfo;
	mediaPath?: string;
}

/**
 * Attaches an incoming-message event listener to a TelegramClient.
 * Messages are NOT marked as read. Each message is appended as a JSON line
 * to storage/<telegramUserId>.log.
 */
export class IncomingMessageHandler {
	private static readonly STORAGE_DIR = path.resolve(
		process.cwd(),
		"storage",
	);

	private readonly client: TelegramClient;
	private readonly telegramUserId: string;
	private handler: ((event: NewMessageEvent) => Promise<void>) | null = null;

	constructor(client: TelegramClient, telegramUserId: string) {
		this.client = client;
		this.telegramUserId = telegramUserId;
		IncomingMessageHandler.ensureStorageDir();
	}

	private static ensureStorageDir(): void {
		if (!fs.existsSync(IncomingMessageHandler.STORAGE_DIR)) {
			fs.mkdirSync(IncomingMessageHandler.STORAGE_DIR, { recursive: true });
		}
	}

	private static extractMedia(
		media: Api.TypeMessageMedia | null | undefined,
	): MediaInfo | undefined {
		if (!media) return undefined;

		if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
			return {
				type: "photo",
				id: media.photo.id.toString(),
				accessHash: media.photo.accessHash.toString(),
				fileSize: media.photo.sizes?.length ?? 0,
			};
		}

		if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
			const doc = media.document;
			const fileNameAttr = doc.attributes?.find(
				(a) => a instanceof Api.DocumentAttributeFilename,
			) as Api.DocumentAttributeFilename | undefined;
			const videoAttr = doc.attributes?.find(
				(a) => a instanceof Api.DocumentAttributeVideo,
			) as Api.DocumentAttributeVideo | undefined;
			const audioAttr = doc.attributes?.find(
				(a) => a instanceof Api.DocumentAttributeAudio,
			) as Api.DocumentAttributeAudio | undefined;

			return {
				type: videoAttr ? "video" : audioAttr ? "audio" : "document",
				id: doc.id.toString(),
				accessHash: doc.accessHash.toString(),
				fileSize: Number(doc.size),
				mimeType: doc.mimeType,
				fileName: fileNameAttr?.fileName,
				duration: videoAttr?.duration ?? audioAttr?.duration,
				width: videoAttr?.w,
				height: videoAttr?.h,
			};
		}

		if (media instanceof Api.MessageMediaGeo && media.geo instanceof Api.GeoPoint) {
			return {
				type: "geo",
			};
		}

		if (media instanceof Api.MessageMediaContact) {
			return {
				type: "contact",
			};
		}

		return { type: media.className ?? "unknown" };
	}

	private static readonly INIT_DELAY_MS = 5000;

	private static readonly DOWNLOADABLE_TYPES = new Set([
		"photo",
		"video",
		"audio",
		"document",
	]);

	private static ensureChatDir(chatId: string): string {
		const chatDir = path.join(IncomingMessageHandler.STORAGE_DIR, chatId);
		if (!fs.existsSync(chatDir)) {
			fs.mkdirSync(chatDir, { recursive: true });
		}
		return chatDir;
	}

	private static resolveMediaFileName(
		mediaInfo: MediaInfo,
		messageId: number,
	): string {
		if (mediaInfo.type === "photo") {
			return `${messageId}_${mediaInfo.id}.jpg`;
		}

		if (mediaInfo.fileName) {
			return `${messageId}_${mediaInfo.fileName}`;
		}

		const ext = mediaInfo.mimeType
			? `.${mediaInfo.mimeType.split("/")[1] ?? "bin"}`
			: ".bin";
		return `${messageId}_${mediaInfo.id}${ext}`;
	}

	private async downloadMediaFile(
		message: Api.Message,
		chatId: string,
		mediaInfo: MediaInfo,
	): Promise<string | undefined> {
		try {
			const chatDir = IncomingMessageHandler.ensureChatDir(chatId);
			const fileName = IncomingMessageHandler.resolveMediaFileName(
				mediaInfo,
				message.id,
			);
			const filePath = path.join(chatDir, fileName);

			await this.client.downloadMedia(message, { outputFile: filePath });
			return filePath;
		} catch (error) {
			console.error(
				`Failed to download media for message ${message.id} in chat ${chatId}:`,
				error,
			);
			return undefined;
		}
	}

	async start(): Promise<void> {
		this.handler = async (event: NewMessageEvent) => {
			try {
				const message = event.message;
				const chatId = message.chatId?.toString() ?? "";
				const mediaInfo = IncomingMessageHandler.extractMedia(message.media);

				const entry: MessageLogEntry = {
					timestamp: new Date().toISOString(),
					messageId: message.id,
					chatId,
					senderId: message.senderId?.toString() ?? "",
					isPrivate: event.isPrivate ?? false,
					isGroup: event.isGroup ?? false,
					isChannel: event.isChannel ?? false,
					text: message.text ?? "",
					date: message.date,
					replyToMessageId: message.replyTo?.replyToMsgId,
					forwardFromId: message.fwdFrom?.fromId?.toString(),
					media: mediaInfo,
				};

				if (
					mediaInfo &&
					chatId &&
					IncomingMessageHandler.DOWNLOADABLE_TYPES.has(mediaInfo.type)
				) {
					entry.mediaPath = await this.downloadMediaFile(
						message,
						chatId,
						mediaInfo,
					);
				}

				const logPath = path.join(
					IncomingMessageHandler.STORAGE_DIR,
					`${this.telegramUserId}.log`,
				);
				fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
			} catch (error) {
				console.error(
					`Message handler error for user ${this.telegramUserId}:`,
					error,
				);
			}
		};

		this.client.addEventHandler(this.handler, new NewMessage({ incoming: true }));

		// Delay the getDialogs() call to let the session stabilize after sign-in.
		// GramJS's internal update loop needs time before it can fetch updates
		// without timing out on a freshly authenticated session.
		await this.delay(IncomingMessageHandler.INIT_DELAY_MS);

		try {
			// Fetch recent dialogs to populate GramJS's in-memory entity cache.
			// Without this, peer resolution for any chat not yet encountered in
			// the current process lifetime will throw "Could not find input entity".
			await this.client.getDialogs({ limit: 100 });
		} catch {
			// Non-fatal — events may still work if the session already has update state
		}

		console.log(`Message handler started for user ${this.telegramUserId}`);
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	stop(): void {
		if (this.handler) {
			this.client.removeEventHandler(this.handler, new NewMessage({ incoming: true }));
			this.handler = null;
		}
	}
}
