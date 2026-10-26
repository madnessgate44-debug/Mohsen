/**
 * The artifact bus: how employees hand work to each other.
 *
 * An append-only, typed log. Every handoff between roles is recorded, so a
 * company run is fully inspectable after the fact (the same discipline the
 * Firstborn COORDINATION.md uses). Nothing is overwritten; later stages read
 * what earlier stages produced.
 */

export type ArtifactKind = 'requirements' | 'design' | 'change' | 'review' | 'evidence' | 'security' | 'decision' | 'note';

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  /** The role that produced it. */
  author: string;
  /** Which work item / attempt it belongs to. */
  scope: string;
  /** Human-readable summary. */
  summary: string;
  /** Structured payload (diff text, findings, test evidence, ...). */
  data: Record<string, unknown>;
  at: string;
}

export class ArtifactBus {
  private readonly log: Artifact[] = [];
  private seq = 0;
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  post(a: Omit<Artifact, 'id' | 'at'>): Artifact {
    this.seq += 1;
    const artifact: Artifact = { ...a, id: `A-${String(this.seq).padStart(4, '0')}`, at: this.now().toISOString() };
    this.log.push(artifact);
    return artifact;
  }

  all(): readonly Artifact[] {
    return this.log;
  }

  /** Artifacts for one work item / attempt. */
  forScope(scope: string): Artifact[] {
    return this.log.filter((a) => a.scope === scope);
  }

  /** Most recent artifact of a kind within a scope, or undefined. */
  latest(scope: string, kind: ArtifactKind): Artifact | undefined {
    for (let i = this.log.length - 1; i >= 0; i -= 1) {
      const a = this.log[i];
      if (a.scope === scope && a.kind === kind) return a;
    }
    return undefined;
  }
}
