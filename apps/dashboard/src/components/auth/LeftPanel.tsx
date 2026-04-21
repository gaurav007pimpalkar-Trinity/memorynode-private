export function LeftPanel(): JSX.Element {
  return (
    <div className="relative hidden animate-auth-panel-in overflow-hidden bg-[linear-gradient(135deg,#1E2A78_0%,#2D3BCF_50%,#4F5FFF_100%)] px-16 py-12 motion-reduce:animate-none motion-reduce:opacity-100 md:flex md:w-3/5 md:flex-col md:items-center">
      <div
        className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.08),transparent_60%)]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 z-0 opacity-[0.065] bg-[linear-gradient(to_right,rgba(255,255,255,0.1)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.1)_1px,transparent_1px)] [background-size:32px_32px]"
        aria-hidden
      />
      <div className="relative z-10 flex w-full max-w-xl flex-1 flex-col items-start justify-center">
        <h1 className="mb-6 text-4xl font-bold leading-tight text-white md:text-5xl">Hello MemoryNode 👋</h1>
        <p className="mb-4 mt-0 text-xl font-semibold text-white md:text-2xl">Build AI that understands context and memory</p>
        <p className="max-w-sm text-base leading-relaxed text-white/90 md:text-lg">
          Capture context, connect memory,
          <br />
          and make every interaction smarter
        </p>
      </div>
      <p className="absolute bottom-12 left-16 z-10 text-sm text-white/70">© 2026 MemoryNode</p>
    </div>
  );
}
