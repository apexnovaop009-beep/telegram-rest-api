export interface RawInputPhoto {
	type: "photo";
	id: string;
	accessHash: string;
	fileReference: string;
	thumbSize: string;
	dcId: number;
	messageId: number;
	peerId: string;
	peerType: "user" | "chat" | "channel";
}

export interface RawInputDocument {
	type: "document";
	id: string;
	accessHash: string;
	fileReference: string;
	thumbSize: string;
	dcId: number;
	mimeType: string;
	fileName: string;
	messageId: number;
	peerId: string;
	peerType: "user" | "chat" | "channel";
}

/**
 * Chat/channel profile photo. Uses InputPeerPhotoFileLocation so the
 * download never relies on an expiring fileReference.
 */
export interface RawInputChatPhoto {
	type: "chat_photo";
	photoId: string;
	peerId: string;
	peerType: "chat" | "channel" | "user";
	dcId: number;
}

export type RawInput = RawInputPhoto | RawInputDocument | RawInputChatPhoto;

export interface DownloadTaskRow {
	id: bigint;
	file_unique_id: string;
	raw_input_json: string | null;
	from_accounts: bigint[];
	file_type: string | null;
	owner_session_id: bigint | null;
}
