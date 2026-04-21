import { LeftPanel } from "./LeftPanel";
import { LoginForm, type LoginFormProps } from "./LoginForm";

export type LoginScreenProps = LoginFormProps;

export function LoginScreen(props: LoginScreenProps): JSX.Element {
  return (
    <div className="mn-auth-login box-border flex min-h-screen min-h-[100dvh] flex-col bg-white text-gray-900 antialiased [color-scheme:light] md:flex-row">
      <LeftPanel />
      <div className="flex min-h-0 w-full flex-1 animate-auth-form-in items-center justify-center bg-white px-5 py-10 motion-safe:md:-translate-y-6 motion-reduce:animate-none motion-reduce:opacity-100 motion-reduce:md:translate-y-0 md:w-2/5 md:border-l md:border-gray-100 md:px-6 md:py-0 md:shadow-[0_0_40px_rgba(0,0,0,0.03)]">
        <LoginForm {...props} />
      </div>
    </div>
  );
}
