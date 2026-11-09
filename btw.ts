/**
 * /btw — ask a quick side question without interrupting the main conversation.
 *
 * A Pi port of Claude Code's /btw. The side question reuses the conversation
 * context, runs without tools, and never blocks the main session.
 *
 *   /btw <question>   ask; the panel opens immediately and fills in the answer
 *   /btw              reopen the most recent exchange
 *
 * Keys: esc close · c copy · f keep in transcript · ←/→ history · ↑/↓ scroll
 */
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Text, matchesKey } from "@earendil-works/pi-tui";

const MAX_EXCHANGES = 20;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SIDE_SYSTEM = [
	"This is a side question from the user. Answer it directly in a single response.",
	"",
	"IMPORTANT CONTEXT:",
	"- You are a separate, lightweight instance answering this one question",
	"- The main session is NOT interrupted - it continues independently",
	"- You share the conversation context but you are a separate instance",
	'- Do NOT reference being interrupted or what you were "previously doing"',
	"",
	"CRITICAL CONSTRAINTS:",
	"- You have NO tools available - you cannot read files, run commands, or search",
	"- Do NOT write tool calls or tool output as text; nothing you write here is executed",
	"- This is a one-off response - there are no follow-up turns",
	"- You may only use what you already know from the conversation context",
	'- NEVER say "Let me try...", "I\'ll now...", "Let me check...", or promise any action',
	"- If you don't know the answer, say so rather than offering to look it up",
	"",
	"Answer with the information you have.",
].join("\n");

type Exchange = { question: string; answer: string; at: number };

type EntryLike = {
	type?: string;
	message?: { role?: string; content?: unknown };
};

const history: Exchange[] = [];

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("\n").trim();
}

function toMessages(entries: EntryLike[]) {
	const messages: Array<{ role: "user" | "assistant"; content: unknown; timestamp: number }> = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = textOf(entry.message.content);
		if (!text) continue;
		messages.push({ role, content: [{ type: "text", text }], timestamp: Date.now() });
	}
	// Cap inherited context so a huge session cannot blow up the side query.
	return messages.slice(-40);
}

function cleanAnswer(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "(the model returned an empty answer)";
	const toolish = /<(\w+:)?(invoke|function_calls)\b/i.test(trimmed);
	return toolish
		? `_/btw can't run tools: any tool calls or tool output above were not executed._\n\n${trimmed}`
		: trimmed;
}

async function ask(ctx: ExtensionCommandContext, question: string, prior: Exchange[]): Promise<string> {
	const model = ctx.model;
	if (!model) throw new Error("no active model");
	const branch = ctx.sessionManager.buildContextEntries() as EntryLike[];
	const messages = toMessages(branch);
	for (const exchange of prior) {
		messages.push({ role: "user", content: [{ type: "text", text: exchange.question }], timestamp: exchange.at });
		messages.push({ role: "assistant", content: [{ type: "text", text: exchange.answer }], timestamp: exchange.at });
	}
	messages.push({
		role: "user",
		content: [{ type: "text", text: question }],
		timestamp: Date.now(),
	});
	const response = await ctx.modelRegistry.complete(
		model,
		{ system: SIDE_SYSTEM, messages } as never,
		{ cacheRetention: "short", sessionId: uuidv7() } as never,
	);
	return cleanAnswer(textOf((response as { content?: unknown }).content));
}

async function showPanel(
	ctx: ExtensionCommandContext,
	seed: { question: string; prior: Exchange[]; answer?: string },
	onKeep: (exchange: Exchange) => void,
	onInject: (exchange: Exchange) => void,
): Promise<void> {
	if (ctx.mode !== "tui") {
		const answer = seed.answer ?? (await ask(ctx, seed.question, seed.prior));
		process.stdout.write(`/btw ${seed.question}\n\n${answer}\n`);
		return;
	}

	const entries: Exchange[] = [...history];
	const live: Exchange = { question: seed.question, answer: seed.answer ?? "", at: Date.now() };
	if (seed.answer === undefined) entries.push(live);
	let index = Math.max(0, entries.length - 1);

	await ctx.ui.custom((tui, theme, _kb, done) => {
		const screenHeight = (tui as { height?: number }).height ?? process.stdout.rows ?? 24;
		// Keep the panel under ~half the terminal so the conversation above stays visible.
		const maxBodyRows = Math.max(6, Math.min(20, Math.floor(screenHeight * 0.45)));

		const head = new Container();
		const body = new Container();
		const foot = new Container();
		let phase: "pending" | "done" | "error" = seed.answer === undefined ? "pending" : "done";
		let errorMsg = "";
		let frame = 0;
		let offset = 0;
		let closed = false;
		let timer: ReturnType<typeof setInterval> | null = null;
		let cache: { width: number; head: string[]; body: string[]; foot: string[] } | null = null;

		const current = () => entries[Math.min(index, entries.length - 1)];
		const pendingHere = () => phase === "pending" && current() === live;

		const build = (width: number) => {
			head.clear();
			body.clear();
			foot.clear();
			head.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			if (entries.length > 1) {
				head.addChild(
					new Text(theme.fg("dim", `(${index + 1}/${entries.length} side questions · ←/→ to browse)`), 1, 0),
				);
			}
			head.addChild(
				new Text(`${theme.fg("accent", theme.bold("/btw"))} ${theme.fg("muted", current().question)}`, 1, 0),
			);
			if (pendingHere()) {
				body.addChild(new Text(theme.fg("accent", `${SPINNER[frame % SPINNER.length]} Answering…`), 1, 1));
			} else if (phase === "error" && current() === live) {
				body.addChild(new Text(theme.fg("warning", `⚠ ${errorMsg}`), 1, 1));
			} else {
				body.addChild(new Markdown(current().answer, 1, 1, getMarkdownTheme()));
			}
			foot.addChild(
				new Text(theme.fg("dim", "↑↓ scroll · c copy · r reply · f send to chat · ←/→ history · esc close"), 1, 0),
			);
			foot.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			cache = { width, head: head.render(width), body: body.render(width), foot: foot.render(width) };
		};

		const stopTimer = () => {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		};

		const settle = async () => {
			try {
				live.answer = await ask(ctx, seed.question, seed.prior);
				phase = "done";
				history.push({ question: live.question, answer: live.answer, at: live.at });
				if (history.length > MAX_EXCHANGES) history.shift();
			} catch (error) {
				errorMsg = error instanceof Error ? error.message : String(error);
				phase = "error";
			}
			stopTimer();
			cache = null;
			if (!closed) tui.requestRender();
		};

		if (phase === "pending") {
			void settle();
			timer = setInterval(() => {
				frame++;
				if (!closed) {
					cache = null;
					tui.requestRender();
				}
			}, 120);
		}

		return {
			render: (width: number) => {
				if (!cache || cache.width !== width) build(width);
				const bounded = cache as { width: number; head: string[]; body: string[]; foot: string[] };
				if (bounded.body.length <= maxBodyRows) {
					offset = 0;
					return [...bounded.head, ...bounded.body, ...bounded.foot];
				}
				offset = Math.max(0, Math.min(offset, bounded.body.length - maxBodyRows));
				const shown = bounded.body.slice(offset, offset + maxBodyRows);
				const hint = theme.fg("dim", `  … lines ${offset + 1}-${offset + maxBodyRows} of ${bounded.body.length}`);
				return [...bounded.head, ...shown, hint, ...bounded.foot];
			},
			invalidate: () => {
				cache = null;
			},
			handleInput: (data: string) => {
				if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
					closed = true;
					stopTimer();
					done(undefined);
					return;
				}
				if (matchesKey(data, "up")) {
					offset = Math.max(0, offset - 2);
					return;
				}
				if (matchesKey(data, "down")) {
					offset += 2;
					return;
				}
				if (matchesKey(data, "left") && !pendingHere()) {
					index = (index - 1 + entries.length) % entries.length;
					offset = 0;
					cache = null;
					return;
				}
				if (matchesKey(data, "right") && !pendingHere()) {
					index = (index + 1) % entries.length;
					offset = 0;
					cache = null;
					return;
				}
				if (data === "c") {
					onKeep(current());
					void ctx.ui.setEditorText(current().answer);
					return;
				}
				if (data === "r") {
					onKeep(current());
					closed = true;
					stopTimer();
					done(undefined);
					// set after the overlay closes, or the editor reset clears it
					setTimeout(() => {
						void ctx.ui.setEditorText("/btw ");
					}, 50);
					return;
				}
				if (data === "f") {
					onInject(current());
					closed = true;
					stopTimer();
					done(undefined);
				}
			},
		};
	});
}

function inject(pi: ExtensionAPI, exchange: Exchange): void {
	// deliverAs "nextTurn": the model sees it on the next user message, and
	// nothing is triggered now — a side question must not start a turn.
	pi.sendMessage(
		{
			customType: "btw-exchange",
			content: `[/btw side question] ${exchange.question}` + "\n\n" + exchange.answer,
			display: true,
			details: exchange,
		},
		{ deliverAs: "steer", triggerTurn: false },
	);
}

export default function btwExtension(pi: ExtensionAPI) {
	pi.registerCommand("btw", {
		description: "Ask a quick side question without interrupting the main conversation",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				const last = history.at(-1);
				if (!last) {
					if (ctx.mode !== "tui") process.stdout.write("Usage: /btw <your question>\n");
					else ctx.ui.notify("Usage: /btw <your question>", "warning");
					return;
				}
				await showPanel(
					ctx,
					{ question: last.question, prior: [], answer: last.answer },
					(exchange) => pi.appendEntry("btw-exchange", exchange),
					(exchange) => inject(pi, exchange),
				);
				return;
			}
			await showPanel(
				ctx,
				{ question, prior: history.slice(-MAX_EXCHANGES) },
				(exchange) => pi.appendEntry("btw-exchange", exchange),
				(exchange) => inject(pi, exchange),
			);
		},
	});

	pi.registerMessageRenderer("btw-exchange", (message, { expanded, outputPad }, theme) => {
		const data = (message.details ?? {}) as Exchange;
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Markdown(String((message as { content?: unknown }).content ?? ""), 0, 0, getMarkdownTheme()));
		if (expanded && data.at) box.addChild(new Text(theme.fg("dim", new Date(data.at).toLocaleString())));
		return box;
	});

	pi.registerEntryRenderer("btw-exchange", (entry, { expanded }, theme) => {
		const data = entry.data as Exchange;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.fg("accent", theme.bold("/btw"))} ${theme.fg("muted", data.question)}`));
		box.addChild(new Markdown(data.answer, 0, 0, getMarkdownTheme()));
		if (expanded) box.addChild(new Text(theme.fg("dim", new Date(data.at).toLocaleString())));
		return box;
	});
}
