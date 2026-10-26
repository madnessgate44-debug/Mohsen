/** Resolve and validate Forge's explicit repository target. */
export function resolveTargetRepo(requested: string | undefined, currentRepo: string | undefined): string {
  const target = (requested ?? '').trim() || (currentRepo ?? '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target)) {
    throw new Error('BLOCKED: target repository must be exactly owner/repo; URLs and extra path segments are forbidden.');
  }
  return target;
}
