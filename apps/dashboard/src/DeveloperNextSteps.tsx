/**
 * Post-workspace onboarding: point builders at Quickstart + use-case recipes (GitHub).
 */

const DOCS_QUICKSTART = "https://docs.memorynode.ai/quickstart";
const GH_EXTERNAL = "https://github.com/gaurav007pimpalkar-Trinity/memorynode/blob/main/docs/external";

export function DeveloperNextSteps({ hasApiKey }: { hasApiKey: boolean }): JSX.Element {
  return (
    <section className="developer-next-steps" aria-labelledby="developer-next-steps-title">
      <h2 id="developer-next-steps-title" className="developer-next-steps-title">
        Next: ship memory in your app
      </h2>
      <p className="muted small developer-next-steps-lead">
        Same API for support bots, SaaS copilots, and high-volume chat. See{" "}
        <a href={`${GH_EXTERNAL}/POSITIONING.md`} target="_blank" rel="noopener noreferrer">
          positioning
        </a>{" "}
        for the full story.
      </p>
      <ul className="developer-next-steps-list muted small">
        <li>
          <a href={DOCS_QUICKSTART} target="_blank" rel="noopener noreferrer">
            Quickstart (hosted docs)
          </a>{" "}
          — first insert and search in minutes.
        </li>
        <li>
          <a href={`${GH_EXTERNAL}/RECIPE_SUPPORT_AGENT.md`} target="_blank" rel="noopener noreferrer">
            Support-style agent recipe
          </a>
        </li>
        <li>
          <a href={`${GH_EXTERNAL}/RECIPE_SAAS_COPILOT.md`} target="_blank" rel="noopener noreferrer">
            SaaS copilot recipe
          </a>{" "}
          ·{" "}
          <a href={`${GH_EXTERNAL}/RECIPE_SMB_CHATBOT.md`} target="_blank" rel="noopener noreferrer">
            SMB / chatbot recipe
          </a>
        </li>
        <li>
          Runnable demo:{" "}
          <a
            href="https://github.com/gaurav007pimpalkar-Trinity/memorynode/tree/main/examples/support-bot-minimal"
            target="_blank"
            rel="noopener noreferrer"
          >
            examples/support-bot-minimal
          </a>
        </li>
        {!hasApiKey ? (
          <li>
            <strong>Create an API key</strong> under <strong>API Keys</strong> in the sidebar, then run the script with{" "}
            <code className="developer-next-steps-code">API_KEY</code> set.
          </li>
        ) : null}
      </ul>
    </section>
  );
}
