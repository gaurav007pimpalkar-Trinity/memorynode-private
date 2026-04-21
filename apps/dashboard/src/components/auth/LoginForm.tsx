function GoogleIcon(): JSX.Element {
  return (
    <svg className="h-5 w-5 shrink-0" viewBox="0 0 533.5 544.3" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M533.5 278.4c0-17.4-1.6-34.1-4.7-50.2H272v95h147c-6.4 34.2-25.8 63.2-55 82.5v68h88.8c52-47.8 80.7-118.2 80.7-195.3Z"
      />
      <path
        fill="#34A853"
        d="M272 544.3c73.1 0 134.4-24.2 179.2-65.6l-88.8-68c-24.7 16.6-56.3 26.4-90.4 26.4-69.5 0-128.3-46.9-149.3-110l-70.8 54.4c44.6 88.7 136.5 148.8 220.1 148.8Z"
      />
      <path
        fill="#FBBC04"
        d="M122.7 327.1c-5.3-15.7-8.4-32.5-8.4-49.9 0-17.3 3-34.2 8.4-49.9l-70.8-54.4C34.5 206.3 24 240.2 24 277.2s10.5 70.9 27.9 104.3l70.8-54.4Z"
      />
      <path
        fill="#EA4335"
        d="M272 107.3c39.8 0 75.5 13.7 103.6 40.5l77.7-77.7C406.3 26.3 345 0 272 0 188.4 0 96.5 60.1 51.9 148.8l70.8 54.4c21-63.1 79.8-110 149.3-110Z"
      />
    </svg>
  );
}

function GitHubIcon(): JSX.Element {
  return (
    <svg className="h-5 w-5 shrink-0 text-gray-900" viewBox="0 0 98 96" aria-hidden="true">
      <path
        fill="currentColor"
        d="M49 0C21.9 0 0 21.9 0 49c0 21.7 14.1 40.1 33.6 46.6 2.5.5 3.4-1.1 3.4-2.4 0-1.2 0-4.5-.1-8.8-13.7 3-16.6-6.6-16.6-6.6-2.2-5.7-5.5-7.2-5.5-7.2-4.5-3.1.3-3 .3-3 5 .3 7.6 5.1 7.6 5.1 4.4 7.6 11.6 5.4 14.4 4.1.5-3.2 1.7-5.4 3.1-6.7-10.9-1.2-22.4-5.4-22.4-24.3 0-5.4 1.9-9.8 5.1-13.2-.5-1.2-2.2-6.2.5-12.8 0 0 4.2-1.3 13.6 5a46.9 46.9 0 0 1 24.8 0c9.5-6.4 13.6-5 13.6-5 2.7 6.6 1 11.6.5 12.8 3.2 3.4 5.1 7.8 5.1 13.2 0 18.9-11.5 23-22.5 24.2 1.8 1.5 3.3 4.6 3.3 9.2 0 6.7-.1 12.1-.1 13.7 0 1.3.9 2.9 3.4 2.4C83.9 89.1 98 70.7 98 49 98 21.9 76.1 0 49 0Z"
      />
    </svg>
  );
}

function EmailButtonSpinner(): JSX.Element {
  return (
    <svg className="h-4 w-4 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

export type LoginFormProps = {
  email: string;
  onEmailChange: (value: string) => void;
  busy: boolean;
  errorMessage: string | null;
  magicSent: boolean;
  onMagic: () => void;
  onGoogle: () => void;
  onGithub: () => void;
  onChangeEmail: () => void;
};

export function LoginForm({
  email,
  onEmailChange,
  busy,
  errorMessage,
  magicSent,
  onMagic,
  onGoogle,
  onGithub,
  onChangeEmail,
}: LoginFormProps): JSX.Element {
  if (magicSent) {
    return (
      <div className="w-full max-w-md">
        <h2 className="mt-0 text-xl font-semibold tracking-tight text-gray-950">Check your email</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-gray-600">We sent a secure login link to {email}</p>
        <p className="mt-1 text-sm leading-relaxed text-gray-500">Open it to continue</p>
        <div className="mt-1.5 min-h-[1.25rem]">
          {errorMessage ? <p className="text-sm text-red-500">{errorMessage}</p> : null}
        </div>
        <div className="mt-5 flex flex-col gap-2.5">
          <button
            type="button"
            className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-4 py-[0.7rem] font-medium text-white shadow-[0_1px_0_rgba(255,255,255,0.1)_inset,0_10px_28px_-4px_rgba(79,70,229,0.55)] transition-all duration-200 hover:scale-[1.01] hover:bg-indigo-700 hover:brightness-[1.03] hover:shadow-[0_1px_0_rgba(255,255,255,0.12)_inset,0_14px_36px_-6px_rgba(79,70,229,0.6)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
            onClick={() => void onMagic()}
            disabled={busy}
          >
            {busy ? (
              <>
                <EmailButtonSpinner />
                Sending...
              </>
            ) : (
              "Resend"
            )}
          </button>
          <button
            type="button"
            className="cursor-pointer text-center text-sm text-gray-500 underline decoration-gray-400/80 underline-offset-2 transition-colors duration-150 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onChangeEmail}
            disabled={busy}
          >
            Change email
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md">
      <h2 className="mt-0 text-2xl font-semibold tracking-tight text-gray-950">MemoryNode</h2>
      <p className="mt-0.5 text-sm font-medium text-gray-700">Welcome back</p>
      <p className="mt-1 text-sm text-gray-500">Don’t have an account? Create one</p>

      <label className="sr-only" htmlFor="console-login-email">
        Email
      </label>
      <input
        id="console-login-email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => onEmailChange(e.target.value)}
        placeholder="you@company.com"
        className="mt-4 w-full rounded-2xl border border-gray-300 bg-white px-4 py-[0.7rem] text-base text-gray-900 shadow-sm placeholder:text-gray-400 transition-[border-color,box-shadow,transform] duration-200 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:shadow-[0_0_0_3px_rgba(99,102,241,0.14)]"
      />
      <div className="mt-1.5 min-h-[1.25rem]">
        {errorMessage ? <p className="text-sm text-red-500">{errorMessage}</p> : null}
      </div>

      <button
        type="button"
        className="mt-3 flex w-full cursor-pointer items-center justify-center gap-2 rounded-2xl bg-indigo-600 py-[0.7rem] font-medium text-white shadow-[0_1px_0_rgba(255,255,255,0.1)_inset,0_10px_28px_-4px_rgba(79,70,229,0.55)] transition-all duration-200 hover:scale-[1.01] hover:bg-indigo-700 hover:brightness-[1.03] hover:shadow-[0_1px_0_rgba(255,255,255,0.12)_inset,0_14px_36px_-6px_rgba(79,70,229,0.6)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
        onClick={() => void onMagic()}
        disabled={!email || busy}
      >
        {busy ? (
          <>
            <EmailButtonSpinner />
            Sending...
          </>
        ) : (
          "Continue with email"
        )}
      </button>

      <div className="mt-4 flex items-center">
        <div className="h-px flex-1 bg-gray-200" />
        <span className="px-3 text-xs font-medium uppercase tracking-wide text-gray-400">or</span>
        <div className="h-px flex-1 bg-gray-200" />
      </div>

      <button
        type="button"
        className="mt-2.5 flex w-full cursor-pointer items-center justify-center gap-2.5 rounded-2xl border border-gray-300 bg-white py-[0.65rem] text-sm text-gray-800 shadow-sm transition-all duration-200 hover:scale-[1.01] hover:border-gray-400/90 hover:bg-gray-50 hover:shadow-md active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
        onClick={() => void onGoogle()}
        disabled={busy}
      >
        <GoogleIcon />
        {busy ? "Opening Google..." : "Continue with Google"}
      </button>
      <button
        type="button"
        className="mt-2 flex w-full cursor-pointer items-center justify-center gap-2.5 rounded-2xl border border-gray-300 bg-white py-[0.65rem] text-sm text-gray-800 shadow-sm transition-all duration-200 hover:scale-[1.01] hover:border-gray-400/90 hover:bg-gray-50 hover:shadow-md active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
        onClick={() => void onGithub()}
        disabled={busy}
      >
        <GitHubIcon />
        {busy ? "Opening GitHub..." : "Continue with GitHub"}
      </button>

      <p className="mt-5 text-center text-xs leading-relaxed text-gray-400">
        By continuing, you agree to{" "}
        <a className="cursor-pointer text-gray-500 underline decoration-gray-300 underline-offset-2 transition-colors hover:text-gray-700" href="https://memorynode.ai/terms" target="_blank" rel="noopener noreferrer">
          Terms
        </a>{" "}
        &{" "}
        <a className="cursor-pointer text-gray-500 underline decoration-gray-300 underline-offset-2 transition-colors hover:text-gray-700" href="https://memorynode.ai/privacy" target="_blank" rel="noopener noreferrer">
          Privacy
        </a>
      </p>
    </div>
  );
}
