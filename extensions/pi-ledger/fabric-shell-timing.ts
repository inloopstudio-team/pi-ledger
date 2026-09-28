// Mirrored from pi-fabric/protocol: optional interop without a runtime dependency.
export const FABRIC_SHELL_TIMING_EVENT = 'pi-fabric:shell:timing:v1';

export interface BackgroundToolSpan {
  startedAt: number;
  endedAt: number;
  toolMs: number;
  taskIds: string[];
}

/** Only the background union not already covered by ordinary tool execution. */
export class FabricShellTimeMeter {
  private sessionId: string | undefined;
  private active = new Set<string>();
  private finished = new Set<string>();
  private cursor = 0;

  constructor(
    private readonly foregroundActive: () => boolean,
    private readonly record: (span: BackgroundToolSpan) => void
  ) {}

  startSession(sessionId: string): void {
    this.active.clear();
    this.finished.clear();
    this.sessionId = sessionId;
    this.cursor = Date.now();
  }

  accept(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const event = payload as Record<string, unknown>;
    if (
      !this.sessionId ||
      event.version !== 1 ||
      event.sessionId !== this.sessionId ||
      typeof event.taskId !== 'string' ||
      !event.taskId ||
      (event.tool !== 'bash' && event.tool !== 'powershell') ||
      (event.phase !== 'started' && event.phase !== 'finished') ||
      typeof event.timestamp !== 'number' ||
      !Number.isFinite(event.timestamp) ||
      event.timestamp < 0 ||
      event.timestamp > Date.now()
    )
      return false;
    const id = event.taskId;
    if (this.finished.has(id)) return false;
    if (event.phase === 'started' && this.active.has(id)) return false;
    this.checkpoint();
    if (event.phase === 'started') this.active.add(id);
    else {
      this.active.delete(id);
      this.finished.add(id);
    }
    return true;
  }

  checkpoint(now = Date.now()): void {
    const startedAt = this.cursor;
    this.cursor = Math.max(this.cursor, now);
    if (this.active.size && !this.foregroundActive() && this.cursor > startedAt) {
      this.record({
        startedAt,
        endedAt: this.cursor,
        toolMs: this.cursor - startedAt,
        taskIds: [...this.active],
      });
    }
  }

  close(): void {
    this.checkpoint();
    this.active.clear();
    this.finished.clear();
    this.sessionId = undefined;
  }
}
