import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

type WorkflowStage = "idle" | "research" | "planning" | "annotation" | "implementation";
type ActiveStage = Exclude<WorkflowStage, "idle">;
type DocCategory = "features" | "bugs" | "refactors" | "migrations" | "spikes";

interface PhaseCounters {
	research: number;
	planning: number;
	annotation: number;
	implementation: number;
}

interface WorkflowState {
	task?: string;
	stage: WorkflowStage;
	docCategory: DocCategory;
	slug: string;
	docsDir: string;
	researchPath: string;
	planPath: string;
	phaseCounters: PhaseCounters;
}

interface ChecklistItem {
	checked: boolean;
	text: string;
}

interface SavedState extends Partial<WorkflowState> {
	phaseCounters?: Partial<PhaseCounters>;
}

interface StartCommandOptions {
	categoryOverride?: DocCategory;
	task: string;
}

const STATE_ENTRY = "boris-workflow-state";
const REQUIRED_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
const DEFAULT_CATEGORY: DocCategory = "features";
const UNASSIGNED_SLUG = "unassigned";

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)\b/i,
	/\byarn\s+(add|remove|install|publish)\b/i,
	/\bpnpm\s+(add|remove|install|publish)\b/i,
	/\bpip\s+(install|uninstall)\b/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)\b/i,
	/\bsudo\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_READONLY_PATTERNS = [
	/^\s*cat\b/i,
	/^\s*head\b/i,
	/^\s*tail\b/i,
	/^\s*less\b/i,
	/^\s*more\b/i,
	/^\s*grep\b/i,
	/^\s*find\b/i,
	/^\s*ls\b/i,
	/^\s*pwd\b/i,
	/^\s*echo\b/i,
	/^\s*printf\b/i,
	/^\s*wc\b/i,
	/^\s*sort\b/i,
	/^\s*uniq\b/i,
	/^\s*diff\b/i,
	/^\s*file\b/i,
	/^\s*stat\b/i,
	/^\s*du\b/i,
	/^\s*df\b/i,
	/^\s*tree\b/i,
	/^\s*which\b/i,
	/^\s*whereis\b/i,
	/^\s*type\b/i,
	/^\s*env\b/i,
	/^\s*printenv\b/i,
	/^\s*uname\b/i,
	/^\s*whoami\b/i,
	/^\s*id\b/i,
	/^\s*date\b/i,
	/^\s*ps\b/i,
	/^\s*top\b/i,
	/^\s*htop\b/i,
	/^\s*free\b/i,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-)\b/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*yarn\s+(list|info|why|audit)\b/i,
	/^\s*node\s+--version\b/i,
	/^\s*python\s+--version\b/i,
	/^\s*curl\b/i,
	/^\s*wget\s+-O\s*-$|^\s*wget\s+-O\s+-\b/i,
	/^\s*jq\b/i,
	/^\s*sed\s+-n\b/i,
	/^\s*awk\b/i,
	/^\s*rg\b/i,
	/^\s*fd\b/i,
	/^\s*bat\b/i,
	/^\s*exa\b/i,
];

function defaultPhaseCounters(): PhaseCounters {
	return {
		research: 0,
		planning: 0,
		annotation: 0,
		implementation: 0,
	};
}

function defaultState(cwd: string): WorkflowState {
	const docsDir = resolve(cwd, "docs", DEFAULT_CATEGORY, UNASSIGNED_SLUG);
	return {
		task: undefined,
		stage: "idle",
		docCategory: DEFAULT_CATEGORY,
		slug: UNASSIGNED_SLUG,
		docsDir,
		researchPath: resolve(docsDir, "research.md"),
		planPath: resolve(docsDir, "plan.md"),
		phaseCounters: defaultPhaseCounters(),
	};
}

function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 64);
	return slug || "work-item";
}

function inferDocCategory(task: string): DocCategory {
	const text = task.toLowerCase();
	if (/\b(bug|fix|broken|regression|issue|error|crash|failing|failure)\b/.test(text)) return "bugs";
	if (/\b(refactor|cleanup|clean up|simplify|rename|deduplicate|reorganize)\b/.test(text)) return "refactors";
	if (/\b(migration|migrate|upgrade|downgrade|schema change|rollout)\b/.test(text)) return "migrations";
	if (/\b(investigate|research|spike|explore|analysis|understand|audit)\b/.test(text)) return "spikes";
	return "features";
}

function datedFolderPrefix(): string {
	return new Date().toISOString().slice(0, 10);
}

function categoryFromFlag(flag: string): DocCategory | undefined {
	switch (flag) {
		case "--feature":
			return "features";
		case "--bug":
			return "bugs";
		case "--refactor":
			return "refactors";
		case "--migration":
			return "migrations";
		case "--spike":
			return "spikes";
		default:
			return undefined;
	}
}

function parseStartCommandArgs(args: string): StartCommandOptions {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let categoryOverride: DocCategory | undefined;
	const taskTokens: string[] = [];

	for (const token of tokens) {
		const category = categoryFromFlag(token);
		if (category) {
			categoryOverride = category;
			continue;
		}
		taskTokens.push(token);
	}

	return {
		categoryOverride,
		task: taskTokens.join(" ").trim(),
	};
}

function normalizeUserPath(pathInput: string, cwd: string): string {
	const trimmed = pathInput.startsWith("@") ? pathInput.slice(1) : pathInput;
	return resolve(cwd, trimmed);
}

function relativeToCwd(path: string, cwd: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") ? rel : path;
}

function stageLabel(stage: WorkflowStage): string {
	switch (stage) {
		case "research":
			return "Research";
		case "planning":
			return "Planning";
		case "annotation":
			return "Annotation";
		case "implementation":
			return "Implementation";
		default:
			return "Idle";
	}
}

function createResearchTemplate(task?: string): string {
	return [
		"# Research",
		"",
		"## Task",
		task ? task : "Describe the task or subsystem being researched.",
		"",
		"## Scope",
		"- Relevant folders:",
		"- Relevant services / modules:",
		"- Key entry points:",
		"",
		"## Findings",
		"",
		"## Relevant files",
		"- ",
		"",
		"## Constraints / invariants",
		"- ",
		"",
		"## Risks / open questions",
		"- ",
	].join("\n");
}

function createPlanTemplate(task?: string): string {
	return [
		"# Plan",
		"",
		"## Goal",
		task ? task : "Describe the change to implement.",
		"",
		"## Approach",
		"",
		"## Files to change",
		"- ",
		"",
		"## Risks / trade-offs",
		"- ",
		"",
		"## Todo",
		"",
	].join("\n");
}

function allocateFeatureDocs(
	cwd: string,
	task: string,
	forceUnique: boolean,
	categoryOverride?: DocCategory,
): Pick<WorkflowState, "docCategory" | "slug" | "docsDir" | "researchPath" | "planPath"> {
	const docCategory = categoryOverride ?? inferDocCategory(task);
	const baseFolder = `${datedFolderPrefix()}-${slugify(task)}`;
	let docsDir = resolve(cwd, "docs", docCategory, baseFolder);
	let suffix = 2;

	while (forceUnique && existsSync(docsDir)) {
		const hasArtifacts = existsSync(resolve(docsDir, "research.md")) || existsSync(resolve(docsDir, "plan.md"));
		if (!hasArtifacts) break;
		docsDir = resolve(cwd, "docs", docCategory, `${baseFolder}-${suffix++}`);
	}

	return {
		docCategory,
		slug: basename(docsDir),
		docsDir,
		researchPath: resolve(docsDir, "research.md"),
		planPath: resolve(docsDir, "plan.md"),
	};
}

function hasAssignedDocs(state: WorkflowState): boolean {
	return state.slug !== UNASSIGNED_SLUG;
}

function looksLikeLegacyRootArtifacts(state: WorkflowState, cwd: string): boolean {
	return state.researchPath === resolve(cwd, "research.md") || state.planPath === resolve(cwd, "plan.md");
}

function assignFeatureDocs(
	state: WorkflowState,
	cwd: string,
	task: string,
	forceNew: boolean,
	categoryOverride?: DocCategory,
): { previousResearchPath: string; previousPlanPath: string } {
	const previousResearchPath = state.researchPath;
	const previousPlanPath = state.planPath;
	const next = allocateFeatureDocs(cwd, task, forceNew, categoryOverride);
	state.docCategory = next.docCategory;
	state.slug = next.slug;
	state.docsDir = next.docsDir;
	state.researchPath = next.researchPath;
	state.planPath = next.planPath;
	return { previousResearchPath, previousPlanPath };
}

function migrateLegacyArtifacts(cwd: string, state: WorkflowState) {
	if (!state.task) return;
	if (!looksLikeLegacyRootArtifacts(state, cwd) && hasAssignedDocs(state)) return;

	const previousResearchPath = state.researchPath;
	const previousPlanPath = state.planPath;
	assignFeatureDocs(state, cwd, state.task, false);
	mkdirSync(state.docsDir, { recursive: true });

	if (existsSync(previousResearchPath) && !existsSync(state.researchPath)) {
		writeFileSync(state.researchPath, readFileSync(previousResearchPath, "utf8"), "utf8");
	}
	if (existsSync(previousPlanPath) && !existsSync(state.planPath)) {
		writeFileSync(state.planPath, readFileSync(previousPlanPath, "utf8"), "utf8");
	}
}

function ensureArtifacts(state: WorkflowState): string[] {
	mkdirSync(state.docsDir, { recursive: true });
	const created: string[] = [];
	if (!existsSync(state.researchPath)) {
		writeFileSync(state.researchPath, createResearchTemplate(state.task), "utf8");
		created.push(state.researchPath);
	}
	if (!existsSync(state.planPath)) {
		writeFileSync(state.planPath, createPlanTemplate(state.task), "utf8");
		created.push(state.planPath);
	}
	return created;
}

function parseChecklist(planPath: string): ChecklistItem[] {
	if (!existsSync(planPath)) return [];
	const content = readFileSync(planPath, "utf8");
	const matches = [...content.matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/gm)];
	return matches.map((match) => ({
		checked: match[1].toLowerCase() === "x",
		text: match[2].trim(),
	}));
}

function summarizeChecklist(items: ChecklistItem[]): { done: number; total: number; next?: string } {
	const done = items.filter((item) => item.checked).length;
	const next = items.find((item) => !item.checked)?.text;
	return { done, total: items.length, next };
}

function isSafeReadonlyCommand(command: string): boolean {
	const segments = command
		.split(/&&|;|\n/)
		.map((segment) => segment.trim())
		.filter(Boolean);
	if (segments.length === 0) return false;

	return segments.every((segment) => {
		if (/^cd\s+/i.test(segment)) return true;
		if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(segment))) return false;
		return SAFE_READONLY_PATTERNS.some((pattern) => pattern.test(segment));
	});
}

function allowedWritableTargets(stage: WorkflowStage, state: WorkflowState): Set<string> | undefined {
	switch (stage) {
		case "research":
			return new Set([state.researchPath]);
		case "planning":
		case "annotation":
			return new Set([state.planPath]);
		default:
			return undefined;
	}
}

function buildResearchPrompt(scope: string | undefined, state: WorkflowState, cwd: string): string {
	const target = scope?.trim() || state.task?.trim() || "the relevant part of this codebase";
	const researchFile = relativeToCwd(state.researchPath, cwd);
	return [
		`Study ${target} in depth.`,
		"Read the relevant files thoroughly and understand how it works, what it does, its specificities, surrounding constraints, integrations, existing patterns, invariants, and likely failure modes.",
		"Do not implement anything yet.",
		`When you are done, write a detailed report of your learnings and findings in ${researchFile}.`,
		"Ground everything in the actual codebase, not guesses.",
	].join(" ");
}

function buildPlanningPrompt(goal: string | undefined, state: WorkflowState, cwd: string): string {
	const target = goal?.trim() || state.task?.trim() || "the requested change";
	const researchFile = relativeToCwd(state.researchPath, cwd);
	const planFile = relativeToCwd(state.planPath, cwd);
	return [
		`Using ${researchFile} and fresh reads of the relevant source files, write a detailed implementation plan in ${planFile} for: ${target}.`,
		"Base the plan on the actual codebase and include the approach, rationale, concrete file paths to change, code-level notes or snippets, trade-offs, risks, and edge cases.",
		"Do not implement anything yet.",
	].join(" ");
}

function buildAnnotatePrompt(state: WorkflowState, cwd: string): string {
	const planFile = relativeToCwd(state.planPath, cwd);
	return [
		`I added inline notes to ${planFile}.`,
		"Address every note and update the document accordingly.",
		"Re-read the relevant source files if needed, keep the plan grounded in the actual codebase, and do not implement anything yet.",
	].join(" ");
}

function buildReviewLoopPrompt(state: WorkflowState, cwd: string, reviewerNotes?: string): string {
	const planFile = relativeToCwd(state.planPath, cwd);
	const extra = reviewerNotes?.trim() ? ` Additional reviewer guidance: ${reviewerNotes.trim()}` : "";
	return [
		`I reviewed ${planFile} and added inline notes.`,
		"Address every note, keep the document grounded in the actual codebase, and update only the plan document.",
		"Do not implement anything yet.",
		extra,
	].join(" ").trim();
}

function buildTodosPrompt(state: WorkflowState, cwd: string): string {
	const planFile = relativeToCwd(state.planPath, cwd);
	return [
		`Update ${planFile} to add a detailed markdown task list grouped by phase.`,
		"Use GitHub-style checkboxes (- [ ] / - [x]) so progress can be tracked during implementation.",
		"Do not implement anything yet.",
	].join(" ");
}

function buildImplementationPrompt(state: WorkflowState, cwd: string): string {
	const planFile = relativeToCwd(state.planPath, cwd);
	return [
		`Implement the approved plan in ${planFile}.`,
		`When you finish a task or phase, mark its checkbox as completed in ${planFile}.`,
		"Use red/green TDD whenever a test harness exists: write or update the test first, run it and observe it fail, then implement the minimal code, then rerun the test and watch it pass.",
		"Prefer the smallest targeted test command that proves the behavior before broad validation.",
		"Do not stop until all in-scope tasks are complete.",
		"Do not add unnecessary comments or JSDoc.",
		"Do not use any or unknown types.",
		"Continuously run the project's typecheck or the closest equivalent validation command so you do not introduce new issues.",
		"If the plan is ambiguous or conflicts with the codebase, stop and explain the exact issue instead of improvising.",
	].join(" ");
}

function buildStageInstructions(state: WorkflowState, cwd: string): string | undefined {
	if (state.stage === "idle") return undefined;

	const researchFile = relativeToCwd(state.researchPath, cwd);
	const planFile = relativeToCwd(state.planPath, cwd);
	const docsDir = relativeToCwd(state.docsDir, cwd);
	const taskLine = state.task ? `Task context: ${state.task}` : "Task context: use the user's latest request.";

	const common = [
		"## Boris workflow",
		"You are operating inside Boris Tane's research -> plan -> annotate -> implement workflow.",
		taskLine,
		`Feature docs folder: ${docsDir}`,
		"Persistent artifacts:",
		`- ${researchFile}`,
		`- ${planFile}`,
		"",
		"Global rules:",
		"- Never jump straight to implementation for a non-trivial task.",
		"- Keep research and planning grounded in the actual codebase.",
		"- The markdown artifacts are review surfaces for the user and must stay accurate.",
		"- Stay in this long-running session unless the user explicitly asks for a new one.",
		"",
	];

	const stageSpecific =
		state.stage === "research"
			? [
				"Current stage: RESEARCH",
				"- Deeply understand the relevant code before proposing solutions.",
				"- Read relevant files thoroughly; avoid shallow skimming.",
				"- Surface patterns, invariants, integrations, edge cases, and likely failure modes.",
				`- Do not implement anything. You may only create or update ${researchFile}.`,
				`- ${researchFile} should end up as a detailed report, not a brief summary.`,
			]
			: state.stage === "planning"
				? [
					"Current stage: PLANNING",
					`- Use ${researchFile} plus fresh source-code reads to build ${planFile}.`,
					`- Do not implement anything. You may only create or update ${planFile}.`,
					"- The plan must be concrete: approach, rationale, files, code-level notes, risks, and assumptions.",
				]
				: state.stage === "annotation"
					? [
						"Current stage: ANNOTATION",
						`- The user has edited ${planFile} with inline notes or constraints.`,
						`- Re-read ${planFile} carefully, address every note, and update only ${planFile}.`,
						"- Do not implement anything.",
					]
					: [
						"Current stage: IMPLEMENTATION",
						`- ${planFile} is the approved source of truth. Execute it with minimal improvisation.`,
						`- Mark completed task-list items in ${planFile} as you go.`,
						"- Use red/green TDD whenever a test harness exists: write or update a targeted test first, run it and observe the failure, then implement the minimum code, then rerun it until it passes.",
						"- Prefer the smallest targeted test command first, then broaden validation.",
						"- Do not add unnecessary comments or JSDoc.",
						"- Do not use any or unknown types.",
						"- Run typecheck or the closest project validation command continuously.",
						"- If the plan is ambiguous or clashes with reality, stop and explain the exact issue.",
					];

	return [...common, ...stageSpecific].join("\n");
}

async function resolveTextInput(
	ctx: ExtensionContext,
	args: string,
	prompt: string,
	fallback?: string,
): Promise<string | undefined> {
	const trimmed = args.trim();
	if (trimmed) return trimmed;
	if (fallback?.trim()) return fallback.trim();
	if (!ctx.hasUI) return undefined;
	return (await ctx.ui.input(prompt, fallback ?? ""))?.trim() || undefined;
}

function buildStatusSummary(state: WorkflowState, cwd: string): string {
	const lines = [
		`stage: ${stageLabel(state.stage)}`,
		state.task ? `task: ${state.task}` : undefined,
		`docs: ${relativeToCwd(state.docsDir, cwd)}`,
		`research: ${relativeToCwd(state.researchPath, cwd)}`,
		`plan: ${relativeToCwd(state.planPath, cwd)}`,
	].filter((line): line is string => Boolean(line));

	if (state.stage === "implementation") {
		const checklist = parseChecklist(state.planPath);
		if (checklist.length > 0) {
			const progress = summarizeChecklist(checklist);
			lines.push(`progress: ${progress.done}/${progress.total}`);
			if (progress.next) lines.push(`next: ${progress.next}`);
		}
	}

	return lines.join("\n");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isTerminalEditorCommand(command: string): boolean {
	return /\b(vim|nvim|nano|hx|helix|kak|less|more)\b/i.test(command);
}

function spawnDetached(command: string, cwd: string, path: string): boolean {
	try {
		const child = spawn("/bin/sh", ["-lc", `${command} ${shellQuote(path)}`], {
			cwd,
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

function commandExists(command: string): boolean {
	return spawnSync("/bin/sh", ["-lc", `command -v ${command} >/dev/null 2>&1`]).status === 0;
}

function openPathInEditor(path: string, ctx: ExtensionContext, label: string): boolean {
	const preferred = (process.env.VISUAL || process.env.EDITOR || "").trim();
	if (preferred && !isTerminalEditorCommand(preferred) && spawnDetached(preferred, ctx.cwd, path)) {
		if (ctx.hasUI) ctx.ui.notify(`Opened ${label} in ${preferred}`, "info");
		return true;
	}
	if (commandExists("xdg-open") && spawnDetached("xdg-open", ctx.cwd, path)) {
		if (ctx.hasUI) ctx.ui.notify(`Opened ${label} with xdg-open`, "info");
		return true;
	}
	if (ctx.hasUI) {
		ctx.ui.notify(`Couldn't auto-open ${label}. Open ${relativeToCwd(path, ctx.cwd)} manually.`, "warning");
	}
	return false;
}

function makeCheckpointLabel(stage: ActiveStage, run: number, kind: "start" | "checkpoint"): string {
	return `boris-${stage}-${String(run).padStart(2, "0")}-${kind}`;
}

function bumpPhaseCounter(state: WorkflowState, stage: ActiveStage): number {
	state.phaseCounters[stage] += 1;
	return state.phaseCounters[stage];
}

export default function borisWorkflowExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer("boris-stage", (message, { expanded }, theme) => {
		const details = (message.details ?? {}) as {
			stage?: WorkflowStage;
			task?: string;
			docsDir?: string;
			researchPath?: string;
			planPath?: string;
			created?: string[];
			autoOpenedPlan?: boolean;
		};
		const stage = details.stage ? stageLabel(details.stage) : message.content;
		const lines = [
			theme.fg("accent", theme.bold(`▌ Boris workflow → ${stage}`)),
			details.task ? `${theme.fg("muted", "task:")} ${details.task}` : undefined,
			details.docsDir ? `${theme.fg("muted", "docs:")} ${details.docsDir}` : undefined,
			details.autoOpenedPlan ? theme.fg("success", "plan.md opened in external editor") : undefined,
		].filter((line): line is string => Boolean(line));

		if (expanded) {
			if (details.researchPath) lines.push(`${theme.fg("muted", "research:")} ${details.researchPath}`);
			if (details.planPath) lines.push(`${theme.fg("muted", "plan:")} ${details.planPath}`);
			if (details.created && details.created.length > 0) {
				lines.push(`${theme.fg("muted", "created:")} ${details.created.join(", ")}`);
			}
		}

		return new Text(lines.join("\n"), 0, 0);
	});

	let state: WorkflowState | undefined;
	let pendingCheckpointLabel: string | undefined;

	function ensureState(cwd: string): WorkflowState {
		if (!state) state = defaultState(cwd);
		return state;
	}

	function persistState() {
		if (state) {
			pi.appendEntry<SavedState>(STATE_ENTRY, { ...state, phaseCounters: { ...state.phaseCounters } });
		}
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		const restored = defaultState(ctx.cwd);
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
				const data = (entry.data ?? {}) as SavedState;
				restored.task = data.task ?? restored.task;
				restored.stage = data.stage ?? restored.stage;
				restored.docCategory = data.docCategory ?? restored.docCategory;
				restored.slug = data.slug ?? restored.slug;
				restored.docsDir = data.docsDir ?? restored.docsDir;
				restored.researchPath = data.researchPath ?? restored.researchPath;
				restored.planPath = data.planPath ?? restored.planPath;
				restored.phaseCounters = { ...restored.phaseCounters, ...(data.phaseCounters ?? {}) };
			}
		}
		migrateLegacyArtifacts(ctx.cwd, restored);
		state = restored;
		pendingCheckpointLabel = undefined;
	}

	function labelLatestMessageEntry(ctx: ExtensionContext, label: string) {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i] as { type: string; id?: string };
			if (entry.type === "message" && entry.id) {
				pi.setLabel(entry.id, label);
				return;
			}
		}
	}

	function ensureRequiredTools() {
		const active = new Set(pi.getActiveTools());
		for (const tool of REQUIRED_TOOLS) active.add(tool);
		pi.setActiveTools(Array.from(active));
	}

	function emitStageMessage(ctx: ExtensionContext, current: WorkflowState, stage: ActiveStage, created: string[], autoOpenedPlan: boolean) {
		pi.sendMessage(
			{
				customType: "boris-stage",
				content: stageLabel(stage),
				display: true,
				details: {
					stage,
					task: current.task,
					docsDir: relativeToCwd(current.docsDir, ctx.cwd),
					researchPath: relativeToCwd(current.researchPath, ctx.cwd),
					planPath: relativeToCwd(current.planPath, ctx.cwd),
					created: created.map((path) => relativeToCwd(path, ctx.cwd)),
					autoOpenedPlan,
				},
			},
			{ triggerTurn: false },
		);
	}

	function updateUi(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const current = ensureState(ctx.cwd);
		const theme = ctx.ui.theme;

		const checklist = current.stage === "implementation" ? parseChecklist(current.planPath) : [];
		const progress = summarizeChecklist(checklist);
		const statusText =
			current.stage === "idle" && !current.task
				? undefined
				: current.stage === "implementation" && progress.total > 0
					? theme.fg("accent", `boris:${current.stage}`) + theme.fg("muted", ` ${progress.done}/${progress.total}`)
					: theme.fg("accent", `boris:${current.stage}`);

		ctx.ui.setStatus("boris-workflow", statusText);

		if (current.stage === "idle" && !current.task) {
			ctx.ui.setWidget("boris-workflow", undefined);
			return;
		}

		const lines = [
			theme.fg("accent", theme.bold("Boris workflow")),
			`${theme.fg("muted", "stage:")} ${theme.fg("text", stageLabel(current.stage))}`,
			current.task ? `${theme.fg("muted", "task:")} ${current.task}` : undefined,
			`${theme.fg("muted", "docs:")} ${relativeToCwd(current.docsDir, ctx.cwd)}`,
			`${theme.fg("muted", "research:")} ${relativeToCwd(current.researchPath, ctx.cwd)}`,
			`${theme.fg("muted", "plan:")} ${relativeToCwd(current.planPath, ctx.cwd)}`,
		].filter((line): line is string => Boolean(line));

		if (current.stage === "implementation" && progress.total > 0) {
			lines.push(`${theme.fg("muted", "progress:")} ${progress.done}/${progress.total}`);
			if (progress.next) lines.push(`${theme.fg("muted", "next:")} ${progress.next}`);
		}

		ctx.ui.setWidget("boris-workflow", lines);
	}

	async function sendWorkflowPrompt(ctx: ExtensionContext, prompt: string) {
		if (ctx.isIdle()) {
			pi.sendUserMessage(prompt);
		} else {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			if (ctx.hasUI) ctx.ui.notify("Queued Boris workflow prompt as a follow-up", "info");
		}
	}

	async function transition(
		ctx: ExtensionContext,
		stage: ActiveStage,
		prompt: string,
		options?: {
			task?: string;
			newFeature?: boolean;
			sessionName?: string;
			categoryOverride?: DocCategory;
			autoOpenPlan?: boolean;
		},
	) {
		await ctx.waitForIdle();
		if (options?.newFeature || !state) state = defaultState(ctx.cwd);
		const current = ensureState(ctx.cwd);
		if (options?.task) current.task = options.task;
		if (current.task && (options?.newFeature || !hasAssignedDocs(current) || looksLikeLegacyRootArtifacts(current, ctx.cwd))) {
			assignFeatureDocs(current, ctx.cwd, current.task, Boolean(options?.newFeature), options?.categoryOverride);
		}
		const created = ensureArtifacts(current);
		current.stage = stage;
		ensureRequiredTools();
		const run = bumpPhaseCounter(current, stage);
		const startLabel = makeCheckpointLabel(stage, run, "start");
		pendingCheckpointLabel = makeCheckpointLabel(stage, run, "checkpoint");
		persistState();
		labelLatestMessageEntry(ctx, startLabel);
		if (options?.sessionName) {
			pi.setSessionName(options.sessionName);
		} else if (current.task) {
			pi.setSessionName(`Boris: ${current.task}`);
		}
		let autoOpenedPlan = false;
		if (options?.autoOpenPlan) {
			autoOpenedPlan = openPathInEditor(current.planPath, ctx, "plan.md");
		}
		updateUi(ctx);
		emitStageMessage(ctx, current, stage, created, autoOpenedPlan);
		if (ctx.hasUI && created.length > 0) {
			ctx.ui.notify(`Created ${created.map((path) => relativeToCwd(path, ctx.cwd)).join(", ")}`, "info");
		}
		await sendWorkflowPrompt(ctx, prompt);
	}

	async function runReviewLoop(args: string, ctx: ExtensionContext) {
		const current = ensureState(ctx.cwd);
		if (!existsSync(current.planPath)) {
			if (ctx.hasUI) ctx.ui.notify("No plan document exists yet. Run /boris-plan first.", "warning");
			return;
		}
		await transition(ctx, "annotation", buildReviewLoopPrompt(current, ctx.cwd, args.trim() || undefined), {
			autoOpenPlan: true,
		});
	}

	pi.registerCommand("boris-start", {
		description: "Start a new Boris workflow feature and kick off deep research (supports --bug/--feature/--refactor/--migration/--spike)",
		handler: async (args, ctx) => {
			const parsed = parseStartCommandArgs(args);
			const task = parsed.task || (await resolveTextInput(ctx, "", "What are we building or investigating?"));
			if (!task) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"Usage: /boris-start [--bug|--feature|--refactor|--migration|--spike] <task>",
						"warning",
					);
				}
				return;
			}
			const previewState = defaultState(ctx.cwd);
			previewState.task = task;
			assignFeatureDocs(previewState, ctx.cwd, task, true, parsed.categoryOverride);
			await transition(ctx, "research", buildResearchPrompt(task, previewState, ctx.cwd), {
				task,
				newFeature: true,
				sessionName: `Boris: ${task}`,
				categoryOverride: parsed.categoryOverride,
			});
		},
	});

	pi.registerCommand("boris-research", {
		description: "Enter Boris research stage and write the feature's research.md under docs/",
		handler: async (args, ctx) => {
			const current = ensureState(ctx.cwd);
			const scope = await resolveTextInput(ctx, args, "What should be researched?", current.task);
			if (!scope) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /boris-research <scope>", "warning");
				return;
			}
			if (!current.task) current.task = scope;
			if (current.task && (!hasAssignedDocs(current) || looksLikeLegacyRootArtifacts(current, ctx.cwd))) {
				assignFeatureDocs(current, ctx.cwd, current.task, false, current.docCategory);
			}
			await transition(ctx, "research", buildResearchPrompt(scope, current, ctx.cwd));
		},
	});

	pi.registerCommand("boris-plan", {
		description: "Enter Boris planning stage and write the feature's plan.md under docs/",
		handler: async (args, ctx) => {
			const current = ensureState(ctx.cwd);
			const goal = await resolveTextInput(ctx, args, "What should plan.md cover?", current.task);
			if (!goal) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /boris-plan <goal>", "warning");
				return;
			}
			if (!current.task) current.task = goal;
			if (current.task && (!hasAssignedDocs(current) || looksLikeLegacyRootArtifacts(current, ctx.cwd))) {
				assignFeatureDocs(current, ctx.cwd, current.task, false, current.docCategory);
			}
			await transition(ctx, "planning", buildPlanningPrompt(goal, current, ctx.cwd), { autoOpenPlan: true });
		},
	});

	pi.registerCommand("boris-annotate", {
		description: "Address inline notes in the current plan.md without implementing",
		handler: async (_args, ctx) => {
			const current = ensureState(ctx.cwd);
			if (!existsSync(current.planPath)) {
				if (ctx.hasUI) ctx.ui.notify("No plan document exists yet. Run /boris-plan first.", "warning");
				return;
			}
			await transition(ctx, "annotation", buildAnnotatePrompt(current, ctx.cwd), { autoOpenPlan: true });
		},
	});

	pi.registerCommand("boris-review-loop", {
		description: "Run one Boris annotation/review loop on the current plan.md",
		handler: async (args, ctx) => {
			await runReviewLoop(args, ctx);
		},
	});

	pi.registerCommand("boris-open-plan", {
		description: "Open the current plan.md in your external editor",
		handler: async (_args, ctx) => {
			const current = ensureState(ctx.cwd);
			if (!existsSync(current.planPath)) {
				if (ctx.hasUI) ctx.ui.notify("No plan document exists yet. Run /boris-plan first.", "warning");
				return;
			}
			openPathInEditor(current.planPath, ctx, "plan.md");
		},
	});

	pi.registerCommand("boris-todos", {
		description: "Add a detailed checkbox task list to the current plan.md",
		handler: async (_args, ctx) => {
			const current = ensureState(ctx.cwd);
			if (!existsSync(current.planPath)) {
				if (ctx.hasUI) ctx.ui.notify("No plan document exists yet. Run /boris-plan first.", "warning");
				return;
			}
			await transition(ctx, "planning", buildTodosPrompt(current, ctx.cwd), { autoOpenPlan: true });
		},
	});

	pi.registerCommand("boris-implement", {
		description: "Enter Boris implementation stage and execute the approved plan.md",
		handler: async (_args, ctx) => {
			const current = ensureState(ctx.cwd);
			if (!existsSync(current.planPath)) {
				if (ctx.hasUI) ctx.ui.notify("No plan document exists yet. Run /boris-plan first.", "warning");
				return;
			}
			const checklist = parseChecklist(current.planPath);
			if (checklist.length === 0) {
				if (ctx.hasUI) {
					const generate = await ctx.ui.confirm(
						"No checkbox task list found",
						"Implementation is blocked until plan.md has a non-empty checkbox task list. Generate one now?",
					);
					if (generate) {
						await transition(ctx, "planning", buildTodosPrompt(current, ctx.cwd), { autoOpenPlan: true });
					}
					return;
				}
				return;
			}
			await transition(ctx, "implementation", buildImplementationPrompt(current, ctx.cwd));
		},
	});

	pi.registerCommand("boris-status", {
		description: "Show current Boris workflow status and artifact locations",
		handler: async (_args, ctx) => {
			const current = ensureState(ctx.cwd);
			updateUi(ctx);
			if (ctx.hasUI) ctx.ui.notify(buildStatusSummary(current, ctx.cwd), "info");
		},
	});

	pi.registerCommand("boris-reset", {
		description: "Reset Boris workflow state without deleting docs artifacts",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Reset Boris workflow?",
					"This clears the workflow stage and task, but keeps the docs/ feature folder and its files.",
				);
				if (!ok) return;
			}
			await ctx.waitForIdle();
			state = defaultState(ctx.cwd);
			pendingCheckpointLabel = undefined;
			persistState();
			updateUi(ctx);
			if (ctx.hasUI) ctx.ui.notify("Boris workflow reset", "info");
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const current = ensureState(ctx.cwd);
		const extra = buildStageInstructions(current, ctx.cwd);
		if (!extra) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${extra}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const current = ensureState(ctx.cwd);
		if (current.stage === "idle" || current.stage === "implementation") return;

		if (event.toolName === "bash") {
			const command = String(event.input.command ?? "");
			if (!isSafeReadonlyCommand(command)) {
				return {
					block: true,
					reason:
						`Boris ${stageLabel(current.stage).toLowerCase()} stage only allows read-only bash commands until implementation begins. ` +
						`Blocked command: ${command}`,
				};
			}
			return;
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			const rawPath = String(event.input.path ?? "");
			const absolutePath = normalizeUserPath(rawPath, ctx.cwd);
			const allowedTargets = allowedWritableTargets(current.stage, current);
			if (allowedTargets && !allowedTargets.has(absolutePath)) {
				const allowedList = Array.from(allowedTargets)
					.map((path) => relativeToCwd(path, ctx.cwd))
					.join(", ");
				return {
					block: true,
					reason:
						`Boris ${stageLabel(current.stage).toLowerCase()} stage only allows writing to ${allowedList}. ` +
						`Do not modify source files until /boris-implement.`,
				};
			}
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
		if (state && (state.stage !== "idle" || state.task)) ensureRequiredTools();
		updateUi(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify("pi-boris loaded · use /boris-start to begin", "info");
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		restoreFromBranch(ctx);
		if (state && (state.stage !== "idle" || state.task)) ensureRequiredTools();
		updateUi(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
		if (state && (state.stage !== "idle" || state.task)) ensureRequiredTools();
		updateUi(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		restoreFromBranch(ctx);
		if (state && (state.stage !== "idle" || state.task)) ensureRequiredTools();
		updateUi(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (pendingCheckpointLabel) {
			labelLatestMessageEntry(ctx, pendingCheckpointLabel);
			pendingCheckpointLabel = undefined;
		}
		updateUi(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		updateUi(ctx);
	});
}
