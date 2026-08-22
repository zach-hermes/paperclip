import { useMemo, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { paperclipRunnerUIAdapter } from "@/adapters/paperclip-runner";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskChatInteractionCard } from "@/components/task-chat/TaskChatInteractionCard";
import { TaskChatRunnerTurn } from "@/components/task-chat/TaskChatRunnerTurn";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";
import { transcriptToTaskChatItems } from "@/components/task-chat/transcript-adapter";
import type {
  TaskChatItem,
  TaskChatProviderActivityFamily,
  TaskChatProviderActivityItem,
  TaskChatRuntimeRequestItem,
} from "@/components/task-chat/task-chat-model";
import {
  answeredAskUserQuestionsInteraction,
  pendingAskUserQuestionsInteraction,
  pendingRequestCheckboxConfirmationInteraction,
  pendingRequestConfirmationInteraction,
  pendingRequestItemVerdictsInteraction,
  pendingSuggestedTasksInteraction,
  issueThreadInteractionFixtureMeta,
} from "@/fixtures/issueThreadInteractionFixtures";
import { storybookAgentMap } from "../fixtures/paperclipData";

const TS = "2026-08-21T12:00:00.000Z";
const boardUserLabels = new Map([[issueThreadInteractionFixtureMeta.currentUserId, "Riley Board"]]);

function prp(eventType: string, payload: Record<string, unknown>, itemId?: string): string {
  return JSON.stringify({ type: "paperclip.prp.event", event: { eventType, itemId, payload } });
}

function protocolItems(events: string[], running = false): TaskChatItem[] {
  const parser = paperclipRunnerUIAdapter.createStdoutParser!();
  const transcript = events.flatMap((event, index) => parser.parseLine(event, new Date(Date.parse(TS) + index * 1000).toISOString()));
  return transcriptToTaskChatItems(transcript, { runId: "storybook-run", agentName: "Codex", running });
}

const providerEvents = [
  prp("plan.updated", { planId: "plan-1", revision: 3, complete: false, syncStatus: "synchronized", explanation: "Implement the production protocol surfaces.", steps: [
    { stepId: "one", body: "Inventory protocol events", status: "completed" },
    { stepId: "two", body: "Render task-page widgets", status: "in_progress" },
    { stepId: "three", body: "Verify Storybook coverage", status: "pending" },
  ] }),
  prp("tool.execution.completed", { executionId: "exec-1", transport: "process", operation: "execute", name: "pnpm test", target: "ui", status: "completed", durationMs: 8420, exitCode: 0, output: "63 tests passed", outputBytes: 15, outputTruncated: false }),
  prp("research.completed", { researchId: "research-1", action: "search", status: "completed", query: "Paperclip protocol UX", sources: [
    { sourceId: "source-1", title: "Protocol design notes", url: "https://example.com/protocol", snippet: "Provider-neutral interaction guidance." },
  ] }),
  prp("delegation.updated", { delegationId: "delegation-1", action: "spawn", status: "running", children: [
    { childId: "child-1", role: "UI reviewer", model: "gpt-5", status: "completed", summary: "Reviewed interaction states.", activitySummary: "4 files" },
    { childId: "child-2", role: "Test author", model: "gpt-5", status: "running", summary: null, activitySummary: "Writing contract tests" },
  ] }),
  prp("model.route.changed", { routeId: "route-1", provider: "openai", requestedModel: "auto", fromModel: null, effectiveModel: "gpt-5", reason: "Task complexity" }),
  prp("context.compacted", { compactionId: "compact-1", reason: "context_window", preTokens: 112000, postTokens: 48000, sameSession: true }),
  prp("artifact.generated", { artifactId: "artifact-1", status: "completed", reference: "artifacts/protocol-report.md", mediaType: "text/markdown", registered: true, transparentBackground: null, failure: null }),
  prp("review.mode.changed", { reviewId: "review-1", state: "entered", scope: "task changes" }),
  prp("hook.completed", { hookId: "hook-1", event: "post-test", scope: "workspace", status: "completed", blocking: false, durationMs: 320, summary: "Checks recorded" }),
  prp("memory.citation.referenced", { citationId: "citation-1", messageItemId: "message-1", label: "Prior task decision", available: true, reference: "document:architecture" }),
  prp("safety.review.completed", { reviewId: "safety-1", targetExecutionId: "exec-1", status: "completed", decision: "allowed", summary: "No destructive operation detected" }),
  prp("terminal.input.sent", { executionId: "exec-1", origin: "agent", inputClass: "control", byteCount: 1 }),
  prp("wait.started", { waitId: "wait-1", reason: "provider_backoff", status: "running", plannedDurationMs: 2000, elapsedDurationMs: 500 }),
  prp("provider.notice.recorded", { noticeId: "notice-1", level: "warning", code: "rate_limit", message: "Provider throughput is temporarily reduced.", action: "The runner will retry automatically." }),
];

const workspaceEvents = [
  prp("workspace.change.updated", {
    changeSetId: "changes-1", revision: 1, source: "harness_reported", complete: false,
    files: [{ path: "ui/src/App.tsx", operation: "modify", previousPath: null, additions: 2, deletions: 1, binary: false, diff: "@@ -1,2 +1,3 @@\n-old\n+new\n+line" }],
    totals: { files: 1, additions: 2, deletions: 1 }, patchArtifactRef: null,
  }),
  prp("workspace.diff.recorded", {
    changeSetId: "changes-1", revision: 2, source: "runner_verified", complete: true,
    files: [
      { path: "ui/src/App.tsx", operation: "modify", previousPath: null, additions: 2, deletions: 1, binary: false, diff: "@@ -1,2 +1,3 @@\n-old\n+new\n+line" },
      { path: "ui/src/new-card.tsx", operation: "create", previousPath: null, additions: 14, deletions: 0, binary: false, diff: "@@ -0,0 +1,2 @@\n+export function Card() {\n+  return null;\n+}" },
      { path: "ui/public/preview.png", operation: "modify", previousPath: null, additions: null, deletions: null, binary: true, diff: null },
      { path: "ui/src/old.ts", operation: "rename", previousPath: "ui/src/legacy.ts", additions: 0, deletions: 0, binary: false, diff: null },
    ],
    totals: { files: 4, additions: 16, deletions: 1 }, patchArtifactRef: "artifact:patch-1",
  }),
];

const fileReferenceEvent = prp("workspace.file.referenced", {
  referenceId: "reference-1", source: "runner_verified", path: "packages/paperclip-runner/protocol/README.md",
  displayName: "README.md", mediaType: "text/markdown", presentation: "document", line: 42,
  preview: "# Paperclip Runner Protocol\n\nThe runner emits provider-neutral events that the task page renders as durable operator-facing widgets.",
  previewTruncated: false, contentDigest: null,
});

const resultEvents = [
  prp("runtime_request.created", { request: { requestId: "request-1", requestKind: "command_approval", turnId: "turn-1", type: "item/commandExecution/requestApproval", status: "pending", prompt: "Allow the test command to run?", actions: ["accept", "accept_for_session", "decline", "cancel"] } }),
  prp("run.result.proposed", {
    reportedWorkDisposition: "needs_review", summary: "Protocol surfaces are implemented and ready for review.",
    completionClaim: { objectiveSatisfied: true, remainingWork: [{ description: "Review the visual snapshots", blocksCompletion: false }] },
    verification: [{ commandOrCheck: "pnpm --filter @paperclipai/ui typecheck", status: "passed", detail: "No errors" }],
    artifacts: [{ kind: "work_product", ref: "protocol-report", title: "Coverage report" }], attentionRequests: [], evidence: [],
  }),
  prp("run.terminal", { turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "needs_review" }),
];

const runtimeInputEvent = prp("runtime_request.created", {
  request: {
    requestId: "request-input",
    requestKind: "user_input",
    turnId: "turn-1",
    type: "item/tool/requestUserInput",
    status: "pending",
    prompt: "Which environment should the verification target?",
    details: { fields: [{ name: "environment", label: "Environment", placeholder: "staging" }] },
    actions: ["submit", "decline", "cancel"],
  },
});

function TaskPageFrame({ children, composerDisabledReason }: { children: ReactNode; composerDisabledReason?: string }) {
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <section className="mx-auto flex min-h-(--sz-70vh) w-full max-w-(--tc-shell-max-w) flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        {children}
        <div className="border-t border-border bg-background/90 p-3">
          <TaskChatComposer onAdd={() => undefined} workMode="standard" disabled={Boolean(composerDisabledReason)} disabledReason={composerDisabledReason} draftKey="storybook:runner-protocol" />
        </div>
      </section>
    </main>
  );
}

function TaskHeader({ title = "Implement Paperclip protocol coverage" }: { title?: string }) {
  return (
    <header className="flex flex-col gap-2 border-b border-border pb-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">PAP-16679 · In progress</div>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">Codex · Paperclip Runner · default task interface</p>
    </header>
  );
}

function ThreadStory({ items, disabledReason }: { items: TaskChatItem[]; disabledReason?: string }) {
  return <TaskPageFrame composerDisabledReason={disabledReason}><TaskChatThreadView scroll={false} header={<TaskHeader />} items={items} /></TaskPageFrame>;
}

function RunnerTurnStory({
  items,
  status = "running",
  mobile = false,
}: {
  items: TaskChatItem[];
  status?: string;
  mobile?: boolean;
}) {
  const content = (
    <TaskPageFrame>
      <TaskChatThreadView
        scroll={false}
        header={<TaskHeader title="Inspect the active Paperclip runner" />}
        items={[{ id: "request", kind: "message", author: "human", text: "Investigate this task and keep me updated as you work.", timestamp: "11:58 AM" }]}
        tail={(
          <TaskChatRunnerTurn
            runId="storybook-run"
            agentName="Runner"
            items={items}
            status={status}
            startedAtMs={Date.now() - 18_000}
            finishedAtMs={status === "running" || status === "queued" ? null : Date.now()}
          />
        )}
      />
    </TaskPageFrame>
  );
  return mobile ? <div className="mx-auto max-w-(--sz-390px)">{content}</div> : content;
}

function providerActivity(
  family: TaskChatProviderActivityFamily,
  eventType: string,
  status: TaskChatProviderActivityItem["status"],
  overrides: Partial<TaskChatProviderActivityItem> = {},
): TaskChatProviderActivityItem {
  return {
    id: `provider-${family}`,
    kind: "protocol",
    surface: "provider_activity",
    family,
    eventType,
    status,
    title: family.replaceAll("_", " "),
    details: [],
    steps: [],
    links: [],
    children: [],
    ...overrides,
  };
}

const mixedLiveActivity: TaskChatItem[] = [
  { id: "commentary-1", kind: "message", author: "agent", text: "I’ll inspect the current implementation, then verify the live behavior.", interstitial: true, channel: "progress" },
  { id: "reasoning", kind: "thinking", lines: ["The runner has the normalized events; the missing piece is their live presentation."], streaming: false, channel: "summary" },
  { id: "read", kind: "tool", name: "Read", rawName: "read_file", target: "ui/src/components/task-chat/TaskChatRunnerTurn.tsx", status: "completed", detail: "Read 324 lines" },
  providerActivity("research", "research.completed", "completed", {
    summary: "Codex live activity disclosure",
    details: [{ label: "Query", value: "Codex live activity disclosure", mono: true }],
    links: [{ label: "App-server interaction notes", href: "https://example.com/app-server", description: "Provider-neutral lifecycle reference." }],
  }),
  { id: "commentary-2", kind: "message", author: "agent", text: "The event stream is complete. I’m wiring the compact rows now.", interstitial: true, channel: "progress" },
  {
    id: "workspace",
    kind: "protocol",
    surface: "workspace_change",
    changeSetId: "change-live",
    revision: 2,
    source: "runner_verified",
    complete: true,
    files: [{ path: "ui/src/components/task-chat/TaskChatRunnerTurn.tsx", operation: "modify", previousPath: null, additions: 42, deletions: 18, binary: false, diff: "@@ -1,2 +1,3 @@\n-static row\n+expandable activity\n+semantic timeline" }],
    totals: { files: 1, additions: 42, deletions: 18 },
    patchArtifactRef: null,
  },
  { id: "test", kind: "tool", name: "Command", rawName: "bash", target: "pnpm vitest TaskChatRunnerTurn", status: "in_progress", detail: "82 tests running" },
];

const allProviderActivity: TaskChatItem[] = [
  providerActivity("plan", "plan.updated", "completed", { summary: "Three implementation steps", steps: [{ id: "step-1", label: "Build disclosure", status: "completed" }, { id: "step-2", label: "Add stories", status: "in_progress" }] }),
  providerActivity("tool_execution", "tool.execution.completed", "completed", { summary: "pnpm vitest", output: "82 tests passed" }),
  providerActivity("research", "research.completed", "completed", { summary: "Paperclip protocol UX", links: [{ label: "Protocol notes", href: "https://example.com/protocol" }] }),
  providerActivity("delegation", "delegation.updated", "completed", { details: [{ label: "Action", value: "spawn" }], children: [{ id: "child-1", title: "UI reviewer", status: "completed", summary: "Reviewed compact rows." }] }),
  providerActivity("model_identity", "model.route.changed", "informational", { summary: "gpt-5.6", details: [{ label: "Effective Model", value: "gpt-5.6", mono: true }] }),
  providerActivity("context", "context.compacted", "completed", { summary: "Context compacted" }),
  providerActivity("artifact", "artifact.generated", "completed", { summary: "runner-activity.png" }),
  providerActivity("review", "review.mode.changed", "informational", { details: [{ label: "State", value: "entered" }] }),
  providerActivity("hook", "hook.completed", "completed", { summary: "post-test" }),
  providerActivity("memory", "memory.citation.referenced", "informational", { summary: "Prior design decision" }),
  providerActivity("safety", "safety.review.completed", "completed", { summary: "Allowed" }),
  providerActivity("terminal", "terminal.input.sent", "informational", { summary: "Control input" }),
  providerActivity("wait", "wait.started", "running", { summary: "Provider backoff" }),
  providerActivity("provider_notice", "provider.notice.recorded", "informational", { summary: "Throughput temporarily reduced" }),
];

const searchResultsAndFileChanges: TaskChatItem[] = [
  providerActivity("research", "research.completed", "completed", {
    summary: "site:nextjs.org/docs/app/api-reference/config/eslint Next.js 16 eslint.config.mjs core-web-vitals typescript",
    details: [
      { label: "Action", value: "search" },
      { label: "Status", value: "completed" },
      { label: "Query", value: "site:nextjs.org/docs/app/api-reference/config/eslint Next.js 16 eslint.config.mjs core-web-vitals typescript", mono: true },
    ],
    links: [
      { label: "Configuration: ESLint | Next.js", href: "https://nextjs.org/docs/app/api-reference/config/eslint", description: "Configure ESLint in the App Router and understand the current defaults." },
      { label: "next.config.js: eslint | Next.js", href: "https://nextjs.org/docs/pages/api-reference/config/next-config-js/eslint", description: "Legacy configuration behavior and migration notes." },
      { label: "Configuration: TypeScript | Next.js", href: "https://nextjs.org/docs/app/api-reference/config/typescript", description: "TypeScript configuration options for modern Next.js applications." },
      { label: "Upgrading: Codemods | Next.js", href: "https://nextjs.org/docs/app/guides/upgrading/codemods", description: "Automated migrations for eslint.config.mjs and current conventions." },
      { label: "API Reference: Configuration | Next.js", href: "https://nextjs.org/docs/app/api-reference/config", description: "The complete application configuration reference." },
      { label: "Next.js 16 upgrade guide", href: "https://nextjs.org/docs/app/guides/upgrading/version-16", description: "Breaking changes and recommended upgrade steps for version 16." },
      { label: "Core Web Vitals", href: "https://nextjs.org/docs/app/api-reference/functions/use-report-web-vitals", description: "Measure and report application performance metrics." },
    ],
  }),
  {
    id: "file-change-search-story",
    kind: "tool",
    name: "File change",
    rawName: "file_change",
    target: "/Users/runner/workspaces/example/tsconfig.json",
    status: "completed",
    diff: {
      path: "tsconfig.json",
      added: 228,
      removed: 0,
      lines: Array.from({ length: 24 }, (_, index) => ({ kind: "add" as const, text: `generated diff line ${index + 1}` })),
    },
  },
];

function RunnerTransitionStory() {
  const [phase, setPhase] = useState(0);
  const items: TaskChatItem[] = phase === 0
    ? [{ id: "reasoning-lifecycle", kind: "thinking", lines: [], streaming: true, lifecycleOnly: true }]
    : phase === 1
      ? mixedLiveActivity.slice(0, 4)
      : phase === 2
        ? mixedLiveActivity
        : [
            ...mixedLiveActivity.map((item) => item.kind === "tool" && item.id === "test" ? { ...item, status: "completed" as const, detail: "82 tests passed" } : item),
            { id: "final", kind: "message", author: "agent", authorName: "Runner", text: "The live activity disclosure is implemented and verified.", channel: "final" },
          ];
  const status = phase === 3 ? "succeeded" : "running";
  return (
    <div className="flex flex-col gap-3">
      <div className="mx-auto flex w-full max-w-(--tc-shell-max-w) flex-wrap gap-2 px-4 pt-3">
        <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm" onClick={() => setPhase(1)}>Add research</button>
        <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm" onClick={() => setPhase(2)}>Add tool activity</button>
        <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm" onClick={() => setPhase(3)}>Finish run</button>
      </div>
      <RunnerTurnStory items={items} status={status} />
    </div>
  );
}

function RuntimeRequestStory() {
  const initial = useMemo(() => protocolItems(resultEvents), []);
  const [items, setItems] = useState(initial);
  const resolve = (request: TaskChatRuntimeRequestItem) => setItems((current) => current.map((item) => item.id === request.id && item.kind === "protocol" && item.surface === "runtime_request" ? { ...item, status: "resolved" } : item));
  return <TaskPageFrame composerDisabledReason="Waiting for a runtime decision"><TaskChatThreadView scroll={false} header={<TaskHeader />} items={items} onRuntimeRequestDecision={resolve} /></TaskPageFrame>;
}

function RuntimeInputStory() {
  const initial = useMemo(() => protocolItems([runtimeInputEvent]), []);
  const [items, setItems] = useState(initial);
  const resolve = (request: TaskChatRuntimeRequestItem) => setItems((current) => current.map((item) => item.id === request.id && item.kind === "protocol" && item.surface === "runtime_request" ? { ...item, status: "resolved" } : item));
  return <TaskPageFrame composerDisabledReason="Waiting for a runtime response"><TaskChatThreadView scroll={false} header={<TaskHeader />} items={items} onRuntimeRequestDecision={resolve} /></TaskPageFrame>;
}

function InteractionStory() {
  const [question, setQuestion] = useState(pendingAskUserQuestionsInteraction);
  const items: TaskChatItem[] = [
    { id: "human", kind: "message", author: "human", text: "Inventory the task-page protocol interactions.", timestamp: "11:58 AM" },
    ...[pendingSuggestedTasksInteraction, pendingRequestConfirmationInteraction, pendingRequestCheckboxConfirmationInteraction, pendingRequestItemVerdictsInteraction, question]
      .map((interaction) => ({ id: `interaction:${interaction.id}`, kind: "interaction" as const, interaction })),
  ];
  return (
    <TaskPageFrame composerDisabledReason="Answer the pending request above to continue">
      <TaskChatThreadView
        scroll={false}
        header={<TaskHeader title="Resolve protocol interactions" />}
        items={items}
        renderInteraction={(item) => (
          <TaskChatInteractionCard
            item={item}
            agentMap={storybookAgentMap}
            currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
            userLabelMap={boardUserLabels}
            onAcceptInteraction={() => undefined}
            onRejectInteraction={() => undefined}
            onSubmitInteractionAnswers={(interaction) => { if (interaction.id === question.id) setQuestion(answeredAskUserQuestionsInteraction); }}
            onCancelInteraction={() => undefined}
            onSubmitInteractionVerdicts={() => undefined}
          />
        )}
      />
    </TaskPageFrame>
  );
}

const meta = {
  title: "Task Page/Runner Protocol",
  component: TaskChatThreadView,
  args: { items: [] },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TaskChatThreadView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProviderSemantics: Story = { render: () => <ThreadStory items={protocolItems(providerEvents)} /> };
export const WorkspaceChanges: Story = {
  render: () => <ThreadStory items={protocolItems(workspaceEvents)} />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Review diff" }));
    await expect(within(canvasElement.ownerDocument.body).getByRole("dialog")).toHaveTextContent("ui/src/App.tsx");
  },
};
export const FileReferences: Story = {
  render: () => <ThreadStory items={protocolItems([fileReferenceEvent])} />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Preview" }));
    await expect(within(canvasElement.ownerDocument.body).getByRole("dialog")).toHaveTextContent("Paperclip Runner Protocol");
  },
};
export const RuntimeRequests: Story = {
  render: () => <RuntimeRequestStory />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Allow once" }));
    await expect(within(canvasElement).getByTestId("task-chat-runtime-request")).toHaveTextContent("resolved");
  },
};
export const RuntimeInput: Story = {
  render: () => <RuntimeInputStory />,
  play: async ({ canvasElement }) => {
    await userEvent.type(within(canvasElement).getByLabelText("Environment"), "production");
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Submit response" }));
    await expect(within(canvasElement).getByTestId("task-chat-runtime-request")).toHaveTextContent("resolved");
  },
};
export const Interactions: Story = { render: () => <InteractionStory /> };
export const ResultsAndTerminalStates: Story = { render: () => <ThreadStory items={protocolItems(resultEvents.slice(1))} /> };
export const DesktopKitchenSink: Story = {
  render: () => <ThreadStory items={[
    { id: "request", kind: "message", author: "human", text: "Implement and verify the Paperclip protocol task-page surfaces.", timestamp: "11:58 AM" },
    ...protocolItems([...providerEvents.slice(0, 4), ...workspaceEvents, fileReferenceEvent, ...resultEvents]),
  ]} disabledReason="Waiting for a runtime decision" />,
};
export const MobileKitchenSink: Story = {
  render: () => <div className="mx-auto max-w-(--sz-390px)"><ThreadStory items={protocolItems([...providerEvents.slice(0, 3), ...workspaceEvents, fileReferenceEvent])} /></div>,
};

// Named regression stories match the Runner Lab qualifications that first
// exposed the production task-page gaps.
export const FrFileReference: Story = { render: () => <ThreadStory items={protocolItems([fileReferenceEvent])} /> };
export const WcWorkspaceChanges: Story = { render: () => <ThreadStory items={protocolItems(workspaceEvents)} /> };
export const PendingQuestions: Story = {
  render: () => <InteractionStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const questionCard = canvas.getByText("Resolve open UX decisions before Phase 1").closest("article");
    if (!questionCard) throw new Error("Question interaction card did not render");
    const questions = within(questionCard);
    await userEvent.click(questions.getByText("Only collapse hidden descendants"));
    await userEvent.click(questions.getByRole("button", { name: "Next" }));
    await userEvent.click(questions.getByText("Inline answer pills"));
    await userEvent.click(questions.getByRole("button", { name: "Send answers" }));
    await waitFor(() => {
      expect(canvas.queryByRole("button", { name: "Send answers" })).not.toBeInTheDocument();
      expect(
        canvas
          .getAllByTestId("interaction-status-badge")
          .some((badge) => badge.textContent?.trim().toLowerCase() === "answered"),
      ).toBe(true);
    });
  },
};
export const CmProviderLabels: Story = { render: () => <ThreadStory items={protocolItems([prp("model.route.changed", { routeId: "cm-route", provider: "claude", requestedModel: "claude", fromModel: null, effectiveModel: "Claude Sonnet", reason: "Managed provider label" }), prp("model.verification.updated", { verificationId: "cm-verify", status: "completed", classes: ["managed"], buffering: false, summary: "Provider-neutral label verified" })])} /> };

export const RunnerThinkingNoEvents: Story = {
  name: "Runner Activity / Thinking / No Events",
  render: () => <RunnerTurnStory items={[{ id: "reasoning-lifecycle", kind: "thinking", lines: [], streaming: true, lifecycleOnly: true }]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("task-chat-current-activity")).toHaveTextContent("Thinking");
    await expect(canvas.queryByTestId("task-chat-current-activity-icon")).not.toBeInTheDocument();
    await expect(canvas.queryByTestId("task-chat-runner-disclosure-caret")).not.toBeInTheDocument();
  },
};

export const RunnerLiveCollapsedHover: Story = {
  name: "Runner Activity / Live / Collapsed Hover",
  render: () => <RunnerTurnStory items={mixedLiveActivity} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const disclosure = canvas.getByRole("button", { name: /expand run activity/i });
    await userEvent.hover(disclosure);
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.getByTestId("task-chat-runner-disclosure-caret")).toHaveClass("group-hover/disclosure:opacity-80");
  },
};

export const RunnerLiveExpandedMixedActivity: Story = {
  name: "Runner Activity / Live / Expanded Mixed Activity",
  render: () => <RunnerTurnStory items={mixedLiveActivity} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const disclosure = canvas.getByRole("button", { name: /expand run activity/i });
    disclosure.focus();
    await expect(disclosure).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByRole("list", { name: "Run activity" })).toBeInTheDocument();
    await expect(canvas.getAllByTestId("task-chat-activity-commentary")).toHaveLength(2);
    const centerX = (element: HTMLElement) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left + bounds.width / 2;
    };
    const avatarCenter = centerX(canvas.getByTestId("task-chat-agent-avatar"));
    const railCenter = centerX(canvas.getByTestId("task-chat-runner-activity-rail"));
    await expect(Math.abs(avatarCenter - railCenter)).toBeLessThanOrEqual(1);
    const activityIconCenters = [
      canvas.getByTestId("task-chat-current-activity-icon"),
      canvas.getByTestId("task-chat-thinking-icon"),
      ...canvas.getAllByTestId("task-chat-tool-icon"),
      ...canvas.getAllByTestId("task-chat-protocol-activity-icon"),
    ].map(centerX);
    await expect(Math.max(...activityIconCenters) - Math.min(...activityIconCenters)).toBeLessThanOrEqual(1);
    await expect(Math.min(...activityIconCenters) - railCenter).toBeGreaterThanOrEqual(16);
    await expect(disclosure).not.toHaveClass("focus-visible:ring-2");
  },
};

export const RunnerLiveAllProviderFamilies: Story = {
  name: "Runner Activity / Live / All Provider Families",
  render: () => <RunnerTurnStory items={allProviderActivity} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /expand run activity/i }));
    await expect(canvas.getAllByTestId("task-chat-protocol-activity-row")).toHaveLength(14);
    for (const family of ["plan", "tool_execution", "research", "delegation", "model_identity", "context", "artifact", "review", "hook", "memory", "safety", "terminal", "wait", "provider_notice"]) {
      await expect(canvas.getByTestId("task-chat-runner-activity-list").querySelector(`[data-activity-family="${family}"]`)).not.toBeNull();
    }
    const planRow = canvas.getByTestId("task-chat-runner-activity-list").querySelector<HTMLElement>('[data-activity-family="plan"]');
    if (!planRow) throw new Error("Plan activity row did not render");
    await userEvent.click(within(planRow).getByRole("button"));
    await expect(within(planRow).getByRole("list", { name: "Plan steps" })).toBeInTheDocument();
  },
};

export const RunnerLiveSearchResultsAndFileChanges: Story = {
  name: "Runner Activity / Live / Search Results and File Changes",
  render: () => <RunnerTurnStory items={searchResultsAndFileChanges} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /expand run activity/i }));
    const list = canvas.getByTestId("task-chat-runner-activity-list");
    const researchRow = list.querySelector<HTMLElement>('[data-activity-family="research"]');
    if (!researchRow) throw new Error("Research activity row did not render");
    await userEvent.click(within(researchRow).getByRole("button"));
    const toolRow = Array.from(list.querySelectorAll<HTMLElement>(".tc-enter-tool")).find((row) => row.textContent?.includes("File change"));
    if (!toolRow) throw new Error("File change tool row did not render");
    await userEvent.click(within(toolRow).getByRole("button"));

    await expect(canvas.getByTestId("task-chat-research-query")).toHaveTextContent("eslint.config.mjs");
    await expect(canvas.getByRole("list", { name: "Research sources" }).querySelectorAll("li")).toHaveLength(5);
    await expect(canvas.getByText("Show 2 more results")).toBeVisible();
    await expect(canvas.getByTestId("task-chat-tool-change-summary")).toHaveTextContent("+228 −0");
    await expect(canvas.queryByText("generated diff line 1")).not.toBeInTheDocument();
  },
};

export const RunnerLiveCommentaryAndStreamingUpdates: Story = {
  name: "Runner Activity / Live / Commentary and Streaming Updates",
  render: () => <RunnerTurnStory items={mixedLiveActivity} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("task-chat-progress-update")).toHaveTextContent("wiring the compact rows");
    await userEvent.click(canvas.getByRole("button", { name: /expand run activity/i }));
    await expect(canvas.queryByTestId("task-chat-progress-update")).not.toBeInTheDocument();
    const commentary = canvas.getAllByTestId("task-chat-activity-commentary");
    await expect(commentary[0]).toHaveTextContent("inspect the current implementation");
    await expect(commentary[1]).toHaveTextContent("wiring the compact rows");
  },
};

export const RunnerLiveRuntimeRequest: Story = {
  name: "Runner Activity / Live / Runtime Request",
  render: () => <RunnerTurnStory items={[{
    id: "request-live",
    kind: "protocol",
    surface: "runtime_request",
    runId: "storybook-running",
    requestId: "request-live",
    requestKind: "command_approval",
    turnId: "turn-live",
    requestType: "permission",
    status: "pending",
    prompt: "Allow the verification command to run?",
    choices: [{ key: "accept", label: "Allow once" }, { key: "decline", label: "Deny" }],
    fields: [],
  }]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("task-chat-runtime-request")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Allow once" })).toBeVisible();
    await expect(canvas.queryByTestId("task-chat-runner-disclosure-caret")).not.toBeInTheDocument();
  },
};

export const RunnerTransitionRunningToFinal: Story = {
  name: "Runner Activity / Transition / Running to Final",
  render: () => <RunnerTransitionStory />,
};

export const RunnerTerminalFailedOrInterrupted: Story = {
  name: "Runner Activity / Terminal / Failed or Interrupted",
  render: () => <RunnerTurnStory status="failed" items={[
    { id: "command-failed", kind: "tool", name: "Command", rawName: "bash", target: "pnpm test", status: "failed", detail: "Tests exited with code 1" },
    { id: "interrupted", kind: "marker", variant: "interrupted", label: "Run interrupted", detail: "Provider connection closed" },
  ]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("task-chat-current-activity")).toHaveTextContent("Stopped after");
    await userEvent.click(canvas.getByRole("button", { name: /expand run activity/i }));
    await expect(canvas.getByTestId("task-chat-runner-activity-list")).toHaveTextContent("Run interrupted");
  },
};

export const RunnerMobileExpandedActivity: Story = {
  name: "Runner Activity / Mobile / Expanded Activity",
  render: () => <RunnerTurnStory items={mixedLiveActivity} mobile />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /expand run activity/i }));
    await expect(canvas.getByRole("list", { name: "Run activity" })).toBeInTheDocument();
    const avatarBottom = canvas.getByTestId("task-chat-agent-avatar").getBoundingClientRect().bottom;
    const disclosureTop = canvas.getByTestId("task-chat-current-activity").getBoundingClientRect().top;
    await expect(disclosureTop - avatarBottom).toBeGreaterThanOrEqual(4);
  },
};
