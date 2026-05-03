import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
	process.env.SERVER_NAME = "test-server";
});

import { SessionCallbackService } from "../../src/services/SessionCallbackService";

const CALLBACK_URL = "https://example.com/webhook";
const SESSION_ID = "abc123";
const TELEGRAM_USER_ID = "999";

describe("SessionCallbackService", () => {
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
		vi.stubGlobal("fetch", fetchSpy);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// ── telegram_session_removed ─────────────────────────────────────

	describe("telegram_session_removed", () => {
		it("sends correct payload for logout reason", async () => {
			await SessionCallbackService.notify(
				CALLBACK_URL,
				"telegram_session_removed",
				SESSION_ID,
				TELEGRAM_USER_ID,
				"removed",
				"logout",
			);

			expect(fetchSpy).toHaveBeenCalledOnce();
			const [url, options] = fetchSpy.mock.calls[0];
			expect(url).toBe(CALLBACK_URL);
			expect(options.method).toBe("POST");
			expect(options.headers).toEqual({ "Content-Type": "application/json" });

			const body = JSON.parse(options.body);
			expect(body).toMatchObject({
				event: "telegram_session_removed",
				sessionId: SESSION_ID,
				telegramUserId: TELEGRAM_USER_ID,
				status: "removed",
				reason: "logout",
				serverName: "test-server",
			});
			expect(body.timestamp).toBeDefined();
		});

		it("sends correct payload for unauthorized reason", async () => {
			await SessionCallbackService.notify(
				CALLBACK_URL,
				"telegram_session_removed",
				SESSION_ID,
				TELEGRAM_USER_ID,
				"removed",
				"unauthorized",
			);

			const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
			expect(body).toMatchObject({
				event: "telegram_session_removed",
				status: "removed",
				reason: "unauthorized",
			});
		});

		it("sends correct payload for authorization_check_failed reason", async () => {
			await SessionCallbackService.notify(
				CALLBACK_URL,
				"telegram_session_removed",
				SESSION_ID,
				TELEGRAM_USER_ID,
				"removed",
				"authorization_check_failed",
			);

			const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
			expect(body).toMatchObject({
				event: "telegram_session_removed",
				status: "removed",
				reason: "authorization_check_failed",
			});
		});

		it("logs error but does not throw when callback returns non-OK", async () => {
			fetchSpy.mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable" });
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			await expect(
				SessionCallbackService.notify(
					CALLBACK_URL,
					"telegram_session_removed",
					SESSION_ID,
					TELEGRAM_USER_ID,
					"removed",
					"logout",
				),
			).resolves.toBeUndefined();

			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("POST to"),
			);
			errorSpy.mockRestore();
		});

		it("logs error but does not throw when fetch rejects", async () => {
			fetchSpy.mockRejectedValue(new Error("connection refused"));
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			await expect(
				SessionCallbackService.notify(
					CALLBACK_URL,
					"telegram_session_removed",
					SESSION_ID,
					TELEGRAM_USER_ID,
					"removed",
					"logout",
				),
			).resolves.toBeUndefined();

			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("POST to"),
				expect.anything(),
			);
			errorSpy.mockRestore();
		});
	});

	// ── telegram_session_disconnected ────────────────────────────────

	describe("telegram_session_disconnected", () => {
		it("sends correct payload for authorization_check_failed reason", async () => {
			await SessionCallbackService.notify(
				CALLBACK_URL,
				"telegram_session_disconnected",
				SESSION_ID,
				TELEGRAM_USER_ID,
				"disconnected",
				"authorization_check_failed",
			);

			expect(fetchSpy).toHaveBeenCalledOnce();
			const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
			expect(body).toMatchObject({
				event: "telegram_session_disconnected",
				sessionId: SESSION_ID,
				telegramUserId: TELEGRAM_USER_ID,
				status: "disconnected",
				reason: "authorization_check_failed",
				serverName: "test-server",
			});
			expect(body.timestamp).toBeDefined();
		});

		it("sends correct payload for reconnecting status and reason", async () => {
			await SessionCallbackService.notify(
				CALLBACK_URL,
				"telegram_session_disconnected",
				SESSION_ID,
				TELEGRAM_USER_ID,
				"reconnecting",
				"reconnecting",
			);

			const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
			expect(body).toMatchObject({
				event: "telegram_session_disconnected",
				status: "reconnecting",
				reason: "reconnecting",
			});
		});

		it("sends correct payload for reconnect_failed reason", async () => {
			await SessionCallbackService.notify(
				CALLBACK_URL,
				"telegram_session_disconnected",
				SESSION_ID,
				TELEGRAM_USER_ID,
				"disconnected",
				"reconnect_failed",
			);

			const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
			expect(body).toMatchObject({
				event: "telegram_session_disconnected",
				status: "disconnected",
				reason: "reconnect_failed",
			});
		});

		it("logs error but does not throw when callback returns non-OK", async () => {
			fetchSpy.mockResolvedValue({ ok: false, status: 500, statusText: "Internal Server Error" });
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			await expect(
				SessionCallbackService.notify(
					CALLBACK_URL,
					"telegram_session_disconnected",
					SESSION_ID,
					TELEGRAM_USER_ID,
					"disconnected",
					"reconnect_failed",
				),
			).resolves.toBeUndefined();

			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("POST to"),
			);
			errorSpy.mockRestore();
		});

		it("logs error but does not throw when fetch rejects", async () => {
			fetchSpy.mockRejectedValue(new Error("ENOTFOUND"));
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			await expect(
				SessionCallbackService.notify(
					CALLBACK_URL,
					"telegram_session_disconnected",
					SESSION_ID,
					TELEGRAM_USER_ID,
					"disconnected",
					"authorization_check_failed",
				),
			).resolves.toBeUndefined();

			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("POST to"),
				expect.anything(),
			);
			errorSpy.mockRestore();
		});
	});

	// ── Timestamp validation ─────────────────────────────────────────

	it("includes a valid ISO-8601 timestamp in the payload", async () => {
		const before = new Date().toISOString();

		await SessionCallbackService.notify(
			CALLBACK_URL,
			"telegram_session_removed",
			SESSION_ID,
			TELEGRAM_USER_ID,
			"removed",
			"logout",
		);

		const after = new Date().toISOString();
		const body = JSON.parse(fetchSpy.mock.calls[0][1].body);

		expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
		expect(body.timestamp >= before).toBe(true);
		expect(body.timestamp <= after).toBe(true);
	});
});
