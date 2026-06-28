type Listener = (pendingCount: number) => void;

const listeners = new Set<Listener>();
let pendingCount = 0;

function emit() {
  for (const listener of listeners) {
    listener(pendingCount);
  }
}

export function getGlobalLoadingCount(): number {
  return pendingCount;
}

export function subscribeGlobalLoading(listener: Listener): () => void {
  listeners.add(listener);
  listener(pendingCount);
  return () => {
    listeners.delete(listener);
  };
}

export function beginGlobalLoading(): () => void {
  let finished = false;
  pendingCount += 1;
  emit();
  return () => {
    if (finished) return;
    finished = true;
    pendingCount = Math.max(0, pendingCount - 1);
    emit();
  };
}
