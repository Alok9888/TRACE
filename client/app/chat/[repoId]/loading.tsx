export default function ChatLoading() {
  return (
    <main
      role="status"
      aria-live="polite"
      className="flex min-h-svh items-center justify-center bg-background text-foreground"
    >
      <div className="flex items-center gap-3 rounded-[2px] border border-border bg-card px-5 py-3.5">
        <span className="size-1.5 animate-pulse rounded-full bg-foreground" />
        <span className="font-mono text-xs tracking-[0.16em] uppercase">Initializing Comms...</span>
      </div>
    </main>
  );
}
