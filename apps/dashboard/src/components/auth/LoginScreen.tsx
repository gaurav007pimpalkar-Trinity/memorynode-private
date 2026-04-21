import { LeftPanel } from "./LeftPanel";
import { LoginForm, type LoginFormProps } from "./LoginForm";

export type LoginScreenProps = LoginFormProps;

export function LoginScreen(props: LoginScreenProps): JSX.Element {
  return (
    <div className="flex min-h-screen flex-col bg-white md:flex-row">
      <LeftPanel />
      <div className="flex min-h-0 w-full flex-1 animate-auth-form-in items-center justify-center bg-white px-5 py-12 motion-reduce:animate-none motion-reduce:opacity-100 md:w-2/5 md:border-l md:border-gray-100 md:px-6 md:py-0 md:shadow-[0_0_40px_rgba(0,0,0,0.03)]">
        <LoginForm {...props} />
      </div>
    </div>
  );
}
