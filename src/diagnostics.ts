import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const DEFAULT_LIMIT_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_CHARS = 8_000;

/** One automatic-compaction attempt. The file is newline-delimited JSON. */
export interface CompactionAttempt {
  timestamp: string;
  durationMs: number;
  ok: boolean;
  /** `attempt` covers planning, summarizing and persisting the checkpoint. */
  phase: "attempt" | "post-check" | "completed";
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  repository?: string;
  model: { provider: string; id: string; contextWindow: number; maxTokens: number; reasoning: boolean };
  /** Effective trigger and result target in tokens at the time of the attempt. */
  trigger: number;
  target: number;
  tokensBefore: number;
  tokensAfter?: number;
  summaryChars?: number;
  stopReason?: string;
  usage?: unknown;
  error?: string;
}

/**
 * Appends compaction attempts under pi's agent directory so the real provider
 * error survives after the notification is dismissed. Every failure here is
 * swallowed: diagnostics must never block compaction or the conversation.
 */
export class DiagnosticsLog {
  readonly path: string;
  constructor(agentDir: string, private readonly limitBytes = DEFAULT_LIMIT_BYTES) {
    this.path = join(agentDir, "compactor", "compactions.jsonl");
  }
  async append(attempt: CompactionAttempt): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await this.rotate();
      await appendFile(this.path, `${JSON.stringify(clip(attempt))}\n`, { mode: 0o600 });
    } catch {
      // Missing permissions or a read-only home are not compaction failures.
    }
  }
  private async rotate(): Promise<void> {
    try {
      if ((await stat(this.path)).size < this.limitBytes) return;
      await rm(`${this.path}.1`, { force: true });
      await rename(this.path, `${this.path}.1`);
    } catch {
      // No file yet, or the previous log cannot be rotated; keep appending.
    }
  }
}

function clip(attempt: CompactionAttempt): CompactionAttempt {
  if (!attempt.error || attempt.error.length <= MAX_ERROR_CHARS) return attempt;
  return { ...attempt, error: `${attempt.error.slice(0, MAX_ERROR_CHARS)}…` };
}
